import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JsonChannelPostStore } from '../src/channelPosts.js';
import { atomicWriteJson, readJson, withFileLock } from '../src/safeJson.js';

async function fixture(prefix = 'safe-json-') {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const file = path.join(directory, 'state.json');
  return { directory, file, cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

async function json(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}

async function runWriterProcess(file: string, prefix: string, count: number): Promise<void> {
  const script = fileURLToPath(new URL('./fixtures/safeJsonWriter.ts', import.meta.url));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, file, prefix, String(count)], {
      cwd: path.resolve(path.dirname(script), '..', '..'),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`writer ${prefix} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
        path.join(lockPath, '.reclaim'),
        JSON.stringify({ token: 'old-reclaimer', observedOwnerToken: 'dead-owner', pid: 999_999, createdAtMs: 0 }),
        'utf8',
      );
    });
    await assert.rejects(stat(lockPath), { code: 'ENOENT' });
  } finally { await cleanup(); }
});

test('transient primary I/O failures never fall back, rotate, or replace a generation', async () => {
  const { directory, file, cleanup } = await fixture();
  try {
    await writeFile(file, JSON.stringify({ generation: 3 }), 'utf8');
    await writeFile(`${file}.bak`, JSON.stringify({ generation: 2 }), 'utf8');
    await writeFile(`${file}.bak.1`, JSON.stringify({ generation: 1 }), 'utf8');
    const expected = await Promise.all([file, `${file}.bak`, `${file}.bak.1`].map((entry) => readFile(entry, 'utf8')));

    for (const code of ['EACCES', 'EIO']) {
      const reader = async (target: string, encoding: 'utf8'): Promise<string> => {
        if (target === file) throw Object.assign(new Error(`injected ${code}`), { code });
        return readFile(target, encoding);
      };
      await assert.rejects(readJson(file, { generation: 0 }, { readFile: reader }), (error: unknown) => (error as NodeJS.ErrnoException).code === code);
      await assert.rejects(atomicWriteJson(file, { generation: 99 }, { readFile: reader }), (error: unknown) => (error as NodeJS.ErrnoException).code === code);
      assert.deepEqual(await Promise.all([file, `${file}.bak`, `${file}.bak.1`].map((entry) => readFile(entry, 'utf8'))), expected);
      assert.equal((await readdir(directory)).some((entry) => entry.endsWith('.tmp')), false);
    }
  } finally { await cleanup(); }
});

test('backup I/O failure stops recovery and rotation before any generation changes', async () => {
  const { file, cleanup } = await fixture();
  try {
    await writeFile(file, '{malformed primary', 'utf8');
    await writeFile(`${file}.bak`, JSON.stringify({ generation: 2 }), 'utf8');
    await writeFile(`${file}.bak.1`, JSON.stringify({ generation: 1 }), 'utf8');
    const backupReader = async (target: string, encoding: 'utf8'): Promise<string> => {
      if (target === `${file}.bak`) throw Object.assign(new Error('injected backup EIO'), { code: 'EIO' });
      return readFile(target, encoding);
    };
    await assert.rejects(readJson(file, { generation: 0 }, { readFile: backupReader }), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EIO');

    await writeFile(file, JSON.stringify({ generation: 3 }), 'utf8');
    const expected = await Promise.all([file, `${file}.bak`, `${file}.bak.1`].map((entry) => readFile(entry, 'utf8')));
    await assert.rejects(atomicWriteJson(file, { generation: 4 }, { readFile: backupReader }), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EIO');
    assert.deepEqual(await Promise.all([file, `${file}.bak`, `${file}.bak.1`].map((entry) => readFile(entry, 'utf8'))), expected);
  } finally { await cleanup(); }
});

test('a malformed newest backup falls through to the valid preceding generation', async () => {
  const { file, cleanup } = await fixture();
  try {
    await writeFile(file, '{malformed primary', 'utf8');
    await writeFile(`${file}.bak`, '{malformed backup', 'utf8');
    await writeFile(`${file}.bak.1`, JSON.stringify({ generation: 1 }), 'utf8');
    assert.deepEqual(await readJson(file, { generation: 0 }), { generation: 1 });
  } finally { await cleanup(); }
});

test('interruption during backup rotation preserves the primary and a parseable backup generation', async () => {
  const { directory, file, cleanup } = await fixture();
  try {
    await atomicWriteJson(file, { generation: 1 });
    await atomicWriteJson(file, { generation: 2 });
    await atomicWriteJson(file, { generation: 3 });
    await assert.rejects(
      atomicWriteJson(file, { generation: 4 }, {
        onStep: (step) => { if (step === 'before_backup_commit') throw new Error('injected backup interruption'); },
      }),
      /injected backup interruption/,
    );
    assert.deepEqual(await json(file), { generation: 3 });
    await assert.rejects(stat(`${file}.bak`), { code: 'ENOENT' });
    assert.deepEqual(await json(`${file}.bak.1`), { generation: 2 });
    assert.equal((await readdir(directory)).some((entry) => entry.endsWith('.tmp')), false);
  } finally { await cleanup(); }
});

test('two stale reclaimers serialize on one fixed claim and cannot overlap successor ownership', async () => {
  const { file, cleanup } = await fixture();
  const lockPath = `${file}.lock`;
  try {
    await mkdir(lockPath);
    await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ token: 'dead-owner', pid: 999_999, createdAt: new Date(0).toISOString(), createdAtMs: 0 }), 'utf8');
    await utimes(lockPath, new Date(0), new Date(0));

    let releaseClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const claimSafetyTimer = setTimeout(releaseClaim, 4_500);
    let claimReached!: () => void;
    const reached = new Promise<void>((resolve) => { claimReached = resolve; });
    let active = 0;
    let maxActive = 0;
    const processAlive = (pid: number) => pid === process.pid;

    const first = withFileLock(file, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
    }, {
      staleMs: 1,
      retryMs: 2,
      processAlive,
      onReclaimStep: async (step) => {
        if (step === 'claim_acquired') {
          claimReached();
          await claimGate;
        }
      },
    });
    await withTimeout(reached, 5_000, 'first reclaimer did not acquire its claim');

    let secondEntered = false;
    const second = withFileLock(file, async () => {
      secondEntered = true;
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
    }, { staleMs: 1, retryMs: 2, processAlive });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(secondEntered, false);
    releaseClaim();
    clearTimeout(claimSafetyTimer);
    await withTimeout(Promise.all([first, second]), 5_000, 'reclaimers did not finish');
    assert.equal(maxActive, 1);
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

test('separate Node processes serialize writers through the filesystem lock', { timeout: 60_000 }, async () => {
  const { file, cleanup } = await fixture('safe-json-processes-');
  try {
    await Promise.all([
      runWriterProcess(file, 'worker-a', 4),
      runWriterProcess(file, 'worker-b', 4),
    ]);
    const posts = await new JsonChannelPostStore(file).all();
    assert.equal(posts.length, 8);
    assert.equal(new Set(posts.map((post) => post.id)).size, 8);
  } finally { await cleanup(); }
});

test('state directory, lock directory, primary and backup generations are private on POSIX', { skip: process.platform === 'win32' }, async () => {
  const { directory, file, cleanup } = await fixture('safe-json-modes-');
  try {
    let lockMode = 0;
    await withFileLock(file, async () => { lockMode = (await stat(`${file}.lock`)).mode & 0o777; });
    await atomicWriteJson(file, { generation: 1 });
    await atomicWriteJson(file, { generation: 2 });
    await atomicWriteJson(file, { generation: 3 });
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal(lockMode, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(`${file}.bak`)).mode & 0o777, 0o600);
    assert.equal((await stat(`${file}.bak.1`)).mode & 0o777, 0o600);
  } finally { await cleanup(); }
});
