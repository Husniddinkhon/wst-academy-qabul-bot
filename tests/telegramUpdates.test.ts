import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Telegram } from 'telegraf';
import { JsonChannelPostStore } from '../src/channelPosts.js';
import { JsonFollowUpStore, JsonLeadStore } from '../src/storage.js';
import {
  createTelegramUpdateMiddleware,
  JsonTelegramSessionStore,
  startTelegramUpdateRecovery,
  TelegramUpdateJournal,
  withTelegramCallLabel,
} from '../src/telegramUpdates.js';
import type { BotContext, Lead } from '../src/types.js';

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'telegram-updates-'));
  return {
    directory,
    journalFile: path.join(directory, 'updates.json'),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function context(update: Record<string, unknown>, telegram?: Telegram): BotContext {
  return {
    update,
    telegram: telegram ?? { async callApi() { return true; } } as unknown as Telegram,
  } as unknown as BotContext;
}

async function sendPrimary(telegram: Telegram, payload: unknown): Promise<unknown> { return await telegram.callApi('sendMessage', payload as never); }
async function answerCallback(telegram: Telegram, payload: unknown): Promise<unknown> { return await telegram.callApi('answerCallbackQuery', payload as never); }
async function sendExport(telegram: Telegram, payload: unknown): Promise<unknown> { return await telegram.callApi('sendDocument', payload as never); }

function messageUpdate(updateId: number, text = '/start'): Record<string, unknown> {
  return { update_id: updateId, message: { message_id: updateId, date: 1_785_000_000, chat: { id: 7, type: 'private' }, from: { id: 7 }, text } };
}

function callbackUpdate(updateId: number): Record<string, unknown> {
  return { update_id: updateId, callback_query: { id: `callback-${updateId}`, from: { id: 7 }, data: 'academy_register', message: { message_id: 4, date: 1_785_000_000, chat: { id: 7, type: 'private' } } } };
}

function lead(lastMessage: string): Lead {
  return {
    id: `lead-${lastMessage}`,
    createdAt: '2026-07-21T10:00:00.000Z',
    updatedAt: '2026-07-21T10:00:00.000Z',
    telegramId: 7,
    fullName: 'Applicant',
    phone: '+998901234567',
    city: 'Tashkent',
    age: '25',
    workStatus: '',
    experience: 'beginner',
    goal: 'course',
    paymentOption: '',
    status: 'RegistrationCompleted',
    source: 'registration',
    intent: 'registration',
    lastMessage,
    messages: [{ text: lastMessage, createdAt: '2026-07-21T10:00:00.000Z' }],
    operatorNote: '',
    nextFollowUp: '',
    paymentStatus: '',
    preferredTime: 'morning',
  };
}

test('same update replay is rejected after durable completion', async () => {
  const f = await fixture();
  try {
    const middleware = createTelegramUpdateMiddleware(new TelegramUpdateJournal(f.journalFile));
    let handled = 0;
    const update = messageUpdate(100);
    await middleware(context(update), async () => { handled += 1; });
    await middleware(context(update), async () => { handled += 1; });
    assert.equal(handled, 1);
  } finally { await f.cleanup(); }
});

test('exact replay retention rejects recent IDs without assuming Telegram IDs are monotonic forever', async () => {
  const f = await fixture();
  try {
    let now = new Date('2026-07-21T10:00:00.000Z');
    const journal = new TelegramUpdateJournal(f.journalFile, { maxCompletedUpdates: 2, terminalRetentionMs: 100, now: () => now });
    const middleware = createTelegramUpdateMiddleware(journal);
    for (const updateId of [90, 91]) await middleware(context(messageUpdate(updateId)), async () => undefined);
    let replayed = false;
    await middleware(context(messageUpdate(90)), async () => { replayed = true; });
    assert.equal(replayed, false);
    now = new Date('2026-07-21T10:00:00.101Z');
    let lowerIdHandled = false;
    await middleware(context(messageUpdate(12, 'new random update id')), async () => { lowerIdHandled = true; });
    assert.equal(lowerIdHandled, true);
    assert.equal((await journal.snapshot()).updates.some((item) => item.updateId === 90), false);
  } finally { await f.cleanup(); }
});

test('concurrent delivery of the same update has one owner and one handler', async () => {
  const f = await fixture();
  try {
    const middleware = createTelegramUpdateMiddleware(new TelegramUpdateJournal(f.journalFile));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let handled = 0;
    const update = messageUpdate(101);
    const first = middleware(context(update), async () => { handled += 1; await gate; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await middleware(context(update), async () => { handled += 1; });
    release();
    await first;
    assert.equal(handled, 1);
  } finally { await f.cleanup(); }
});

test('dead process ownership is deterministically resumed by a restarted journal', async () => {
  const f = await fixture();
  try {
    let now = new Date('2026-07-21T10:00:00.000Z');
    const update = messageUpdate(102);
    const first = new TelegramUpdateJournal(f.journalFile, { leaseMs: 100, now: () => now, instanceId: 'process-one', tokenFactory: () => 'first' });
    assert.deepEqual(await first.claim(102, 'fingerprint', update), { status: 'claimed', token: 'first' });
    const restarted = new TelegramUpdateJournal(f.journalFile, { leaseMs: 100, now: () => now, instanceId: 'process-two', tokenFactory: () => 'second' });
    assert.deepEqual(await restarted.claim(102, 'fingerprint'), { status: 'claimed', token: 'second' });
    await restarted.complete(102, 'second');
    assert.deepEqual(await first.claim(102, 'fingerprint'), { status: 'duplicate' });
  } finally { await f.cleanup(); }
});

test('a live owner is never stolen merely because its lease timestamp elapsed', async () => {
  const f = await fixture();
  try {
    let now = new Date('2026-07-21T10:00:00.000Z');
    const owner = new TelegramUpdateJournal(f.journalFile, { leaseMs: 10, now: () => now, instanceId: 'live-owner', tokenFactory: () => 'owner-token' });
    assert.deepEqual(await owner.claim(120, 'fingerprint', messageUpdate(120)), { status: 'claimed', token: 'owner-token' });
    now = new Date('2026-07-21T10:00:01.000Z');
    const contender = new TelegramUpdateJournal(f.journalFile, { leaseMs: 10, now: () => now, instanceId: 'live-owner', tokenFactory: () => 'contender-token' });
    assert.deepEqual(await contender.claim(120, 'fingerprint'), { status: 'busy' });
  } finally { await f.cleanup(); }
});

test('restart preserves queued same-session order before admitting a newer update', async () => {
  const f = await fixture();
  try {
    let now = new Date('2026-07-21T10:00:00.000Z');
    const oldProcess = new TelegramUpdateJournal(f.journalFile, { now: () => now, instanceId: 'old-process', tokenFactory: () => 'old-token' });
    const first = messageUpdate(127, 'older update');
    const second = messageUpdate(128, 'queued update');
    const third = messageUpdate(129, 'newer update');
    assert.deepEqual(await oldProcess.claim(127, 'first', first, '7:7'), { status: 'claimed', token: 'old-token' });
    assert.deepEqual(await oldProcess.claim(128, 'second', second, '7:7'), { status: 'busy' });
    await oldProcess.complete(127, 'old-token');

    now = new Date('2026-07-21T10:00:00.500Z');
    const restarted = new TelegramUpdateJournal(f.journalFile, { now: () => now, instanceId: 'new-process', tokenFactory: () => `token-${now.getTime()}` });
    assert.deepEqual(await restarted.claim(129, 'third', third, '7:7'), { status: 'busy' });
    now = new Date('2026-07-21T10:00:01.001Z');
    const secondClaim = await restarted.claim(128, 'second', second, '7:7');
    assert.equal(secondClaim.status, 'claimed');
    if (secondClaim.status === 'claimed') await restarted.complete(128, secondClaim.token);
    assert.deepEqual(await restarted.claim(129, 'third', third, '7:7'), { status: 'busy' });
    now = new Date('2026-07-21T10:00:01.501Z');
    const thirdClaim = await restarted.claim(129, 'third', third, '7:7');
    assert.equal(thirdClaim.status, 'claimed');
  } finally { await f.cleanup(); }
});

test('restart skips completed effects and continues after partial side-effect completion', async () => {
  const f = await fixture();
  try {
    const calls: string[] = [];
    const telegram = {
      async callApi(method: string) { calls.push(method); return { message_id: calls.length, text: 'must-not-enter-journal' }; },
    } as unknown as Telegram;
    let now = new Date('2026-07-21T10:00:00.000Z');
    const retryJournal = new TelegramUpdateJournal(f.journalFile, { now: () => now });
    const retryMiddleware = createTelegramUpdateMiddleware(retryJournal);
    const update = messageUpdate(103, 'partial');
    await assert.rejects(retryMiddleware(context(update, telegram), async () => {
      await sendPrimary(telegram, { chat_id: 7 });
      throw new Error('simulated process stop after first completed effect');
    }) as Promise<unknown>, /simulated process stop/);

    now = new Date('2026-07-21T10:00:01.001Z');
    await retryMiddleware(context(update, telegram), async () => {
      const restored = await sendPrimary(telegram, { chat_id: 7 });
      assert.deepEqual(restored, { message_id: 1 });
      await answerCallback(telegram, { callback_query_id: 'callback-103' });
    });
    assert.deepEqual(calls, ['sendMessage', 'answerCallbackQuery']);
    assert.doesNotMatch(JSON.stringify(await retryJournal.snapshot()), /must-not-enter-journal/);
  } finally { await f.cleanup(); }
});

test('explicit semantic Telegram labels stay correct when retry control flow changes in one route', async () => {
  const f = await fixture();
  try {
    let now = new Date('2026-07-21T10:00:00.000Z');
    const middleware = createTelegramUpdateMiddleware(new TelegramUpdateJournal(f.journalFile, { now: () => now }));
    const calls: Array<{ method: string; payload: unknown }> = [];
    const telegram = { async callApi(method: string, payload: unknown) { calls.push({ method, payload }); return { message_id: calls.length }; } } as unknown as Telegram;
    const update = messageUpdate(111, 'shifted branch');
    await assert.rejects(middleware(context(update, telegram), async () => {
      await withTelegramCallLabel('validation-reply', () => sendPrimary(telegram, { chat_id: 7, text: 'validation reply' }));
      throw new Error('retry after completed admin notification');
    }) as Promise<unknown>, /retry after completed/);
    now = new Date('2026-07-21T10:00:01.001Z');
    const result: unknown[] = [];
    await middleware(context(update, telegram), async () => { result.push(await withTelegramCallLabel('success-reply', () => sendPrimary(telegram, { chat_id: 7, text: 'success reply' }))); });
    assert.deepEqual(calls.map((item) => item.payload), [{ chat_id: 7, text: 'validation reply' }, { chat_id: 7, text: 'success reply' }]);
    assert.deepEqual(result, [{ message_id: 2 }]);
  } finally { await f.cleanup(); }
});

test('Telegram retry key remains stable when regenerated content changes for the same target', async () => {
  const f = await fixture();
  try {
    let now = new Date('2026-07-21T10:00:00.000Z');
    const middleware = createTelegramUpdateMiddleware(new TelegramUpdateJournal(f.journalFile, { now: () => now }));
    const payloads: unknown[] = [];
    const telegram = { async callApi(_method: string, payload: unknown) { payloads.push(payload); return { message_id: 44 }; } } as unknown as Telegram;
    const update = messageUpdate(112, 'volatile content');
    await assert.rejects(middleware(context(update, telegram), async () => {
      await sendExport(telegram, { chat_id: 7, document: 'day-one.csv' });
      throw new Error('retry after generated export');
    }) as Promise<unknown>, /retry after generated export/);
    now = new Date('2026-07-21T10:00:01.001Z');
    let replayResult: unknown;
    await middleware(context(update, telegram), async () => { replayResult = await sendExport(telegram, { chat_id: 7, document: 'day-two.csv' }); });
    assert.deepEqual(payloads, [{ chat_id: 7, document: 'day-one.csv' }]);
    assert.deepEqual(replayResult, { message_id: 44 });
  } finally { await f.cleanup(); }
});

test('duplicate callback query does not repeat callback answer or reply', async () => {
  const f = await fixture();
  try {
    const middleware = createTelegramUpdateMiddleware(new TelegramUpdateJournal(f.journalFile));
    const calls: string[] = [];
    const telegram = { async callApi(method: string) { calls.push(method); return { ok: true }; } } as unknown as Telegram;
    const update = callbackUpdate(104);
    const handler = async () => { await answerCallback(telegram, { callback_query_id: 'callback-104' }); await sendPrimary(telegram, { chat_id: 7 }); };
    await middleware(context(update, telegram), handler);
    await middleware(context(update, telegram), handler);
    assert.deepEqual(calls, ['answerCallbackQuery', 'sendMessage']);
  } finally { await f.cleanup(); }
});

test('interrupted outbound action becomes durable uncertain state and is never replayed', async () => {
  const f = await fixture();
  try {
    const journal = new TelegramUpdateJournal(f.journalFile);
    const middleware = createTelegramUpdateMiddleware(journal);
    let calls = 0;
    const telegram = { async callApi() { calls += 1; throw new Error('connection ended with unknown send outcome'); } } as unknown as Telegram;
    const update = messageUpdate(107, 'uncertain');
    await assert.rejects(middleware(context(update, telegram), async () => { await sendPrimary(telegram, { chat_id: 7 }); }) as Promise<unknown>, /outcome is uncertain/);
    let replayed = false;
    await middleware(context(update, telegram), async () => { replayed = true; });
    assert.equal(calls, 1);
    assert.equal(replayed, false);
    assert.equal((await journal.snapshot()).updates[0].state, 'uncertain');
  } finally { await f.cleanup(); }
});

test('caught outbound uncertainty still makes the durable update terminal-uncertain', async () => {
  const f = await fixture();
  try {
    const journal = new TelegramUpdateJournal(f.journalFile);
    const middleware = createTelegramUpdateMiddleware(journal);
    const telegram = { async callApi() { throw new Error('unknown outbound result'); } } as unknown as Telegram;
    await middleware(context(messageUpdate(108, 'caught uncertainty'), telegram), async () => {
      try { await sendPrimary(telegram, { chat_id: 7 }); } catch { /* application contained the error */ }
    });
    assert.equal((await journal.snapshot()).updates[0].state, 'uncertain');
  } finally { await f.cleanup(); }
});

test('duplicate channel draft request reuses one durable publication request', async () => {
  const f = await fixture();
  try {
    const postFile = path.join(f.directory, 'posts.json');
    const store = new JsonChannelPostStore(postFile);
    const key = 'telegram-update:105:channel:text-draft';
    const [first, replay] = await Promise.all([
      new JsonChannelPostStore(postFile).create('A valid admin-created channel draft', undefined, 99, key),
      store.create('A valid admin-created channel draft', undefined, 99, key),
    ]);
    assert.equal(first.id, replay.id);
    assert.equal((await store.all()).length, 1);
  } finally { await f.cleanup(); }
});

test('duplicate admin command applies one lead transition', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.directory, 'admin-leads.json');
    const store = new JsonLeadStore(file);
    await store.upsert({ ...lead('initial'), status: 'New' });
    const key = 'telegram-update:109:admin:set-status';
    const first = await store.updateByTelegramId(7, { status: 'OperatorContacted' }, key);
    const replay = await new JsonLeadStore(file).updateByTelegramId(7, { status: 'Rejected', operatorNote: 'duplicate must not apply' }, key);
    assert.deepEqual(replay, first);
    assert.equal((await store.getByTelegramId(7))?.status, 'OperatorContacted');
    assert.equal((await store.getByTelegramId(7))?.operatorNote, '');
  } finally { await f.cleanup(); }
});

test('duplicate follow-up scheduling write is ignored after restart', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.directory, 'followups.json');
    const key = 'telegram-update:110:followup:registration-start';
    await new JsonFollowUpStore(file).upsert({ telegramId: 7, startedAt: '2026-07-21T10:00:00.000Z', count: 0 }, key);
    await new JsonFollowUpStore(file).upsert({ telegramId: 7, startedAt: '2026-07-22T10:00:00.000Z', count: 99 }, key);
    assert.deepEqual(await new JsonFollowUpStore(file).all(), [{ telegramId: 7, startedAt: '2026-07-21T10:00:00.000Z', count: 0 }]);
  } finally { await f.cleanup(); }
});

test('duplicate applicant submission creates and transitions one lead once', async () => {
  const f = await fixture();
  try {
    const leadFile = path.join(f.directory, 'leads.json');
    const store = new JsonLeadStore(leadFile);
    const key = 'telegram-update:106:applicant:registration-complete';
    const first = await store.upsert(lead('submitted'), key);
    const replay = await new JsonLeadStore(leadFile).upsert(lead('replayed submission'), key);
    assert.equal(first.created, true);
    assert.deepEqual(replay, first);
    const all = await store.all();
    assert.equal(all.length, 1);
    assert.equal(all[0].messages.length, 1);
    assert.equal(all[0].lastMessage, 'submitted');
  } finally { await f.cleanup(); }
});

test('durable Telegram session survives a store restart', async () => {
  const f = await fixture();
  try {
    const journal = new TelegramUpdateJournal(f.journalFile);
    await new JsonTelegramSessionStore(journal).set('7:7', { source: 'registration', leadDraft: { fullName: 'Applicant' } });
    assert.deepEqual(await new JsonTelegramSessionStore(new TelegramUpdateJournal(f.journalFile)).get('7:7'), { source: 'registration', leadDraft: { fullName: 'Applicant' } });
  } finally { await f.cleanup(); }
});

test('inactive Telegram session data expires after the bounded retention period', async () => {
  const f = await fixture();
  try {
    let now = new Date('2026-07-21T10:00:00.000Z');
    const journal = new TelegramUpdateJournal(f.journalFile, { now: () => now });
    const store = new JsonTelegramSessionStore(journal);
    await store.set('7:7', { source: 'registration', leadDraft: { fullName: 'Applicant' } });
    now = new Date('2026-08-21T10:00:00.001Z');
    assert.equal(await store.get('7:7'), undefined);
    const claim = await journal.claim(123, 'session-prune', messageUpdate(123));
    assert.equal(claim.status, 'claimed');
    if (claim.status === 'claimed') await journal.complete(123, claim.token);
    assert.equal((await journal.snapshot()).sessions['7:7'], undefined);
  } finally { await f.cleanup(); }
});

test('session mutation and update completion share one atomic journal generation', async () => {
  const f = await fixture();
  try {
    let now = new Date('2026-07-21T10:00:00.000Z');
    const journal = new TelegramUpdateJournal(f.journalFile, { now: () => now });
    const store = new JsonTelegramSessionStore(journal);
    const middleware = createTelegramUpdateMiddleware(journal);
    await store.set('7:7', { source: 'registration', leadDraft: { fullName: 'Before' } });
    const update = messageUpdate(121, 'session crash');
    await assert.rejects(middleware(context(update), async () => {
      await store.set('7:7', { source: 'registration', leadDraft: { fullName: 'Uncommitted' } });
      throw new Error('crash before terminal commit');
    }) as Promise<unknown>, /crash before terminal commit/);
    assert.equal((await store.get('7:7'))?.leadDraft?.fullName, 'Before');
    assert.equal((await journal.recoverableUpdates()).length, 0);
    now = new Date('2026-07-21T10:00:01.001Z');
    assert.equal((await journal.recoverableUpdates()).length, 1);
    await middleware(context(update), async () => {
      assert.equal((await store.get('7:7'))?.leadDraft?.fullName, 'Before');
      await store.set('7:7', { source: 'registration', leadDraft: { fullName: 'Committed' } });
    });
    const snapshot = await journal.snapshot();
    assert.equal(snapshot.sessions['7:7'].leadDraft?.fullName, 'Committed');
    assert.equal(snapshot.updates[0].state, 'completed');
  } finally { await f.cleanup(); }
});

test('different concurrent updates for one session are durably serialized before session read', async () => {
  const f = await fixture();
  try {
    let now = new Date('2026-07-21T10:00:00.000Z');
    const journal = new TelegramUpdateJournal(f.journalFile, { now: () => now });
    const middleware = createTelegramUpdateMiddleware(journal);
    const store = new JsonTelegramSessionStore(journal);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstUpdate = messageUpdate(124, 'first session update');
    const secondUpdate = messageUpdate(125, 'second session update');
    const first = middleware(context(firstUpdate), async () => {
      await store.set('7:7', { source: 'registration', leadDraft: { fullName: 'First' } });
      await firstGate;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    let secondHandled = false;
    await middleware(context(secondUpdate), async () => {
      secondHandled = true;
      await store.set('7:7', { source: 'registration', leadDraft: { fullName: 'Leaked' } });
    });
    assert.equal(secondHandled, false);
    assert.equal((await journal.snapshot()).sessions['7:7'], undefined);
    releaseFirst();
    await first;
    assert.equal((await store.get('7:7'))?.leadDraft?.fullName, 'First');

    let thirdHandled = false;
    await middleware(context(messageUpdate(126, 'third session update')), async () => { thirdHandled = true; });
    assert.equal(thirdHandled, false, 'a newer update must not overtake the reserved queued update');

    now = new Date('2026-07-21T10:00:01.001Z');
    await assert.rejects(middleware(context(secondUpdate), async () => {
      assert.equal((await store.get('7:7'))?.leadDraft?.fullName, 'First');
      await store.set('7:7', { source: 'registration', leadDraft: { fullName: 'Uncommitted second' } });
      throw new Error('second update crashes');
    }) as Promise<unknown>, /second update crashes/);
    assert.equal((await store.get('7:7'))?.leadDraft?.fullName, 'First');
    now = new Date('2026-07-21T10:00:03.002Z');
    await middleware(context(secondUpdate), async () => {
      await store.set('7:7', { source: 'registration', leadDraft: { fullName: 'Second committed' } });
    });
    assert.equal((await store.get('7:7'))?.leadDraft?.fullName, 'Second committed');
    now = new Date('2026-07-21T10:00:04.003Z');
    await middleware(context(messageUpdate(126, 'third session update')), async () => {
      assert.equal((await store.get('7:7'))?.leadDraft?.fullName, 'Second committed');
      thirdHandled = true;
    });
    assert.equal(thirdHandled, true);
  } finally { await f.cleanup(); }
});

test('recovery worker resumes a persisted retryable raw update after restart', async () => {
  const f = await fixture();
  let timer: NodeJS.Timeout | undefined;
  try {
    let now = new Date('2026-07-21T10:00:00.000Z');
    const firstJournal = new TelegramUpdateJournal(f.journalFile, { now: () => now, instanceId: 'first-process' });
    const update = messageUpdate(122, 'recover me');
    await assert.rejects(createTelegramUpdateMiddleware(firstJournal)(context(update), async () => { throw new Error('process exits'); }) as Promise<unknown>, /process exits/);
    now = new Date('2026-07-21T10:00:01.001Z');
    const restartedJournal = new TelegramUpdateJournal(f.journalFile, { now: () => now, instanceId: 'second-process' });
    let handled = 0;
    let recovered!: () => void;
    const recoveredUpdate = new Promise<void>((resolve) => { recovered = resolve; });
    const middleware = createTelegramUpdateMiddleware(restartedJournal);
    const bot = { async handleUpdate(raw: never) { await middleware(context(raw as Record<string, unknown>), async () => { handled += 1; }); recovered(); } };
    timer = startTelegramUpdateRecovery(bot, restartedJournal, 1_000);
    await Promise.race([recoveredUpdate, new Promise((_, reject) => setTimeout(() => reject(new Error('recovery timeout')), 5_000))]);
    assert.equal(handled, 1);
    assert.equal((await restartedJournal.snapshot()).updates[0].state, 'completed');
  } finally {
    if (timer) clearInterval(timer);
    await f.cleanup();
  }
});
