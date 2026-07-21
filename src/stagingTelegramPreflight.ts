import { identityFingerprint } from './stagingConfig.js';

const READ_ONLY_METHODS = new Set(['getMe', 'getChat', 'getChatMember']);

interface TelegramUser { id: number; is_bot: boolean; username?: string }
interface TelegramChat { id: number; type: string; username?: string }
interface TelegramMember { status: string; user: TelegramUser; can_post_messages?: boolean; can_edit_messages?: boolean; can_delete_messages?: boolean }
interface TelegramEnvelope<T> { ok: boolean; result?: T; error_code?: number }

export interface StagingTelegramPreflightInput { token: string; channelId: string; adminIds: number[] }
export interface StagingTelegramPreflightReport {
  event: 'staging_readonly_preflight';
  mode: 'STAGING MODE';
  methods: string[];
  bot: { identitySha256: string; usernameSha256: string; valid: true };
  channel: { identitySha256: string; reachable: true; private: true; type: 'channel' };
  admins: { identitySha256: string; count: number; allChannelAdmins: true };
  botPermissions: { status: string; canPostMessages: true; canEditMessages: boolean; canDeleteMessages: boolean };
  mutatingTelegramMethodsCalled: 0;
}

export async function runReadOnlyTelegramPreflight(input: StagingTelegramPreflightInput, fetchImpl: typeof fetch = fetch): Promise<StagingTelegramPreflightReport> {
  const bot = await callTelegram<TelegramUser>(input.token, 'getMe', {}, fetchImpl);
  if (!bot.is_bot || !Number.isSafeInteger(bot.id)) throw new Error('Telegram getMe did not return a valid bot identity.');
  const channel = await callTelegram<TelegramChat>(input.token, 'getChat', { chat_id: input.channelId }, fetchImpl);
  if (channel.type !== 'channel' || String(channel.id) !== input.channelId) throw new Error('Configured staging target is not the expected Telegram channel.');
  if (channel.username) throw new Error('Configured staging channel is public; a private channel is required.');
  const botMembership = await callTelegram<TelegramMember>(input.token, 'getChatMember', { chat_id: input.channelId, user_id: bot.id }, fetchImpl);
  const botCanPost = botMembership.status === 'creator' || (botMembership.status === 'administrator' && botMembership.can_post_messages === true);
  if (!botCanPost) throw new Error('Staging bot lacks permission to post in the private staging channel.');
  const adminMemberships = await Promise.all(input.adminIds.map((adminId) => callTelegram<TelegramMember>(input.token, 'getChatMember', { chat_id: input.channelId, user_id: adminId }, fetchImpl)));
  if (adminMemberships.some((member) => !['administrator', 'creator'].includes(member.status))) throw new Error('At least one configured staging admin lacks channel administration access.');
  return {
    event: 'staging_readonly_preflight', mode: 'STAGING MODE', methods: [...READ_ONLY_METHODS],
    bot: { identitySha256: identityFingerprint(String(bot.id)), usernameSha256: identityFingerprint(bot.username ?? ''), valid: true },
    channel: { identitySha256: identityFingerprint(String(channel.id)), reachable: true, private: true, type: 'channel' },
    admins: { identitySha256: identityFingerprint([...input.adminIds].sort((a, b) => a - b).join(',')), count: input.adminIds.length, allChannelAdmins: true },
    botPermissions: {
      status: botMembership.status,
      canPostMessages: true,
      canEditMessages: botMembership.status === 'creator' || botMembership.can_edit_messages === true,
      canDeleteMessages: botMembership.status === 'creator' || botMembership.can_delete_messages === true,
    },
    mutatingTelegramMethodsCalled: 0,
  };
}

async function callTelegram<T>(token: string, method: string, payload: Record<string, string | number>, fetchImpl: typeof fetch): Promise<T> {
  if (!READ_ONLY_METHODS.has(method)) throw new Error('Non-read-only Telegram method blocked by staging preflight.');
  let response: Response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error(`Telegram ${method} network request failed.`);
  }
  const envelope = await response.json() as TelegramEnvelope<T>;
  if (!response.ok || !envelope.ok || !envelope.result) throw new Error(`Telegram ${method} failed with API code ${envelope.error_code ?? response.status}.`);
  return envelope.result;
}
