import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const STAGING_SECRET_KEYS = [
  'NODE_ENV',
  'BOT_TOKEN',
  'CHANNEL_CHAT_ID',
  'ADMIN_IDS',
  'ACADEMY_DATA_DIR',
  'ACADEMY_MEDIA_DIR',
  'ACADEMY_BACKUP_DIR',
] as const;

export type StagingSecretKey = typeof STAGING_SECRET_KEYS[number];
export type StagingSecrets = Record<StagingSecretKey, string>;

const EXPECTED_PATHS: Pick<StagingSecrets, 'ACADEMY_DATA_DIR' | 'ACADEMY_MEDIA_DIR' | 'ACADEMY_BACKUP_DIR'> = {
  ACADEMY_DATA_DIR: './.staging-data',
  ACADEMY_MEDIA_DIR: './.staging-media',
  ACADEMY_BACKUP_DIR: './.staging-backups',
};

const PROHIBITED_INHERITED_KEYS = [
  'DATABASE_URL',
  'LEAD_WEBHOOK_URL',
  'LEAD_WEBHOOK_SERVICE_ID',
  'LEAD_WEBHOOK_SECRET',
  'ACADEMY_REPORT_BASE_URL',
  'AI_API_KEY',
  'AI_BASE_URL',
  'AI_FALLBACK_API_KEY',
  'AI_FALLBACK_BASE_URL',
  'OPS_AGGREGATE_PORT',
  'OPS_AGGREGATE_SERVICE_ID',
  'OPS_AGGREGATE_SECRET',
  'SALES_DISCUSSION_CHAT_ID',
] as const;

export function loadStagingSecrets(filePath: string, repoRoot: string): StagingSecrets {
  const values = new Map<string, string>();
  for (const raw of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error('Staging secret file contains an invalid assignment.');
    if (values.has(match[1])) throw new Error(`Staging secret file contains duplicate key ${match[1]}.`);
    if (!STAGING_SECRET_KEYS.includes(match[1] as StagingSecretKey)) throw new Error(`Staging secret file contains unsupported key ${match[1]}.`);
    values.set(match[1], match[2].trim());
  }
  for (const key of STAGING_SECRET_KEYS) {
    if (!values.get(key)) throw new Error(`Staging secret file is missing required key ${key}.`);
  }
  const secrets = Object.fromEntries(STAGING_SECRET_KEYS.map((key) => [key, values.get(key)!])) as StagingSecrets;
  if (secrets.NODE_ENV !== 'staging') throw new Error('NODE_ENV must be staging.');
  if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(secrets.BOT_TOKEN)) throw new Error('BOT_TOKEN has an invalid staging token format.');
  if (!/^-100\d+$/.test(secrets.CHANNEL_CHAT_ID)) throw new Error('CHANNEL_CHAT_ID has an invalid private-channel format.');
  if (!/^\d+(,\d+)*$/.test(secrets.ADMIN_IDS) || secrets.ADMIN_IDS.split(',').some((value) => !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) {
    throw new Error('ADMIN_IDS must contain one or more positive numeric IDs.');
  }
  if (!Number.isSafeInteger(Number(secrets.CHANNEL_CHAT_ID))) throw new Error('CHANNEL_CHAT_ID must be a safe Telegram channel ID.');
  for (const [key, expected] of Object.entries(EXPECTED_PATHS)) {
    const value = secrets[key as keyof typeof EXPECTED_PATHS];
    if (value !== expected) throw new Error(`${key} must be ${expected}.`);
    assertPathInside(repoRoot, value, key);
  }
  return secrets;
}

export function installStagingProcessEnvironment(secrets: StagingSecrets, env: NodeJS.ProcessEnv = process.env): void {
  for (const key of PROHIBITED_INHERITED_KEYS) {
    if (env[key]?.trim()) throw new Error(`${key} must be unset for the read-only staging precheck.`);
  }
  for (const key of STAGING_SECRET_KEYS) {
    const inherited = env[key];
    if (inherited?.trim() && inherited !== secrets[key]) throw new Error(`${key} conflicts with the staging secret file.`);
  }
  for (const key of STAGING_SECRET_KEYS) env[key] = secrets[key];
}

export function identityFingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function stagingAdminIds(secrets: StagingSecrets): number[] {
  return secrets.ADMIN_IDS.split(',').map((value) => Number(value));
}

export function resolveStagingPaths(secrets: StagingSecrets, repoRoot: string): string[] {
  return [secrets.ACADEMY_DATA_DIR, secrets.ACADEMY_MEDIA_DIR, secrets.ACADEMY_BACKUP_DIR]
    .map((value) => assertPathInside(repoRoot, value, 'staging path'));
}

function assertPathInside(repoRoot: string, value: string, name: string): string {
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error(`${name} must resolve inside the repository staging workspace.`);
  return resolved;
}
