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
  webhookFailedFile: string;
  followupsFile: string;
  dailyReportEnabled: boolean;
  dailyReportHour: number;
  operatorUsername: string;
  operatorPhone: string;
  botDescription: string;
  botShortDescription: string;
  channelChatId: string;
  salesDiscussionChatId?: number;
  channelPostsFile: string;
  isProduction: boolean;
  ai: AiConfig;
  databaseUrl?: string;
}

function parseBoolean(value: string | undefined): boolean {
  return value?.toLowerCase() === 'true';
}

function parseTemperature(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0.3;
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

  return {
    botToken,
    adminIds: parseAdminIds(process.env.ADMIN_IDS),
    leadsFile: process.env.LEADS_FILE ?? './data/leads.json',
    leadWebhookUrl: process.env.LEAD_WEBHOOK_URL?.trim() || undefined,
    leadWebhookServiceId,
    leadWebhookSecret,
    webhookFailedFile: process.env.WEBHOOK_FAILED_FILE ?? './data/webhook_failed.json',
    followupsFile: process.env.FOLLOWUPS_FILE ?? './data/followups.json',
    dailyReportEnabled: process.env.DAILY_REPORT_ENABLED !== 'false',
    dailyReportHour: parseReportHour(process.env.DAILY_REPORT_HOUR),
    operatorUsername: process.env.OPERATOR_USERNAME || '@hr_wst',
    operatorPhone: process.env.OPERATOR_PHONE || '+998333011511',
    botDescription: process.env.BOT_DESCRIPTION || 'WST Academy videokuzatuv kursi: 1 oy, 12 dars, offline real uskunalarda amaliyot. Manzil: Toshkent shahri, Arnasoy ko‘chasi, 33-uy. Keyingi guruh 2026-yil 4-avgustga rejalashtirilgan; qabulga qarab 1–2 kun siljishi mumkin. Darslar 10:00–16:00 oralig‘ida, kunlar guruh talabiga qarab belgilanadi.',
    botShortDescription: process.env.BOT_SHORT_DESCRIPTION || 'WST Academy: videokuzatuv bo‘yicha 1 oy, 12 dars. Offline, real uskunalarda amaliy kurs.',
    channelChatId: process.env.CHANNEL_CHAT_ID || '-1004297032922',
    salesDiscussionChatId: parseOptionalChatId(process.env.SALES_DISCUSSION_CHAT_ID),
    channelPostsFile: process.env.CHANNEL_POSTS_FILE || './data/channel_posts.json',
    isProduction: process.env.NODE_ENV === 'production',
    databaseUrl: process.env.DATABASE_URL || undefined,
    ai: {
      enabled: parseBoolean(process.env.AI_ENABLED),
      provider: 'openai_compatible',
      apiKey: process.env.AI_API_KEY || undefined,
      baseUrl: process.env.AI_BASE_URL || undefined,
      model: process.env.AI_MODEL || undefined,
      temperature: parseTemperature(process.env.AI_TEMPERATURE),
    },
  };
}
