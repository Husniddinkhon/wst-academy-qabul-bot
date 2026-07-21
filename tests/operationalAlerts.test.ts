import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonChannelPostStore } from '../src/channelPosts.js';
import { alertActionableChannelFailures, deliverOperationalAlert, JsonOperationalAlertStore } from '../src/operationalAlerts.js';

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ops-alerts-'));
  const file = path.join(directory, 'alerts.json');
  return { file, store: new JsonOperationalAlertStore(file), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('marks only successful admin deliveries and retries failed recipients with bounded backoff', async () => {
  const { file, store, cleanup } = await fixture();
  try {
    const calls: number[] = [];
    let failSecond = true;
    const sender = async (adminId: number) => {
      calls.push(adminId);
      if (adminId === 22 && failSecond) throw new Error('secret transport failure');
    };
    const common = { key: 'alert-1', message: 'Safe aggregate alert', adminIds: [11, 22], sender, store, cooldownGroup: 'systemd:unit', cooldownMs: 60 * 60_000 };
    const first = await deliverOperationalAlert({ ...common, now: new Date('2026-07-15T05:00:00Z') });
    assert.deepEqual(first, { attempted: 2, sent: 1, failed: 1, suppressed: false });
    const immediate = await deliverOperationalAlert({ ...common, now: new Date('2026-07-15T05:00:30Z') });
    assert.equal(immediate.attempted, 0);
    failSecond = false;
    const retry = await deliverOperationalAlert({ ...common, now: new Date('2026-07-15T05:01:01Z') });
    assert.deepEqual(retry, { attempted: 1, sent: 1, failed: 0, suppressed: false });
    assert.deepEqual(calls, [11, 22, 22]);
    const idempotent = await deliverOperationalAlert({ ...common, now: new Date('2026-07-15T05:02:00Z') });
    assert.deepEqual(idempotent, { attempted: 0, sent: 0, failed: 0, suppressed: false });
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(file, 'utf8'), /\b11\b|\b22\b|secret transport failure/);
  } finally { await cleanup(); }
});

test('an idempotent delivered alert does not rewrite the primary or backup generation', async () => {
  const { file, store, cleanup } = await fixture();
  try {
    const request = { key: 'no-op', message: 'Safe', adminIds: [44], sender: async () => undefined, store };
    await deliverOperationalAlert({ ...request, now: new Date('2026-07-15T05:00:00Z') });
    const beforePrimary = await readFile(file, 'utf8');
    const beforeBackup = await readFile(`${file}.bak`, 'utf8');
    const beforePrimaryMtime = (await stat(file)).mtimeMs;
    const beforeBackupMtime = (await stat(`${file}.bak`)).mtimeMs;

    const repeated = await deliverOperationalAlert({ ...request, now: new Date('2026-07-15T05:01:00Z') });
    assert.deepEqual(repeated, { attempted: 0, sent: 0, failed: 0, suppressed: false });
    assert.equal(await readFile(file, 'utf8'), beforePrimary);
    assert.equal(await readFile(`${file}.bak`, 'utf8'), beforeBackup);
    assert.equal((await stat(file)).mtimeMs, beforePrimaryMtime);
    assert.equal((await stat(`${file}.bak`)).mtimeMs, beforeBackupMtime);
  } finally { await cleanup(); }
});

test('persists per-group cooldown across alert occurrences without leaking recipient ids', async () => {
  const { store, cleanup } = await fixture();
  try {
    let sends = 0;
    const request = { message: 'Systemd unit failed', adminIds: [123], sender: async () => { sends += 1; }, store, cooldownGroup: 'systemd:health', cooldownMs: 60 * 60_000 };
    await deliverOperationalAlert({ ...request, key: 'systemd:health:first', now: new Date('2026-07-15T05:00:00Z') });
    const suppressed = await deliverOperationalAlert({ ...request, key: 'systemd:health:second', now: new Date('2026-07-15T05:05:00Z') });
    assert.equal(suppressed.suppressed, true);
    await deliverOperationalAlert({ ...request, key: 'systemd:health:third', now: new Date('2026-07-15T06:00:01Z') });
    assert.equal(sends, 2);
  } finally { await cleanup(); }
});

test('failed delivery retry grows exponentially but never exceeds one hour', async () => {
  const { store, cleanup } = await fixture();
  try {
    let now = new Date('2026-07-15T00:00:00Z');
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await deliverOperationalAlert({ key: 'bounded', message: 'Safe', adminIds: [5], sender: async () => { throw new Error('down'); }, store, now });
      const snapshot = await store.snapshot();
      const recipient = Object.values(snapshot.records.bounded.recipients)[0];
      const retryAt = new Date(recipient.nextAttemptAt!).getTime();
      assert.ok(retryAt - now.getTime() > 0);
      assert.ok(retryAt - now.getTime() <= 60 * 60_000);
      now = new Date(retryAt + 1);
    }
  } finally { await cleanup(); }
});

test('channel alerts are actionable, deduplicated per failure attempt, and ignore stale history', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'channel-alerts-'));
  try {
    const posts = new JsonChannelPostStore(path.join(directory, 'posts.json'));
    const alerts = new JsonOperationalAlertStore(path.join(directory, 'alerts.json'));
    const recent = await posts.create('Reviewed post', undefined, 1);
    await posts.schedule(recent.id, '2026-07-16T05:00:00Z', 1);
    const claim = await posts.claimNextDue(new Date('2026-07-16T05:01:00Z'));
    assert.equal(claim.ok, true);
    if (claim.ok) await posts.markFailed(recent.id, claim.attemptId, 'raw secret must not be alerted');
    const stale = await posts.create('Old failed post', undefined, 1);
    await posts.schedule(stale.id, '2026-07-10T05:00:00Z', 1);
    const staleClaim = await posts.claimNextDue(new Date('2026-07-10T05:01:00Z'));
    if (staleClaim.ok) await posts.markFailed(stale.id, staleClaim.attemptId, 'old');

    const messages: string[] = [];
    const sender = { sendMessage: async (_chatId: string | number, text: string) => { messages.push(text); return { message_id: 1 }; }, sendPhoto: async () => ({ message_id: 2 }) };
    const now = new Date();
    const db = JSON.parse(await readFile(path.join(directory, 'posts.json'), 'utf8'));
    db.posts = db.posts.map((post: { id: string; failedAt?: string }) => post.id === recent.id
      ? { ...post, failedAt: new Date(now.getTime() - 60_000).toISOString() }
      : { ...post, failedAt: new Date(now.getTime() - 25 * 60 * 60_000).toISOString() });
    await writeFile(path.join(directory, 'posts.json'), JSON.stringify(db), 'utf8');

    await alertActionableChannelFailures(posts, sender, [77], alerts, now);
    await alertActionableChannelFailures(posts, sender, [77], alerts, new Date(now.getTime() + 30_000));
    assert.equal(messages.length, 1);
    assert.match(messages[0], new RegExp(recent.id));
    assert.doesNotMatch(messages[0], /raw secret|old failed/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recent Uncertain publication emits one privacy-safe manual-review alert', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'channel-uncertain-alert-'));
  try {
    const posts = new JsonChannelPostStore(path.join(directory, 'posts.json'));
    const alerts = new JsonOperationalAlertStore(path.join(directory, 'alerts.json'));
    const post = await posts.create('Approved content hidden from alert logs', undefined, 10);
    const claim = await posts.claimForPublishing(post.id, 20);
    assert.equal(claim.ok, true);
    if (!claim.ok) return;
    await posts.markSendStarted(post.id, claim.attemptId, claim.claimToken, '-100-private', 'd'.repeat(64));
    await posts.markUncertain(post.id, claim.attemptId, 'raw connection detail must stay private', claim.claimToken);
    const messages: string[] = [];
    const sender = { sendMessage: async (_chatId: string | number, text: string) => { messages.push(text); return { message_id: 1 }; }, sendPhoto: async () => ({ message_id: 2 }) };
    await alertActionableChannelFailures(posts, sender, [77], alerts);
    await alertActionableChannelFailures(posts, sender, [77], alerts);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Uncertain\/manual review/);
    assert.doesNotMatch(messages[0], /raw connection detail|100-private|Approved content/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
