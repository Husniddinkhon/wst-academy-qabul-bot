import dotenv from 'dotenv';
import type { AiConfig } from './aiAgent.js';

dotenv.config();

export interface AppConfig {
  botToken: string;
  adminIds: number[];
  leadsFile: string;
  leadWebhookUrl?: string;
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
