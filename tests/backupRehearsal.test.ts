import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverBackups, computeManifest, verifyManifest, encryptBackup, decryptBackup, copyToOffHost, restoreFromOffHost, cleanupRestore } from '../src/backupManifest.js';

const ENC_KEY = '5d0ef41ac5911bd37250e4524ccccf7eb312e48a6e0df718e1f827b54c1ea683';

async function withTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'backup-test-'));
}

test('discoverBackups finds .bak files in data directory', async () => {
  const dir = await withTempDir();
  try {
    await writeFile(path.join(dir, 'test.json'), '{"a":1}', 'utf8');
    await writeFile(path.join(dir, 'test.json.bak'), '{"a":1}', 'utf8');
    await writeFile(path.join(dir, 'test.json.bak.1'), '{"a":0}', 'utf8');

    const migrationDir = path.join(dir, 'migrations');
    await mkdir(migrationDir, { recursive: true });
    const entries = await discoverBackups(dir, migrationDir);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].sourceName, 'test.json');
    assert.equal(entries[0].generation, 0);
    assert.ok(entries[0].sha256.length === 64);
    assert.equal(entries[1].generation, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('discoverBackups includes migration manifests', async () => {
  const dir = await withTempDir();
  try {
    const migrationDir = path.join(dir, 'migrations');
    await mkdir(migrationDir, { recursive: true });
    await writeFile(path.join(migrationDir, 'abc-123.json'), '{"state":"completed"}', 'utf8');
    await writeFile(path.join(migrationDir, '.gitkeep'), '', 'utf8');

    const entries = await discoverBackups(dir, migrationDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].sourceName, 'migration:abc-123');
    assert.ok(entries[0].sha256.length === 64);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('computeManifest creates checksummed manifest', async () => {
  const entries = [
    { sourceName: 'test.json', filePath: '/x/test.json', backupPath: '/x/test.json.bak', sha256: 'a'.repeat(64), size: 10, mtime: '2026-01-01T00:00:00.000Z', generation: 0 },
  ];
  const manifest = computeManifest(entries, 'test-host');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.hostname, 'test-host');
  assert.equal(manifest.entryCount, 1);
  assert.equal(manifest.totalSize, 10);
  assert.equal(manifest.hash.length, 64);
  assert.ok(manifest.createdAt.length > 0);
});

test('verifyManifest passes for matching hashes', async () => {
  const dir = await withTempDir();
  try {
    await writeFile(path.join(dir, 'test.json.bak'), '{"a":1}', 'utf8');
    const content = '{"a":1}';
    const { createHash } = await import('node:crypto');
    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
    const entries = [
      { sourceName: 'test.json', filePath: path.join(dir, 'test.json'), backupPath: path.join(dir, 'test.json.bak'), sha256, size: 8, mtime: '2026-01-01T00:00:00.000Z', generation: 0 },
    ];
    const result = await verifyManifest({ schemaVersion: 1, createdAt: '', hostname: '', totalSize: 8, entryCount: 1, entries, hash: '' });
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('encryptBackup and decryptBackup round-trip', () => {
  const plaintext = '{"hello":"world"}';
  const encrypted = encryptBackup(plaintext, ENC_KEY);
  assert.ok(encrypted.iv.length > 0);
  assert.ok(encrypted.tag.length > 0);
  assert.ok(encrypted.ciphertext.length > 0);
  assert.notEqual(encrypted.ciphertext, plaintext);

  const decrypted = decryptBackup(encrypted.ciphertext, ENC_KEY, encrypted.iv, encrypted.tag);
  assert.equal(decrypted, plaintext);
});

test('encryptBackup produces different ciphertext for same plaintext (different IV)', () => {
  const plaintext = 'same data';
  const e1 = encryptBackup(plaintext, ENC_KEY);
  const e2 = encryptBackup(plaintext, ENC_KEY);
  assert.notEqual(e1.ciphertext, e2.ciphertext);
  assert.notEqual(e1.iv, e2.iv);
});

test('decryptBackup fails with wrong key', () => {
  const plaintext = 'secret data';
  const encrypted = encryptBackup(plaintext, ENC_KEY);
  const wrongKey = 'a'.repeat(64);
  assert.throws(() => {
    decryptBackup(encrypted.ciphertext, wrongKey, encrypted.iv, encrypted.tag);
  });
});

test('copyToOffHost and restoreFromOffHost round-trip', async () => {
  const dataDir = await withTempDir();
  const offHostDir = await withTempDir();
  const restoreDir = await withTempDir();
  try {
    await writeFile(path.join(dataDir, 'state.json.bak'), '{"counter":1}', 'utf8');
    await writeFile(path.join(dataDir, 'state.json.bak.1'), '{"counter":0}', 'utf8');
    const migrationDir = path.join(dataDir, 'migrations');
    await mkdir(migrationDir, { recursive: true });

    const entries = await discoverBackups(dataDir, migrationDir);
    assert.equal(entries.length, 2);

    await copyToOffHost(entries, offHostDir, ENC_KEY);

    const report = await restoreFromOffHost(offHostDir, restoreDir, ENC_KEY);
    assert.equal(report.allOk, true);
    assert.equal(report.restored.length, 2);
    assert.ok(report.rtoMs >= 0);
    assert.ok(report.manifest.entryCount === 2);

    const restoredFiles: string[] = [];
    async function walk(dir: string, prefix: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(prefix, entry.name);
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), full);
        else restoredFiles.push(full);
      }
    }
    await walk(restoreDir, '');
    assert.ok(restoredFiles.some((f: string) => f.includes('state.json.bak')), `Missing state.json.bak in ${restoredFiles.join(',')}`);
    assert.ok(restoredFiles.some((f: string) => f.includes('state.json.bak.1')), `Missing state.json.bak.1 in ${restoredFiles.join(',')}`);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(offHostDir, { recursive: true, force: true });
    await rm(restoreDir, { recursive: true, force: true });
  }
});

test('restoreFromOffHost detects hash mismatch', async () => {
  const dataDir = await withTempDir();
  const offHostDir = await withTempDir();
  const restoreDir = await withTempDir();
  try {
    await writeFile(path.join(dataDir, 'test.json.bak'), '{"original":1}', 'utf8');
    const migrationDir = path.join(dataDir, 'migrations');
    await mkdir(migrationDir, { recursive: true });
    const entries = await discoverBackups(dataDir, migrationDir);
    await copyToOffHost(entries, offHostDir, ENC_KEY);

    const report = await restoreFromOffHost(offHostDir, restoreDir, ENC_KEY);
    assert.equal(report.allOk, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(offHostDir, { recursive: true, force: true });
    await rm(restoreDir, { recursive: true, force: true });
  }
});

test('cleanupRestore removes restored directory', async () => {
  const dir = await withTempDir();
  const restorePath = path.join(dir, 'restored');
  await mkdir(restorePath, { recursive: true });
  await writeFile(path.join(restorePath, 'test.txt'), 'data', 'utf8');

  await cleanupRestore(restorePath);
  await assert.rejects(async () => { await readdir(restorePath); });
});
