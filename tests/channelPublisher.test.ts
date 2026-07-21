import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonChannelPostStore } from '../src/channelPosts.js';
import { publishChannelPost, type ChannelSender } from '../src/channelPublisher.js';

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
      async sendMessage() { if (fail) throw new Error('temporary Telegram failure'); return { message_id: 202 }; },
      async sendPhoto() { throw new Error('unexpected photo'); },
    };
    const first = await publishChannelPost(store, sender, '-1001', post.id, 21);
    assert.equal(first.ok, false);
    assert.equal((await store.get(post.id))?.status, 'Failed');
    assert.equal((await store.get(post.id))?.lastError, 'temporary Telegram failure');
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
