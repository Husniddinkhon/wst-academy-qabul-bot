import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { identityFingerprint, installStagingProcessEnvironment, loadStagingSecrets, resolveStagingPaths } from '../src/stagingConfig.js';

const valid = `NODE_ENV=staging
BOT_TOKEN=123456789:abcdefghijklmnopqrstuvwxyzABCDE
CHANNEL_CHAT_ID=-1009876543210
ADMIN_IDS=123456789
ACADEMY_DATA_DIR=./.staging-data
ACADEMY_MEDIA_DIR=./.staging-media
ACADEMY_BACKUP_DIR=./.staging-backups
`;

test('strict staging secret parser accepts only the seven isolated staging values', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'academy-staging-config-'));
  try {
    const file = path.join(root, '.env.staging.local');
    await writeFile(file, valid);
    const parsed = loadStagingSecrets(file, root);
    assert.equal(parsed.NODE_ENV, 'staging');
    assert.deepEqual(resolveStagingPaths(parsed, root), [path.join(root, '.staging-data'), path.join(root, '.staging-media'), path.join(root, '.staging-backups')]);
    assert.match(identityFingerprint(parsed.CHANNEL_CHAT_ID), /^[a-f0-9]{64}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('staging secret parser rejects missing, duplicate, unknown and escaping values without echoing secrets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'academy-staging-reject-'));
  const file = path.join(root, '.env.staging.local');
  try {
    await writeFile(file, valid.replace('CHANNEL_CHAT_ID=-1009876543210\n', ''));
    assert.throws(() => loadStagingSecrets(file, root), /missing required key CHANNEL_CHAT_ID/);
    await writeFile(file, `${valid}BOT_TOKEN=do-not-echo-this-token\n`);
    assert.throws(() => loadStagingSecrets(file, root), (error: unknown) => error instanceof Error && /duplicate key BOT_TOKEN/.test(error.message) && !error.message.includes('do-not-echo'));
    await writeFile(file, `${valid}DATABASE_URL=postgres:\/\/production.invalid\n`);
    assert.throws(() => loadStagingSecrets(file, root), /unsupported key DATABASE_URL/);
    await writeFile(file, valid.replace('./.staging-data', '../outside'));
    assert.throws(() => loadStagingSecrets(file, root), /ACADEMY_DATA_DIR must be/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('staging process install rejects conflicting identities and inherited production targets', () => {
  const secrets = {
    NODE_ENV: 'staging', BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyzABCDE', CHANNEL_CHAT_ID: '-1009876543210', ADMIN_IDS: '123456789',
    ACADEMY_DATA_DIR: './.staging-data', ACADEMY_MEDIA_DIR: './.staging-media', ACADEMY_BACKUP_DIR: './.staging-backups',
  } as const;
  assert.throws(() => installStagingProcessEnvironment(secrets, { BOT_TOKEN: 'different-token' }), /BOT_TOKEN conflicts/);
  assert.throws(() => installStagingProcessEnvironment(secrets, { DATABASE_URL: 'postgres://production.invalid/database' }), /DATABASE_URL must be unset/);
  const env: NodeJS.ProcessEnv = {};
  installStagingProcessEnvironment(secrets, env);
  assert.equal(env.NODE_ENV, 'staging');
  assert.equal(env.CHANNEL_CHAT_ID, '-1009876543210');
});
