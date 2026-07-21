import dotenv from 'dotenv';
import type { AiConfig } from './aiAgent.js';

dotenv.config();

export interface AppConfig {
  botToken: string;
  adminIds: number[];
  leadsFile: string;
  leadWebhookUrl?: string;
  leadWebhookServiceId?: string;
  leadWebhookSecret?: string;
  academyReportBaseUrl?: string;
  academyReportTimeoutMs: number;
  webhookFailedFile: string;
  followupsFile: string;
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

export function loadConfig(): AppConfig {
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

  if (!botToken) {
    throw new Error('BOT_TOKEN is required. Copy .env.example to .env and set your Telegram bot token.');
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
    botToken,
    adminIds: parseAdminIds(process.env.ADMIN_IDS),
    leadsFile: process.env.LEADS_FILE ?? './data/leads.json',
    leadWebhookUrl: process.env.LEAD_WEBHOOK_URL?.trim() || undefined,
    leadWebhookServiceId,
    leadWebhookSecret,
    academyReportBaseUrl,
    academyReportTimeoutMs: parseBoundedInteger('ACADEMY_REPORT_TIMEOUT_MS', process.env.ACADEMY_REPORT_TIMEOUT_MS, 5_000, 500, 15_000),
    webhookFailedFile: process.env.WEBHOOK_FAILED_FILE ?? './data/webhook_failed.json',
    followupsFile: process.env.FOLLOWUPS_FILE ?? './data/followups.json',
    telegramUpdatesFile: process.env.TELEGRAM_UPDATES_FILE ?? './data/telegram_updates.json',
    telegramUpdateLeaseMs: parseBoundedInteger('TELEGRAM_UPDATE_LEASE_MS', process.env.TELEGRAM_UPDATE_LEASE_MS, 300_000, 30_000, 3_600_000),
    telegramUpdateRetention: parseBoundedInteger('TELEGRAM_UPDATE_RETENTION', process.env.TELEGRAM_UPDATE_RETENTION, 100_000, 10_000, 1_000_000),
    dailyReportEnabled: process.env.DAILY_REPORT_ENABLED !== 'false',
    dailyReportHour: parseReportHour(process.env.DAILY_REPORT_HOUR),
    operatorUsername: process.env.OPERATOR_USERNAME || '@hr_wst',
    operatorPhone: process.env.OPERATOR_PHONE || '+998333011511',
    botDescription: process.env.BOT_DESCRIPTION || 'WST Academy videokuzatuv kursi: 1 oy, 12 dars, offline real uskunalarda amaliyot. Manzil: Toshkent shahri, Arnasoy ko‘chasi, 33-uy. Keyingi guruh 2026-yil 4-avgustga rejalashtirilgan; qabulga qarab 1–2 kun siljishi mumkin. Darslar 10:00–16:00 oralig‘ida, kunlar guruh talabiga qarab belgilanadi.',
    botShortDescription: process.env.BOT_SHORT_DESCRIPTION || 'WST Academy: videokuzatuv bo‘yicha 1 oy, 12 dars. Offline, real uskunalarda amaliy kurs.',
    channelChatId: process.env.CHANNEL_CHAT_ID || '-1004297032922',
    salesDiscussionChatId: parseOptionalChatId(process.env.SALES_DISCUSSION_CHAT_ID),
    channelPostsFile: process.env.CHANNEL_POSTS_FILE || './data/channel_posts.json',
    opsAlertsFile: process.env.OPS_ALERTS_FILE || './data/ops_alerts.json',
    channelSchedulerEnabled: process.env.CHANNEL_SCHEDULER_ENABLED !== 'false',
    channelSchedulerPollMs: parseBoundedInteger('CHANNEL_SCHEDULER_POLL_MS', process.env.CHANNEL_SCHEDULER_POLL_MS, 30_000, 5_000, 300_000),
    channelPublishStaleMs: channelClaimLeaseMs,
    channelClaimLeaseMs,
    channelClaimRenewMs,
    channelUncertainWindowMs: parseBoundedInteger('CHANNEL_UNCERTAIN_WINDOW_MS', process.env.CHANNEL_UNCERTAIN_WINDOW_MS, 86_400_000, 300_000, 604_800_000),
    shutdownDrainTimeoutMs: parseBoundedInteger('SHUTDOWN_DRAIN_TIMEOUT_MS', process.env.SHUTDOWN_DRAIN_TIMEOUT_MS, 30_000, 1_000, 300_000),
    channelAssetRoot: process.env.CHANNEL_ASSET_ROOT?.trim() || './assets/channel',
    channelImageHosts: (process.env.CHANNEL_IMAGE_HOSTS || '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean),
    isProduction: process.env.NODE_ENV === 'production',
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
