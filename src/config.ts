import dotenv from 'dotenv';
import type { AiConfig } from './aiAgent.js';

dotenv.config();

export interface AppConfig {
  botToken: string;
  adminIds: number[];
  leadsFile: string;
  leadWebhookUrl?: string;
  webhookFailedFile: string;
  followupsFile: string;
  dailyReportEnabled: boolean;
  dailyReportHour: number;
  operatorUsername: string;
  operatorPhone: string;
  botDescription: string;
  channelChatId: string;
  channelPostsFile: string;
  isProduction: boolean;
  ai: AiConfig;
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

export function loadConfig(): AppConfig {
  const botToken = process.env.BOT_TOKEN;

  if (!botToken) {
    throw new Error('BOT_TOKEN is required. Copy .env.example to .env and set your Telegram bot token.');
  }

  return {
    botToken,
    adminIds: parseAdminIds(process.env.ADMIN_IDS),
    leadsFile: process.env.LEADS_FILE ?? './data/leads.json',
    leadWebhookUrl: process.env.LEAD_WEBHOOK_URL || undefined,
    webhookFailedFile: process.env.WEBHOOK_FAILED_FILE ?? './data/webhook_failed.json',
    followupsFile: process.env.FOLLOWUPS_FILE ?? './data/followups.json',
    dailyReportEnabled: process.env.DAILY_REPORT_ENABLED !== 'false',
    dailyReportHour: parseReportHour(process.env.DAILY_REPORT_HOUR),
    operatorUsername: process.env.OPERATOR_USERNAME || '@hr_wst',
    operatorPhone: process.env.OPERATOR_PHONE || '+998333011511',
    botDescription: process.env.BOT_DESCRIPTION || 'WST Academy qabul boti. Videokuzatuv tizimlari boyicha 1 oylik offline kurs: 12 ta dars, real uskunalarda amaliy mashgulotlar. Kurs dasturi, narxi va royxatdan otish haqida malumot oling.',
    channelChatId: process.env.CHANNEL_CHAT_ID || '-1004297032922',
    channelPostsFile: process.env.CHANNEL_POSTS_FILE || './data/channel_posts.json',
    isProduction: process.env.NODE_ENV === 'production',
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
