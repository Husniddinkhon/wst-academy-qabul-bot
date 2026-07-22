import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MigrationEngine, backupStoreFile, restoreStoreFile, peekJsonSchemaVersion, MigrationRequiredError } from '../src/migrationEngine.js';

test('inspect returns detected versions for all handlers', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'migration-'));
  try {
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    engine.register({
      name: 'test-store',
      filePath: path.join(dir, 'store.json'),
      currentVersion: 2,
      detectVersion: async () => 1,
      migrate: async () => null,
      rollback: async () => undefined,
      verify: async () => ({ ok: true, errors: [] }),
    });
    const results = await engine.inspect();
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'test-store');
    assert.equal(results[0].detectedVersion, 1);
    assert.equal(results[0].currentVersion, 2);
    assert.equal(results[0].needsMigration, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('plan returns migrations only for outdated stores', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'migration-'));
  try {
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    engine.register({
      name: 'up-to-date', filePath: '/dev/null', currentVersion: 2,
      detectVersion: async () => 2, migrate: async () => null, rollback: async () => undefined, verify: async () => ({ ok: true, errors: [] }),
    });
    engine.register({
      name: 'needs-upgrade', filePath: '/dev/null', currentVersion: 2,
      detectVersion: async () => 1, migrate: async () => null, rollback: async () => undefined, verify: async () => ({ ok: true, errors: [] }),
    });
    engine.register({
      name: 'fresh', filePath: '/dev/null', currentVersion: 2,
      detectVersion: async () => null, migrate: async () => null, rollback: async () => undefined, verify: async () => ({ ok: true, errors: [] }),
    });
    const plans = await engine.plan();
    assert.equal(plans.length, 2);
    assert.ok(plans.some((p) => p.store === 'needs-upgrade'));
    assert.ok(plans.some((p) => p.store === 'fresh'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('execute migration creates manifest and marks completed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'migration-'));
  try {
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    let migrated = false;
    engine.register({
      name: 'test-store', filePath: path.join(dir, 'store.json'), currentVersion: 2,
      detectVersion: async () => 1,
      migrate: async (dryRun) => { migrated = true; return { backupHash: 'abc', backupPath: path.join(dir, 'backup.bak') }; },
      rollback: async () => undefined,
      verify: async () => ({ ok: true, errors: [] }),
    });
    const plans = await engine.plan();
    assert.equal(plans.length, 1);
    const manifest = await engine.execute(plans[0]);
    assert.equal(manifest.state, 'completed');
    assert.equal(manifest.plan[0].state, 'completed');
    assert.ok(manifest.migrationId);
    assert.equal(migrated, true);

    const manifestFile = await readFile(path.join(dir, 'migrations', `${manifest.migrationId}.json`), 'utf8');
    assert.ok(manifestFile.includes('"state": "completed"'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('backup and restore preserves file content', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'migration-'));
  try {
    const storePath = path.join(dir, 'store.json');
    const backupDir = path.join(dir, 'backups');
    await writeFile(storePath, JSON.stringify({ schemaVersion: 1, data: 'test' }), 'utf8');
    const backup = await backupStoreFile(storePath, backupDir, 'test-store');
    assert.ok(backup.backupPath);
    assert.ok(backup.contentHash);
    assert.equal(backup.size > 0, true);
    const originalHash = backup.contentHash;

    await writeFile(storePath, JSON.stringify({ schemaVersion: 2, data: 'modified' }), 'utf8');
    await restoreStoreFile(backup.backupPath, storePath);
    const restored = JSON.parse(await readFile(storePath, 'utf8'));
    assert.equal(restored.schemaVersion, 1);
    assert.equal(restored.data, 'test');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('peekJsonSchemaVersion returns version from raw file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'migration-'));
  try {
    const filePath = path.join(dir, 'test.json');
    await writeFile(filePath, JSON.stringify({ schemaVersion: 3 }), 'utf8');
    assert.equal(await peekJsonSchemaVersion(filePath), 3);

    await writeFile(filePath, JSON.stringify({}), 'utf8');
    assert.equal(await peekJsonSchemaVersion(filePath), null);

    await writeFile(filePath, JSON.stringify({ schemaVersion: 'invalid' }), 'utf8');
    assert.equal(await peekJsonSchemaVersion(filePath), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('verifyStartupCompatibility passes when all versions match', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'migration-'));
  try {
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    engine.register({
      name: 'a', filePath: '/dev/null', currentVersion: 2,
      detectVersion: async () => 2, migrate: async () => null, rollback: async () => undefined, verify: async () => ({ ok: true, errors: [] }),
    });
    const compat = await engine.verifyStartupCompatibility();
    assert.equal(compat.ok, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('verifyStartupCompatibility fails on outdated version', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'migration-'));
  try {
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    engine.register({
      name: 'a', filePath: '/dev/null', currentVersion: 2,
      detectVersion: async () => 1, migrate: async () => null, rollback: async () => undefined, verify: async () => ({ ok: true, errors: [] }),
    });
    const compat = await engine.verifyStartupCompatibility();
    assert.equal(compat.ok, false);
    assert.ok(compat.guidance.some((g) => g.includes('MIGRATION REQUIRED')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('verifyStartupCompatibility allows fresh deployment (no data)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'migration-'));
  try {
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    engine.register({
      name: 'a', filePath: '/dev/null', currentVersion: 2,
      detectVersion: async () => null, migrate: async () => null, rollback: async () => undefined, verify: async () => ({ ok: true, errors: [] }),
    });
    const compat = await engine.verifyStartupCompatibility();
    assert.equal(compat.ok, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('executeAll runs multiple pending migrations sequentially', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'migration-'));
  try {
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    const order: string[] = [];
    engine.register({
      name: 'store-a', filePath: '/dev/null', currentVersion: 2,
      detectVersion: async () => 1,
      migrate: async () => { order.push('a'); return { backupHash: 'a', backupPath: path.join(dir, 'a.bak') }; },
      rollback: async () => undefined, verify: async () => ({ ok: true, errors: [] }),
    });
    engine.register({
      name: 'store-b', filePath: '/dev/null', currentVersion: 2,
      detectVersion: async () => 1,
      migrate: async () => { order.push('b'); return { backupHash: 'b', backupPath: path.join(dir, 'b.bak') }; },
      rollback: async () => undefined, verify: async () => ({ ok: true, errors: [] }),
    });
    const manifests = await engine.executeAll();
    assert.equal(manifests.length, 2);
    assert.deepEqual(order, ['a', 'b']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
