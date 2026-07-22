import dotenv from 'dotenv';
import path from 'node:path';
import type { AiConfig } from './aiAgent.js';

if (process.env.NODE_ENV !== 'staging') dotenv.config();

export interface AppConfig {
  environment: 'development' | 'staging' | 'production';
  botToken: string;
  adminIds: number[];
  leadsFile: string;
  applicantIdentitiesFile: string;
  authorizationFile: string;
  leadWebhookUrl?: string;
  leadWebhookServiceId?: string;
  leadWebhookSecret?: string;
  academyReportBaseUrl?: string;
  academyReportTimeoutMs: number;
  webhookFailedFile: string;
  webhookMaxAttempts: number;
  webhookRetentionMs: number;
  webhookRetryBaseMs: number;
  webhookRetryMaxMs: number;
  webhookClaimLeaseMs: number;
  webhookMaxManualReplays: number;
  followupsFile: string;
  followUpClaimLeaseMs: number;
  followUpMaxAttempts: number;
  followUpRetryBaseMs: number;
  followUpRetryMaxMs: number;
  telegramUpdatesFile: string;
  telegramUpdateLeaseMs: number;
  telegramUpdateRetention: number;
  dailyReportEnabled: boolean;
  dailyReportHour: number;
  operatorUsername: string;
  operatorPhone: string;
  botDescription: string;
  botShortDescription: string;
  channelChatId: string;
  salesDiscussionChatId?: number;
  channelPostsFile: string;
  opsAlertsFile: string;
  channelSchedulerEnabled: boolean;
  channelSchedulerPollMs: number;
  channelPublishStaleMs: number;
  channelClaimLeaseMs: number;
  channelClaimRenewMs: number;
  channelUncertainWindowMs: number;
  shutdownDrainTimeoutMs: number;
  channelAssetRoot: string;
  channelImageHosts: string[];
  isProduction: boolean;
  stagingDataDir?: string;
  stagingMediaDir?: string;
  stagingBackupDir?: string;
  ai: AiConfig;
  databaseUrl?: string;
  opsAggregatePort?: number;
  opsAggregateServiceId?: string;
  opsAggregateSecret?: string;
}

function parseBoolean(value: string | undefined): boolean {
  return value?.toLowerCase() === 'true';
}

function parseTemperature(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0.3;
}

function parseBoundedInteger(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value?.trim() ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function parseReportHour(value: string | undefined): number {
  const parsed = Number(value ?? 21);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : 21;
}

function parseAdminIds(value: string | undefined): number[] {
  if (!value) return [];

  return value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => Number(id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

function parseOptionalChatId(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed === 0) {
    throw new Error('SALES_DISCUSSION_CHAT_ID must be a valid Telegram chat ID.');
  }
  return parsed;
}

function parseEnvironment(value: string | undefined): AppConfig['environment'] {
  const normalized = value?.trim().toLowerCase() || 'development';
  if (!['development', 'staging', 'production'].includes(normalized)) {
    throw new Error('NODE_ENV must be development, staging or production.');
  }
  return normalized as AppConfig['environment'];
}

function requireStagingPath(name: string, value: string | undefined, expected: string): string {
  if (value !== expected) throw new Error(`${name} must be ${expected} in staging.`);
  const repoRoot = path.resolve(process.cwd());
  const resolved = path.resolve(repoRoot, value);
  if (!resolved.startsWith(`${repoRoot}${path.sep}`)) throw new Error(`${name} must resolve inside the repository staging workspace.`);
  return value;
}

export function loadConfig(): AppConfig {
  const environment = parseEnvironment(process.env.NODE_ENV);
  const isStaging = environment === 'staging';
  const botToken = process.env.BOT_TOKEN;
  const leadWebhookServiceId = process.env.LEAD_WEBHOOK_SERVICE_ID?.trim() || undefined;
  const leadWebhookSecret = process.env.LEAD_WEBHOOK_SECRET || undefined;
  const academyReportBaseUrl = process.env.ACADEMY_REPORT_BASE_URL?.trim().replace(/\/+$/, '') || undefined;
  const fallbackValues = [process.env.AI_FALLBACK_API_KEY, process.env.AI_FALLBACK_BASE_URL, process.env.AI_FALLBACK_MODEL];
  const requestTimeoutMs = parseBoundedInteger('AI_REQUEST_TIMEOUT_MS', process.env.AI_REQUEST_TIMEOUT_MS, 15_000, 1_000, 60_000);
  const maxOutputTokens = parseBoundedInteger('AI_MAX_OUTPUT_TOKENS', process.env.AI_MAX_OUTPUT_TOKENS, 300, 32, 2_048);
  const legacyChannelLease = process.env.CHANNEL_PUBLISH_STALE_MS;
  const channelClaimLeaseMs = parseBoundedInteger(process.env.CHANNEL_CLAIM_LEASE_MS === undefined && legacyChannelLease !== undefined ? 'CHANNEL_PUBLISH_STALE_MS' : 'CHANNEL_CLAIM_LEASE_MS', process.env.CHANNEL_CLAIM_LEASE_MS ?? legacyChannelLease, 600_000, 60_000, 86_400_000);
  const channelClaimRenewMs = parseBoundedInteger('CHANNEL_CLAIM_RENEW_MS', process.env.CHANNEL_CLAIM_RENEW_MS, 120_000, 5_000, 3_600_000);
  if (channelClaimRenewMs >= channelClaimLeaseMs) throw new Error('CHANNEL_CLAIM_RENEW_MS must be shorter than CHANNEL_CLAIM_LEASE_MS.');
  const followUpRetryBaseMs = parseBoundedInteger('FOLLOWUP_RETRY_BASE_MS', process.env.FOLLOWUP_RETRY_BASE_MS, 300_000, 1_000, 3_600_000);
  const followUpRetryMaxMs = parseBoundedInteger('FOLLOWUP_RETRY_MAX_MS', process.env.FOLLOWUP_RETRY_MAX_MS, 3_600_000, 1_000, 86_400_000);
  if (followUpRetryMaxMs < followUpRetryBaseMs) throw new Error('FOLLOWUP_RETRY_MAX_MS must be greater than or equal to FOLLOWUP_RETRY_BASE_MS.');
  const webhookRetryBaseMs = parseBoundedInteger('WEBHOOK_RETRY_BASE_MS', process.env.WEBHOOK_RETRY_BASE_MS, 60_000, 1_000, 3_600_000);
  const webhookRetryMaxMs = parseBoundedInteger('WEBHOOK_RETRY_MAX_MS', process.env.WEBHOOK_RETRY_MAX_MS, 3_600_000, 1_000, 86_400_000);
  if (webhookRetryMaxMs < webhookRetryBaseMs) throw new Error('WEBHOOK_RETRY_MAX_MS must be greater than or equal to WEBHOOK_RETRY_BASE_MS.');

  if (!botToken) {
    throw new Error('BOT_TOKEN is required. Copy .env.example to .env and set your Telegram bot token.');
  }
  const rawChannelChatId = process.env.CHANNEL_CHAT_ID?.trim();
  const rawAdminIds = process.env.ADMIN_IDS?.trim();
  let stagingDataDir: string | undefined;
  let stagingMediaDir: string | undefined;
  let stagingBackupDir: string | undefined;
  if (isStaging) {
    if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(botToken)) throw new Error('BOT_TOKEN must be a valid staging Telegram bot token.');
    if (!rawChannelChatId) throw new Error('CHANNEL_CHAT_ID is required in staging; no fallback is permitted.');
    if (!/^-100\d+$/.test(rawChannelChatId)) throw new Error('CHANNEL_CHAT_ID must be a Telegram channel ID in staging.');
    if (!rawAdminIds || !/^\d+(,\d+)*$/.test(rawAdminIds) || rawAdminIds.split(',').some((value) => !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) {
      throw new Error('ADMIN_IDS must contain one or more valid staging admin IDs.');
    }
    if (!Number.isSafeInteger(Number(rawChannelChatId))) throw new Error('CHANNEL_CHAT_ID must be a safe Telegram channel ID in staging.');
    if (process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is prohibited in local staging precheck; use staging-local JSON state.');
    const prohibitedTargets = ['LEAD_WEBHOOK_URL', 'LEAD_WEBHOOK_SERVICE_ID', 'LEAD_WEBHOOK_SECRET', 'ACADEMY_REPORT_BASE_URL', 'AI_API_KEY', 'AI_BASE_URL', 'AI_FALLBACK_API_KEY', 'AI_FALLBACK_BASE_URL', 'OPS_AGGREGATE_PORT', 'OPS_AGGREGATE_SERVICE_ID', 'OPS_AGGREGATE_SECRET', 'SALES_DISCUSSION_CHAT_ID'];
    const presentTarget = prohibitedTargets.find((name) => process.env[name]?.trim());
    if (presentTarget) throw new Error(`${presentTarget} is prohibited in the read-only staging precheck.`);
    const forbiddenOverrides = ['LEADS_FILE', 'APPLICANT_IDENTITIES_FILE', 'AUTHORIZATION_FILE', 'WEBHOOK_FAILED_FILE', 'FOLLOWUPS_FILE', 'TELEGRAM_UPDATES_FILE', 'CHANNEL_POSTS_FILE', 'OPS_ALERTS_FILE', 'CHANNEL_ASSET_ROOT'];
    const presentOverride = forbiddenOverrides.find((name) => process.env[name]?.trim());
    if (presentOverride) throw new Error(`${presentOverride} cannot override isolated ACADEMY_* paths in staging.`);
    stagingDataDir = requireStagingPath('ACADEMY_DATA_DIR', process.env.ACADEMY_DATA_DIR, './.staging-data');
    stagingMediaDir = requireStagingPath('ACADEMY_MEDIA_DIR', process.env.ACADEMY_MEDIA_DIR, './.staging-media');
    stagingBackupDir = requireStagingPath('ACADEMY_BACKUP_DIR', process.env.ACADEMY_BACKUP_DIR, './.staging-backups');
  }
  if (Boolean(leadWebhookServiceId) !== Boolean(leadWebhookSecret)) {
    throw new Error('LEAD_WEBHOOK_SERVICE_ID and LEAD_WEBHOOK_SECRET must be configured together.');
  }
  if (leadWebhookSecret && leadWebhookSecret.length < 32) {
    throw new Error('LEAD_WEBHOOK_SECRET must contain at least 32 characters.');
  }
  if (leadWebhookServiceId && !process.env.LEAD_WEBHOOK_URL?.trim()) {
    throw new Error('LEAD_WEBHOOK_URL is required when signed Academy webhook delivery is enabled.');
  }
  if (academyReportBaseUrl && (!leadWebhookServiceId || !leadWebhookSecret)) {
    throw new Error('ACADEMY_REPORT_BASE_URL requires the existing signed webhook service ID and secret.');
  }
  if (academyReportBaseUrl && !/^https:\/\//i.test(academyReportBaseUrl)) {
    throw new Error('ACADEMY_REPORT_BASE_URL must use HTTPS.');
  }
  if (fallbackValues.some(Boolean) && !fallbackValues.every(Boolean)) {
    throw new Error('AI_FALLBACK_API_KEY, AI_FALLBACK_BASE_URL and AI_FALLBACK_MODEL must be configured together.');
  }
  const opsAggregateSecret = process.env.OPS_AGGREGATE_SECRET || undefined;
  const opsAggregateServiceId = process.env.OPS_AGGREGATE_SERVICE_ID?.trim() || undefined;
  const opsAggregatePortRaw = process.env.OPS_AGGREGATE_PORT?.trim();
  if ([opsAggregateSecret, opsAggregateServiceId, opsAggregatePortRaw].some(Boolean) && ![opsAggregateSecret, opsAggregateServiceId, opsAggregatePortRaw].every(Boolean)) {
    throw new Error('OPS_AGGREGATE_PORT, OPS_AGGREGATE_SERVICE_ID and OPS_AGGREGATE_SECRET must be configured together.');
  }
  if (opsAggregateSecret && opsAggregateSecret.length < 32) throw new Error('OPS_AGGREGATE_SECRET must contain at least 32 characters.');

  return {
    environment,
    botToken,
    adminIds: parseAdminIds(process.env.ADMIN_IDS),
    leadsFile: isStaging ? path.join(stagingDataDir!, 'leads.json') : process.env.LEADS_FILE ?? './data/leads.json',
    applicantIdentitiesFile: isStaging ? path.join(stagingDataDir!, 'applicant_identities.json') : process.env.APPLICANT_IDENTITIES_FILE ?? './data/applicant_identities.json',
    authorizationFile: isStaging ? path.join(stagingDataDir!, 'authorization.json') : process.env.AUTHORIZATION_FILE ?? './data/authorization.json',
    leadWebhookUrl: process.env.LEAD_WEBHOOK_URL?.trim() || undefined,
    leadWebhookServiceId,
    leadWebhookSecret,
    academyReportBaseUrl,
    academyReportTimeoutMs: parseBoundedInteger('ACADEMY_REPORT_TIMEOUT_MS', process.env.ACADEMY_REPORT_TIMEOUT_MS, 5_000, 500, 15_000),
    webhookFailedFile: isStaging ? path.join(stagingDataDir!, 'webhook_failed.json') : process.env.WEBHOOK_FAILED_FILE ?? './data/webhook_failed.json',
    webhookMaxAttempts: parseBoundedInteger('WEBHOOK_MAX_ATTEMPTS', process.env.WEBHOOK_MAX_ATTEMPTS, 5, 1, 20),
    webhookRetentionMs: parseBoundedInteger('WEBHOOK_RETENTION_MS', process.env.WEBHOOK_RETENTION_MS, 604_800_000, 3_600_000, 2_592_000_000),
    webhookRetryBaseMs,
    webhookRetryMaxMs,
    webhookClaimLeaseMs: parseBoundedInteger('WEBHOOK_CLAIM_LEASE_MS', process.env.WEBHOOK_CLAIM_LEASE_MS, 600_000, 30_000, 3_600_000),
    webhookMaxManualReplays: parseBoundedInteger('WEBHOOK_MAX_MANUAL_REPLAYS', process.env.WEBHOOK_MAX_MANUAL_REPLAYS, 1, 1, 3),
    followupsFile: isStaging ? path.join(stagingDataDir!, 'followups.json') : process.env.FOLLOWUPS_FILE ?? './data/followups.json',
    followUpClaimLeaseMs: parseBoundedInteger('FOLLOWUP_CLAIM_LEASE_MS', process.env.FOLLOWUP_CLAIM_LEASE_MS, 300_000, 30_000, 3_600_000),
    followUpMaxAttempts: parseBoundedInteger('FOLLOWUP_MAX_ATTEMPTS', process.env.FOLLOWUP_MAX_ATTEMPTS, 3, 1, 10),
    followUpRetryBaseMs,
    followUpRetryMaxMs,
    telegramUpdatesFile: isStaging ? path.join(stagingDataDir!, 'telegram_updates.json') : process.env.TELEGRAM_UPDATES_FILE ?? './data/telegram_updates.json',
    telegramUpdateLeaseMs: parseBoundedInteger('TELEGRAM_UPDATE_LEASE_MS', process.env.TELEGRAM_UPDATE_LEASE_MS, 300_000, 30_000, 3_600_000),
    telegramUpdateRetention: parseBoundedInteger('TELEGRAM_UPDATE_RETENTION', process.env.TELEGRAM_UPDATE_RETENTION, 100_000, 10_000, 1_000_000),
    dailyReportEnabled: process.env.DAILY_REPORT_ENABLED !== 'false',
    dailyReportHour: parseReportHour(process.env.DAILY_REPORT_HOUR),
    operatorUsername: process.env.OPERATOR_USERNAME || '@hr_wst',
    operatorPhone: process.env.OPERATOR_PHONE || '+998333011511',
    botDescription: process.env.BOT_DESCRIPTION || 'WST Academy videokuzatuv kursi: 1 oy, 12 dars, offline real uskunalarda amaliyot. Manzil: Toshkent shahri, Arnasoy ko‘chasi, 33-uy. Keyingi guruh 2026-yil 4-avgustga rejalashtirilgan; qabulga qarab 1–2 kun siljishi mumkin. Darslar 10:00–16:00 oralig‘ida, kunlar guruh talabiga qarab belgilanadi.',
    botShortDescription: process.env.BOT_SHORT_DESCRIPTION || 'WST Academy: videokuzatuv bo‘yicha 1 oy, 12 dars. Offline, real uskunalarda amaliy kurs.',
    channelChatId: rawChannelChatId || '-1004297032922',
    salesDiscussionChatId: parseOptionalChatId(process.env.SALES_DISCUSSION_CHAT_ID),
    channelPostsFile: isStaging ? path.join(stagingDataDir!, 'channel_posts.json') : process.env.CHANNEL_POSTS_FILE || './data/channel_posts.json',
    opsAlertsFile: isStaging ? path.join(stagingDataDir!, 'ops_alerts.json') : process.env.OPS_ALERTS_FILE || './data/ops_alerts.json',
    channelSchedulerEnabled: process.env.CHANNEL_SCHEDULER_ENABLED !== 'false',
    channelSchedulerPollMs: parseBoundedInteger('CHANNEL_SCHEDULER_POLL_MS', process.env.CHANNEL_SCHEDULER_POLL_MS, 30_000, 5_000, 300_000),
    channelPublishStaleMs: channelClaimLeaseMs,
    channelClaimLeaseMs,
    channelClaimRenewMs,
    channelUncertainWindowMs: parseBoundedInteger('CHANNEL_UNCERTAIN_WINDOW_MS', process.env.CHANNEL_UNCERTAIN_WINDOW_MS, 86_400_000, 300_000, 604_800_000),
    shutdownDrainTimeoutMs: parseBoundedInteger('SHUTDOWN_DRAIN_TIMEOUT_MS', process.env.SHUTDOWN_DRAIN_TIMEOUT_MS, 30_000, 1_000, 300_000),
    channelAssetRoot: isStaging ? stagingMediaDir! : process.env.CHANNEL_ASSET_ROOT?.trim() || './assets/channel',
    channelImageHosts: (process.env.CHANNEL_IMAGE_HOSTS || '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean),
    isProduction: environment === 'production',
    stagingDataDir,
    stagingMediaDir,
    stagingBackupDir,
    databaseUrl: process.env.DATABASE_URL || undefined,
    opsAggregatePort: opsAggregatePortRaw ? parseBoundedInteger('OPS_AGGREGATE_PORT', opsAggregatePortRaw, 8381, 1024, 65535) : undefined,
    opsAggregateServiceId,
    opsAggregateSecret,
    ai: {
      enabled: parseBoolean(process.env.AI_ENABLED),
      provider: 'openai_compatible',
      apiKey: process.env.AI_API_KEY || undefined,
      baseUrl: process.env.AI_BASE_URL || undefined,
      model: process.env.AI_MODEL || undefined,
      temperature: parseTemperature(process.env.AI_TEMPERATURE),
      requestTimeoutMs,
      maxOutputTokens,
      supportsMaxOutputTokens: process.env.AI_MAX_OUTPUT_TOKENS_ENABLED !== 'false',
      reliability: {
        rateLimitMaxRequests: parseBoundedInteger('AI_RATE_LIMIT_MAX_REQUESTS', process.env.AI_RATE_LIMIT_MAX_REQUESTS, 6, 1, 100),
        rateLimitWindowMs: parseBoundedInteger('AI_RATE_LIMIT_WINDOW_MS', process.env.AI_RATE_LIMIT_WINDOW_MS, 60_000, 1_000, 3_600_000),
        circuitFailureThreshold: parseBoundedInteger('AI_CIRCUIT_FAILURE_THRESHOLD', process.env.AI_CIRCUIT_FAILURE_THRESHOLD, 3, 1, 20),
        circuitBaseBackoffMs: parseBoundedInteger('AI_CIRCUIT_BASE_BACKOFF_MS', process.env.AI_CIRCUIT_BASE_BACKOFF_MS, 30_000, 1_000, 600_000),
        circuitMaxBackoffMs: parseBoundedInteger('AI_CIRCUIT_MAX_BACKOFF_MS', process.env.AI_CIRCUIT_MAX_BACKOFF_MS, 300_000, 1_000, 3_600_000),
      },
      fallback: fallbackValues.every(Boolean)
        ? {
            provider: 'openai_compatible',
            apiKey: process.env.AI_FALLBACK_API_KEY,
            baseUrl: process.env.AI_FALLBACK_BASE_URL,
            model: process.env.AI_FALLBACK_MODEL,
            temperature: parseTemperature(process.env.AI_FALLBACK_TEMPERATURE),
            requestTimeoutMs: parseBoundedInteger('AI_FALLBACK_REQUEST_TIMEOUT_MS', process.env.AI_FALLBACK_REQUEST_TIMEOUT_MS, requestTimeoutMs, 1_000, 60_000),
            maxOutputTokens: parseBoundedInteger('AI_FALLBACK_MAX_OUTPUT_TOKENS', process.env.AI_FALLBACK_MAX_OUTPUT_TOKENS, maxOutputTokens, 32, 2_048),
            supportsMaxOutputTokens: process.env.AI_FALLBACK_MAX_OUTPUT_TOKENS_ENABLED !== 'false',
          }
        : undefined,
    },
  };
}

export function runtimeEnvironmentEvent(config: Pick<AppConfig, 'environment'>): { event: 'runtime_environment'; mode: 'STAGING MODE'; production: false; isolatedState: true } | undefined {
  return config.environment === 'staging'
    ? { event: 'runtime_environment', mode: 'STAGING MODE', production: false, isolatedState: true }
    : undefined;
}
