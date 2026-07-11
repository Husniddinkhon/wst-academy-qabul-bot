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
