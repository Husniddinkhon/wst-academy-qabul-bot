import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonChannelPostStore } from '../src/channelPosts.js';
import { atomicWriteJson, readJson, withFileLock } from '../src/safeJson.js';

async function fixture(prefix = 'safe-json-') {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const file = path.join(directory, 'state.json');
  return { directory, file, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function json(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}

test('corrupt primary recovers from a valid backup without overwriting the recovery generation', async () => {
  const { file, cleanup } = await fixture();
  try {
    const expected = { generation: 7, records: ['preserved'] };
    await writeFile(file, '{corrupt primary', 'utf8');
    await writeFile(`${file}.bak`, JSON.stringify(expected), 'utf8');

    const recovered = await readJson(file, { generation: 0, records: [] as string[] });
    assert.deepEqual(recovered, expected);
    await atomicWriteJson(file, recovered);

    assert.deepEqual(await json(file), expected);
    assert.deepEqual(await json(`${file}.bak`), expected);
  } finally { await cleanup(); }
});

test('missing primary recovers from a valid backup instead of returning an empty fallback', async () => {
  const { file, cleanup } = await fixture();
  try {
    const expected = { generation: 3, records: ['recover-me'] };
    await writeFile(`${file}.bak`, JSON.stringify(expected), 'utf8');

    const recovered = await readJson(file, { generation: 0, records: [] as string[] });
    assert.deepEqual(recovered, expected);
    await atomicWriteJson(file, recovered);
    assert.deepEqual(await json(file), expected);
    assert.deepEqual(await json(`${file}.bak`), expected);
  } finally { await cleanup(); }
});

test('missing primary with only corrupt backup artifacts fails closed', async () => {
  const { file, cleanup } = await fixture();
  try {
    await writeFile(`${file}.bak`, '{corrupt backup', 'utf8');
    await assert.rejects(readJson(file, { records: [] }), /JSON storage read failed/);
  } finally { await cleanup(); }
});

test('interrupted primary commit leaves the primary and both backup generations recoverable', async () => {
  const { directory, file, cleanup } = await fixture();
  try {
    await atomicWriteJson(file, { generation: 1 });
    await atomicWriteJson(file, { generation: 2 });

    await assert.rejects(
      atomicWriteJson(file, { generation: 3 }, {
        onStep: (step) => { if (step === 'before_primary_commit') throw new Error('injected interruption'); },
      }),
      /injected interruption/,
    );

    assert.deepEqual(await json(file), { generation: 2 });
    assert.deepEqual(await json(`${file}.bak`), { generation: 2 });
    assert.deepEqual(await json(`${file}.bak.1`), { generation: 1 });
    assert.equal((await readdir(directory)).some((entry) => entry.endsWith('.tmp')), false);
  } finally { await cleanup(); }
});

test('successive writes preserve two valid backup generations and never rotate a corrupt primary', async () => {
  const { file, cleanup } = await fixture();
  try {
    await atomicWriteJson(file, { generation: 1 });
    await atomicWriteJson(file, { generation: 2 });
    await atomicWriteJson(file, { generation: 3 });
    assert.deepEqual(await json(file), { generation: 3 });
    assert.deepEqual(await json(`${file}.bak`), { generation: 2 });
    assert.deepEqual(await json(`${file}.bak.1`), { generation: 1 });

    await writeFile(file, '{corrupt primary', 'utf8');
    await atomicWriteJson(file, { generation: 4 });
    assert.deepEqual(await json(file), { generation: 4 });
    assert.deepEqual(await json(`${file}.bak`), { generation: 2 });
    assert.deepEqual(await json(`${file}.bak.1`), { generation: 1 });
  } finally { await cleanup(); }
});

test('a stale lock owned by a live process is not stolen', async () => {
  const { file, cleanup } = await fixture();
  const lockPath = `${file}.lock`;
  try {
    await mkdir(lockPath);
    const owner = { token: 'live-owner', pid: process.pid, createdAt: new Date(0).toISOString(), createdAtMs: 0 };
    await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify(owner), 'utf8');
    await utimes(lockPath, new Date(0), new Date(0));

    await assert.rejects(
      withFileLock(file, async () => undefined, { timeoutMs: 30, staleMs: 1, retryMs: 2, processAlive: (pid) => pid === process.pid }),
      /lock timeout/,
    );
    assert.deepEqual(JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8')), owner);
  } finally { await cleanup(); }
});

test('an abandoned stale lock is reclaimed but an old owner cannot remove a successor lock', async () => {
  const { file, cleanup } = await fixture();
  const lockPath = `${file}.lock`;
  try {
    await mkdir(lockPath);
    await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ token: 'dead-owner', pid: 999_999, createdAt: new Date(0).toISOString(), createdAtMs: 0 }), 'utf8');
    await utimes(lockPath, new Date(0), new Date(0));
    let entered = false;
    await withFileLock(file, async () => { entered = true; }, { staleMs: 1, processAlive: () => false });
    assert.equal(entered, true);
    await assert.rejects(stat(lockPath), { code: 'ENOENT' });

    await withFileLock(file, async () => {
      const displaced = `${lockPath}.displaced`;
      await rename(lockPath, displaced);
      await mkdir(lockPath);
      await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ token: 'successor', pid: process.pid, createdAt: new Date().toISOString(), createdAtMs: Date.now() }), 'utf8');
      await rm(displaced, { recursive: true, force: true });
    });
    assert.equal(JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8')).token, 'successor');
  } finally { await cleanup(); }
});

test('a successor owner removes a reclamation marker aimed at an older lock generation', async () => {
  const { file, cleanup } = await fixture();
  const lockPath = `${file}.lock`;
  try {
    await withFileLock(file, async () => {
      await writeFile(
        path.join(lockPath, '.reclaim-old-generation'),
        JSON.stringify({ token: 'old-reclaimer', observedOwnerToken: 'dead-owner', pid: 999_999, createdAtMs: 0 }),
        'utf8',
      );
    });
    await assert.rejects(stat(lockPath), { code: 'ENOENT' });
  } finally { await cleanup(); }
});

test('independent store instances serialize concurrent channel-post writers', async () => {
  const { file, cleanup } = await fixture('safe-json-concurrency-');
  try {
    const first = new JsonChannelPostStore(file);
    const second = new JsonChannelPostStore(file);
    await Promise.all(Array.from({ length: 16 }, (_, index) => {
      const store = index % 2 === 0 ? first : second;
      return store.create(`Concurrent post ${index}`, undefined, index);
    }));
    const posts = await first.all();
    assert.equal(posts.length, 16);
    assert.equal(new Set(posts.map((post) => post.id)).size, 16);
    assert.equal(posts.every((post) => post.status === 'Draft'), true);
  } finally { await cleanup(); }
});
