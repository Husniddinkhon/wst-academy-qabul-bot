import type { JsonChannelPostStore, ChannelPost } from './channelPosts.js';
import { isUnvPromotionActive, UNV_CAMPAIGN_ID, UNV_PRODUCT } from './productSales.js';

export interface ChannelSender {
  sendMessage(chatId: string, text: string): Promise<{ message_id: number }>;
  sendPhoto(chatId: string, photo: string, extra: { caption: string }): Promise<{ message_id: number }>;
}

export type PublishResult =
  | { ok: true; post: ChannelPost }
  | { ok: false; reason: 'not_found' | 'not_publishable'; post?: ChannelPost }
  | { ok: false; reason: 'campaign_expired'; post: ChannelPost; error: string }
  | { ok: false; reason: 'send_failed'; post: ChannelPost; error: string };

export async function publishChannelPost(store: JsonChannelPostStore, sender: ChannelSender, channelChatId: string, id: string, publisherId: number, retryFailed = false): Promise<PublishResult> {
  const claim = await store.claimForPublishing(id, publisherId, retryFailed);
  if (!claim.ok) return claim;
  return publishClaimedChannelPost(store, sender, channelChatId, claim.post, claim.attemptId);
}

export async function publishClaimedChannelPost(store: JsonChannelPostStore, sender: ChannelSender, channelChatId: string, post: ChannelPost, attemptId: string, now = new Date()): Promise<PublishResult> {
  const blocked = campaignExpiryError(post, now);
  if (blocked) {
    const failed = await store.markFailed(post.id, attemptId, blocked);
    if (!failed) throw new Error('Publish state changed before campaign validation completed');
    return { ok: false, reason: 'campaign_expired', post: failed, error: blocked };
  }
  try {
    const sent = post.photoFileId
      ? await sender.sendPhoto(channelChatId, post.photoFileId, { caption: post.text })
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

export function campaignExpiryError(post: ChannelPost, now = new Date()): string | undefined {
  const text = post.text.toLowerCase();
  const looksLikeKnownPromotion = post.campaignId === UNV_CAMPAIGN_ID || (text.includes(UNV_PRODUCT.model.toLowerCase()) && (text.includes('aksiya') || text.includes('499 000') || text.includes('499000')));
  if (looksLikeKnownPromotion && !isUnvPromotionActive(now)) return `Campaign ${UNV_CAMPAIGN_ID} is outside its approved Asia/Tashkent date range.`;
  return undefined;
}
