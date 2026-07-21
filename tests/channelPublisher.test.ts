import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonChannelPostStore } from '../src/channelPosts.js';
import { publishChannelPost, PublisherRuntime, type ChannelSender } from '../src/channelPublisher.js';

async function fixture(): Promise<{ store: JsonChannelPostStore; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'channel-publisher-'));
  return { store: new JsonChannelPostStore(path.join(directory, 'posts.json')), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('concurrent publish claims once and sends one text message', async () => {
  const { store, cleanup } = await fixture();
  try {
    const post = await store.create('Production safe text post content', undefined, 10);
    let sends = 0;
    const sender: ChannelSender = {
      async sendMessage() { sends += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { message_id: 101 }; },
      async sendPhoto() { throw new Error('unexpected photo'); },
    };
    const results = await Promise.all([
      publishChannelPost(store, sender, '-1001', post.id, 20),
      publishChannelPost(store, sender, '-1001', post.id, 20),
    ]);
    assert.equal(sends, 1);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal((await store.get(post.id))?.status, 'Published');
    assert.equal((await store.get(post.id))?.attempts, 1);
  } finally { await cleanup(); }
});

test('failed send is retryable and preserves attempts and audit', async () => {
  const { store, cleanup } = await fixture();
  try {
    const post = await store.create('Retryable channel text post', undefined, 11);
    let fail = true;
    const sender: ChannelSender = {
      async sendMessage() { if (fail) throw Object.assign(new Error('Telegram rejected the request'), { response: { error_code: 400 } }); return { message_id: 202 }; },
      async sendPhoto() { throw new Error('unexpected photo'); },
    };
    const first = await publishChannelPost(store, sender, '-1001', post.id, 21);
    assert.equal(first.ok, false);
    assert.equal((await store.get(post.id))?.status, 'Failed');
    assert.equal((await store.get(post.id))?.lastError, 'Telegram rejected the request');
    fail = false;
    const retried = await publishChannelPost(store, sender, '-1001', post.id, 22, true);
    assert.equal(retried.ok, true);
    const saved = await store.get(post.id);
    assert.equal(saved?.status, 'Published');
    assert.equal(saved?.attempts, 2);
    assert.equal(saved?.createdBy, 11);
    assert.equal(saved?.publishedBy, 22);
    assert.equal(saved?.publishedMessageId, 202);
    assert.equal(saved?.lastError, undefined);
  } finally { await cleanup(); }
});

test('timeout after send starts becomes Uncertain and cannot be blindly retried', async () => {
  const { store, cleanup } = await fixture();
  try {
    const post = await store.create('Timeout-safe channel publication', undefined, 10);
    let sends = 0;
    const sender: ChannelSender = {
      async sendMessage() { sends += 1; throw Object.assign(new Error('Telegram request timed out'), { code: 'ETIMEDOUT' }); },
      async sendPhoto() { throw new Error('unexpected photo'); },
    };
    const first = await publishChannelPost(store, sender, '-1001', post.id, 20);
    assert.equal(first.ok, false);
    assert.equal(first.ok ? '' : first.reason, 'outcome_uncertain');
    const saved = await store.get(post.id);
    assert.equal(saved?.status, 'Uncertain');
    assert.match(saved?.requestFingerprint ?? '', /^[a-f0-9]{64}$/);
    assert.equal(saved?.reconciliationStatus, 'pending');

    const replay = await publishChannelPost(store, sender, '-1001', post.id, 20, true);
    assert.equal(replay.ok, false);
    assert.equal(sends, 1);
  } finally { await cleanup(); }
});

test('Telegram success followed by local commit failure preserves observed message id for reconciliation', async () => {
  const { store, cleanup } = await fixture();
  try {
    const post = await store.create('Commit failure after Telegram success', undefined, 10);
    const original = store.markPublished.bind(store);
    let failedCommits = 0;
    store.markPublished = async (...args) => {
      if (failedCommits < 2) { failedCommits += 1; throw new Error('local publication commit failed'); }
      return original(...args);
    };
    const sender: ChannelSender = {
      async sendMessage() { return { message_id: 991 }; },
      async sendPhoto() { throw new Error('unexpected photo'); },
    };
    const result = await publishChannelPost(store, sender, '-1001', post.id, 20);
    assert.equal(result.ok, false);
    const uncertain = await store.get(post.id);
    assert.equal(uncertain?.status, 'Uncertain');
    assert.equal(uncertain?.observedMessageId, 991);
    assert.equal(uncertain?.reconciliationStatus, 'message_id_observed');
    const reconciled = await store.reconcileUncertain(post.id, { outcome: 'published', actorId: 20, messageId: 991, note: 'Matched the locally observed Telegram response.' });
    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.ok ? reconciled.post.status : '', 'Published');
  } finally { await cleanup(); }
});

test('a known Telegram message id is automatically reconciled after one transient local commit failure', async () => {
  const { store, cleanup } = await fixture();
  try {
    const post = await store.create('Known response recovery', undefined, 10);
    const original = store.markPublished.bind(store);
    let failed = false;
    store.markPublished = async (...args) => {
      if (!failed) { failed = true; throw new Error('one transient fsync failure'); }
      return original(...args);
    };
    const sender: ChannelSender = { async sendMessage() { return { message_id: 992 }; }, async sendPhoto() { throw new Error('unexpected photo'); } };
    const result = await publishChannelPost(store, sender, '-1001', post.id, 20);
    assert.equal(result.ok, true);
    assert.equal((await store.get(post.id))?.status, 'Published');
    assert.equal((await store.get(post.id))?.publishedMessageId, 992);
  } finally { await cleanup(); }
});

test('campaign validation failure releases the publisher runtime entry', async () => {
  const { store, cleanup } = await fixture();
  try {
    const post = await store.create('UNV Uho-P1G-M3F4D-EU aksiya 499 000', undefined, 10);
    const runtime = new PublisherRuntime();
    const sender: ChannelSender = { async sendMessage() { throw new Error('must not send'); }, async sendPhoto() { throw new Error('must not send'); } };
    const result = await publishChannelPost(store, sender, '-1001', post.id, 20, false, undefined, undefined, { runtime, now: new Date('2026-07-21T05:01:00.000Z') });
    assert.equal(result.ok, false);
    assert.equal(runtime.activeCount, 0);
    assert.equal((await runtime.drain(100)).drained, true);

    const storageFailure = await store.create('UNV Uho-P1G-M3F4D-EU aksiya 499 000', undefined, 10);
    const failureRuntime = new PublisherRuntime();
    store.markFailed = async () => { throw new Error('simulated durable write failure'); };
    await assert.rejects(
      publishChannelPost(store, sender, '-1001', storageFailure.id, 20, false, undefined, undefined, { runtime: failureRuntime, now: new Date('2026-07-21T05:01:00.000Z') }),
      /simulated durable write failure/,
    );
    assert.equal(failureRuntime.activeCount, 0);
    assert.equal((await failureRuntime.drain(100)).drained, true);
  } finally { await cleanup(); }
});

test('expired pre-send claim recovers safely while an expired in-send claim becomes Uncertain', async () => {
  const { store, cleanup } = await fixture();
  try {
    const preSend = await store.create('Pre-send crash recovery', undefined, 10);
    const first = await store.claimForPublishing(preSend.id, 20, false, undefined, { now: new Date('2026-07-21T10:00:00.000Z'), leaseMs: 1_000, workerId: 'worker-a' });
    assert.equal(first.ok, true);
    const recovered = await store.recoverExpiredClaims(new Date('2026-07-21T10:00:02.000Z'));
    assert.equal(recovered.find((item) => item.id === preSend.id)?.status, 'RetryWait');

    const inSend = await store.create('In-send crash recovery', undefined, 10);
    const second = await store.claimForPublishing(inSend.id, 20, false, undefined, { now: new Date('2026-07-21T11:00:00.000Z'), leaseMs: 1_000, workerId: 'worker-b' });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    await store.markSendStarted(inSend.id, second.attemptId, second.claimToken, '-1001', 'a'.repeat(64), new Date('2026-07-21T11:00:00.100Z'));
    await store.recoverExpiredClaims(new Date('2026-07-21T11:00:02.000Z'));
    assert.equal((await store.get(inSend.id))?.status, 'Uncertain');
  } finally { await cleanup(); }
});

test('claim cancellation invalidates ownership and published posts cannot be claimed again', async () => {
  const { store, cleanup } = await fixture();
  try {
    const post = await store.create('Cancellation-safe post', undefined, 10);
    const claim = await store.claimForPublishing(post.id, 20);
    assert.equal(claim.ok, true);
    const cancelled = await store.cancel(post.id, 20);
    assert.equal(cancelled.ok, true);
    if (!claim.ok) return;
    assert.equal(await store.markSendStarted(post.id, claim.attemptId, claim.claimToken, '-1001', 'b'.repeat(64)), undefined);

    const publishedDraft = await store.create('Terminal published post', undefined, 10);
    const sender: ChannelSender = { async sendMessage() { return { message_id: 300 }; }, async sendPhoto() { throw new Error('unexpected photo'); } };
    assert.equal((await publishChannelPost(store, sender, '-1001', publishedDraft.id, 20)).ok, true);
    assert.equal((await publishChannelPost(store, sender, '-1001', publishedDraft.id, 20, true)).ok, false);
  } finally { await cleanup(); }
});

test('controlled Uncertain override is audited and preserves the semantic publication identity', async () => {
  const { store, cleanup } = await fixture();
  try {
    const post = await store.create('Human-reviewed uncertain retry', undefined, 10);
    let calls = 0;
    const sender: ChannelSender = {
      async sendMessage() { calls += 1; if (calls === 1) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); return { message_id: 444 }; },
      async sendPhoto() { throw new Error('unexpected photo'); },
    };
    await publishChannelPost(store, sender, '-1001', post.id, 20);
    const before = await store.get(post.id);
    const override = await store.authorizeUncertainOverride(post.id, 21, 'Operator inspected channel history and approved retry.');
    assert.equal(override.ok, true);
    assert.equal((await publishChannelPost(store, sender, '-1001', post.id, 21, true)).ok, true);
    const after = await store.get(post.id);
    assert.equal(after?.semanticKey, before?.semanticKey);
    assert.equal(after?.attempts, 2);
    assert.ok(after?.audit?.some((event) => event.event === 'controlled_override_authorized' && event.actorId === 21));
  } finally { await cleanup(); }
});

test('Telegram rate limit enters bounded RetryWait and media timeout enters Uncertain', async () => {
  const { store, cleanup } = await fixture();
  try {
    const text = await store.create('Rate-limited publication', undefined, 10);
    const rateLimited: ChannelSender = {
      async sendMessage() { throw Object.assign(new Error('Too Many Requests'), { response: { error_code: 429, parameters: { retry_after: 12 } } }); },
      async sendPhoto() { throw new Error('unexpected photo'); },
    };
    const waiting = await publishChannelPost(store, rateLimited, '-1001', text.id, 20, false, undefined, undefined, { now: new Date('2026-07-21T10:00:00.000Z') });
    assert.equal(waiting.ok ? '' : waiting.reason, 'retry_wait');
    assert.equal((await store.get(text.id))?.status, 'RetryWait');

    const photo = await store.create('Media timeout publication', 'telegram-file-id', 10);
    const mediaTimeout: ChannelSender = {
      async sendMessage() { throw new Error('unexpected text'); },
      async sendPhoto() { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); },
    };
    const uncertain = await publishChannelPost(store, mediaTimeout, '-1001', photo.id, 20);
    assert.equal(uncertain.ok ? '' : uncertain.reason, 'outcome_uncertain');
    assert.equal((await store.get(photo.id))?.status, 'Uncertain');
  } finally { await cleanup(); }
});

test('photo post uses sendPhoto and stores Telegram message id', async () => {
  const { store, cleanup } = await fixture();
  try {
    const post = await store.create('Photo caption suitable for Telegram', 'file-123', 12);
    let photoCall: unknown[] | undefined;
    const sender: ChannelSender = {
      async sendMessage() { throw new Error('unexpected text'); },
      async sendPhoto(...args) { photoCall = args; return { message_id: 303 }; },
    };
    const result = await publishChannelPost(store, sender, '-1001', post.id, 23);
    assert.equal(result.ok, true);
    assert.deepEqual(photoCall, ['-1001', 'file-123', { caption: 'Photo caption suitable for Telegram' }]);
    assert.equal((await store.get(post.id))?.publishedMessageId, 303);
  } finally { await cleanup(); }
});

test('verified local channel image resolves only inside the configured asset root', async () => {
  const { store, cleanup } = await fixture();
  try {
    const post = await store.createFromSource('Original local technical diagram caption', { kind: 'local_path', value: 'series/image.png' }, 12, 'technical-1');
    let photo: unknown;
    const sender: ChannelSender = {
      async sendMessage() { throw new Error('unexpected text'); },
      async sendPhoto(_chatId, input) { photo = input; return { message_id: 404 }; },
    };
    const result = await publishChannelPost(store, sender, '-1001', post.id, 23, false, { assetRoot: '/safe/assets', allowedHttpsHosts: [] });
    assert.equal(result.ok, true);
    assert.deepEqual(photo, { source: path.resolve('/safe/assets', 'series/image.png'), filename: 'image.png' });

    const traversal = await store.createFromSource('Traversal must be rejected before Telegram', { kind: 'local_path', value: '../secret.png' }, 12, 'technical-2');
    const blocked = await publishChannelPost(store, sender, '-1001', traversal.id, 23, false, { assetRoot: '/safe/assets', allowedHttpsHosts: [] });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'send_failed');
    assert.match(blocked.ok ? '' : blocked.error ?? '', /escapes CHANNEL_ASSET_ROOT/);
  } finally { await cleanup(); }
});

test('hosted channel images require HTTPS and an exact configured host', async () => {
  const { store, cleanup } = await fixture();
  try {
    let photo: unknown;
    const sender: ChannelSender = {
      async sendMessage() { throw new Error('unexpected text'); },
      async sendPhoto(_chatId, input) { photo = input; return { message_id: 505 }; },
    };
    const allowed = await store.createFromSource('Approved hosted technical diagram caption', { kind: 'https_url', value: 'https://cdn.montag.uz/academy/image.png' }, 12, 'technical-3');
    const published = await publishChannelPost(store, sender, '-1001', allowed.id, 23, false, { assetRoot: '/safe/assets', allowedHttpsHosts: ['cdn.montag.uz'] });
    assert.equal(published.ok, true);
    assert.equal(photo, 'https://cdn.montag.uz/academy/image.png');

    const rejected = await store.createFromSource('Unlisted host must be rejected before Telegram', { kind: 'https_url', value: 'https://example.org/image.png' }, 12, 'technical-4');
    const blocked = await publishChannelPost(store, sender, '-1001', rejected.id, 23, false, { assetRoot: '/safe/assets', allowedHttpsHosts: ['cdn.montag.uz'] });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'send_failed');
    assert.match(blocked.ok ? '' : blocked.error ?? '', /not allowed/);
  } finally { await cleanup(); }
});
