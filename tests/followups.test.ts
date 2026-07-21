import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Telegraf } from 'telegraf';
import { FollowUpRuntime, processFollowUps } from '../src/followups.js';
import { JsonFollowUpStore, JsonLeadStore } from '../src/storage.js';
import type { BotContext } from '../src/types.js';

const NOW = new Date('2026-07-21T10:00:00.000Z');
const CONSENTED = { canSendNonEssential: async () => true } as const;

async function fixture(): Promise<{ followUps: JsonFollowUpStore; leads: JsonLeadStore; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'followup-claims-'));
  return {
    followUps: new JsonFollowUpStore(path.join(directory, 'followups.json')),
    leads: new JsonLeadStore(path.join(directory, 'leads.json')),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function bot(sendMessage: (chatId: number, text: string) => Promise<{ message_id: number }>): Telegraf<BotContext> {
  return { telegram: { sendMessage } } as unknown as Telegraf<BotContext>;
}

async function dueState(store: JsonFollowUpStore, telegramId = 1001): Promise<void> {
  await store.upsert({ telegramId, startedAt: '2026-07-21T07:00:00.000Z', count: 0 });
}

test('follow-up delivery fails closed when no consent resolver is installed', async () => {
  const { followUps, leads, cleanup } = await fixture();
  try {
    await dueState(followUps);
    let sends = 0;
    const result = await processFollowUps(bot(async () => { sends += 1; return { message_id: 1 }; }), leads, followUps, { now: NOW });
    assert.equal(sends, 0);
    assert.equal(result.sent, 0);
    assert.equal((await followUps.all())[0].deliveryState, 'Cancelled');
  } finally { await cleanup(); }
});

test('two concurrent follow-up workers claim and deliver one recipient exactly once', async () => {
  const { followUps, leads, cleanup } = await fixture();
  try {
    await dueState(followUps);
    let sends = 0;
    const sender = bot(async () => { sends += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return { message_id: 1 }; });
    const [left, right] = await Promise.all([
      processFollowUps(sender, leads, followUps, { ...CONSENTED, now: NOW, workerId: 'worker-a' }),
      processFollowUps(sender, leads, followUps, { ...CONSENTED, now: NOW, workerId: 'worker-b' }),
    ]);
    assert.equal(sends, 1);
    assert.equal(left.sent + right.sent, 1);
    const saved = (await followUps.all())[0];
    assert.equal(saved.deliveryState, 'Sent');
    assert.equal(saved.count, 1);
    assert.match(saved.followUpId ?? '', /^followup:1001:1:registration_incomplete$/);
    assert.equal(saved.timeZone, 'Asia/Tashkent');
  } finally { await cleanup(); }
});

test('restart recovery after send start fails closed and never duplicates the message', async () => {
  const { followUps, leads, cleanup } = await fixture();
  try {
    await dueState(followUps);
    const request = { telegramId: 1001, followUpId: 'followup:1001:1:registration_incomplete', task: 'registration_incomplete' as const, dueAt: '2026-07-21T09:00:00.000Z', timeZone: 'Asia/Tashkent' as const };
    const claimed = await followUps.claimDelivery(request, { workerId: 'crashed', leaseMs: 1_000, maxAttempts: 3, now: NOW });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    await followUps.markDeliverySending(claimed.claim, NOW);
    const recovered = await followUps.recoverExpiredDeliveryClaims(new Date(NOW.getTime() + 1_001));
    assert.equal(recovered[0]?.deliveryState, 'Uncertain');
    let sends = 0;
    await processFollowUps(bot(async () => { sends += 1; return { message_id: 2 }; }), leads, followUps, { ...CONSENTED, now: new Date(NOW.getTime() + 2_000) });
    assert.equal(sends, 0);
  } finally { await cleanup(); }
});

test('definite rate limit retries with bounded backoff and then reaches the attempt ceiling', async () => {
  const { followUps, leads, cleanup } = await fixture();
  try {
    await dueState(followUps);
    const sender = bot(async () => { throw Object.assign(new Error('Too Many Requests'), { response: { error_code: 429, parameters: { retry_after: 1 } } }); });
    const first = await processFollowUps(sender, leads, followUps, { ...CONSENTED, now: NOW, maxAttempts: 2, retryBaseMs: 1_000, retryMaxMs: 1_000 });
    assert.equal(first.retryWait, 1);
    assert.equal((await followUps.all())[0].deliveryState, 'RetryWait');
    const second = await processFollowUps(sender, leads, followUps, { ...CONSENTED, now: new Date(NOW.getTime() + 1_001), maxAttempts: 2, retryBaseMs: 1_000, retryMaxMs: 1_000 });
    assert.equal(second.failed, 1);
    const saved = (await followUps.all())[0];
    assert.equal(saved.deliveryState, 'Failed');
    assert.equal(saved.attempts, 2);
    assert.ok(saved.audit?.some((event) => event.event === 'delivery_retry_exhausted'));
  } finally { await cleanup(); }
});

test('permanent Telegram rejection is terminal while an ambiguous transport failure is Uncertain', async () => {
  const first = await fixture();
  try {
    await dueState(first.followUps, 2001);
    const rejected = bot(async () => { throw Object.assign(new Error('Forbidden'), { response: { error_code: 403 } }); });
    const result = await processFollowUps(rejected, first.leads, first.followUps, { ...CONSENTED, now: NOW });
    assert.equal(result.failed, 1);
    assert.equal((await first.followUps.all())[0].deliveryState, 'Failed');
  } finally { await first.cleanup(); }

  const second = await fixture();
  try {
    await dueState(second.followUps, 2002);
    const ambiguous = bot(async () => { throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); });
    const result = await processFollowUps(ambiguous, second.leads, second.followUps, { ...CONSENTED, now: NOW });
    assert.equal(result.uncertain, 1);
    assert.equal((await second.followUps.all())[0].deliveryState, 'Uncertain');
  } finally { await second.cleanup(); }
});

test('registration completion cancels a pre-send claim and invalidates its token', async () => {
  const { followUps, cleanup } = await fixture();
  try {
    await dueState(followUps);
    const claimed = await followUps.claimDelivery({ telegramId: 1001, followUpId: 'followup:1001:1:registration_incomplete', task: 'registration_incomplete', dueAt: '2026-07-21T09:00:00.000Z', timeZone: 'Asia/Tashkent' }, { workerId: 'worker', leaseMs: 60_000, maxAttempts: 3, now: NOW });
    assert.equal(claimed.ok, true);
    await followUps.upsert({ telegramId: 1001, startedAt: '2026-07-21T07:00:00.000Z', count: 0, registrationCompleted: true });
    const saved = (await followUps.all())[0];
    assert.equal(saved.deliveryState, 'Cancelled');
    assert.equal(saved.claimToken, undefined);
    if (claimed.ok) assert.equal(await followUps.markDeliverySending(claimed.claim, NOW), undefined);
  } finally { await cleanup(); }
});

test('follow-up shutdown drain marks an unfinished send Uncertain', async () => {
  const { followUps, leads, cleanup } = await fixture();
  try {
    await dueState(followUps);
    const runtime = new FollowUpRuntime();
    let started!: () => void;
    let release!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const running = processFollowUps(bot(async () => { started(); await blocked; return { message_id: 9 }; }), leads, followUps, { ...CONSENTED, now: NOW, runtime });
    await startedPromise;
    const drain = await runtime.drain(5, NOW);
    assert.equal(drain.timedOut, true);
    assert.equal((await followUps.all())[0].deliveryState, 'Uncertain');
    release();
    await running;
    assert.equal((await followUps.all())[0].count, 0);
  } finally { await cleanup(); }
});
