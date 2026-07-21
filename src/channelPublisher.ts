import path from 'node:path';
import { channelRequestFingerprint, type JsonChannelPostStore, type ChannelPost, type PublicationFailureCategory } from './channelPosts.js';
import { isUnvPromotionActive, UNV_CAMPAIGN_ID, UNV_PRODUCT } from './productSales.js';
import { IndeterminateTelegramEffectError, withTelegramCallLabel } from './telegramUpdates.js';

export interface ChannelSender {
  sendMessage(chatId: string, text: string): Promise<{ message_id: number }>;
  sendPhoto(chatId: string, photo: string | { source: string; filename?: string }, extra: { caption: string }): Promise<{ message_id: number }>;
}

export interface ChannelMediaPolicy { assetRoot: string; allowedHttpsHosts: string[] }

export type PublishResult =
  | { ok: true; post: ChannelPost }
  | { ok: false; reason: 'not_found' | 'not_publishable'; post?: ChannelPost }
  | { ok: false; reason: 'campaign_expired'; post: ChannelPost; error: string }
  | { ok: false; reason: 'outcome_uncertain' | 'retry_wait'; post: ChannelPost; error: string }
  | { ok: false; reason: 'send_failed'; post: ChannelPost; error: string };

export interface PublishAttemptOptions {
  workerId?: string;
  claimLeaseMs?: number;
  claimRenewMs?: number;
  uncertainWindowMs?: number;
  now?: Date;
  runtime?: PublisherRuntime;
}

interface ActivePublication {
  key: string;
  store: JsonChannelPostStore;
  postId: string;
  attemptId: string;
  claimToken: string;
  uncertainWindowMs?: number;
}

export interface PublisherDrainResult { drained: boolean; timedOut: boolean; activeAtTimeout: number; durationMs: number }

export class PublisherRuntime {
  private accepting = true;
  private readonly active = new Map<string, ActivePublication>();
  private readonly waiters = new Set<() => void>();

  get isAccepting(): boolean { return this.accepting; }
  get activeCount(): number { return this.active.size; }
  stopAccepting(): void { this.accepting = false; }
  assertAccepting(): void { if (!this.accepting) throw new PublisherStoppingError(); }

  begin(active: Omit<ActivePublication, 'key'>): string {
    this.assertAccepting();
    const key = `${active.postId}:${active.attemptId}`;
    this.active.set(key, { ...active, key });
    return key;
  }

  finish(key: string | undefined): void {
    if (!key) return;
    this.active.delete(key);
    if (this.active.size === 0) {
      for (const resolve of this.waiters) resolve();
      this.waiters.clear();
    }
  }

  async drain(timeoutMs: number, now = new Date()): Promise<PublisherDrainResult> {
    this.stopAccepting();
    const started = Date.now();
    if (this.active.size === 0) return { drained: true, timedOut: false, activeAtTimeout: 0, durationMs: Date.now() - started };
    let timer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      new Promise<true>((resolve) => this.waiters.add(() => resolve(true))),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
    if (drained) return { drained: true, timedOut: false, activeAtTimeout: 0, durationMs: Date.now() - started };
    const remaining = [...this.active.values()];
    await Promise.allSettled(remaining.map((item) => item.store.abandonForShutdown(item.postId, item.attemptId, item.claimToken, now, item.uncertainWindowMs)));
    return { drained: false, timedOut: true, activeAtTimeout: remaining.length, durationMs: Date.now() - started };
  }
}

export class PublisherStoppingError extends Error {
  constructor() { super('Publisher is stopping and will not accept new claims.'); this.name = 'PublisherStoppingError'; }
}

export async function publishChannelPost(store: JsonChannelPostStore, sender: ChannelSender, channelChatId: string, id: string, publisherId: number, retryFailed = false, mediaPolicy = defaultMediaPolicy(), idempotencyKey?: string, options: PublishAttemptOptions = {}): Promise<PublishResult> {
  options.runtime?.assertAccepting();
  const now = options.now ?? new Date();
  const claim = await store.claimForPublishing(id, publisherId, retryFailed, idempotencyKey, { workerId: options.workerId, leaseMs: options.claimLeaseMs, now });
  if (!claim.ok) return claim;
  if (claim.replayed && claim.post.status === 'Published') return { ok: true, post: claim.post };
  if (claim.replayed && claim.post.status === 'Failed') return { ok: false, reason: 'send_failed', post: claim.post, error: claim.post.lastError ?? 'Previous publication attempt failed.' };
  if (claim.replayed && claim.post.status === 'Uncertain') return { ok: false, reason: 'outcome_uncertain', post: claim.post, error: claim.post.uncertainReason ?? 'Previous publication outcome is uncertain.' };
  return publishClaimedChannelPost(store, sender, channelChatId, claim.post, claim.attemptId, now, mediaPolicy, claim.claimToken, options);
}

export async function publishClaimedChannelPost(store: JsonChannelPostStore, sender: ChannelSender, channelChatId: string, post: ChannelPost, attemptId: string, now = new Date(), mediaPolicy = defaultMediaPolicy(), claimToken = post.claimToken ?? '', options: PublishAttemptOptions = {}): Promise<PublishResult> {
  let runtimeKey: string | undefined;
  try {
    runtimeKey = options.runtime?.begin({ store, postId: post.id, attemptId, claimToken, uncertainWindowMs: options.uncertainWindowMs });
  } catch (error) {
    await store.abandonForShutdown(post.id, attemptId, claimToken, now, options.uncertainWindowMs);
    throw error;
  }
  const blocked = campaignExpiryError(post, now);
  if (blocked) {
    const failed = await store.markFailed(post.id, attemptId, blocked, 'validation', claimToken, now);
    if (!failed) throw new Error('Publish state changed before campaign validation completed');
    return { ok: false, reason: 'campaign_expired', post: failed, error: blocked };
  }
  let observedMessageId: number | undefined;
  let sendStarted = false;
  let renewal: NodeJS.Timeout | undefined;
  try {
    const photo = resolveChannelPhoto(post, mediaPolicy);
    const fingerprint = channelRequestFingerprint(post, channelChatId, photo ? 'photo' : 'text');
    const started = await store.markSendStarted(post.id, attemptId, claimToken, channelChatId, fingerprint, now);
    if (!started) throw new Error('Publish claim ownership changed before Telegram send started');
    sendStarted = true;
    if (options.claimRenewMs && options.claimLeaseMs) {
      renewal = setInterval(() => {
        void store.renewClaim(post.id, attemptId, claimToken, options.claimLeaseMs!).catch(() => undefined);
      }, options.claimRenewMs);
      renewal.unref?.();
    }
    const sent = photo
      ? await withTelegramCallLabel(`channel:publish:${post.id}`, () => sender.sendPhoto(channelChatId, photo, { caption: post.text }))
      : await withTelegramCallLabel(`channel:publish:${post.id}`, () => sender.sendMessage(channelChatId, post.text));
    observedMessageId = sent.message_id;
    const published = await store.markPublished(post.id, attemptId, sent.message_id, claimToken);
    if (!published) throw new Error('Publish state changed before completion');
    return { ok: true, post: published };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outcome = classifyPublicationFailure(error, sendStarted, observedMessageId);
    if (outcome.kind === 'uncertain') {
      const uncertain = await store.markUncertain(post.id, attemptId, message, claimToken, observedMessageId, new Date(), options.uncertainWindowMs);
      if (!uncertain) throw error;
      return { ok: false, reason: 'outcome_uncertain', post: uncertain, error: message };
    }
    if (outcome.kind === 'retry_wait') {
      const waiting = await store.markRetryWait(post.id, attemptId, message, outcome.category, new Date(Date.now() + outcome.retryAfterMs), claimToken);
      if (!waiting) throw error;
      return { ok: false, reason: 'retry_wait', post: waiting, error: message };
    }
    const failed = await store.markFailed(post.id, attemptId, message, outcome.category, claimToken);
    if (!failed) throw error;
    return { ok: false, reason: 'send_failed', post: failed, error: message };
  } finally {
    if (renewal) clearInterval(renewal);
    options.runtime?.finish(runtimeKey);
  }
}

type FailureDisposition =
  | { kind: 'uncertain'; category: 'uncertain' | 'storage' }
  | { kind: 'retry_wait'; category: 'rate_limit' | 'transient'; retryAfterMs: number }
  | { kind: 'failed'; category: PublicationFailureCategory };

export function classifyPublicationFailure(error: unknown, sendStarted: boolean, observedMessageId?: number): FailureDisposition {
  const message = error instanceof Error ? error.message : String(error);
  const record = error as { response?: { error_code?: number; parameters?: { retry_after?: number } }; code?: string; name?: string };
  const errorCode = record.response?.error_code;
  if (observedMessageId !== undefined) return { kind: 'uncertain', category: 'storage' };
  if (!sendStarted) return { kind: 'failed', category: 'validation' };
  if (errorCode === 429 || /\b429\b|too many requests|retry after/i.test(message)) {
    const retrySeconds = record.response?.parameters?.retry_after;
    return { kind: 'retry_wait', category: 'rate_limit', retryAfterMs: Math.min(60 * 60_000, Math.max(1_000, (retrySeconds ?? 30) * 1_000)) };
  }
  if (errorCode && errorCode >= 400 && errorCode < 500) return { kind: 'failed', category: 'telegram_rejection' };
  if (error instanceof IndeterminateTelegramEffectError || ['AbortError', 'TimeoutError'].includes(record.name ?? '') || ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(record.code ?? '') || /timeout|timed out|connection reset|socket hang up|network/i.test(message)) {
    return { kind: 'uncertain', category: 'uncertain' };
  }
  return { kind: 'uncertain', category: 'uncertain' };
}

export function resolveChannelPhoto(post: ChannelPost, policy = defaultMediaPolicy()): string | { source: string; filename?: string } | undefined {
  if (post.photoFileId) return post.photoFileId;
  if (!post.photoSource) return undefined;
  if (post.photoSource.kind === 'local_path') {
    if (!/\.(png|jpe?g|webp)$/i.test(post.photoSource.value)) throw new Error('Local channel image must be PNG, JPEG or WebP.');
    const root = path.resolve(policy.assetRoot);
    const resolved = path.resolve(root, post.photoSource.value);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('Local channel image escapes CHANNEL_ASSET_ROOT.');
    if (resolved === root) throw new Error('Local channel image path must identify a file.');
    return { source: resolved, filename: path.basename(resolved) };
  }
  const url = new URL(post.photoSource.value);
  const allowed = new Set(policy.allowedHttpsHosts.map((host) => host.trim().toLowerCase()).filter(Boolean));
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed.has(url.hostname.toLowerCase())) throw new Error('Hosted channel image URL is not allowed by CHANNEL_IMAGE_HOSTS.');
  if (!/\.(png|jpe?g|webp)$/i.test(url.pathname)) throw new Error('Hosted channel image must be PNG, JPEG or WebP.');
  return url.toString();
}

function defaultMediaPolicy(): ChannelMediaPolicy { return { assetRoot: path.resolve('assets/channel'), allowedHttpsHosts: [] }; }

export function campaignExpiryError(post: ChannelPost, now = new Date()): string | undefined {
  const text = post.text.toLowerCase();
  const looksLikeKnownPromotion = post.campaignId === UNV_CAMPAIGN_ID || (text.includes(UNV_PRODUCT.model.toLowerCase()) && (text.includes('aksiya') || text.includes('499 000') || text.includes('499000')));
  if (looksLikeKnownPromotion && !isUnvPromotionActive(now)) return `Campaign ${UNV_CAMPAIGN_ID} is outside its approved Asia/Tashkent date range.`;
  return undefined;
}
