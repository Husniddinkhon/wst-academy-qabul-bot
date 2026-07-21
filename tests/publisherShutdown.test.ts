import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonChannelPostStore } from '../src/channelPosts.js';
import { publishChannelPost, PublisherRuntime, type ChannelSender } from '../src/channelPublisher.js';
import { runChannelSchedulerOnce } from '../src/channelScheduler.js';

async function fixture(): Promise<{ store: JsonChannelPostStore; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'publisher-shutdown-'));
  return { store: new JsonChannelPostStore(path.join(directory, 'posts.json')), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('graceful publisher shutdown with no active work drains immediately', async () => {
  const runtime = new PublisherRuntime();
  const result = await runtime.drain(100);
  assert.equal(result.drained, true);
  assert.equal(result.timedOut, false);
  assert.equal(runtime.isAccepting, false);
});

test('drain timeout before send starts releases the owned claim as retry-safe', async () => {
  const { store, cleanup } = await fixture();
  try {
    const post = await store.create('Shutdown while publication is claimed', undefined, 10);
    const claim = await store.claimForPublishing(post.id, 20, false, undefined, { workerId: 'worker-a', leaseMs: 60_000 });
    assert.equal(claim.ok, true);
    if (!claim.ok) return;
    const runtime = new PublisherRuntime();
    const key = runtime.begin({ store, postId: post.id, attemptId: claim.attemptId, claimToken: claim.claimToken });
    const result = await runtime.drain(5);
    assert.equal(result.timedOut, true);
    assert.equal((await store.get(post.id))?.status, 'RetryWait');
    runtime.finish(key);
  } finally { await cleanup(); }
});

test('drain timeout during Telegram send fails closed as Uncertain', async () => {
  const { store, cleanup } = await fixture();
  try {
    const post = await store.create('Shutdown during Telegram send', undefined, 10);
    const runtime = new PublisherRuntime();
    let release!: () => void;
    let started!: () => void;
    const sendStarted = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const sender: ChannelSender = {
      async sendMessage() { started(); await blocked; return { message_id: 700 }; },
      async sendPhoto() { throw new Error('unexpected photo'); },
    };
    const publishing = publishChannelPost(store, sender, '-1001', post.id, 20, false, undefined, undefined, { runtime, claimLeaseMs: 60_000, uncertainWindowMs: 3_600_000 });
    await sendStarted;
    const result = await runtime.drain(5);
    assert.equal(result.timedOut, true);
    assert.equal(result.activeAtTimeout, 1);
    assert.equal((await store.get(post.id))?.status, 'Uncertain');
    release();
    await assert.rejects(publishing);
  } finally { await cleanup(); }
});

test('active send that finishes inside the drain bound is durably Published', async () => {
  const { store, cleanup } = await fixture();
  try {
    const post = await store.create('Bounded graceful completion', undefined, 10);
    const runtime = new PublisherRuntime();
    let started!: () => void;
    const sendStarted = new Promise<void>((resolve) => { started = resolve; });
    const sender: ChannelSender = {
      async sendMessage() { started(); await new Promise((resolve) => setTimeout(resolve, 10)); return { message_id: 701 }; },
      async sendPhoto() { throw new Error('unexpected photo'); },
    };
    const publishing = publishChannelPost(store, sender, '-1001', post.id, 20, false, undefined, undefined, { runtime, claimLeaseMs: 60_000 });
    await sendStarted;
    const drain = await runtime.drain(1_000);
    assert.equal(drain.drained, true);
    assert.equal((await publishing).ok, true);
    assert.equal((await store.get(post.id))?.status, 'Published');
  } finally { await cleanup(); }
});

test('stopping publisher rejects new work before any claim and scheduler stop gate claims nothing', async () => {
  const { store, cleanup } = await fixture();
  try {
    const draft = await store.create('New manual work after shutdown', undefined, 10);
    const runtime = new PublisherRuntime();
    runtime.stopAccepting();
    const sender: ChannelSender = { async sendMessage() { return { message_id: 1 }; }, async sendPhoto() { return { message_id: 2 }; } };
    await assert.rejects(publishChannelPost(store, sender, '-1001', draft.id, 20, false, undefined, undefined, { runtime }), /stopping/);
    assert.equal((await store.get(draft.id))?.status, 'Draft');

    const scheduled = await store.create('Scheduled work blocked during shutdown', undefined, 10);
    await store.schedule(scheduled.id, '2026-07-21T10:00:00.000Z', 20);
    const run = await runChannelSchedulerOnce(store, sender, '-1001', new Date('2026-07-21T10:01:00.000Z'), 60_000, undefined, { canClaim: () => false });
    assert.equal(run.claimed, 0);
    assert.equal((await store.get(scheduled.id))?.status, 'Scheduled');
  } finally { await cleanup(); }
});
