import { Input } from 'telegraf';
import type { BotContext, LeadStatus, StudentStatus } from './types.js';
import type { JsonLeadStore, JsonWebhookFailureStore } from './storage.js';
import { formatLead, formatLeadList } from './messages.js';
import { deliverLeadWebhook, retryFailedWebhooks } from './webhook.js';
import type { JsonChannelPostStore } from './channelPosts.js';
import { publishChannelPost } from './channelPublisher.js';
import { formatTashkentSchedule, parseTashkentSchedule } from './channelScheduler.js';

const HOT_LEAD_COOLDOWN_MS = 30 * 60 * 1000;
const lastHotLeadAtByTelegramId = new Map<number, number>();

export function isAdmin(ctx: BotContext, adminIds: number[]): boolean { const id = ctx.from?.id; return Boolean(id && adminIds.includes(id)); }
export async function notifyAdmins(ctx: BotContext, adminIds: number[], lead: import('./types.js').Lead): Promise<void> { if (adminIds.length === 0) return; await Promise.allSettled(adminIds.map((adminId) => ctx.telegram.sendMessage(adminId, formatLead(lead)))); }
export interface HotLeadNotification { username?: string; telegramId?: number; phone?: string; message: string; reason: string; }
export async function notifyHotLead(ctx: BotContext, adminIds: number[], lead: HotLeadNotification): Promise<void> { if (adminIds.length === 0 || !canNotifyHotLead(lead.telegramId)) return; await Promise.allSettled(adminIds.map((adminId) => ctx.telegram.sendMessage(adminId, ['🔥 Hot lead detected',`Username: ${lead.username ? `@${lead.username}` : '—'}`,`Telegram ID: ${lead.telegramId ?? '—'}`,lead.phone ? `Phone: ${lead.phone}` : undefined,`Message: ${lead.message}`,`Reason: ${lead.reason}`].filter(Boolean).join('\n')))); }
export async function notifyScoredHotLead(ctx: BotContext, adminIds: number[], lead: HotLeadNotification): Promise<void> {
  if (adminIds.length === 0) return;
  const text = ['🔥 Hot lead escalation',`Username: ${lead.username ? `@${lead.username}` : '—'}`,`Telegram ID: ${lead.telegramId ?? '—'}`,lead.phone ? `Phone: ${lead.phone}` : undefined,`Message: ${lead.message}`,`Reason: ${lead.reason}`].filter(Boolean).join('\n');
  const results = await Promise.allSettled(adminIds.map((adminId) => ctx.telegram.sendMessage(adminId, text)));
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length > 0) console.error(`Hot lead escalation notification failed for ${failed.length}/${results.length} admins.`);
  if (failed.length === results.length) throw new Error('Hot lead escalation notification failed for every admin.');
}
export async function notifyCallRequestLead(ctx: BotContext, adminIds: number[], lead: HotLeadNotification): Promise<void> { if (adminIds.length === 0 || !canNotifyHotLead(lead.telegramId)) return; await Promise.allSettled(adminIds.map((adminId) => ctx.telegram.sendMessage(adminId, ['🔥 Call request lead',`Username: ${lead.username ? `@${lead.username}` : '—'}`,`Telegram ID: ${lead.telegramId ?? '—'}`,`Phone: ${lead.phone ?? '—'}`,`Message: ${lead.message}`,`Reason: ${lead.reason}`].join('\n')))); }
function canNotifyHotLead(telegramId?: number): boolean { if (!telegramId) return true; const now = Date.now(); const last = lastHotLeadAtByTelegramId.get(telegramId) ?? 0; if (now - last < HOT_LEAD_COOLDOWN_MS) return false; lastHotLeadAtByTelegramId.set(telegramId, now); return true; }

const VALID_STATUSES: LeadStatus[] = ['New', 'Warm', 'Hot', 'RegistrationCompleted', 'CallRequested', 'OperatorContacted', 'Paid', 'Rejected'];
const STUDENT_STATUSES: StudentStatus[] = ['NotEnrolled', 'Enrolled', 'Active', 'Completed', 'Dropped'];

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

export function registerAdminCommands(bot: import('telegraf').Telegraf<BotContext>, store: JsonLeadStore, adminIds: number[], failureStore: JsonWebhookFailureStore, leadWebhookUrl: string | undefined, channelPosts: JsonChannelPostStore, channelChatId: string, botToken: string): void {
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
      '/ads_stats [campaign] — reklama kampaniyalari bo‘yicha leadlar',
      '/channel_draft <text> — kanal posti drafti',
      '/channel_posts — oxirgi kanal postlari',
      '/channel_publish <id> — draftni kanalga yuborish',
      '/channel_schedule <id> <YYYY-MM-DD> <HH:mm> [campaign] — admin tasdiqlagan postni Toshkent vaqti bilan rejalash',
      '/channel_cancel <id> — rejalangan postni bekor qilish',
      '/channel_retry <id> — xato bo‘lgan postni qayta yuborish',
      '/channel_report — subscriber, post va lead hisoboti',
      '/leads_today — bugungi leadlar',
      '/last_leads — oxirgi 10 lead',
      '/hot_leads — hot leadlar',
      '/call_requests — qo‘ng‘iroq so‘ragan leadlar',
      '/stats — umumiy statistika',
      '/sales_report — заявкадан active studentgacha funnel',
      '/set_student <telegram_id> <status> — o‘quvchi holati',
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
      `LEAD_WEBHOOK_SIGNING: ${process.env.LEAD_WEBHOOK_SERVICE_ID && process.env.LEAD_WEBHOOK_SECRET ? 'configured' : 'disabled'}`,
      `WEBHOOK_FAILED_FILE: ${envValue('WEBHOOK_FAILED_FILE', './data/webhook_failed.json')}`,
      `FOLLOWUPS_FILE: ${envValue('FOLLOWUPS_FILE', './data/followups.json')}`,
      `NODE_ENV: ${envValue('NODE_ENV', 'not set')}`,
      `AI_ENABLED: ${envValue('AI_ENABLED', 'false')}`,
      `AI_PROVIDER: ${envValue('AI_PROVIDER', 'openai_compatible')}`,
      `AI_API_KEY: ${yesNo(process.env.AI_API_KEY)}`,
      `AI_BASE_URL: ${envValue('AI_BASE_URL', 'not set')}`,
      `AI_MODEL: ${envValue('AI_MODEL', 'not set')}`,
      `AI_FALLBACK_API_KEY: ${yesNo(process.env.AI_FALLBACK_API_KEY)}`,
      `AI_FALLBACK_BASE_URL: ${envValue('AI_FALLBACK_BASE_URL', 'not set')}`,
      `AI_FALLBACK_MODEL: ${envValue('AI_FALLBACK_MODEL', 'not set')}`,
      `OPERATOR_USERNAME: ${envValue('OPERATOR_USERNAME', '@hr_wst')}`,
      `OPERATOR_PHONE: ${envValue('OPERATOR_PHONE', '+998333011511')}`,
      `BOT_DESCRIPTION: ${yesNo(process.env.BOT_DESCRIPTION || 'default')}`,
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

  bot.command('ads_stats', async (ctx) => {
    if (!(await guard(ctx))) return;
    const campaignFilter = commandText(ctx).split(/\s+/)[1]?.trim();
    const adLeads = (await store.all()).filter((lead) => lead.source === 'telegram_ads');
    const filtered = campaignFilter ? adLeads.filter((lead) => lead.campaignId === campaignFilter) : adLeads;
    const grouped = new Map<string, typeof filtered>();
    for (const lead of filtered) {
      const key = lead.campaignId || 'legacy';
      grouped.set(key, [...(grouped.get(key) ?? []), lead]);
    }
    const lines = [...grouped.entries()].map(([campaign, leads]) => {
      const withPhone = leads.filter((lead) => Boolean(lead.phone)).length;
      const qualified = leads.filter((lead) => ['Hot', 'CallRequested', 'RegistrationCompleted', 'Paid'].includes(lead.status)).length;
      return `${campaign}: ${leads.length} lead, ${withPhone} telefon, ${qualified} qualified`;
    });
    return ctx.reply(lines.length ? ['📣 Telegram Ads lead statistikasi', ...lines].join('\n') : 'Telegram Ads leadlari topilmadi.');
  });

  bot.command('channel_draft', async (ctx) => {
    if (!(await guard(ctx))) return;
    const text = commandText(ctx).replace(/^\/channel_draft(?:@\w+)?\s*/i, '').trim();
    if (text.length < 20 || text.length > 4000) return ctx.reply('Post matni 20–4000 belgi bo‘lishi kerak.');
    const post = await channelPosts.create(text, undefined, ctx.from?.id);
    return ctx.reply(`Draft saqlandi: ${post.id}\n\n${post.text}\n\nYuborish: /channel_publish ${post.id}`);
  });

  bot.command('channel_posts', async (ctx) => {
    if (!(await guard(ctx))) return;
    const posts = await channelPosts.last();
    return ctx.reply(posts.length ? posts.map((post) => `${post.id} | ${post.status}${post.scheduledAt ? ` | ${formatTashkentSchedule(new Date(post.scheduledAt))} Tashkent` : ''} | ${post.photoFileId ? 'PHOTO' : 'TEXT'} | ${post.text.slice(0, 80)}`).join('\n') : 'Kanal postlari yo‘q.');
  });

  bot.command('channel_schedule', async (ctx) => {
    if (!(await guard(ctx))) return;
    const [, id, date, time, campaignId] = commandText(ctx).split(/\s+/);
    const scheduledAt = date && time ? parseTashkentSchedule(`${date} ${time}`) : undefined;
    if (!id || !scheduledAt || !ctx.from?.id) return ctx.reply('Format: /channel_schedule <id> <YYYY-MM-DD> <HH:mm> [campaign]\nVaqt Asia/Tashkent bo‘yicha.');
    if (new Date(scheduledAt) <= new Date()) return ctx.reply('Rejalangan vaqt kelajakda bo‘lishi kerak.');
    const result = await channelPosts.schedule(id, scheduledAt, ctx.from.id, campaignId);
    if (result.ok) return ctx.reply(`Post tasdiqlandi va rejalandi: ${result.post.id}\n${formatTashkentSchedule(new Date(result.post.scheduledAt!))} Asia/Tashkent`);
    return ctx.reply(result.reason === 'not_found' ? 'Post topilmadi.' : `Bu postni rejalab bo‘lmaydi. Holat: ${result.post?.status ?? 'unknown'}.`);
  });

  bot.command('channel_cancel', async (ctx) => {
    if (!(await guard(ctx))) return;
    const id = commandText(ctx).split(/\s+/)[1];
    if (!id || !ctx.from?.id) return ctx.reply('Format: /channel_cancel <id>');
    const result = await channelPosts.cancel(id, ctx.from.id);
    if (result.ok) return ctx.reply(`Reja bekor qilindi: ${result.post.id}`);
    return ctx.reply(result.reason === 'not_found' ? 'Post topilmadi.' : `Bekor qilib bo‘lmaydi. Holat: ${result.post?.status ?? 'unknown'}.`);
  });

  bot.command('channel_report', async (ctx) => {
    if (!(await guard(ctx))) return;
    const [memberResponse, leads] = await Promise.all([
      fetch(`https://api.telegram.org/bot${botToken}/getChatMemberCount?chat_id=${encodeURIComponent(channelChatId)}`).then((response) => response.json()) as Promise<{ ok: boolean; result?: number }>,
      store.all(),
    ]);
    const postStats = await channelPosts.stats();
    const channelLeads = leads.filter((lead) => lead.source === 'channel').length;
    const adsLeads = leads.filter((lead) => lead.source === 'telegram_ads').length;
    const activeStudents = leads.filter((lead) => lead.studentStatus === 'Active').length;
    return ctx.reply(['📣 Channel report', `Obunachilar: ${memberResponse.ok ? memberResponse.result : 'ERROR'}`, `Draft: ${postStats.Draft}`, `Scheduled: ${postStats.Scheduled}`, `Due: ${postStats.due}`, `Publishing: ${postStats.Publishing}`, `Published: ${postStats.Published}`, `Failed/manual review: ${postStats.Failed}`, `Cancelled: ${postStats.Cancelled}`, `Channel leadlar: ${channelLeads}`, `Telegram Ads leadlar: ${adsLeads}`, `Active studentlar: ${activeStudents}`].join('\n'));
  });

  const publish = async (ctx: BotContext, retryFailed: boolean): Promise<unknown> => {
    if (!(await guard(ctx))) return;
    const id = commandText(ctx).split(/\s+/)[1]?.trim();
    if (!id || !ctx.from?.id) return ctx.reply(`Format: /channel_${retryFailed ? 'retry' : 'publish'} <id>`);
    const result = await publishChannelPost(channelPosts, bot.telegram, channelChatId, id, ctx.from.id, retryFailed);
    if (result.ok) return ctx.reply(`Kanalga yuborildi: ${result.post.id}, message ${result.post.publishedMessageId}`);
    if (result.reason === 'send_failed') {
      console.error('Channel publish failed:', result.error);
      return ctx.reply(`Kanalga yuborilmadi: ${result.error}\nQayta urinish: /channel_retry ${id}`);
    }
    if (result.reason === 'campaign_expired') return ctx.reply(`Post yuborilmadi: aksiya muddati tugagan. ${result.error}`);
    if (result.reason === 'not_found') return ctx.reply('Post topilmadi.');
    return ctx.reply(`Post yuborib bo‘lmaydi. Hozirgi holat: ${result.post?.status ?? 'unknown'}.`);
  };

  bot.command('channel_publish', (ctx) => publish(ctx, false));
  bot.command('channel_retry', (ctx) => publish(ctx, true));

  bot.command('leads_today', async (ctx) => { if (!(await guard(ctx))) return; return ctx.reply(formatLeadList(await store.today(), 'Bugun hali lead yo‘q.')); });
  bot.command('last_leads', async (ctx) => { if (!(await guard(ctx))) return; return ctx.reply(formatLeadList(await store.last(10), 'Hali lead yo‘q.')); });
  bot.command('hot_leads', async (ctx) => { if (!(await guard(ctx))) return; return ctx.reply(formatLeadList((await store.all()).filter((l) => l.status === 'Hot'), 'Hot lead yo‘q.')); });
  bot.command('call_requests', async (ctx) => { if (!(await guard(ctx))) return; return ctx.reply(formatLeadList((await store.all()).filter((l) => l.status === 'CallRequested'), 'Call request yo‘q.')); });
  bot.command('stats', async (ctx) => { if (!(await guard(ctx))) return; const s = await store.stats(); return ctx.reply([`📊 Statistika`,`Jami leadlar: ${s.total}`,`Bugun: ${s.today}`,`Oxirgi 7 kun: ${s.last7Days}`,`Hot: ${s.hot}`,`Call requests: ${s.callRequests}`,`Completed: ${s.completed}`,`No phone: ${s.noPhone}`].join('\n')); });
  bot.command('sales_report', async (ctx) => {
    if (!(await guard(ctx))) return;
    const leads = await store.all();
    const registered = leads.filter((lead) => lead.status === 'RegistrationCompleted' || lead.status === 'Paid').length;
    const paid = leads.filter((lead) => lead.status === 'Paid').length;
    const active = leads.filter((lead) => lead.studentStatus === 'Active').length;
    const completed = leads.filter((lead) => lead.studentStatus === 'Completed').length;
    const withPhone = leads.filter((lead) => Boolean(lead.phone)).length;
    const agentWorked = leads.filter((lead) => (lead.agentActionCount ?? 0) > 0).length;
    const conversion = leads.length ? ((active / leads.length) * 100).toFixed(1) : '0.0';
    return ctx.reply(['📈 Sales funnel', `Jami заявка: ${leads.length}`, `Agent ishlagan leadlar: ${agentWorked}`, `Telefon olingan: ${withPhone}`, `Ro‘yxatdan o‘tgan: ${registered}`, `To‘lov tasdiqlangan: ${paid}`, `Haqiqatan o‘qiyapti: ${active}`, `Kursni tugatgan: ${completed}`, `Lead → active conversion: ${conversion}%`].join('\n'));
  });
  bot.command('set_student', async (ctx) => {
    if (!(await guard(ctx))) return;
    const [, idText, statusText] = commandText(ctx).split(/\s+/);
    const telegramId = Number(idText);
    const studentStatus = STUDENT_STATUSES.find((status) => status.toLowerCase() === statusText?.toLowerCase());
    if (!Number.isSafeInteger(telegramId) || !studentStatus) return ctx.reply(`Format: /set_student <telegram_id> <status>\nStatuslar: ${STUDENT_STATUSES.join(', ')}`);
    const lead = await store.updateByTelegramId(telegramId, { studentStatus });
    if (lead) await deliverLeadWebhook(leadWebhookUrl, failureStore, 'lead_updated', lead);
    return ctx.reply(lead ? `Student status: ${studentStatus}` : 'Lead topilmadi.');
  });
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
