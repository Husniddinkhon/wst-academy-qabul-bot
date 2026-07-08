import { Input } from 'telegraf';
import type { BotContext, LeadStatus } from './types.js';
import type { JsonLeadStore, JsonWebhookFailureStore } from './storage.js';
import { formatLead, formatLeadList } from './messages.js';
import { deliverLeadWebhook, retryFailedWebhooks } from './webhook.js';

const HOT_LEAD_COOLDOWN_MS = 30 * 60 * 1000;
const lastHotLeadAtByTelegramId = new Map<number, number>();

export function isAdmin(ctx: BotContext, adminIds: number[]): boolean { const id = ctx.from?.id; return Boolean(id && adminIds.includes(id)); }
export async function notifyAdmins(ctx: BotContext, adminIds: number[], lead: import('./types.js').Lead): Promise<void> { if (adminIds.length === 0) return; await Promise.allSettled(adminIds.map((adminId) => ctx.telegram.sendMessage(adminId, formatLead(lead)))); }
export interface HotLeadNotification { username?: string; telegramId?: number; phone?: string; message: string; reason: string; }
export async function notifyHotLead(ctx: BotContext, adminIds: number[], lead: HotLeadNotification): Promise<void> { if (adminIds.length === 0 || !canNotifyHotLead(lead.telegramId)) return; await Promise.allSettled(adminIds.map((adminId) => ctx.telegram.sendMessage(adminId, ['🔥 Hot lead detected',`Username: ${lead.username ? `@${lead.username}` : '—'}`,`Telegram ID: ${lead.telegramId ?? '—'}`,lead.phone ? `Phone: ${lead.phone}` : undefined,`Message: ${lead.message}`,`Reason: ${lead.reason}`].filter(Boolean).join('\n')))); }
export async function notifyCallRequestLead(ctx: BotContext, adminIds: number[], lead: HotLeadNotification): Promise<void> { if (adminIds.length === 0 || !canNotifyHotLead(lead.telegramId)) return; await Promise.allSettled(adminIds.map((adminId) => ctx.telegram.sendMessage(adminId, ['🔥 Call request lead',`Username: ${lead.username ? `@${lead.username}` : '—'}`,`Telegram ID: ${lead.telegramId ?? '—'}`,`Phone: ${lead.phone ?? '—'}`,`Message: ${lead.message}`,`Reason: ${lead.reason}`].join('\n')))); }
function canNotifyHotLead(telegramId?: number): boolean { if (!telegramId) return true; const now = Date.now(); const last = lastHotLeadAtByTelegramId.get(telegramId) ?? 0; if (now - last < HOT_LEAD_COOLDOWN_MS) return false; lastHotLeadAtByTelegramId.set(telegramId, now); return true; }

const VALID_STATUSES: LeadStatus[] = ['New', 'Warm', 'Hot', 'RegistrationCompleted', 'CallRequested', 'OperatorContacted', 'Paid', 'Rejected'];

function yesNo(value: unknown): string {
  return value ? 'OK' : 'MISSING';
}

function configured(value: unknown): string {
  return value ? 'configured' : 'empty';
}

function envValue(name: string, fallback = ''): string {
  return process.env[name] || fallback;
}

async function safeStoreStats(store: JsonLeadStore): Promise<string[]> {
  try {
    const stats = await store.stats();
    return [
      `Jami leadlar: ${stats.total}`,
      `Bugun: ${stats.today}`,
      `Hot: ${stats.hot}`,
      `Call requests: ${stats.callRequests}`,
      `No phone: ${stats.noPhone}`,
    ];
  } catch (error) {
    return [`Lead storage: ERROR (${error instanceof Error ? error.message : 'unknown'})`];
  }
}

export function registerAdminCommands(bot: import('telegraf').Telegraf<BotContext>, store: JsonLeadStore, adminIds: number[], failureStore: JsonWebhookFailureStore, leadWebhookUrl?: string): void {
  const guard = async (ctx: BotContext): Promise<boolean> => { if (isAdmin(ctx, adminIds)) return true; await ctx.reply('⛔ Bu buyruq faqat adminlar uchun.'); return false; };
  const commandText = (ctx: BotContext): string => ctx.message && 'text' in ctx.message && ctx.message.text ? ctx.message.text : '';
  bot.command('id', async (ctx) => ctx.reply(`Sizning Telegram ID: ${ctx.from?.id ?? 'aniqlanmadi'}`));
  bot.command('admin_help', async (ctx) => {
    if (!(await guard(ctx))) return;
    return ctx.reply([
      'Admin buyruqlari:',
      '/setup_status — sozlamalar holati',
      '/health — bot sog‘liq tekshiruvi',
      '/ads_check — Telegram Ads tayyorlik tekshiruvi',
      '/leads_today — bugungi leadlar',
      '/last_leads — oxirgi 10 lead',
      '/hot_leads — hot leadlar',
      '/call_requests — qo‘ng‘iroq so‘ragan leadlar',
      '/stats — umumiy statistika',
      '/export_csv — barcha leadlarni CSV qilish',
      '/lead <telegram_id> — bitta leadni ko‘rish',
      `/set_status <telegram_id> <status> — status o‘zgartirish (${VALID_STATUSES.join(', ')})`,
      '/operator_note <telegram_id> <note> — operator izohi qo‘shish',
      '/retry_webhooks — yuborilmay qolgan webhooklarni qayta yuborish',
    ].join('\n'));
  });

  bot.command('setup_status', async (ctx) => {
    if (!(await guard(ctx))) return;
    return ctx.reply([
      '⚙️ Setup status',
      `BOT_TOKEN: ${yesNo(process.env.BOT_TOKEN)}`,
      `ADMIN_IDS: ${adminIds.length > 0 ? `configured (${adminIds.length})` : 'MISSING'}`,
      `LEADS_FILE: ${envValue('LEADS_FILE', './data/leads.json')}`,
      `LEAD_WEBHOOK_URL: ${configured(leadWebhookUrl)}`,
      `WEBHOOK_FAILED_FILE: ${envValue('WEBHOOK_FAILED_FILE', './data/webhook_failed.json')}`,
      `FOLLOWUPS_FILE: ${envValue('FOLLOWUPS_FILE', './data/followups.json')}`,
      `NODE_ENV: ${envValue('NODE_ENV', 'not set')}`,
      `AI_ENABLED: ${envValue('AI_ENABLED', 'false')}`,
      `AI_PROVIDER: ${envValue('AI_PROVIDER', 'openai_compatible')}`,
      `AI_API_KEY: ${yesNo(process.env.AI_API_KEY)}`,
      `AI_BASE_URL: ${envValue('AI_BASE_URL', 'not set')}`,
      `AI_MODEL: ${envValue('AI_MODEL', 'not set')}`,
      `OPERATOR_USERNAME: ${envValue('OPERATOR_USERNAME', '@hr_wst')}`,
      `OPERATOR_PHONE: ${envValue('OPERATOR_PHONE', '+998333011511')}`,
      `DAILY_REPORT_ENABLED: ${envValue('DAILY_REPORT_ENABLED', 'true')}`,
      `DAILY_REPORT_HOUR: ${envValue('DAILY_REPORT_HOUR', '21')}`,
    ].join('\n'));
  });

  bot.command('health', async (ctx) => {
    if (!(await guard(ctx))) return;
    const statsLines = await safeStoreStats(store);
    return ctx.reply([
      '✅ Health check',
      'Bot: online',
      `Admin: ${adminIds.length > 0 ? 'configured' : 'missing'}`,
      `AI: ${process.env.AI_ENABLED === 'true' && process.env.AI_API_KEY ? 'enabled' : 'disabled or incomplete'}`,
      `Webhook: ${configured(leadWebhookUrl)}`,
      `Operator: ${envValue('OPERATOR_USERNAME', '@hr_wst')} / ${envValue('OPERATOR_PHONE', '+998333011511')}`,
      ...statsLines,
    ].join('\n'));
  });

  bot.command('ads_check', async (ctx) => {
    if (!(await guard(ctx))) return;
    return ctx.reply([
      '📣 Telegram Ads readiness',
      'Destination tavsiya: avval kanal, keyin bot.',
      'Safe URL: t.me/wstacademy_uz',
      '',
      'Safe ad text:',
      'Videokuzatuv tizimlarini amaliy o‘rganing. 1 oylik offline kurs: 12 dars, real uskunalar va amaliy mashg‘ulotlar.',
      '',
      'Tekshiruv:',
      `Bot token: ${yesNo(process.env.BOT_TOKEN)}`,
      `AI: ${process.env.AI_ENABLED === 'true' && process.env.AI_API_KEY ? 'OK' : 'incomplete'}`,
      `Operator: ${envValue('OPERATOR_USERNAME', '@hr_wst')}`,
      `Webhook: ${configured(leadWebhookUrl)}`,
      '',
      'Reklamada vaqtincha ishlatmang:',
      'ish kafolati, tez boyish, 100% daromad, ish taklifi, daromadli kasb.',
      '',
      'Rasmli reklamadan oldin text-only safe versiyani reviewga yuboring.',
    ].join('\n'));
  });

  bot.command('leads_today', async (ctx) => { if (!(await guard(ctx))) return; return ctx.reply(formatLeadList(await store.today(), 'Bugun hali lead yo‘q.')); });
  bot.command('last_leads', async (ctx) => { if (!(await guard(ctx))) return; return ctx.reply(formatLeadList(await store.last(10), 'Hali lead yo‘q.')); });
  bot.command('hot_leads', async (ctx) => { if (!(await guard(ctx))) return; return ctx.reply(formatLeadList((await store.all()).filter((l) => l.status === 'Hot'), 'Hot lead yo‘q.')); });
  bot.command('call_requests', async (ctx) => { if (!(await guard(ctx))) return; return ctx.reply(formatLeadList((await store.all()).filter((l) => l.status === 'CallRequested'), 'Call request yo‘q.')); });
  bot.command('stats', async (ctx) => { if (!(await guard(ctx))) return; const s = await store.stats(); return ctx.reply([`📊 Statistika`,`Jami leadlar: ${s.total}`,`Bugun: ${s.today}`,`Oxirgi 7 kun: ${s.last7Days}`,`Hot: ${s.hot}`,`Call requests: ${s.callRequests}`,`Completed: ${s.completed}`,`No phone: ${s.noPhone}`].join('\n')); });
  bot.command('export_csv', async (ctx) => { if (!(await guard(ctx))) return; const csv = await store.toCsv(); return ctx.replyWithDocument(Input.fromBuffer(Buffer.from(csv, 'utf8'), `wst-leads-${new Date().toISOString().slice(0, 10)}.csv`)); });
  bot.command('retry_webhooks', async (ctx) => { if (!(await guard(ctx))) return; const r = await retryFailedWebhooks(leadWebhookUrl, failureStore); return ctx.reply(`Webhook retry: attempted ${r.attempted}, sent ${r.sent}, remaining ${r.remaining}`); });
  bot.command('lead', async (ctx) => { if (!(await guard(ctx))) return; const id = Number(commandText(ctx).split(/\s+/)[1]); const lead = Number.isSafeInteger(id) ? await store.getByTelegramId(id) : undefined; return ctx.reply(lead ? formatLead(lead) : 'Lead topilmadi.'); });
  bot.command('set_status', async (ctx) => {
    if (!(await guard(ctx))) return;
    const [, idText, statusText] = commandText(ctx).split(/\s+/);
    const telegramId = Number(idText);
    const status = VALID_STATUSES.find((item) => item.toLowerCase() === statusText?.toLowerCase());

    if (!Number.isSafeInteger(telegramId) || !status) {
      return ctx.reply(`Format: /set_status <telegram_id> <status>\nStatuslar: ${VALID_STATUSES.join(', ')}`);
    }

    const lead = await store.updateByTelegramId(telegramId, { status });
    if (lead) await deliverLeadWebhook(leadWebhookUrl, failureStore, 'lead_updated', lead);
    return ctx.reply(lead ? `Status yangilandi: ${lead.status}` : 'Lead topilmadi.');
  });
  bot.command('operator_note', async (ctx) => { if (!(await guard(ctx))) return; const match = commandText(ctx).match(/^\/operator_note\s+(\d+)\s+([\s\S]+)/); const lead = match ? await store.updateByTelegramId(Number(match[1]), { operatorNote: match[2] }) : undefined; if (lead) await deliverLeadWebhook(leadWebhookUrl, failureStore, 'lead_updated', lead); return ctx.reply(lead ? 'Operator note saqlandi.' : 'Format: /operator_note <telegram_id> <note>'); });
}
