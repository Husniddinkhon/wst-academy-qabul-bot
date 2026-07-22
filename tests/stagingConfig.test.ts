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
ACADEMY_BACKUP_KEY=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
ACADEMY_BACKUP_S3_ENDPOINT=https://s3.us-east-005.backblazeb2.com
ACADEMY_BACKUP_S3_REGION=us-east-005
ACADEMY_BACKUP_S3_BUCKET=wst-academy-staging-backup
ACADEMY_BACKUP_S3_PREFIX=staging/
ACADEMY_BACKUP_S3_ACCESS_KEY_ID=005a2f06ef76e140000000001
ACADEMY_BACKUP_S3_SECRET_ACCESS_KEY=K000ABCDEF1234567890abcdef1234567890abcdef
UNV_PROMOTION_START_DATE=2026-07-01
UNV_PROMOTION_END_DATE=2026-09-30
`;

test('strict staging secret parser accepts all sixteen isolated staging values', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'academy-staging-config-'));
  try {
    const file = path.join(root, '.env.staging.local');
    await writeFile(file, valid);
    const parsed = loadStagingSecrets(file, root);
    assert.equal(parsed.NODE_ENV, 'staging');
    assert.equal(parsed.ACADEMY_BACKUP_S3_BUCKET, 'wst-academy-staging-backup');
    assert.equal(parsed.ACADEMY_BACKUP_S3_PREFIX, 'staging/');
    assert.equal(parsed.UNV_PROMOTION_END_DATE, '2026-09-30');
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

test('staging config rejects malformed S3 endpoint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'academy-staging-s3-'));
  const file = path.join(root, '.env.staging.local');
  try {
    await writeFile(file, valid.replace('https://s3.us-east-005.backblazeb2.com', 'http://insecure.endpoint'));
    assert.throws(() => loadStagingSecrets(file, root), /ACADEMY_BACKUP_S3_ENDPOINT must use HTTPS/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('staging config rejects unsafe S3 prefix', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'academy-staging-prefix-'));
  const file = path.join(root, '.env.staging.local');
  try {
    await writeFile(file, valid.replace('staging/', '../escape'));
    assert.throws(() => loadStagingSecrets(file, root), /ACADEMY_BACKUP_S3_PREFIX must be/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('staging config rejects invalid backup key', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'academy-staging-key-'));
  const file = path.join(root, '.env.staging.local');
  try {
    await writeFile(file, valid.replace('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', 'invalid-key'));
    assert.throws(() => loadStagingSecrets(file, root), /ACADEMY_BACKUP_KEY must be exactly 64 hex/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('staging config rejects reversed campaign dates', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'academy-staging-dates-'));
  const file = path.join(root, '.env.staging.local');
  try {
    await writeFile(file, valid.replace('UNV_PROMOTION_END_DATE=2026-09-30', 'UNV_PROMOTION_END_DATE=2026-06-01'));
    assert.throws(() => loadStagingSecrets(file, root), /UNV_PROMOTION_END_DATE must not be before/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('staging config rejects missing S3 credential', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'academy-staging-cred-'));
  const file = path.join(root, '.env.staging.local');
  try {
    await writeFile(file, valid.replace('ACADEMY_BACKUP_S3_SECRET_ACCESS_KEY=K000ABCDEF1234567890abcdef1234567890abcdef', 'ACADEMY_BACKUP_S3_SECRET_ACCESS_KEY=short'));
    assert.throws(() => loadStagingSecrets(file, root), /ACADEMY_BACKUP_S3_SECRET_ACCESS_KEY is too short/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('staging process install rejects conflicting identities and inherited production targets', () => {
  const secrets = {
    NODE_ENV: 'staging', BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyzABCDE', CHANNEL_CHAT_ID: '-1009876543210', ADMIN_IDS: '123456789',
    ACADEMY_DATA_DIR: './.staging-data', ACADEMY_MEDIA_DIR: './.staging-media', ACADEMY_BACKUP_DIR: './.staging-backups',
    ACADEMY_BACKUP_KEY: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    ACADEMY_BACKUP_S3_ENDPOINT: 'https://s3.example.com', ACADEMY_BACKUP_S3_REGION: 'us-east-1',
    ACADEMY_BACKUP_S3_BUCKET: 'test-bucket', ACADEMY_BACKUP_S3_PREFIX: 'staging/',
    ACADEMY_BACKUP_S3_ACCESS_KEY_ID: 'AKIAXXXXXXXXXXXXXXXXXX', ACADEMY_BACKUP_S3_SECRET_ACCESS_KEY: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    UNV_PROMOTION_START_DATE: '2026-07-01', UNV_PROMOTION_END_DATE: '2026-09-30',
  } as const;
  assert.throws(() => installStagingProcessEnvironment(secrets, { BOT_TOKEN: 'different-token' }), /BOT_TOKEN conflicts/);
  assert.throws(() => installStagingProcessEnvironment(secrets, { DATABASE_URL: 'postgres://production.invalid/database' }), /DATABASE_URL must be unset/);
  const env: NodeJS.ProcessEnv = {};
  installStagingProcessEnvironment(secrets, env);
  assert.equal(env.NODE_ENV, 'staging');
  assert.equal(env.CHANNEL_CHAT_ID, '-1009876543210');
});
