import dotenv from 'dotenv';

dotenv.config();

export interface AppConfig {
  botToken: string;
  adminIds: number[];
  leadsFile: string;
  leadWebhookUrl?: string;
  isProduction: boolean;
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
  };
}
