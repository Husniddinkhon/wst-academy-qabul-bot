import type { JsonChannelPostStore, ChannelPost } from './channelPosts.js';

export interface ChannelSender {
  sendMessage(chatId: string, text: string): Promise<{ message_id: number }>;
  sendPhoto(chatId: string, photo: string, extra: { caption: string }): Promise<{ message_id: number }>;
}

export type PublishResult =
  | { ok: true; post: ChannelPost }
  | { ok: false; reason: 'not_found' | 'not_publishable'; post?: ChannelPost }
  | { ok: false; reason: 'send_failed'; post: ChannelPost; error: string };

export async function publishChannelPost(store: JsonChannelPostStore, sender: ChannelSender, channelChatId: string, id: string, publisherId: number, retryFailed = false): Promise<PublishResult> {
  const claim = await store.claimForPublishing(id, publisherId, retryFailed);
  if (!claim.ok) return claim;
  try {
    const sent = claim.post.photoFileId
      ? await sender.sendPhoto(channelChatId, claim.post.photoFileId, { caption: claim.post.text })
      : await sender.sendMessage(channelChatId, claim.post.text);
    const published = await store.markPublished(id, claim.attemptId, sent.message_id);
    if (!published) throw new Error('Publish state changed before completion');
    return { ok: true, post: published };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await store.markFailed(id, claim.attemptId, message);
    if (!failed) throw error;
    return { ok: false, reason: 'send_failed', post: failed, error: message };
  }
}
