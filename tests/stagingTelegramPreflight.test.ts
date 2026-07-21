import assert from 'node:assert/strict';
import test from 'node:test';
import { runReadOnlyTelegramPreflight } from '../src/stagingTelegramPreflight.js';

const token = '123456789:abcdefghijklmnopqrstuvwxyzABCDE';
const channelId = '-1009876543210';
const adminId = 123456789;

function telegramResponse(result: unknown): Response {
  return { ok: true, status: 200, async json() { return { ok: true, result }; } } as Response;
}

test('read-only preflight calls only getMe, getChat and getChatMember and emits hashes only', async () => {
  const methods: string[] = [];
  const fakeFetch = (async (url: string | URL | Request) => {
    const method = String(url).split('/').at(-1)!;
    methods.push(method);
    if (method === 'getMe') return telegramResponse({ id: 555000111, is_bot: true, username: 'staging_bot' });
    if (method === 'getChat') return telegramResponse({ id: Number(channelId), type: 'channel' });
    if (methods.length === 3) return telegramResponse({ status: 'administrator', user: { id: 555000111, is_bot: true }, can_post_messages: true, can_edit_messages: true, can_delete_messages: false });
    return telegramResponse({ status: 'creator', user: { id: adminId, is_bot: false } });
  }) as typeof fetch;
  const report = await runReadOnlyTelegramPreflight({ token, channelId, adminIds: [adminId] }, fakeFetch);
  assert.deepEqual(methods, ['getMe', 'getChat', 'getChatMember', 'getChatMember']);
  assert.equal(report.mutatingTelegramMethodsCalled, 0);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes(channelId), false);
  assert.equal(serialized.includes(String(adminId)), false);
  assert.match(report.bot.identitySha256, /^[a-f0-9]{64}$/);
  assert.equal(report.channel.private, true);
  assert.equal(report.botPermissions.canPostMessages, true);
});

test('read-only preflight rejects a public channel or insufficient bot permission', async () => {
  const publicChannelFetch = (async (url: string | URL | Request) => {
    const method = String(url).split('/').at(-1)!;
    if (method === 'getMe') return telegramResponse({ id: 555000111, is_bot: true });
    return telegramResponse({ id: Number(channelId), type: 'channel', username: 'public_channel' });
  }) as typeof fetch;
  await assert.rejects(runReadOnlyTelegramPreflight({ token, channelId, adminIds: [adminId] }, publicChannelFetch), /private channel is required/);

  const noPostFetch = (async (url: string | URL | Request) => {
    const method = String(url).split('/').at(-1)!;
    if (method === 'getMe') return telegramResponse({ id: 555000111, is_bot: true });
    if (method === 'getChat') return telegramResponse({ id: Number(channelId), type: 'channel' });
    return telegramResponse({ status: 'administrator', user: { id: 555000111, is_bot: true }, can_post_messages: false });
  }) as typeof fetch;
  await assert.rejects(runReadOnlyTelegramPreflight({ token, channelId, adminIds: [adminId] }, noPostFetch), /lacks permission to post/);
});
