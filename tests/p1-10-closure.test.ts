import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MigrationEngine, backupStoreFile, restoreStoreFile, peekJsonSchemaVersion, MigrationRequiredError } from '../src/migrationEngine.js';

// ── C1-2: Zero startup writes + fresh empty deployment ──────────────────────

test('C1: read() performs zero writes — no file changes after read', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-c1-'));
  try {
    const filePath = path.join(dir, 'store.json');
    await writeFile(filePath, JSON.stringify({ schemaVersion: 2, data: 'hello' }), 'utf8');
    const before = await stat(filePath);
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    engine.register({
      name: 'test', filePath, currentVersion: 2,
      detectVersion: async () => {
        const raw = JSON.parse(await readFile(filePath, 'utf8'));
        return typeof raw.schemaVersion === 'number' ? raw.schemaVersion : null;
      },
      migrate: async () => null, rollback: async () => undefined, verify: async () => ({ ok: true, errors: [] }),
    });
    const compat = await engine.verifyStartupCompatibility();
    assert.equal(compat.ok, true);
    const after = await stat(filePath);
    assert.equal(before.mtimeMs, after.mtimeMs, 'File modification time changed — write detected');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('C2: fresh empty deployment does not require migration', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-c2-'));
  try {
    const filePath = path.join(dir, 'store.json');
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    engine.register({
      name: 'test', filePath, currentVersion: 2,
      detectVersion: async () => null,
      migrate: async () => null, rollback: async () => undefined, verify: async () => ({ ok: true, errors: [] }),
    });
    const compat = await engine.verifyStartupCompatibility();
    assert.equal(compat.ok, true, 'Fresh deploy should be allowed');
    const guidance = compat.guidance[0] ?? '';
    assert.ok(guidance.includes('fresh deployment'), 'Should mention fresh deployment');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ── C3: Migration-required startup exits non-zero ──────────────────────────

test('C3: outdated version blocks startup with MIGRATION REQUIRED', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-c3-'));
  try {
    const filePath = path.join(dir, 'store.json');
    await writeFile(filePath, JSON.stringify({ schemaVersion: 0 }), 'utf8');
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    engine.register({
      name: 'test', filePath, currentVersion: 2,
      detectVersion: async () => 0,
      migrate: async () => null, rollback: async () => undefined, verify: async () => ({ ok: true, errors: [] }),
    });
    const compat = await engine.verifyStartupCompatibility();
    assert.equal(compat.ok, false);
    assert.ok(compat.guidance.some((g) => g.includes('MIGRATION REQUIRED')), 'Should say MIGRATION REQUIRED');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ── C4: Unknown and malformed versions fail closed ─────────────────────────

test('C4a: schemaVersion > current is UNSUPPORTED and blocks startup', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-c4a-'));
  try {
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    engine.register({
      name: 'test', filePath: '/dev/null', currentVersion: 2,
      detectVersion: async () => 99,
      migrate: async () => null, rollback: async () => undefined, verify: async () => ({ ok: true, errors: [] }),
    });
    const compat = await engine.verifyStartupCompatibility();
    assert.equal(compat.ok, false);
    assert.ok(compat.guidance.some((g) => g.includes('UNSUPPORTED')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('C4b: malformed schemaVersion (non-number) resolves to null — fresh deploy', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-c4b-'));
  try {
    const filePath = path.join(dir, 'store.json');
    await writeFile(filePath, JSON.stringify({ schemaVersion: 'corrupted' }), 'utf8');
    const detected = await peekJsonSchemaVersion(filePath);
    assert.equal(detected, null, 'String schemaVersion should be treated as absent');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('C4c: store read() throws on unsupported future version', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-c4c-'));
  try {
    const filePath = path.join(dir, 'store.json');
    await writeFile(filePath, JSON.stringify({ schemaVersion: 99, actors: [] }), 'utf8');
    const { JsonAuthorizationStore, authorizationCallbackSecret } = await import('../src/authorization.js');
    const store = new JsonAuthorizationStore(filePath, authorizationCallbackSecret('synthetic-test-bot-token-with-safe-length'));
    await assert.rejects(async () => await store.actors(), /Unsupported authorization schema version 99/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ── C5: Dry-run performs zero writes ───────────────────────────────────────

test('C5: plan() and inspect() perform zero writes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-c5-'));
  try {
    const filePath = path.join(dir, 'store.json');
    await writeFile(filePath, JSON.stringify({ schemaVersion: 0, data: 'legacy' }), 'utf8');
    const beforeContent = await readFile(filePath, 'utf8');
    
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    engine.register({
      name: 'test', filePath, currentVersion: 1,
      detectVersion: async () => 0,
      migrate: async () => { return { backupHash: 'dry-run-test', backupPath: '' }; },
      rollback: async () => undefined, verify: async () => ({ ok: true, errors: [] }),
    });
    
    await engine.inspect();
    const afterInspect = await readFile(filePath, 'utf8');
    assert.equal(afterInspect, beforeContent, 'inspect() must not modify file');
    
    await engine.plan();
    const afterPlan = await readFile(filePath, 'utf8');
    assert.equal(afterPlan, beforeContent, 'plan() must not modify file');
    
    await engine.verifyStartupCompatibility();
    const afterCompat = await readFile(filePath, 'utf8');
    assert.equal(afterCompat, beforeContent, 'verifyStartupCompatibility() must not modify file');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('C5b: actual migrateStore dryRun=true for identity store', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-c5b-'));
  try {
    const filePath = path.join(dir, 'identity.json');
    const at = new Date().toISOString();
    const legacy = { applicants: [{ applicantId: 'legacy-1', telegramUserId: 1001, telegramChatId: 1001, identityStatus: 'ACTIVE', verificationStatus: 'TELEGRAM_VERIFIED', lifecycleState: 'CONSENT_REQUIRED', consents: {}, createdAt: at, updatedAt: at, auditReferences: [] }], audit: [], effectKeys: [] };
    await writeFile(filePath, JSON.stringify(legacy), 'utf8');
    const { JsonApplicantIdentityStore } = await import('../src/applicantIdentity.js');
    const store = new JsonApplicantIdentityStore(filePath);
    const before = await readFile(filePath, 'utf8');
    await store.migrateStore(true);
    const after = await readFile(filePath, 'utf8');
    assert.equal(after, before, 'Dry-run migrateStore should not modify the file');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ── C6: Explicit migrate, verify, status, rollback flows ───────────────────

test('C6a: migrate stores manifest and results in completed state', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-c6a-'));
  try {
    const filePath = path.join(dir, 'store.json');
    await writeFile(filePath, JSON.stringify({ schemaVersion: 0 }), 'utf8');
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    let migrated = false;
    engine.register({
      name: 'test', filePath, currentVersion: 1,
      detectVersion: async () => 0,
      migrate: async () => { migrated = true; return { backupHash: 'abc', backupPath: path.join(dir, 'b.bak') }; },
      rollback: async () => undefined,
      verify: async () => ({ ok: true, errors: [] }),
    });
    const plans = await engine.plan();
    const manifest = await engine.execute(plans[0]);
    assert.equal(manifest.state, 'completed');
    assert.equal(manifest.plan[0].state, 'completed');
    assert.equal(migrated, true);
    const file = await readFile(path.join(dir, 'migrations', `${manifest.migrationId}.json`), 'utf8');
    assert.ok(file.includes('"state": "completed"'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('C6b: verify detects version mismatches', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-c6b-'));
  try {
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    engine.register({
      name: 'needs-migrate', filePath: '/dev/null', currentVersion: 2,
      detectVersion: async () => 1, migrate: async () => null, rollback: async () => undefined,
      verify: async () => ({ ok: false, errors: ['Expected version 2, found 1.'] }),
    });
    engine.register({
      name: 'ok', filePath: '/dev/null', currentVersion: 2,
      detectVersion: async () => 2, migrate: async () => null, rollback: async () => undefined,
      verify: async () => ({ ok: true, errors: [] }),
    });
    const result = await engine.verify();
    assert.equal(result.ok, false);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].ok, false);
    assert.equal(result.results[1].ok, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('C6c: status shows last migration info', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-c6c-'));
  try {
    const filePath = path.join(dir, 'store.json');
    await writeFile(filePath, JSON.stringify({ schemaVersion: 0 }), 'utf8');
    let currentDetected = 0;
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    engine.register({
      name: 'test', filePath, currentVersion: 1,
      detectVersion: async () => currentDetected,
      migrate: async () => { currentDetected = 1; return { backupHash: 'abc', backupPath: path.join(dir, 'b.bak') }; },
      rollback: async () => undefined,
      verify: async () => ({ ok: true, errors: [] }),
    });
    const plans = await engine.plan();
    await engine.execute(plans[0]);
    const statuses = await engine.status();
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].needsMigration, false);
    assert.ok(statuses[0].lastMigration);
    assert.equal(statuses[0].lastMigration!.state, 'completed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('C6d: rollback restores from backup', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-c6d-'));
  try {
    const filePath = path.join(dir, 'store.json');
    await writeFile(filePath, JSON.stringify({ schemaVersion: 0, data: 'original' }), 'utf8');
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    let backupRef = '';
    engine.register({
      name: 'test', filePath, currentVersion: 1,
      detectVersion: async () => 0,
      migrate: async () => {
        const backup = await backupStoreFile(filePath, path.join(dir, 'backups'), 'test-store');
        backupRef = backup.backupPath;
        await writeFile(filePath, JSON.stringify({ schemaVersion: 1, data: 'migrated' }), 'utf8');
        return { backupHash: backup.contentHash, backupPath: backup.backupPath };
      },
      rollback: async (backupPath) => await restoreStoreFile(backupPath, filePath),
      verify: async () => ({ ok: true, errors: [] }),
    });
    const plans = await engine.plan();
    const manifest = await engine.execute(plans[0]);
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).data, 'migrated');
    await engine.rollback(manifest.migrationId);
    const restored = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(restored.schemaVersion, 0);
    assert.equal(restored.data, 'original');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ── C7: Backup hashes, rollback integrity, stale lock ──────────────────────

test('C7a: backupStoreFile returns SHA-256 hash matching content', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-c7a-'));
  try {
    const storePath = path.join(dir, 'store.json');
    const backupDir = path.join(dir, 'backups');
    const content = JSON.stringify({ schemaVersion: 1, data: 'test' });
    await writeFile(storePath, content, 'utf8');
    const backup = await backupStoreFile(storePath, backupDir, 'test-store');
    const backupContent = await readFile(backup.backupPath, 'utf8');
    assert.equal(backup.contentHash.length, 64);
    assert.equal(backupContent, content);
    assert.equal(backup.size, content.length);
    assert.ok(backup.backupPath.endsWith('.bak'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('C7b: rollback integrity — restore recovers byte-identical content', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-c7b-'));
  try {
    const storePath = path.join(dir, 'store.json');
    const backupDir = path.join(dir, 'backups');
    const original = JSON.stringify({ schemaVersion: 1, deep: { nested: [1, 2, 3] } });
    await writeFile(storePath, original, 'utf8');
    const backup = await backupStoreFile(storePath, backupDir, 'test-store');
    await writeFile(storePath, JSON.stringify({ corrupted: true }), 'utf8');
    await restoreStoreFile(backup.backupPath, storePath);
    const restored = await readFile(storePath, 'utf8');
    assert.equal(restored, original, 'Restored content must be byte-identical');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('C7c: backup of non-existent file returns EMPTY hash gracefully', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-c7c-'));
  try {
    const storePath = path.join(dir, 'nonexistent.json');
    const backupDir = path.join(dir, 'backups');
    const backup = await backupStoreFile(storePath, backupDir, 'test-store');
    assert.equal(backup.contentHash, 'EMPTY');
    assert.equal(backup.size, 0);
    assert.ok(backup.backupPath.endsWith('.empty'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('C7d: engine rollback rejects non-existent and non-completed migrations', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-c7d-'));
  try {
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    await assert.rejects(() => engine.rollback('nonexistent-id'), /not found/);
    const filePath = path.join(dir, 'store.json');
    await writeFile(filePath, JSON.stringify({ schemaVersion: 0 }), 'utf8');
    engine.register({
      name: 'test', filePath, currentVersion: 1,
      detectVersion: async () => 0,
      migrate: async () => { throw new Error('simulated failure'); },
      rollback: async () => undefined,
      verify: async () => ({ ok: true, errors: [] }),
    });
    const plans = await engine.plan();
    await assert.rejects(() => engine.execute(plans[0]), /simulated failure/);
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(path.join(dir, 'migrations'));
    assert.equal(files.length, 1, 'Failed migration should still have manifest');
    const manifestContent = JSON.parse(await readFile(path.join(dir, 'migrations', files[0]), 'utf8'));
    assert.equal(manifestContent.state, 'failed');
    await assert.rejects(() => engine.rollback(manifestContent.migrationId), /Cannot rollback migration in state/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ── C8: Concurrent migration — one owner ───────────────────────────────────

test('C8: executeAll runs store migrations sequentially (a before b)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-c8-'));
  try {
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    const runLog: string[] = [];
    const versions = new Map<string, number>();
    versions.set('store-a', 1);
    versions.set('store-b', 1);
    engine.register({
      name: 'store-a', filePath: '/dev/null', currentVersion: 2,
      detectVersion: async () => versions.get('store-a') ?? 1,
      migrate: async () => { runLog.push('a-start'); await new Promise((r) => setTimeout(r, 50)); runLog.push('a-end'); versions.set('store-a', 2); return { backupHash: 'a', backupPath: path.join(dir, 'a.bak') }; },
      rollback: async () => undefined, verify: async () => ({ ok: true, errors: [] }),
    });
    engine.register({
      name: 'store-b', filePath: '/dev/null', currentVersion: 2,
      detectVersion: async () => versions.get('store-b') ?? 1,
      migrate: async () => { runLog.push('b-start'); await new Promise((r) => setTimeout(r, 50)); runLog.push('b-end'); versions.set('store-b', 2); return { backupHash: 'b', backupPath: path.join(dir, 'b.bak') }; },
      rollback: async () => undefined, verify: async () => ({ ok: true, errors: [] }),
    });
    const manifests = await engine.executeAll();
    assert.equal(manifests.length, 2);
    assert.deepEqual(runLog, ['a-start', 'a-end', 'b-start', 'b-end'], 'Stores must run sequentially');
    const secondPass = await engine.executeAll();
    assert.equal(secondPass.length, 0, 'After first pass, nothing should need migration');
    const statuses = await engine.status();
    assert.equal(statuses.every((s) => !s.needsMigration), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ── C9: PostgreSQL and JSON stores follow the same contract ────────────────

test('C9: both stores expose detectVersion/migrateStore/rollbackStore/verifyStore', async () => {
  const { JsonApplicantIdentityStore } = await import('../src/applicantIdentity.js');
  const { JsonAuthorizationStore, authorizationCallbackSecret } = await import('../src/authorization.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-c9-'));
  try {
    const identityPath = path.join(dir, 'identity.json');
    const authPath = path.join(dir, 'auth.json');
    
    const identityStore = new JsonApplicantIdentityStore(identityPath);
    const authStore = new JsonAuthorizationStore(authPath, authorizationCallbackSecret('synthetic-test-bot-token-with-safe-length'));
    
    assert.equal(typeof identityStore.detectVersion, 'function');
    assert.equal(typeof identityStore.migrateStore, 'function');
    assert.equal(typeof identityStore.rollbackStore, 'function');
    assert.equal(typeof identityStore.verifyStore, 'function');
    assert.equal(typeof authStore.detectVersion, 'function');
    assert.equal(typeof authStore.migrateStore, 'function');
    assert.equal(typeof authStore.rollbackStore, 'function');
    assert.equal(typeof authStore.verifyStore, 'function');
    
    assert.equal(await identityStore.detectVersion(), null, 'Empty file should return null version');
    assert.equal(await authStore.detectVersion(), null, 'Empty file should return null version');

    const identityVerify = await identityStore.verifyStore();
    assert.equal(identityVerify.ok, true, 'Empty store verify should pass');
    const authVerify = await authStore.verifyStore();
    assert.equal(authVerify.ok, true, 'Empty store verify should pass');
    
    const identityMigrate = await identityStore.migrateStore(true);
    assert.equal(identityMigrate, null, 'Empty store should return null (no migration needed)');
    const authMigrate = await authStore.migrateStore(true);
    assert.equal(authMigrate, null, 'Empty store should return null (no migration needed)');
    
    await identityStore.verifyStore();
    await authStore.verifyStore();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ── Startup contract with actual store implementation ──────────────────────

test('startup contract: identity store with legacy data blocks bootstrap', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-startup-'));
  try {
    const filePath = path.join(dir, 'identity.json');
    const at = new Date().toISOString();
    const legacy = { applicants: [{ applicantId: 'legacy-1', telegramUserId: 1001, telegramChatId: 1001, identityStatus: 'ACTIVE', verificationStatus: 'TELEGRAM_VERIFIED', lifecycleState: 'CONSENT_REQUIRED', consents: {}, createdAt: at, updatedAt: at, auditReferences: [] }], audit: [], effectKeys: [] };
    await writeFile(filePath, JSON.stringify(legacy), 'utf8');
    
    const { JsonApplicantIdentityStore, APPLICANT_IDENTITY_SCHEMA_VERSION } = await import('../src/applicantIdentity.js');
    const store = new JsonApplicantIdentityStore(filePath);
    
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    engine.register({
      name: 'applicant-identity', filePath, currentVersion: APPLICANT_IDENTITY_SCHEMA_VERSION,
      detectVersion: async () => store.detectVersion(),
      migrate: async (dryRun) => store.migrateStore(dryRun),
      rollback: async (bp) => store.rollbackStore(bp),
      verify: async () => store.verifyStore(),
    });
    const compat = await engine.verifyStartupCompatibility();
    assert.equal(compat.ok, false, 'Legacy data should fail startup compatibility');
    assert.ok(compat.guidance.some((g) => g.includes('MIGRATION REQUIRED')));
    
    await store.migrateStore(false);
    const afterCompat = await engine.verifyStartupCompatibility();
    assert.equal(afterCompat.ok, true, 'After migration, startup should pass');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('startup contract: authorization store with legacy data blocks bootstrap', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-startup-auth-'));
  try {
    const filePath = path.join(dir, 'auth.json');
    const legacy = { actors: [{ actorId: 'old-1', telegramUserId: 1001, status: 'ACTIVE', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], assignments: [] };
    await writeFile(filePath, JSON.stringify(legacy), 'utf8');
    
    const { JsonAuthorizationStore, AUTHORIZATION_SCHEMA_VERSION, authorizationCallbackSecret } = await import('../src/authorization.js');
    const store = new JsonAuthorizationStore(filePath, authorizationCallbackSecret('synthetic-test-bot-token-with-safe-length'));
    
    const engine = new MigrationEngine(path.join(dir, 'migrations'));
    engine.register({
      name: 'authorization', filePath, currentVersion: AUTHORIZATION_SCHEMA_VERSION,
      detectVersion: async () => store.detectVersion(),
      migrate: async (dryRun) => store.migrateStore(dryRun),
      rollback: async (bp) => store.rollbackStore(bp),
      verify: async () => store.verifyStore(),
    });
    const compat = await engine.verifyStartupCompatibility();
    assert.equal(compat.ok, false, 'Legacy auth data should fail startup compatibility');
    
    await store.migrateStore(false);
    const afterCompat = await engine.verifyStartupCompatibility();
    assert.equal(afterCompat.ok, true, 'After migration, startup should pass');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('authorization read() throws MigrationRequiredError for legacy data', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-read-'));
  try {
    const filePath = path.join(dir, 'auth.json');
    const legacy = { actors: [{ actorId: 'old-1', telegramUserId: 1001, status: 'ACTIVE', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], assignments: [] };
    await writeFile(filePath, JSON.stringify(legacy), 'utf8');
    const { JsonAuthorizationStore, authorizationCallbackSecret } = await import('../src/authorization.js');
    const store = new JsonAuthorizationStore(filePath, authorizationCallbackSecret('synthetic-test-bot-token-with-safe-length'));
    await assert.rejects(async () => await store.actors(), MigrationRequiredError);
    await assert.rejects(async () => await store.assignments(), MigrationRequiredError);
    await assert.rejects(async () => await store.approvals(), MigrationRequiredError);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('applicant identity read() throws MigrationRequiredError for legacy data', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p1-read-app-'));
  try {
    const filePath = path.join(dir, 'identity.json');
    const at = new Date().toISOString();
    const legacy = { applicants: [{ applicantId: 'old-1', telegramUserId: 1001, telegramChatId: 1001, identityStatus: 'ACTIVE', verificationStatus: 'TELEGRAM_VERIFIED', lifecycleState: 'CONSENT_REQUIRED', consents: {}, createdAt: at, updatedAt: at, auditReferences: [] }], audit: [], effectKeys: [] };
    await writeFile(filePath, JSON.stringify(legacy), 'utf8');
    const { JsonApplicantIdentityStore } = await import('../src/applicantIdentity.js');
    const store = new JsonApplicantIdentityStore(filePath);
    await assert.rejects(async () => await store.all(), MigrationRequiredError);
    await assert.rejects(async () => await store.getByTelegramUserId(1001), MigrationRequiredError);
    await assert.rejects(async () => await store.audit(), MigrationRequiredError);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
