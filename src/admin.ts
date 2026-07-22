import { Input } from 'telegraf';
import type { BotContext, LeadStatus, StudentStatus } from './types.js';
import { APPROVED_APPLICANT_EXPORT_FIELDS, type JsonLeadStore, type JsonWebhookFailureStore } from './storage.js';
import type { EgressHttpClient } from './egressPolicy.js';
import { formatLead, formatMaskedLead, formatMaskedLeadList } from './messages.js';
import { deliverLeadWebhook, getLeadWebhookRetryPolicy, retryFailedWebhooks } from './webhook.js';
import type { JsonChannelPostStore } from './channelPosts.js';
import { publishChannelPost, type ChannelMediaPolicy, type PublishAttemptOptions } from './channelPublisher.js';
import { buildSalesReport, formatSalesReport, parseSalesReportRange, type SalesReportDependencies } from './salesReporting.js';
import { buildOperationalReport, formatOperationalReport } from './operationalReport.js';
import type { JsonOperationalAlertStore } from './operationalAlerts.js';
import { formatTashkentSchedule, parseTashkentSchedule } from './channelScheduler.js';
import { currentUpdateIdempotencyKey, telegramUpdateTimestamp, withTelegramCallLabel } from './telegramUpdates.js';
import { deriveAuthorizationActor, roleAssignmentPayload, roleRevocationPayload, ROLES, type ApprovalAction, type JsonAuthorizationStore, type Permission, type ResourceKind, type ResourceRef, type ResourceScope, type Role } from './authorization.js';
import { findLeadByReference } from './leadSla.js';

const HOT_LEAD_COOLDOWN_MS = 30 * 60 * 1000;
const lastHotLeadAtByTelegramId = new Map<number, number>();
let adminEgressHttpClient: EgressHttpClient | undefined;
export function setAdminEgressHttpClient(client: EgressHttpClient | undefined): void { adminEgressHttpClient = client; }

async function adminTelegramFetch(url: string, init?: { signal?: AbortSignal }): Promise<{ ok: boolean; result?: number }> {
  const client = adminEgressHttpClient;
  if (client) {
    const response = await client.fetch(url, { actionType: 'telegram.sendMessage', correlationId: 'admin:telegram-api' });
    return JSON.parse(response.body) as { ok: boolean; result?: number };
  }
  const rawResponse = await fetch(url, init); // EGRESS-OK: fallback when no egress client configured
  return rawResponse.json() as Promise<{ ok: boolean; result?: number }>;
}

export async function notifyAdmins(ctx: BotContext, recipientIds: number[], lead: import('./types.js').Lead): Promise<void> { if (recipientIds.length === 0) return; await Promise.allSettled(recipientIds.map((recipientId) => withTelegramCallLabel('admin:new-lead-notification', () => ctx.telegram.sendMessage(recipientId, formatMaskedLead(lead))))); }
export interface HotLeadNotification { applicantReference?: string; telegramId?: number; phone?: string; reason: string; }
export async function notifyScoredHotLead(ctx: BotContext, recipientIds: number[], lead: HotLeadNotification): Promise<void> {
  if (recipientIds.length === 0) return;
  const text = ['Hot lead escalation', `Applicant: ${lead.applicantReference ?? 'masked'}`, `Phone: ${lead.phone ?? 'masked'}`, `Reason: ${lead.reason}`].join('\n');
  const results = await Promise.allSettled(recipientIds.map((recipientId) => withTelegramCallLabel('admin:lead-escalation-notification', () => ctx.telegram.sendMessage(recipientId, text))));
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length > 0) console.error(`Hot lead escalation notification failed for ${failed.length}/${results.length} admins.`);
  if (failed.length === results.length) throw new Error('Hot lead escalation notification failed for every admin.');
}
export async function notifyCallRequestLead(ctx: BotContext, recipientIds: number[], lead: HotLeadNotification): Promise<void> { if (recipientIds.length === 0 || !canNotifyHotLead(lead.telegramId)) return; await Promise.allSettled(recipientIds.map((recipientId) => withTelegramCallLabel('admin:call-request-notification', () => ctx.telegram.sendMessage(recipientId, ['Call request lead', `Applicant: ${lead.applicantReference ?? 'masked'}`, `Phone: ${lead.phone ?? 'masked'}`, `Reason: ${lead.reason}`].join('\n'))))); }
function canNotifyHotLead(telegramId?: number): boolean { if (!telegramId) return true; const now = Date.now(); const last = lastHotLeadAtByTelegramId.get(telegramId) ?? 0; if (now - last < HOT_LEAD_COOLDOWN_MS) return false; lastHotLeadAtByTelegramId.set(telegramId, now); return true; }

const VALID_STATUSES: LeadStatus[] = ['New', 'Warm', 'Hot', 'RegistrationCompleted', 'CallRequested', 'OperatorContacted', 'Paid', 'Rejected'];
const STUDENT_STATUSES: StudentStatus[] = ['NotEnrolled', 'Enrolled', 'Active', 'Completed', 'Dropped'];

function parseRoleScope(kindText: string | undefined, scopeText: string | undefined): ResourceScope | undefined {
  const kinds: Array<ResourceKind | '*'> = ['*', 'applicant', 'publication', 'followup', 'webhook', 'role', 'system'];
  const kind = kinds.find((item) => item === kindText);
  if (!kind || !scopeText) return undefined;
  if (scopeText === 'all') return { kind, mode: 'all' };
  if (scopeText === 'audit-only') return { kind, mode: 'audit_only' };
  const match = scopeText.match(/^(assigned|resource|program|region|channel|campaign):([a-z0-9_.:@/+,-]+)$/i);
  if (!match) return undefined;
  const values = [...new Set(match[2].split(',').map((value) => value.trim()).filter(Boolean))];
  if (!values.length || values.length > 100) return undefined;
  const scope: ResourceScope = { kind, mode: match[1] === 'assigned' ? 'assigned' : 'selected' };
  if (match[1] === 'assigned' || match[1] === 'resource') scope.resourceIds = values;
  else if (match[1] === 'program') scope.programs = values;
  else if (match[1] === 'region') scope.regions = values;
  else if (match[1] === 'channel') scope.channels = values;
  else scope.campaigns = values;
  return scope;
}

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

export function registerAdminCommands(bot: import('telegraf').Telegraf<BotContext>, store: JsonLeadStore, authorization: JsonAuthorizationStore, failureStore: JsonWebhookFailureStore, leadWebhookUrl: string | undefined, channelPosts: JsonChannelPostStore, channelChatId: string, botToken: string, channelMediaPolicy?: ChannelMediaPolicy, academyMetrics?: SalesReportDependencies['academyMetrics'], operationalAlerts?: JsonOperationalAlertStore, publicationOptions: PublishAttemptOptions = {}): void {
  const commandCorrelation = (ctx: BotContext, label: string): string => currentUpdateIdempotencyKey(label) ?? `telegram-update:${ctx.update.update_id}:${label}`;
  const privilegedAction = (ctx: BotContext): string => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : ctx.message && 'caption' in ctx.message ? ctx.message.caption : undefined;
    return `telegram.command.${text?.match(/^\/([a-z0-9_]+)/i)?.[1]?.toLowerCase() ?? 'unknown'}`;
  };
  const guard = async (ctx: BotContext, permission: Permission, resource: ResourceRef = { kind: 'system' }, purpose?: string): Promise<boolean> => {
    const decision = await authorization.authorize(deriveAuthorizationActor(ctx), permission, resource, commandCorrelation(ctx, `authorize:${permission}`), new Date(telegramUpdateTimestamp(ctx.update)), purpose, privilegedAction(ctx));
    if (decision.ok) return true;
    await ctx.reply('⛔ Bu amal uchun ruxsat mavjud emas.');
    return false;
  };
  const approvalVersion = 'telegram-command-v1';
  const requireApproval = async (ctx: BotContext, approvalId: string | undefined, action: ApprovalAction, resource: ResourceRef, payload: unknown): Promise<boolean> => {
    const actor = deriveAuthorizationActor(ctx);
    const correlation = commandCorrelation(ctx, `approval:${action}`);
    const now = new Date(telegramUpdateTimestamp(ctx.update));
    if (!approvalId) {
      const requested = await authorization.requestApproval(actor, action, resource, payload, approvalVersion, new Date(now.getTime() + 15 * 60_000), correlation, now);
      if (!requested.ok) { await ctx.reply('⛔ Tasdiqlash so‘rovi yaratilmadi.'); return false; }
      await ctx.reply(`Ikkinchi vakolatli shaxs tasdiqlashi kerak: /approve ${requested.approval.approvalId}\nTasdiqdan keyin buyruq oxiriga approval ID ni qo‘shib qayta yuboring.`);
      return false;
    }
    const consumed = await authorization.consumeApproval(approvalId, actor, action, resource, payload, approvalVersion, correlation, now);
    if (consumed.ok) return true;
    await ctx.reply(`⛔ Tasdiq yaroqsiz yoki amaldan chiqqan: ${consumed.reason}.`);
    return false;
  };
  const commandText = (ctx: BotContext): string => ctx.message && 'text' in ctx.message && ctx.message.text ? ctx.message.text : '';
  const authorizedApplicantList = async (ctx: BotContext, loadLeads: () => Promise<import('./types.js').Lead[]>): Promise<import('./types.js').Lead[] | undefined> => {
    const actor = deriveAuthorizationActor(ctx);
    const now = new Date(telegramUpdateTimestamp(ctx.update));
    const collection = await authorization.authorizeCollection(actor, 'applicant.view.masked', 'applicant', commandCorrelation(ctx, 'authorize:applicant-list'), now);
    if (!collection.ok) { await ctx.reply('⛔ Bu amal uchun ruxsat mavjud emas.'); return undefined; }
    return authorization.filterAuthorizedApplicants(actor, 'applicant.view.masked', await loadLeads(), now);
  };
  bot.command('id', async (ctx) => ctx.reply(`Sizning Telegram ID: ${ctx.from?.id ?? 'aniqlanmadi'}`));
  bot.command('admin_help', async (ctx) => {
    if (!(await guard(ctx, 'role.view'))) return;
    return ctx.reply([
      'Admin buyruqlari:',
      '/setup_status — sozlamalar holati',
      '/health — bot sog‘liq tekshiruvi',
      '/ads_check — Telegram Ads tayyorlik tekshiruvi',
      '/ads_stats [campaign] — reklama kampaniyalari bo‘yicha leadlar',
      '/channel_draft <text> — kanal posti drafti',
      '/channel_posts — oxirgi kanal postlari',
      '/channel_publish <id> [approval_id] — maker-checker bilan draftni kanalga yuborish',
      '/channel_schedule <id> <YYYY-MM-DD> <HH:mm> <campaign-or-none> [approval_id] — maker-checker bilan rejalash',
      '/channel_cancel <id> [approval_id] — maker-checker bilan rejani bekor qilish',
      '/channel_retry <id> [reason] — definitive failure retry; Uncertain uchun audited sabab kerak',
      '/channel_reconcile <id> published <message_id> <note> — Telegram message ID bilan tasdiqlash',
      '/channel_reconcile <id> not_published <note> — kanal dalili bilan yuborilmaganini tasdiqlash',
      '/channel_report — subscriber, post va lead hisoboti',
      '/leads_today — bugungi leadlar',
      '/last_leads — oxirgi 10 lead',
      '/hot_leads — hot leadlar',
      '/call_requests — qo‘ng‘iroq so‘ragan leadlar',
      '/stats — umumiy statistika',
      '/sales_report [YYYY-MM-DD] [YYYY-MM-DD] — далилга асосланган funnel/KPI',
      '/ops_report [YYYY-MM-DD] [YYYY-MM-DD] — махфий маълумотсиз operational status',
      '/set_student <applicant_ref> <status> — o‘quvchi holati',
      '/export_csv [approval_id] — maker-checker bilan barcha leadlarni CSV qilish',
      '/lead <applicant_ref> — maskalangan leadni ko‘rish',
      '/lead_sensitive <applicant_ref> <purpose> — auditli sensitive ko‘rish',
      `/set_status <applicant_ref> <status> — status o‘zgartirish (${VALID_STATUSES.join(', ')})`,
      '/operator_note <applicant_ref> <note> — operator izohi qo‘shish',
      '/retry_webhooks — yuborilmay qolgan webhooklarni qayta yuborish',
      '/webhook_failures — webhook retry/dead-letter ID va holatlari',
      '/replay_webhook <id> <reason> — dead-letter/uncertain webhookni audited manual replay',
      '/approvals — oxirgi maker-checker so‘rovlari',
      '/approval <approval_id> — bitta so‘rovning safe review tafsiloti',
      '/approve <approval_id> — boshqa maker so‘rovini tasdiqlash',
      '/reject <approval_id> — boshqa maker so‘rovini rad etish',
      '/roles — durable role assignmentlar',
      '/role_assign ... — maker-checker bilan role berish',
      '/role_revoke ... — maker-checker bilan role bekor qilish',
    ].join('\n'));
  });

  bot.command('setup_status', async (ctx) => {
    if (!(await guard(ctx, 'system.audit.view'))) return;
    return ctx.reply([
      '⚙️ Setup status',
      `BOT_TOKEN: ${yesNo(process.env.BOT_TOKEN)}`,
      'AUTHORIZATION: durable RBAC enabled',
      `LEADS_FILE: ${envValue('LEADS_FILE', './data/leads.json')}`,
      `LEAD_WEBHOOK_URL: ${configured(leadWebhookUrl)}`,
      `LEAD_WEBHOOK_SIGNING: ${process.env.LEAD_WEBHOOK_SERVICE_ID && process.env.LEAD_WEBHOOK_SECRET ? 'configured' : 'disabled'}`,
      `WEBHOOK_FAILED_FILE: ${envValue('WEBHOOK_FAILED_FILE', './data/webhook_failed.json')}`,
      `FOLLOWUPS_FILE: ${envValue('FOLLOWUPS_FILE', './data/followups.json')}`,
      `TELEGRAM_UPDATES_FILE: ${envValue('TELEGRAM_UPDATES_FILE', './data/telegram_updates.json')}`,
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
    if (!(await guard(ctx, 'system.audit.view'))) return;
    const statsLines = await safeStoreStats(store);
    return ctx.reply([
      '✅ Health check',
      'Bot: online',
      'Authorization: durable RBAC enabled',
      `AI: ${process.env.AI_ENABLED === 'true' && process.env.AI_API_KEY ? 'enabled' : 'disabled or incomplete'}`,
      `Webhook: ${configured(leadWebhookUrl)}`,
      `Operator: ${envValue('OPERATOR_USERNAME', '@hr_wst')} / ${envValue('OPERATOR_PHONE', '+998333011511')}`,
      ...statsLines,
    ].join('\n'));
  });

  bot.command('ads_check', async (ctx) => {
    if (!(await guard(ctx, 'system.audit.view'))) return;
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
    const campaignFilter = commandText(ctx).split(/\s+/)[1]?.trim();
    if (!(await guard(ctx, 'applicant.view.masked', { kind: 'applicant', campaign: campaignFilter }))) return;
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
    if (!(await guard(ctx, 'publication.create', { kind: 'publication', channel: channelChatId }))) return;
    const text = commandText(ctx).replace(/^\/channel_draft(?:@\w+)?\s*/i, '').trim();
    if (text.length < 20 || text.length > 4000) return ctx.reply('Post matni 20–4000 belgi bo‘lishi kerak.');
    const post = await channelPosts.create(text, undefined, ctx.from?.id, currentUpdateIdempotencyKey('channel:text-draft'));
    return ctx.reply(`Draft saqlandi: ${post.id}\n\n${post.text}\n\nYuborish: /channel_publish ${post.id}`);
  });

  bot.command('channel_posts', async (ctx) => {
    if (!(await guard(ctx, 'publication.create', { kind: 'publication', channel: channelChatId }))) return;
    const posts = await channelPosts.last();
    return ctx.reply(posts.length ? posts.map((post) => `${post.id} | ${post.status}${post.scheduledAt ? ` | ${formatTashkentSchedule(new Date(post.scheduledAt))} Tashkent` : ''} | ${post.photoFileId ? 'PHOTO' : 'TEXT'} | ${post.text.slice(0, 80)}`).join('\n') : 'Kanal postlari yo‘q.');
  });

  bot.command('channel_schedule', async (ctx) => {
    if (!(await guard(ctx, 'publication.create', { kind: 'publication', channel: channelChatId }))) return;
    const [, id, date, time, campaignId, approvalId] = commandText(ctx).split(/\s+/);
    const scheduledAt = date && time ? parseTashkentSchedule(`${date} ${time}`) : undefined;
    if (!id || !scheduledAt || !ctx.from?.id) return ctx.reply('Format: /channel_schedule <id> <YYYY-MM-DD> <HH:mm> <campaign-or-none> [approval_id]\nVaqt Asia/Tashkent bo‘yicha.');
    if (new Date(scheduledAt) <= new Date()) return ctx.reply('Rejalangan vaqt kelajakda bo‘lishi kerak.');
    const resource = { kind: 'publication' as const, id, channel: channelChatId, campaign: campaignId === 'none' ? undefined : campaignId };
    const payload = { operation: 'schedule', scheduledAt, campaignId: campaignId === 'none' ? undefined : campaignId };
    if (!(await requireApproval(ctx, approvalId, 'publication.publish', resource, payload))) return;
    const result = await channelPosts.schedule(id, scheduledAt, ctx.from.id, resource.campaign, currentUpdateIdempotencyKey(`channel:schedule:${id}`));
    if (result.ok) return ctx.reply(`Post tasdiqlandi va rejalandi: ${result.post.id}\n${formatTashkentSchedule(new Date(result.post.scheduledAt!))} Asia/Tashkent`);
    return ctx.reply(result.reason === 'not_found' ? 'Post topilmadi.' : `Bu postni rejalab bo‘lmaydi. Holat: ${result.post?.status ?? 'unknown'}.`);
  });

  bot.command('channel_cancel', async (ctx) => {
    if (!(await guard(ctx, 'publication.create', { kind: 'publication', channel: channelChatId }))) return;
    const [, id, approvalId] = commandText(ctx).split(/\s+/);
    if (!id || !ctx.from?.id) return ctx.reply('Format: /channel_cancel <id>');
    const resource = { kind: 'publication' as const, id, channel: channelChatId };
    if (!(await requireApproval(ctx, approvalId, 'publication.publish', resource, { operation: 'cancel' }))) return;
    const result = await channelPosts.cancel(id, ctx.from.id, currentUpdateIdempotencyKey(`channel:cancel:${id}`));
    if (result.ok) return ctx.reply(`Reja bekor qilindi: ${result.post.id}`);
    return ctx.reply(result.reason === 'not_found' ? 'Post topilmadi.' : `Bekor qilib bo‘lmaydi. Holat: ${result.post?.status ?? 'unknown'}.`);
  });

  bot.command('channel_report', async (ctx) => {
    if (!(await guard(ctx, 'publication.reconcile', { kind: 'publication', channel: channelChatId }))) return;
    const [memberResponse, leads] = await Promise.all([
      adminTelegramFetch(`https://api.telegram.org/bot${botToken}/getChatMemberCount?chat_id=${encodeURIComponent(channelChatId)}`),
      store.all(),
    ]);
    const postStats = await channelPosts.stats();
    const channelLeads = leads.filter((lead) => lead.source === 'channel').length;
    const adsLeads = leads.filter((lead) => lead.source === 'telegram_ads').length;
    const activeStudents = leads.filter((lead) => lead.studentStatus === 'Active').length;
    return ctx.reply(['📣 Channel report', `Obunachilar: ${memberResponse.ok ? memberResponse.result : 'ERROR'}`, `Draft: ${postStats.Draft}`, `Scheduled: ${postStats.Scheduled}`, `Due: ${postStats.due}`, `Claimed: ${postStats.Claimed}`, `Publishing: ${postStats.Publishing}`, `Uncertain/manual review: ${postStats.Uncertain}`, `Retry wait: ${postStats.RetryWait}`, `Published: ${postStats.Published}`, `Failed: ${postStats.Failed}`, `Cancelled: ${postStats.Cancelled}`, `Channel leadlar: ${channelLeads}`, `Telegram Ads leadlar: ${adsLeads}`, `Active studentlar: ${activeStudents}`].join('\n'));
  });

  const publish = async (ctx: BotContext, retryFailed: boolean): Promise<unknown> => {
    if (!(await guard(ctx, 'publication.create', { kind: 'publication', channel: channelChatId }))) return;
    const [, id, ...reasonParts] = commandText(ctx).trim().split(/\s+/);
    if (!id || !ctx.from?.id) return ctx.reply(`Format: /channel_${retryFailed ? 'retry' : 'publish'} <id>${retryFailed ? ' [reason]' : ''}`);
    const possibleApproval = reasonParts.at(-1);
    const approvalId = possibleApproval && /^[a-f0-9-]{36}$/i.test(possibleApproval) ? reasonParts.pop() : undefined;
    const reason = reasonParts.join(' ').trim();
    const resource = { kind: 'publication' as const, id, channel: channelChatId };
    const payload = { operation: retryFailed ? 'retry' : 'publish', reason };
    const current = await channelPosts.get(id);
    if (retryFailed && current?.status === 'Uncertain') {
      if (reason.length < 8) return ctx.reply(`Uncertain postni qayta yuborishdan oldin kanalni tekshiring va sabab yozing: /channel_retry ${id} <kamida 8 belgi sabab>`);
    }
    if (!(await requireApproval(ctx, approvalId, 'publication.publish', resource, payload))) return;
    if (retryFailed && current?.status === 'Uncertain') {
      const override = await channelPosts.authorizeUncertainOverride(id, ctx.from.id, reason, currentUpdateIdempotencyKey(`channel:override:${id}`));
      if (!override.ok) return ctx.reply(`Controlled override rad etildi. Holat: ${override.post?.status ?? 'unknown'}.`);
      console.info(JSON.stringify({ event: 'channel_manual_override_authorized', count: 1 }));
    }
    const result = await publishChannelPost(channelPosts, bot.telegram, channelChatId, id, ctx.from.id, retryFailed, channelMediaPolicy, currentUpdateIdempotencyKey(`channel:${retryFailed ? 'retry' : 'publish'}:${id}`), publicationOptions);
    if (result.ok) return ctx.reply(`Kanalga yuborildi: ${result.post.id}, message ${result.post.publishedMessageId}`);
    if (result.reason === 'send_failed') {
      console.error('Channel publish failed:', result.error);
      return ctx.reply(`Kanalga yuborilmadi: ${result.error}\nQayta urinish: /channel_retry ${id}`);
    }
    if (result.reason === 'campaign_expired') return ctx.reply(`Post yuborilmadi: aksiya muddati tugagan. ${result.error}`);
    if (result.reason === 'outcome_uncertain') return ctx.reply(`Telegram natijasi noaniq. Avtomatik retry bloklandi: ${id}. Kanalni tekshiring va /channel_reconcile dan foydalaning.`);
    if (result.reason === 'retry_wait') return ctx.reply(`Telegram vaqtincha qabul qilmadi. Post bounded retry navbatida: ${id}.`);
    if (result.reason === 'not_found') return ctx.reply('Post topilmadi.');
    return ctx.reply(`Post yuborib bo‘lmaydi. Hozirgi holat: ${result.post?.status ?? 'unknown'}.`);
  };

  bot.command('channel_publish', (ctx) => publish(ctx, false));
  bot.command('channel_retry', (ctx) => publish(ctx, true));
  bot.command('channel_reconcile', async (ctx) => {
    if (!(await guard(ctx, 'publication.reconcile', { kind: 'publication', channel: channelChatId }))) return;
    const [, id, outcome, ...rest] = commandText(ctx).trim().split(/\s+/);
    if (!id || !outcome || !ctx.from?.id) return ctx.reply('Format: /channel_reconcile <id> published <message_id> <note> yoki /channel_reconcile <id> not_published <note>');
    const possibleApproval = rest.at(-1);
    const approvalId = possibleApproval && /^[a-f0-9-]{36}$/i.test(possibleApproval) ? rest.pop() : undefined;
    const resource = { kind: 'publication' as const, id, channel: channelChatId };
    if (outcome === 'published') {
      const messageId = Number(rest.shift());
      const note = rest.join(' ').trim();
      if (!Number.isSafeInteger(messageId) || messageId <= 0 || note.length < 8) return ctx.reply('Format: /channel_reconcile <id> published <message_id> <kamida 8 belgi note>');
      if (!(await requireApproval(ctx, approvalId, 'publication.reconcile', resource, { outcome, messageId, note }))) return;
      const result = await channelPosts.reconcileUncertain(id, { outcome: 'published', actorId: ctx.from.id, messageId, note }, currentUpdateIdempotencyKey(`channel:reconcile:${id}`));
      return ctx.reply(result.ok ? `Post Published deb reconciled qilindi: ${id}, message ${messageId}.` : `Reconciliation rad etildi. Holat: ${result.post?.status ?? result.reason}.`);
    }
    if (outcome === 'not_published') {
      const note = rest.join(' ').trim();
      if (note.length < 8) return ctx.reply('Format: /channel_reconcile <id> not_published <kamida 8 belgi note>');
      if (!(await requireApproval(ctx, approvalId, 'publication.reconcile', resource, { outcome, note }))) return;
      const result = await channelPosts.reconcileUncertain(id, { outcome: 'not_published', actorId: ctx.from.id, note }, currentUpdateIdempotencyKey(`channel:reconcile:${id}`));
      return ctx.reply(result.ok ? `Yuborilmagani tasdiqlandi; controlled retry ruxsat etildi: ${id}.` : `Reconciliation rad etildi. Holat: ${result.post?.status ?? result.reason}.`);
    }
    return ctx.reply('Outcome published yoki not_published bo‘lishi kerak.');
  });

  bot.command('leads_today', async (ctx) => { const leads = await authorizedApplicantList(ctx, () => store.today()); if (!leads) return; return ctx.reply(formatMaskedLeadList(leads, 'Bugun hali lead yo‘q.')); });
  bot.command('last_leads', async (ctx) => { const leads = await authorizedApplicantList(ctx, () => store.last(10)); if (!leads) return; return ctx.reply(formatMaskedLeadList(leads, 'Hali lead yo‘q.')); });
  bot.command('hot_leads', async (ctx) => { const leads = await authorizedApplicantList(ctx, async () => (await store.all()).filter((lead) => lead.status === 'Hot')); if (!leads) return; return ctx.reply(formatMaskedLeadList(leads, 'Hot lead yo‘q.')); });
  bot.command('call_requests', async (ctx) => { const leads = await authorizedApplicantList(ctx, async () => (await store.all()).filter((lead) => lead.status === 'CallRequested')); if (!leads) return; return ctx.reply(formatMaskedLeadList(leads, 'Call request yo‘q.')); });
  bot.command('stats', async (ctx) => { if (!(await guard(ctx, 'applicant.audit.view', { kind: 'applicant' }))) return; const s = await store.stats(); return ctx.reply([`📊 Statistika`,`Jami leadlar: ${s.total}`,`Bugun: ${s.today}`,`Oxirgi 7 kun: ${s.last7Days}`,`Hot: ${s.hot}`,`Call requests: ${s.callRequests}`,`Completed: ${s.completed}`,`No phone: ${s.noPhone}`].join('\n')); });
  bot.command('sales_report', async (ctx) => {
    if (!(await guard(ctx, 'applicant.audit.view', { kind: 'applicant' }))) return;
    const args = commandText(ctx).trim().split(/\s+/).slice(1);
    try {
      const range = parseSalesReportRange(args);
      const snapshot = await buildSalesReport(range, {
        store,
        failureStore,
        academyMetrics,
      });
      return ctx.reply(formatSalesReport(snapshot));
    } catch (error) {
      console.error('Sales KPI report failed:', error instanceof Error ? error.message : String(error));
      return ctx.reply(error instanceof Error && /Format:|Sana|Noto‘g‘ri/.test(error.message) ? error.message : 'Sales KPI hisoboti vaqtincha mavjud emas.');
    }
  });
  bot.command('ops_report', async (ctx) => {
    if (!(await guard(ctx, 'system.audit.view'))) return;
    const args = commandText(ctx).trim().split(/\s+/).slice(1);
    try {
      const range = parseSalesReportRange(args);
      const snapshot = await buildOperationalReport(range, {
        channelPosts,
        sales: { store, failureStore, academyMetrics },
        alerts: operationalAlerts,
        botHealth: async () => {
          const signal = AbortSignal.timeout(5_000);
          const [botResult, channelResult] = await Promise.allSettled([
            adminTelegramFetch(`https://api.telegram.org/bot${botToken}/getMe`, { signal }).then((r) => ({ ok: r.ok }) as { ok: boolean }),
            adminTelegramFetch(`https://api.telegram.org/bot${botToken}/getChatMemberCount?chat_id=${encodeURIComponent(channelChatId)}`, { signal }),
          ]);
          const botResponse = botResult.status === 'fulfilled' ? botResult.value : undefined;
          const channelResponse = channelResult.status === 'fulfilled' ? channelResult.value : undefined;
          return {
            botReachable: botResponse?.ok === true,
            channelReachable: channelResponse?.ok === true,
            subscriberCount: channelResponse?.ok ? channelResponse.result : undefined,
          };
        },
      });
      return ctx.reply(formatOperationalReport(snapshot));
    } catch (error) {
      console.error('Operational report failed:', error instanceof Error ? error.message : String(error));
      return ctx.reply(error instanceof Error && /Format:|Sana|Noto‘g‘ri/.test(error.message)
        ? error.message.replace('/sales_report', '/ops_report')
        : 'Operational hisobot vaqtincha mavjud emas.');
    }
  });
  bot.command('set_student', async (ctx) => {
    const [, reference, statusText] = commandText(ctx).split(/\s+/);
    if (!(await guard(ctx, 'applicant.update', { kind: 'applicant', id: reference }))) return;
    const studentStatus = STUDENT_STATUSES.find((status) => status.toLowerCase() === statusText?.toLowerCase());
    const existing = reference ? findLeadByReference(await store.all(), reference) : undefined;
    if (!existing || !studentStatus) return ctx.reply(`Format: /set_student <applicant_ref> <status>\nStatuslar: ${STUDENT_STATUSES.join(', ')}`);
    const lead = await store.updateByTelegramId(existing.telegramId, { studentStatus }, currentUpdateIdempotencyKey('admin:set-student'));
    if (lead) await deliverLeadWebhook(leadWebhookUrl, failureStore, 'lead_updated', lead, undefined, currentUpdateIdempotencyKey('webhook:set-student'));
    return ctx.reply(lead ? `Student status: ${studentStatus}` : 'Lead topilmadi.');
  });
  bot.command('export_csv', async (ctx) => {
    if (!(await guard(ctx, 'applicant.export', { kind: 'applicant' }))) return;
    const approvalId = commandText(ctx).split(/\s+/)[1];
    if (!(await requireApproval(ctx, approvalId, 'applicant.export', { kind: 'applicant' }, { format: 'csv', scope: 'all', fields: APPROVED_APPLICANT_EXPORT_FIELDS }))) return;
    const csv = await store.toApprovedApplicantCsv();
    return ctx.replyWithDocument(Input.fromBuffer(Buffer.from(csv, 'utf8'), `wst-leads-${telegramUpdateTimestamp(ctx.update).slice(0, 10)}.csv`));
  });
  bot.command('retry_webhooks', async (ctx) => { if (!(await guard(ctx, 'webhook.replay', { kind: 'webhook' }))) return; const r = await retryFailedWebhooks(leadWebhookUrl, failureStore); return ctx.reply(`Webhook retry: attempted ${r.attempted}, sent ${r.sent}, remaining ${r.remaining}`); });
  bot.command('webhook_failures', async (ctx) => {
    if (!(await guard(ctx, 'deadletter.view', { kind: 'webhook' }))) return;
    const failures = await failureStore.all();
    return ctx.reply(failures.length ? failures.slice(0, 20).map((item) => `${item.id} | ${item.state} | attempts ${item.attempts} | retained ${item.retainedUntil ?? 'legacy'}`).join('\n') : 'Webhook failure queue bo‘sh.');
  });
  bot.command('replay_webhook', async (ctx) => {
    if (!(await guard(ctx, 'deadletter.replay', { kind: 'webhook' }))) return;
    const [, id, ...reasonParts] = commandText(ctx).trim().split(/\s+/);
    const possibleApproval = reasonParts.at(-1);
    const approvalId = possibleApproval && /^[a-f0-9-]{36}$/i.test(possibleApproval) ? reasonParts.pop() : undefined;
    const reason = reasonParts.join(' ').trim();
    if (!id || !ctx.from?.id || reason.length < 8) return ctx.reply('Format: /replay_webhook <id> <kamida 8 belgi sabab>');
    if (!(await requireApproval(ctx, approvalId, 'deadletter.replay', { kind: 'webhook', id }, { reason }))) return;
    const result = await failureStore.manualReplay(id, ctx.from.id, reason, new Date(), getLeadWebhookRetryPolicy());
    if (result.ok) console.info(JSON.stringify({ event: 'webhook_manual_replay_authorized', count: 1 }));
    return ctx.reply(result.ok ? `Webhook manual replay navbatiga qaytarildi: ${id}. Original idempotency identity saqlandi.` : `Manual replay rad etildi: ${result.reason}.`);
  });
  bot.command('lead', async (ctx) => { const reference = commandText(ctx).split(/\s+/)[1]; if (!(await guard(ctx, 'applicant.view.masked', { kind: 'applicant', id: reference }))) return; const lead = reference ? findLeadByReference(await store.all(), reference) : undefined; return ctx.reply(lead ? formatMaskedLead(lead) : 'Lead topilmadi.'); });
  bot.command('lead_sensitive', async (ctx) => {
    const [, reference, ...purposeParts] = commandText(ctx).split(/\s+/);
    const purpose = purposeParts.join(' ').trim();
    if (!(await guard(ctx, 'applicant.view.sensitive', { kind: 'applicant', id: reference }, purpose))) return;
    if (!reference || purpose.length < 8) return ctx.reply('Format: /lead_sensitive <applicant_ref> <kamida 8 belgi purpose>');
    const lead = findLeadByReference(await store.all(), reference);
    return ctx.reply(lead ? formatLead(lead) : 'Lead topilmadi.');
  });
  bot.command('set_status', async (ctx) => {
    const [, reference, statusText] = commandText(ctx).split(/\s+/);
    if (!(await guard(ctx, 'applicant.update', { kind: 'applicant', id: reference }))) return;
    const status = VALID_STATUSES.find((item) => item.toLowerCase() === statusText?.toLowerCase());

    const existing = reference ? findLeadByReference(await store.all(), reference) : undefined;
    if (!existing || !status) {
      return ctx.reply(`Format: /set_status <applicant_ref> <status>\nStatuslar: ${VALID_STATUSES.join(', ')}`);
    }

    const lead = await store.updateByTelegramId(existing.telegramId, { status }, currentUpdateIdempotencyKey('admin:set-status'));
    if (lead) await deliverLeadWebhook(leadWebhookUrl, failureStore, 'lead_updated', lead, undefined, currentUpdateIdempotencyKey('webhook:set-status'));
    return ctx.reply(lead ? `Status yangilandi: ${lead.status}` : 'Lead topilmadi.');
  });
  bot.command('operator_note', async (ctx) => { const match = commandText(ctx).match(/^\/operator_note\s+([a-f0-9]{20})\s+([\s\S]+)/i); const reference = match?.[1]; if (!(await guard(ctx, 'applicant.update', { kind: 'applicant', id: reference }))) return; const existing = reference ? findLeadByReference(await store.all(), reference) : undefined; const lead = existing && match ? await store.updateByTelegramId(existing.telegramId, { operatorNote: match[2] }, currentUpdateIdempotencyKey('admin:operator-note')) : undefined; if (lead) await deliverLeadWebhook(leadWebhookUrl, failureStore, 'lead_updated', lead, undefined, currentUpdateIdempotencyKey('webhook:operator-note')); return ctx.reply(lead ? 'Operator note saqlandi.' : 'Format: /operator_note <applicant_ref> <note>'); });

  bot.command('roles', async (ctx) => {
    if (!(await guard(ctx, 'role.view'))) return;
    const assignments = (await authorization.assignments()).slice(-50).reverse();
    return ctx.reply(assignments.length ? assignments.map((item) => `${item.assignmentId} | actor:${item.actorId} | ${item.role} | ${item.state} | ${item.scopes.map((scope) => `${scope.kind}:${scope.mode}`).join(',')} | expires:${item.expiresAt ?? 'none'}`).join('\n') : 'Role assignmentlar yo‘q.');
  });
  bot.command('role_assign', async (ctx) => {
    const [, targetText, roleText, kindText, scopeText, ...reasonParts] = commandText(ctx).trim().split(/\s+/);
    if (!(await guard(ctx, 'role.assign', { kind: 'role', id: targetText }))) return;
    const possibleApproval = reasonParts.at(-1);
    const approvalId = possibleApproval && /^[a-f0-9-]{36}$/i.test(possibleApproval) ? reasonParts.pop() : undefined;
    const targetTelegramUserId = Number(targetText);
    const role = ROLES.find((item) => item === roleText) as Role | undefined;
    const scope = parseRoleScope(kindText, scopeText);
    const reason = reasonParts.join(' ').trim();
    if (!Number.isSafeInteger(targetTelegramUserId) || targetTelegramUserId <= 0 || !role || !scope || reason.length < 8) return ctx.reply('Format: /role_assign <telegram_id> <ROLE> <kind> <all|audit-only|assigned:ids|resource:ids|program:values|region:values|channel:values|campaign:values> <kamida 8 belgi reason> [approval_id]');
    const resource = { kind: 'role' as const, id: String(targetTelegramUserId) };
    const payload = roleAssignmentPayload(targetTelegramUserId, role, [scope], reason);
    const now = new Date(telegramUpdateTimestamp(ctx.update));
    if (!approvalId) {
      const requested = await authorization.requestApproval(deriveAuthorizationActor(ctx), 'role.assign', resource, payload, approvalVersion, new Date(now.getTime() + 15 * 60_000), commandCorrelation(ctx, 'approval:role-assign'), now);
      return ctx.reply(requested.ok ? `Role assignment tasdiqlashi kerak: /approve ${requested.approval.approvalId}\nTasdiqdan keyin ayni buyruq oxiriga approval ID ni qo‘shing.` : `Role assignment so‘rovi rad etildi: ${requested.reason}.`);
    }
    const result = await authorization.assignRole(approvalId, deriveAuthorizationActor(ctx), targetTelegramUserId, role, [scope], reason, approvalVersion, commandCorrelation(ctx, 'role:assign'), undefined, now);
    return ctx.reply(result.ok ? `Role assignment yaratildi: ${result.assignment.assignmentId}.` : `Role assignment bajarilmadi: ${result.reason}.`);
  });
  bot.command('role_revoke', async (ctx) => {
    const [, assignmentId, ...reasonParts] = commandText(ctx).trim().split(/\s+/);
    if (!(await guard(ctx, 'role.revoke', { kind: 'role', id: assignmentId }))) return;
    const possibleApproval = reasonParts.at(-1);
    const approvalId = possibleApproval && /^[a-f0-9-]{36}$/i.test(possibleApproval) ? reasonParts.pop() : undefined;
    const reason = reasonParts.join(' ').trim();
    if (!assignmentId || reason.length < 8) return ctx.reply('Format: /role_revoke <assignment_id> <kamida 8 belgi reason> [approval_id]');
    const resource = { kind: 'role' as const, id: assignmentId };
    const payload = roleRevocationPayload(assignmentId, reason);
    const now = new Date(telegramUpdateTimestamp(ctx.update));
    if (!approvalId) {
      const requested = await authorization.requestApproval(deriveAuthorizationActor(ctx), 'role.revoke', resource, payload, approvalVersion, new Date(now.getTime() + 15 * 60_000), commandCorrelation(ctx, 'approval:role-revoke'), now);
      return ctx.reply(requested.ok ? `Role revocation tasdiqlashi kerak: /approve ${requested.approval.approvalId}\nTasdiqdan keyin ayni buyruq oxiriga approval ID ni qo‘shing.` : `Role revocation so‘rovi rad etildi: ${requested.reason}.`);
    }
    const result = await authorization.revokeRole(approvalId, deriveAuthorizationActor(ctx), assignmentId, reason, approvalVersion, commandCorrelation(ctx, 'role:revoke'), now);
    return ctx.reply(result.ok ? `Role darhol bekor qilindi: ${result.assignment.assignmentId}.` : `Role revocation bajarilmadi: ${result.reason}.`);
  });

  bot.command('approvals', async (ctx) => {
    if (!(await guard(ctx, 'role.view'))) return;
    const approvals = (await authorization.approvals()).slice(-10).reverse();
    return ctx.reply(approvals.length ? approvals.map((item) => `${item.approvalId} | ${item.action} | ${item.state} | ${(item.summary.join(',') || 'no-sensitive-summary').slice(0, 160)} | resource:${item.resourceDigest.slice(0, 12)} | v:${item.version} | expires:${item.expiresAt}`).join('\n') : 'Tasdiqlash so‘rovlari yo‘q.');
  });
  bot.command('approval', async (ctx) => {
    if (!(await guard(ctx, 'role.view'))) return;
    const approvalId = commandText(ctx).split(/\s+/)[1];
    const item = (await authorization.approvals()).find((approval) => approval.approvalId === approvalId);
    return ctx.reply(item ? [`Approval: ${item.approvalId}`, `Action: ${item.action}`, `State: ${item.state}`, `Review: ${item.summary.join(' | ') || 'no-sensitive-summary'}`, `Resource digest: ${item.resourceDigest}`, `Request digest: ${item.requestDigest}`, `Version: ${item.version}`, `Expires: ${item.expiresAt}`].join('\n') : 'Approval topilmadi.');
  });
  bot.command('approve', async (ctx) => {
    const approvalId = commandText(ctx).split(/\s+/)[1];
    if (!approvalId) return ctx.reply('Format: /approve <approval_id>');
    const result = await authorization.approveStoredRequest(approvalId, deriveAuthorizationActor(ctx), commandCorrelation(ctx, 'approval:approve'), new Date(telegramUpdateTimestamp(ctx.update)));
    return ctx.reply(result.ok ? `Tasdiqlandi: ${result.approval.approvalId}. Maker original buyruqni approval ID bilan qayta yuborishi kerak.` : '⛔ Tasdiqlash rad etildi.');
  });
  bot.command('reject', async (ctx) => {
    const approvalId = commandText(ctx).split(/\s+/)[1];
    if (!approvalId) return ctx.reply('Format: /reject <approval_id>');
    const result = await authorization.rejectRequest(approvalId, deriveAuthorizationActor(ctx), commandCorrelation(ctx, 'approval:reject'), new Date(telegramUpdateTimestamp(ctx.update)));
    return ctx.reply(result.ok ? `Rad etildi: ${result.approval.approvalId}.` : '⛔ Rad etish bajarilmadi.');
  });
}
