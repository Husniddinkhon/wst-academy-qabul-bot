import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonChannelPostStore } from '../src/channelPosts.js';
import type { ChannelSender } from '../src/channelPublisher.js';
import { formatTashkentSchedule, parseTashkentSchedule, runChannelSchedulerOnce, startChannelScheduler } from '../src/channelScheduler.js';
import { JsonOperationalAlertStore } from '../src/operationalAlerts.js';
import { UNV_CAMPAIGN_ID } from '../src/productSales.js';

async function fixture(): Promise<{ store: JsonChannelPostStore; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'channel-scheduler-'));
  return { store: new JsonChannelPostStore(path.join(directory, 'posts.json')), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function sender(calls: { texts: number; photos: number }): ChannelSender {
  return {
    async sendMessage() { calls.texts += 1; await new Promise((resolve) => setTimeout(resolve, 15)); return { message_id: 101 }; },
    async sendPhoto() { calls.photos += 1; await new Promise((resolve) => setTimeout(resolve, 15)); return { message_id: 102 }; },
  };
}

test('parses and formats Asia/Tashkent schedule deterministically', () => {
  assert.equal(parseTashkentSchedule('2026-07-15 10:00'), '2026-07-15T05:00:00.000Z');
  assert.equal(formatTashkentSchedule(new Date('2026-07-15T05:00:00.000Z')), '2026-07-15 10:00');
  assert.equal(parseTashkentSchedule('2026-02-31 10:00'), undefined);
  assert.equal(parseTashkentSchedule('15.07.2026 10:00'), undefined);
});

test('two concurrent scheduler ticks claim and publish a due post exactly once', async () => {
  const { store, cleanup } = await fixture();
  try {
    const post = await store.create('Reviewed production channel post content', undefined, 10);
    await store.schedule(post.id, '2026-07-15T05:00:00.000Z', 20);
    const calls = { texts: 0, photos: 0 };
    const results = await Promise.all([
      runChannelSchedulerOnce(store, sender(calls), '-1001', new Date('2026-07-15T05:01:00.000Z')),
      runChannelSchedulerOnce(store, sender(calls), '-1001', new Date('2026-07-15T05:01:00.000Z')),
    ]);
    assert.equal(calls.texts, 1);
    assert.equal(results.reduce((sum, result) => sum + result.published, 0), 1);
    const saved = await store.get(post.id);
    assert.equal(saved?.status, 'Published');
    assert.equal(saved?.attempts, 1);
    assert.equal(saved?.approvedBy, 20);
  } finally { await cleanup(); }
});

test('scheduled photo preserves Telegram file id and uses sendPhoto', async () => {
  const { store, cleanup } = await fixture();
  try {
    const post = await store.create('Reviewed photo caption for the channel', 'telegram-file-id', 10);
    await store.schedule(post.id, '2026-07-15T05:00:00.000Z', 20);
    const calls = { texts: 0, photos: 0 };
    await runChannelSchedulerOnce(store, sender(calls), '-1001', new Date('2026-07-15T05:01:00.000Z'));
    assert.deepEqual(calls, { texts: 0, photos: 1 });
    assert.equal((await store.get(post.id))?.status, 'Published');
  } finally { await cleanup(); }
});

test('restart recovery never automatically retries an unknown publishing outcome', async () => {
  const { store, cleanup } = await fixture();
  try {
    const post = await store.create('Post interrupted during Telegram delivery', undefined, 10);
    await store.schedule(post.id, '2026-07-15T05:00:00.000Z', 20);
    const claim = await store.claimNextDue(new Date('2026-07-15T05:01:00.000Z'));
    assert.equal(claim.ok, true);
    const calls = { texts: 0, photos: 0 };
    const result = await runChannelSchedulerOnce(store, sender(calls), '-1001', new Date('2026-07-15T05:20:00.000Z'), 60_000);
    assert.deepEqual(calls, { texts: 0, photos: 0 });
    assert.equal(result.recovered, 1);
    assert.equal(result.claimed, 0);
    const saved = await store.get(post.id);
    assert.equal(saved?.status, 'Failed');
    assert.match(saved?.lastError ?? '', /inspect the channel before manual retry/);
  } finally { await cleanup(); }
});

test('expired campaign is failed before Telegram send', async () => {
  const { store, cleanup } = await fixture();
  try {
    const post = await store.create('Reviewed campaign post without invented facts', undefined, 10);
    await store.schedule(post.id, '2026-07-21T05:00:00.000Z', 20, UNV_CAMPAIGN_ID);
    const calls = { texts: 0, photos: 0 };
    const result = await runChannelSchedulerOnce(store, sender(calls), '-1001', new Date('2026-07-21T05:01:00.000Z'));
    assert.deepEqual(calls, { texts: 0, photos: 0 });
    assert.equal(result.failed, 1);
    assert.equal((await store.get(post.id))?.status, 'Failed');
    assert.match((await store.get(post.id))?.lastError ?? '', /outside its approved/);
  } finally { await cleanup(); }
});

test('cancelled and unreviewed draft posts are never auto-published', async () => {
  const { store, cleanup } = await fixture();
  try {
    const cancelled = await store.create('Reviewed post later cancelled by admin', undefined, 10);
    await store.schedule(cancelled.id, '2026-07-15T05:00:00.000Z', 20);
    await store.cancel(cancelled.id, 20);
    await store.create('Unreviewed factual claim must remain a draft', undefined, 10);
    const calls = { texts: 0, photos: 0 };
    const result = await runChannelSchedulerOnce(store, sender(calls), '-1001', new Date('2026-07-15T05:01:00.000Z'));
    assert.deepEqual(calls, { texts: 0, photos: 0 });
    assert.equal(result.claimed, 0);
    const stats = await store.stats(new Date('2026-07-15T05:01:00.000Z'));
    assert.equal(stats.Cancelled, 1);
    assert.equal(stats.Draft, 1);
  } finally { await cleanup(); }
});

test('actionable Failed reconciliation still alerts when the scheduler run itself throws', async () => {
  const { store, cleanup } = await fixture();
  const alertDirectory = await mkdtemp(path.join(tmpdir(), 'scheduler-alert-'));
  try {
    const post = await store.create('Reviewed post that failed', undefined, 10);
    await store.schedule(post.id, new Date(Date.now() - 60_000).toISOString(), 20);
    const claim = await store.claimNextDue(new Date());
    if (claim.ok) await store.markFailed(post.id, claim.attemptId, 'raw error excluded');
    const calls: string[] = [];
    const alertSender: ChannelSender = {
      async sendMessage(_chatId, text) { calls.push(text); return { message_id: 99 }; },
      async sendPhoto() { return { message_id: 100 }; },
    };
    const broken = Object.create(store) as JsonChannelPostStore;
    broken.recoverStalePublishing = async () => { throw new Error('scheduler storage error'); };
    const timer = startChannelScheduler(broken, alertSender, '-1001', 60_000, 60_000, undefined, {
      store: new JsonOperationalAlertStore(path.join(alertDirectory, 'alerts.json')),
      adminIds: [1],
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    clearInterval(timer);
    assert.equal(calls.length, 1);
    assert.match(calls[0], new RegExp(post.id));
    assert.doesNotMatch(calls[0], /scheduler storage error|raw error excluded/);
  } finally {
    await cleanup();
    await rm(alertDirectory, { recursive: true, force: true });
  }
});
