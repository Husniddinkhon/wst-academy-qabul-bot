import { createHash, randomUUID } from 'node:crypto';
import { atomicWriteJson, readJson, withFileLock } from './safeJson.js';

export type ChannelPostStatus =
  | 'Draft'
  | 'PendingApproval'
  | 'Approved'
  | 'Scheduled'
  | 'Claimed'
  | 'Publishing'
  | 'Published'
  | 'Uncertain'
  | 'RetryWait'
  | 'Failed'
  | 'Cancelled';

export type PublicationFailureCategory = 'validation' | 'telegram_rejection' | 'rate_limit' | 'transient' | 'uncertain' | 'storage';
export type PublicationReconciliationStatus = 'not_required' | 'pending' | 'message_id_observed' | 'confirmed_published' | 'confirmed_not_published' | 'manual_review_required';

export interface ChannelPostAuditEvent {
  at: string;
  event: string;
  actorId?: number;
  workerId?: string;
  attemptId?: string;
  reason?: string;
}

export interface ChannelPost {
  id: string;
  text: string;
  status: ChannelPostStatus;
  createdAt: string;
  createdBy?: number;
  scheduledAt?: string;
  scheduledBy?: number;
  approvedAt?: string;
  approvedBy?: number;
  cancelledAt?: string;
  cancelledBy?: number;
  campaignId?: string;
  targetChannel?: string;
  semanticKey?: string;
  claimToken?: string;
  claimWorkerId?: string;
  claimStartedAt?: string;
  leaseExpiresAt?: string;
  publishStartedAt?: string;
  sendStartedAt?: string;
  publishedAt?: string;
  publishedBy?: number;
  publishedMessageId?: number;
  observedMessageId?: number;
  publishAttemptId?: string;
  attempts: number;
  requestFingerprint?: string;
  lastError?: string;
  failureCategory?: PublicationFailureCategory;
  failedAt?: string;
  uncertainAt?: string;
  uncertainReason?: string;
  reconciliationStatus?: PublicationReconciliationStatus;
  reconciliationDeadlineAt?: string;
  reconciledAt?: string;
  nextRetryAt?: string;
  photoFileId?: string;
  photoSource?: ChannelImageSource;
  contentKey?: string;
  requestKey?: string;
  actionKeys?: string[];
  audit?: ChannelPostAuditEvent[];
}

export type ChannelImageSource =
  | { kind: 'local_path'; value: string }
  | { kind: 'https_url'; value: string };

interface ChannelPostDatabase { posts: ChannelPost[] }
export interface PublicationClaimOptions { workerId?: string; leaseMs?: number; now?: Date }
export type ClaimResult = { ok: true; post: ChannelPost; attemptId: string; claimToken: string; replayed?: boolean } | { ok: false; reason: 'not_found' | 'not_publishable'; post?: ChannelPost };
export type MutationResult = { ok: true; post: ChannelPost } | { ok: false; reason: 'not_found' | 'not_allowed'; post?: ChannelPost };
export type ReconciliationEvidence =
  | { outcome: 'published'; actorId: number; messageId: number; note: string }
  | { outcome: 'not_published'; actorId: number; note: string };

const DEFAULT_CLAIM_LEASE_MS = 10 * 60_000;
const DEFAULT_UNCERTAIN_WINDOW_MS = 24 * 60 * 60_000;

export class JsonChannelPostStore {
  private mutationQueue: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string) {}

  async create(text: string, photoFileId?: string, createdBy?: number, idempotencyKey?: string): Promise<ChannelPost> {
    return this.mutate((db) => {
      const existing = idempotencyKey ? db.posts.find((item) => item.requestKey === idempotencyKey) : undefined;
      if (existing) return normalizePost(existing);
      const id = randomUUID().slice(0, 8);
      const now = new Date().toISOString();
      const post: ChannelPost = {
        id, text, photoFileId, status: 'Draft', createdAt: now, createdBy, attempts: 0,
        semanticKey: `channel-post:${id}`, requestKey: idempotencyKey, actionKeys: [],
        reconciliationStatus: 'not_required', audit: [{ at: now, event: 'draft_created', actorId: createdBy }],
      };
      db.posts.push(post);
      return post;
    });
  }

  async createFromSource(text: string, photoSource: ChannelImageSource, createdBy?: number, contentKey?: string): Promise<ChannelPost> {
    return this.mutate((db) => {
      const id = randomUUID().slice(0, 8);
      const now = new Date().toISOString();
      const post: ChannelPost = {
        id, text, photoSource, contentKey, status: 'Draft', createdAt: now, createdBy, attempts: 0,
        semanticKey: `channel-post:${id}`, actionKeys: [], reconciliationStatus: 'not_required',
        audit: [{ at: now, event: 'draft_created', actorId: createdBy }],
      };
      db.posts.push(post);
      return post;
    });
  }

  async get(id: string): Promise<ChannelPost | undefined> { return (await this.read()).posts.find((post) => post.id === id); }
  async all(): Promise<ChannelPost[]> { return (await this.read()).posts; }
  async last(limit = 10): Promise<ChannelPost[]> { return (await this.read()).posts.slice(-limit).reverse(); }

  async schedule(id: string, scheduledAt: string, adminId: number, campaignId?: string, idempotencyKey?: string): Promise<MutationResult> {
    return this.mutate((db) => {
      const index = db.posts.findIndex((post) => post.id === id);
      if (index < 0) return { ok: false, reason: 'not_found' } as const;
      const current = normalizePost(db.posts[index]);
      if (idempotencyKey && current.actionKeys?.includes(idempotencyKey)) return { ok: true, post: current } as const;
      if (!['Draft', 'Cancelled', 'Failed', 'RetryWait'].includes(current.status)) return { ok: false, reason: 'not_allowed', post: current } as const;
      const now = new Date().toISOString();
      const post: ChannelPost = appendAudit({
        ...clearClaim(current), status: 'Scheduled', scheduledAt, scheduledBy: adminId, approvedAt: now, approvedBy: adminId,
        campaignId: campaignId || undefined, cancelledAt: undefined, cancelledBy: undefined, lastError: undefined,
        failureCategory: undefined, failedAt: undefined, nextRetryAt: undefined,
        actionKeys: appendActionKey(current.actionKeys, idempotencyKey),
      }, { at: now, event: 'scheduled_and_approved', actorId: adminId });
      db.posts[index] = post;
      return { ok: true, post } as const;
    });
  }

  async refreshScheduledContent(contentKey: string, scheduledAt: string, text: string, photoSource: ChannelImageSource, campaignId: string): Promise<MutationResult> {
    return this.mutate((db) => {
      const index = db.posts.findIndex((post) => post.contentKey === contentKey);
      if (index < 0) return { ok: false, reason: 'not_found' } as const;
      const current = normalizePost(db.posts[index]);
      if (current.status !== 'Scheduled' || current.scheduledAt !== scheduledAt || current.attempts !== 0 || current.publishedMessageId !== undefined) {
        return { ok: false, reason: 'not_allowed', post: current } as const;
      }
      const post: ChannelPost = appendAudit({ ...current, text, photoSource, campaignId }, { at: new Date().toISOString(), event: 'scheduled_content_refreshed' });
      db.posts[index] = post;
      return { ok: true, post } as const;
    });
  }

  async cancel(id: string, adminId: number, idempotencyKey?: string): Promise<MutationResult> {
    return this.mutate((db) => {
      const index = db.posts.findIndex((post) => post.id === id);
      if (index < 0) return { ok: false, reason: 'not_found' } as const;
      const current = normalizePost(db.posts[index]);
      if (idempotencyKey && current.actionKeys?.includes(idempotencyKey)) return { ok: true, post: current } as const;
      if (!['Scheduled', 'RetryWait', 'Claimed'].includes(current.status)) return { ok: false, reason: 'not_allowed', post: current } as const;
      const now = new Date().toISOString();
      const post = appendAudit({
        ...clearClaim(current), status: 'Cancelled', cancelledAt: now, cancelledBy: adminId,
        actionKeys: appendActionKey(current.actionKeys, idempotencyKey), nextRetryAt: undefined,
      }, { at: now, event: 'cancelled', actorId: adminId, attemptId: current.publishAttemptId });
      db.posts[index] = post;
      return { ok: true, post } as const;
    });
  }

  async claimForPublishing(id: string, publisherId: number, retryFailed = false, idempotencyKey?: string, options: PublicationClaimOptions = {}): Promise<ClaimResult> {
    return this.mutate((db) => {
      const index = db.posts.findIndex((post) => post.id === id);
      if (index < 0) return { ok: false, reason: 'not_found' } as const;
      const current = normalizePost(db.posts[index]);
      if (idempotencyKey && current.actionKeys?.includes(idempotencyKey) && current.publishAttemptId && current.claimToken) {
        return { ok: true, post: current, attemptId: current.publishAttemptId, claimToken: current.claimToken, replayed: true } as const;
      }
      const now = options.now ?? new Date();
      const retryReady = current.status === 'RetryWait' && (!current.nextRetryAt || new Date(current.nextRetryAt) <= now);
      if (!(current.status === 'Draft' || retryReady || (retryFailed && current.status === 'Failed'))) return { ok: false, reason: 'not_publishable', post: current } as const;
      return claim(db, index, { ...current, actionKeys: appendActionKey(current.actionKeys, idempotencyKey) }, publisherId, options.workerId ?? `manual:${publisherId}`, now, options.leaseMs ?? DEFAULT_CLAIM_LEASE_MS);
    });
  }

  async claimNextDue(now: Date, publisherId = 0, options: PublicationClaimOptions = {}): Promise<ClaimResult> {
    return this.mutate((db) => {
      const due = db.posts.map(normalizePost).filter((post) =>
        Boolean(post.approvedAt && post.scheduledAt && new Date(post.scheduledAt) <= now)
        && (post.status === 'Scheduled' || (post.status === 'RetryWait' && (!post.nextRetryAt || new Date(post.nextRetryAt) <= now))),
      ).sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!))[0];
      if (!due) return { ok: false, reason: 'not_found' } as const;
      const index = db.posts.findIndex((post) => post.id === due.id);
      return claim(db, index, due, publisherId, options.workerId ?? 'channel-scheduler', now, options.leaseMs ?? DEFAULT_CLAIM_LEASE_MS);
    });
  }

  async markSendStarted(id: string, attemptId: string, claimToken: string, targetChannel: string, requestFingerprint: string, now = new Date()): Promise<ChannelPost | undefined> {
    return this.mutate((db) => {
      const index = db.posts.findIndex((post) => post.id === id);
      if (index < 0) return undefined;
      const current = normalizePost(db.posts[index]);
      if (current.status !== 'Claimed' || current.publishAttemptId !== attemptId || current.claimToken !== claimToken) return undefined;
      const at = now.toISOString();
      const updated = appendAudit({ ...current, status: 'Publishing', targetChannel, requestFingerprint, sendStartedAt: at, publishStartedAt: at }, { at, event: 'telegram_send_started', workerId: current.claimWorkerId, attemptId });
      db.posts[index] = updated;
      return updated;
    });
  }

  async renewClaim(id: string, attemptId: string, claimToken: string, leaseMs: number, now = new Date()): Promise<boolean> {
    return this.mutate((db) => {
      const index = db.posts.findIndex((post) => post.id === id);
      if (index < 0) return false;
      const current = normalizePost(db.posts[index]);
      if (!['Claimed', 'Publishing'].includes(current.status) || current.publishAttemptId !== attemptId || current.claimToken !== claimToken) return false;
      db.posts[index] = { ...current, leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString() };
      return true;
    });
  }

  async abandonForShutdown(id: string, attemptId: string, claimToken: string, now = new Date(), uncertainWindowMs = DEFAULT_UNCERTAIN_WINDOW_MS): Promise<ChannelPost | undefined> {
    return this.mutate((db) => {
      const index = db.posts.findIndex((post) => post.id === id);
      if (index < 0) return undefined;
      const current = normalizePost(db.posts[index]);
      if (!['Claimed', 'Publishing'].includes(current.status) || current.publishAttemptId !== attemptId || current.claimToken !== claimToken) return undefined;
      const updated = current.status === 'Claimed' && !current.sendStartedAt
        ? appendAudit({ ...clearClaim(current), status: 'RetryWait' as const, nextRetryAt: now.toISOString(), lastError: 'Shutdown drain expired before Telegram send started.', failureCategory: 'transient' as const }, { at: now.toISOString(), event: 'shutdown_released_pre_send_claim', workerId: current.claimWorkerId, attemptId })
        : toUncertain(current, 'Shutdown drain expired after Telegram send started; remote outcome is unknown.', now, uncertainWindowMs, 'shutdown_send_outcome_uncertain');
      db.posts[index] = updated;
      return updated;
    });
  }

  async recoverExpiredClaims(now = new Date(), uncertainWindowMs = DEFAULT_UNCERTAIN_WINDOW_MS): Promise<ChannelPost[]> {
    return this.mutate((db) => {
      const recovered: ChannelPost[] = [];
      db.posts = db.posts.map((raw) => {
        const post = normalizePost(raw);
        if (!['Claimed', 'Publishing'].includes(post.status) || !post.leaseExpiresAt || new Date(post.leaseExpiresAt) > now) return post;
        if (post.status === 'Claimed' && !post.sendStartedAt) {
          const next = appendAudit({ ...clearClaim(post), status: 'RetryWait', nextRetryAt: now.toISOString(), failureCategory: 'transient', lastError: 'Publisher claim expired before Telegram send started.' }, { at: now.toISOString(), event: 'stale_claim_recovered_safe', workerId: post.claimWorkerId, attemptId: post.publishAttemptId });
          recovered.push(next);
          return next;
        }
        const next = toUncertain(post, 'Publisher lease expired after Telegram send started; remote outcome is unknown.', now, uncertainWindowMs, 'stale_claim_recovered_uncertain');
        recovered.push(next);
        return next;
      });
      return recovered;
    });
  }

  async closeExpiredReconciliationWindows(now = new Date()): Promise<ChannelPost[]> {
    return this.mutate((db) => {
      const closed: ChannelPost[] = [];
      db.posts = db.posts.map((raw) => {
        const post = normalizePost(raw);
        if (post.status !== 'Uncertain' || post.reconciliationStatus !== 'pending' || !post.reconciliationDeadlineAt || new Date(post.reconciliationDeadlineAt) > now) return post;
        const updated = appendAudit({ ...post, reconciliationStatus: 'manual_review_required' }, { at: now.toISOString(), event: 'reconciliation_window_expired', attemptId: post.publishAttemptId, reason: 'automatic_retry_prohibited' });
        closed.push(updated);
        return updated;
      });
      return closed;
    });
  }

  /** Backward-compatible Wave 2 entrypoint. Publishing claims now fail closed as Uncertain. */
  async recoverStalePublishing(cutoff: Date, uncertainWindowMs = DEFAULT_UNCERTAIN_WINDOW_MS, now = new Date()): Promise<ChannelPost[]> {
    return this.mutate((db) => {
      const recovered: ChannelPost[] = [];
      db.posts = db.posts.map((raw) => {
        const post = normalizePost(raw);
        if (post.status !== 'Publishing' || post.leaseExpiresAt || !post.publishStartedAt || new Date(post.publishStartedAt) > cutoff) return post;
        const next = toUncertain(post, 'Publish outcome unknown after restart; inspect channel evidence before any controlled override.', now, uncertainWindowMs, 'legacy_stale_publish_recovered');
        recovered.push(next);
        return next;
      });
      return recovered;
    });
  }

  async markPublished(id: string, attemptId: string, messageId: number, claimToken?: string, now = new Date()): Promise<ChannelPost | undefined> {
    return this.finishAttempt(id, attemptId, claimToken, (post) => appendAudit({
      ...clearClaim(post), status: 'Published', publishedAt: now.toISOString(), publishedMessageId: messageId, observedMessageId: messageId,
      lastError: undefined, failureCategory: undefined, failedAt: undefined, uncertainAt: undefined, uncertainReason: undefined,
      reconciliationStatus: post.status === 'Uncertain' ? 'confirmed_published' : 'not_required', reconciledAt: post.status === 'Uncertain' ? now.toISOString() : post.reconciledAt,
      nextRetryAt: undefined,
    }, { at: now.toISOString(), event: post.status === 'Uncertain' ? 'reconciled_published' : 'published', workerId: post.claimWorkerId, attemptId }));
  }

  async markFailed(id: string, attemptId: string, error: string, category: PublicationFailureCategory = 'telegram_rejection', claimToken?: string, now = new Date()): Promise<ChannelPost | undefined> {
    return this.finishAttempt(id, attemptId, claimToken, (post) => appendAudit({
      ...clearClaim(post), status: 'Failed', lastError: error, failureCategory: category, failedAt: now.toISOString(), reconciliationStatus: 'not_required', nextRetryAt: undefined,
    }, { at: now.toISOString(), event: 'publication_failed_definitive', workerId: post.claimWorkerId, attemptId, reason: category }));
  }

  async markRetryWait(id: string, attemptId: string, error: string, category: PublicationFailureCategory, nextRetryAt: Date, claimToken?: string, now = new Date()): Promise<ChannelPost | undefined> {
    return this.finishAttempt(id, attemptId, claimToken, (post) => appendAudit({
      ...clearClaim(post), status: 'RetryWait', lastError: error, failureCategory: category, failedAt: now.toISOString(), nextRetryAt: nextRetryAt.toISOString(), reconciliationStatus: 'not_required',
    }, { at: now.toISOString(), event: 'publication_retry_scheduled', workerId: post.claimWorkerId, attemptId, reason: category }));
  }

  async markUncertain(id: string, attemptId: string, reason: string, claimToken?: string, observedMessageId?: number, now = new Date(), uncertainWindowMs = DEFAULT_UNCERTAIN_WINDOW_MS): Promise<ChannelPost | undefined> {
    return this.finishAttempt(id, attemptId, claimToken, (post) => toUncertain({ ...post, observedMessageId: observedMessageId ?? post.observedMessageId }, reason, now, uncertainWindowMs, 'publication_outcome_uncertain'));
  }

  async reconcileUncertain(id: string, evidence: ReconciliationEvidence, idempotencyKey?: string): Promise<MutationResult> {
    return this.mutate((db) => {
      const index = db.posts.findIndex((post) => post.id === id);
      if (index < 0) return { ok: false, reason: 'not_found' } as const;
      const current = normalizePost(db.posts[index]);
      if (idempotencyKey && current.actionKeys?.includes(idempotencyKey)) return { ok: true, post: current } as const;
      if (current.status !== 'Uncertain') return { ok: false, reason: 'not_allowed', post: current } as const;
      const now = new Date().toISOString();
      const common = { ...current, actionKeys: appendActionKey(current.actionKeys, idempotencyKey), reconciledAt: now };
      const updated = evidence.outcome === 'published'
        ? appendAudit({ ...clearClaim(common), status: 'Published' as const, publishedAt: now, publishedMessageId: evidence.messageId, observedMessageId: evidence.messageId, reconciliationStatus: 'confirmed_published' as const, lastError: undefined, nextRetryAt: undefined }, { at: now, event: 'human_reconciled_published', actorId: evidence.actorId, reason: evidence.note, attemptId: current.publishAttemptId })
        : appendAudit({ ...clearClaim(common), status: 'RetryWait' as const, reconciliationStatus: 'confirmed_not_published' as const, nextRetryAt: now, lastError: 'Human evidence confirmed no publication; controlled retry is allowed.' }, { at: now, event: 'human_reconciled_not_published', actorId: evidence.actorId, reason: evidence.note, attemptId: current.publishAttemptId });
      db.posts[index] = updated;
      return { ok: true, post: updated } as const;
    });
  }

  async authorizeUncertainOverride(id: string, actorId: number, reason: string, idempotencyKey?: string): Promise<MutationResult> {
    if (reason.trim().length < 8) return { ok: false, reason: 'not_allowed' };
    return this.mutate((db) => {
      const index = db.posts.findIndex((post) => post.id === id);
      if (index < 0) return { ok: false, reason: 'not_found' } as const;
      const current = normalizePost(db.posts[index]);
      if (idempotencyKey && current.actionKeys?.includes(idempotencyKey)) return { ok: true, post: current } as const;
      if (current.status !== 'Uncertain') return { ok: false, reason: 'not_allowed', post: current } as const;
      const now = new Date().toISOString();
      const updated = appendAudit({ ...clearClaim(current), status: 'RetryWait', nextRetryAt: now, actionKeys: appendActionKey(current.actionKeys, idempotencyKey), reconciliationStatus: 'manual_review_required' }, { at: now, event: 'controlled_override_authorized', actorId, reason: reason.trim(), attemptId: current.publishAttemptId });
      db.posts[index] = updated;
      return { ok: true, post: updated } as const;
    });
  }

  async stats(now = new Date()): Promise<Record<ChannelPostStatus | 'due', number>> {
    const posts = await this.all();
    const result = emptyStats();
    for (const post of posts) {
      result[post.status] += 1;
      if ((post.status === 'Scheduled' || post.status === 'RetryWait') && post.scheduledAt && new Date(post.scheduledAt) <= now && (!post.nextRetryAt || new Date(post.nextRetryAt) <= now)) result.due += 1;
    }
    return result;
  }

  private async finishAttempt(id: string, attemptId: string, claimToken: string | undefined, patch: (post: ChannelPost) => ChannelPost): Promise<ChannelPost | undefined> {
    return this.mutate((db) => {
      const index = db.posts.findIndex((post) => post.id === id);
      if (index < 0) return undefined;
      const current = normalizePost(db.posts[index]);
      if (!['Claimed', 'Publishing', 'Uncertain'].includes(current.status) || current.publishAttemptId !== attemptId || (claimToken && current.claimToken !== claimToken)) return undefined;
      const updated = patch(current);
      db.posts[index] = updated;
      return updated;
    });
  }

  private async mutate<T>(operation: (db: ChannelPostDatabase) => T): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const run = async () => {
      try {
        const value = await withFileLock(this.filePath, async () => {
          const db = await this.read();
          const before = JSON.stringify(db);
          const operationResult = operation(db);
          if (JSON.stringify(db) !== before) await this.write(db);
          return operationResult;
        });
        resolveResult(value);
      } catch (error) { rejectResult(error); }
    };
    this.mutationQueue = this.mutationQueue.then(run, run);
    await this.mutationQueue;
    return result;
  }

  private async read(): Promise<ChannelPostDatabase> {
    const parsed = await readJson<ChannelPostDatabase>(this.filePath, { posts: [] });
    return { posts: Array.isArray(parsed.posts) ? parsed.posts.map(normalizePost) : [] };
  }
  private async write(db: ChannelPostDatabase): Promise<void> { await atomicWriteJson(this.filePath, db); }
}

function claim(db: ChannelPostDatabase, index: number, current: ChannelPost, publisherId: number, workerId: string, startedAt: Date, leaseMs: number): Extract<ClaimResult, { ok: true }> {
  const attemptId = randomUUID();
  const claimToken = randomUUID();
  const at = startedAt.toISOString();
  const post = appendAudit({
    ...current, status: 'Claimed' as const, attempts: current.attempts + 1, publishAttemptId: attemptId,
    claimToken, claimWorkerId: workerId, claimStartedAt: at, leaseExpiresAt: new Date(startedAt.getTime() + leaseMs).toISOString(),
    publishedBy: publisherId, publishStartedAt: undefined, sendStartedAt: undefined, requestFingerprint: undefined,
    lastError: undefined, failureCategory: undefined, failedAt: undefined, nextRetryAt: undefined,
  }, { at, event: 'publication_claimed', actorId: publisherId || undefined, workerId, attemptId });
  db.posts[index] = post;
  return { ok: true, post, attemptId, claimToken };
}

function toUncertain(post: ChannelPost, reason: string, now: Date, uncertainWindowMs: number, event: string): ChannelPost {
  const at = now.toISOString();
  const observed = post.observedMessageId ?? post.publishedMessageId;
  return appendAudit({
    ...clearClaim(post), status: 'Uncertain', uncertainAt: at, uncertainReason: reason, lastError: reason,
    failureCategory: 'uncertain', reconciliationStatus: observed ? 'message_id_observed' : 'pending',
    reconciliationDeadlineAt: new Date(now.getTime() + uncertainWindowMs).toISOString(), nextRetryAt: undefined,
  }, { at, event, workerId: post.claimWorkerId, attemptId: post.publishAttemptId, reason: 'remote_outcome_unknown' });
}

function clearClaim<T extends ChannelPost>(post: T): T {
  return { ...post, claimToken: undefined, claimWorkerId: undefined, claimStartedAt: undefined, leaseExpiresAt: undefined };
}

function normalizePost(post: ChannelPost): ChannelPost {
  const status = isChannelPostStatus(post.status) ? post.status : 'Draft';
  return {
    ...post,
    status,
    attempts: Number.isInteger(post.attempts) ? post.attempts : (status === 'Published' || status === 'Failed' ? 1 : 0),
    semanticKey: post.semanticKey ?? `channel-post:${post.id}`,
    reconciliationStatus: post.reconciliationStatus ?? (status === 'Uncertain' ? 'pending' : 'not_required'),
    actionKeys: Array.isArray(post.actionKeys) ? post.actionKeys : [],
    audit: Array.isArray(post.audit) ? post.audit : [],
  };
}

function isChannelPostStatus(value: string): value is ChannelPostStatus {
  return ['Draft', 'PendingApproval', 'Approved', 'Scheduled', 'Claimed', 'Publishing', 'Published', 'Uncertain', 'RetryWait', 'Failed', 'Cancelled'].includes(value);
}

function appendAudit(post: ChannelPost, event: ChannelPostAuditEvent): ChannelPost {
  return { ...post, audit: [...(post.audit ?? []), event].slice(-200) };
}

function appendActionKey(keys: string[] | undefined, key: string | undefined): string[] {
  const next = [...(keys ?? [])];
  if (key && !next.includes(key)) next.push(key);
  return next.slice(-100);
}

function emptyStats(): Record<ChannelPostStatus | 'due', number> {
  return { Draft: 0, PendingApproval: 0, Approved: 0, Scheduled: 0, Claimed: 0, Publishing: 0, Published: 0, Uncertain: 0, RetryWait: 0, Failed: 0, Cancelled: 0, due: 0 };
}

export function channelRequestFingerprint(post: ChannelPost, targetChannel: string, mediaKind: 'text' | 'photo'): string {
  const media = post.photoFileId ? `file:${post.photoFileId}` : post.photoSource ? `${post.photoSource.kind}:${post.photoSource.value}` : 'none';
  return createHash('sha256').update(JSON.stringify({ semanticKey: post.semanticKey ?? `channel-post:${post.id}`, targetChannel, text: post.text, mediaKind, media })).digest('hex');
}
