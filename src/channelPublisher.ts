import path from 'node:path';
import type { JsonChannelPostStore, ChannelPost } from './channelPosts.js';
import { isUnvPromotionActive, UNV_CAMPAIGN_ID, UNV_PRODUCT } from './productSales.js';

export interface ChannelSender {
  sendMessage(chatId: string, text: string): Promise<{ message_id: number }>;
  sendPhoto(chatId: string, photo: string | { source: string; filename?: string }, extra: { caption: string }): Promise<{ message_id: number }>;
}

export interface ChannelMediaPolicy { assetRoot: string; allowedHttpsHosts: string[] }

export type PublishResult =
  | { ok: true; post: ChannelPost }
  | { ok: false; reason: 'not_found' | 'not_publishable'; post?: ChannelPost }
  | { ok: false; reason: 'campaign_expired'; post: ChannelPost; error: string }
  | { ok: false; reason: 'send_failed'; post: ChannelPost; error: string };

export async function publishChannelPost(store: JsonChannelPostStore, sender: ChannelSender, channelChatId: string, id: string, publisherId: number, retryFailed = false, mediaPolicy = defaultMediaPolicy()): Promise<PublishResult> {
  const claim = await store.claimForPublishing(id, publisherId, retryFailed);
  if (!claim.ok) return claim;
  return publishClaimedChannelPost(store, sender, channelChatId, claim.post, claim.attemptId, new Date(), mediaPolicy);
}

export async function publishClaimedChannelPost(store: JsonChannelPostStore, sender: ChannelSender, channelChatId: string, post: ChannelPost, attemptId: string, now = new Date(), mediaPolicy = defaultMediaPolicy()): Promise<PublishResult> {
  const blocked = campaignExpiryError(post, now);
  if (blocked) {
    const failed = await store.markFailed(post.id, attemptId, blocked);
    if (!failed) throw new Error('Publish state changed before campaign validation completed');
    return { ok: false, reason: 'campaign_expired', post: failed, error: blocked };
  }
  try {
    const photo = resolveChannelPhoto(post, mediaPolicy);
    const sent = photo
      ? await sender.sendPhoto(channelChatId, photo, { caption: post.text })
      : await sender.sendMessage(channelChatId, post.text);
    const published = await store.markPublished(post.id, attemptId, sent.message_id);
    if (!published) throw new Error('Publish state changed before completion');
    return { ok: true, post: published };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await store.markFailed(post.id, attemptId, message);
    if (!failed) throw error;
    return { ok: false, reason: 'send_failed', post: failed, error: message };
  }
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
