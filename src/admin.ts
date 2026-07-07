import { Input } from 'telegraf';
import type { BotContext, Lead } from './types.js';
import type { JsonLeadStore } from './storage.js';
import { formatLead, formatLeadList } from './messages.js';

export function isAdmin(ctx: BotContext, adminIds: number[]): boolean {
  const id = ctx.from?.id;
  return Boolean(id && adminIds.includes(id));
}

export async function notifyAdmins(ctx: BotContext, adminIds: number[], lead: Lead): Promise<void> {
  if (adminIds.length === 0) return;
  await Promise.allSettled(adminIds.map((adminId) => ctx.telegram.sendMessage(adminId, formatLead(lead))));
}


export interface HotLeadNotification {
  username?: string;
  telegramId?: number;
  message: string;
  reason: string;
}

export async function notifyHotLead(ctx: BotContext, adminIds: number[], lead: HotLeadNotification): Promise<void> {
  if (adminIds.length === 0) return;

  const text = [
    '🔥 Hot lead detected',
    `Username: ${lead.username ? `@${lead.username}` : '—'}`,
    `Telegram ID: ${lead.telegramId ?? '—'}`,
    `Message: ${lead.message}`,
    `Reason: ${lead.reason}`,
  ].join('\n');

  await Promise.allSettled(adminIds.map((adminId) => ctx.telegram.sendMessage(adminId, text)));
}

export function registerAdminCommands(bot: import('telegraf').Telegraf<BotContext>, store: JsonLeadStore, adminIds: number[]): void {
  bot.command('id', async (ctx) => {
    await ctx.reply(`Sizning Telegram ID: ${ctx.from?.id ?? 'aniqlanmadi'}`);
  });

  bot.command('leads_today', async (ctx) => {
    if (!isAdmin(ctx, adminIds)) return ctx.reply('⛔ Bu buyruq faqat adminlar uchun.');
    const leads = await store.today();
    return ctx.reply(formatLeadList(leads, 'Bugun hali lead yo‘q.'));
  });

  bot.command('last_leads', async (ctx) => {
    if (!isAdmin(ctx, adminIds)) return ctx.reply('⛔ Bu buyruq faqat adminlar uchun.');
    const leads = await store.last(10);
    return ctx.reply(formatLeadList(leads, 'Hali lead yo‘q.'));
  });

  bot.command('stats', async (ctx) => {
    if (!isAdmin(ctx, adminIds)) return ctx.reply('⛔ Bu buyruq faqat adminlar uchun.');
    const stats = await store.stats();
    return ctx.reply([`📊 Statistika`, `Jami leadlar: ${stats.total}`, `Bugun: ${stats.today}`, `Oxirgi 7 kun: ${stats.last7Days}`].join('\n'));
  });

  bot.command('export_csv', async (ctx) => {
    if (!isAdmin(ctx, adminIds)) return ctx.reply('⛔ Bu buyruq faqat adminlar uchun.');
    const csv = await store.toCsv();
    return ctx.replyWithDocument(Input.fromBuffer(Buffer.from(csv, 'utf8'), `wst-leads-${new Date().toISOString().slice(0, 10)}.csv`));
  });
}
