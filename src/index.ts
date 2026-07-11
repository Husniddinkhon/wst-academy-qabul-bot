import { randomUUID } from 'node:crypto';
import { Telegraf, Scenes, session } from 'telegraf';
import { loadConfig } from './config.js';
import { courseInfo, formatCourseIntro, formatCourseProgram, formatPriceInfo } from './course.js';
import { isAdmin, notifyAdmins, notifyCallRequestLead, notifyHotLead, registerAdminCommands } from './admin.js';
import { JsonFollowUpStore, JsonLeadStore, JsonWebhookFailureStore } from './storage.js';
import { createRegistrationScene, mainMenu, REGISTRATION_SCENE_ID, sendStart } from './registration.js';
import { answerWithAiAgent, extractPhoneNumber, getAiFallbackAnswer, getPhoneRequestAnswer, getUnrelatedTopicAnswer, isCallRequest, isCallRequestCancel, isUnrelatedTopic } from './aiAgent.js';
import { deliverLeadWebhook } from './webhook.js';
import type { BotContext, Lead, LeadSource } from './types.js';
import { startFollowUpAutomation } from './followups.js';
import { startDailyReport } from './dailyReport.js';
import { JsonChannelPostStore } from './channelPosts.js';


async function saveCallRequestLead(ctx: BotContext, store: JsonLeadStore, failureStore: JsonWebhookFailureStore, adminIds: number[], leadWebhookUrl: string | undefined, phone: string, message: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const lead: Lead = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
    lastName: from.last_name,
    fullName: [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Call request',
    phone,
    age: '',
    city: '',
    workStatus: '',
    experience: '',
    preferredTime: '',
    notes: message,
    goal: '',
    paymentOption: '',
    status: 'CallRequested',
    source: 'call_request',
    intent: 'call request',
    lastMessage: message,
    messages: [{ text: message, createdAt: new Date().toISOString() }],
    operatorNote: '',
    nextFollowUp: '',
    paymentStatus: '',
  };

  const saved = await store.upsert(lead);
  await deliverLeadWebhook(leadWebhookUrl, failureStore, 'call_request', saved.lead);

  await notifyCallRequestLead(ctx, adminIds, {
    username: from.username,
    telegramId: from.id,
    phone,
    message,
    reason: 'User asked for a call.',
  });
}

async function saveTelegramAdsLead(ctx: BotContext, store: JsonLeadStore, failureStore: JsonWebhookFailureStore, followUpStore: JsonFollowUpStore, adminIds: number[], leadWebhookUrl: string | undefined): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const now = new Date().toISOString();
  const message = ctx.message && 'text' in ctx.message ? (ctx.message.text ?? '/start ads') : '/start ads';
  const lead: Lead = {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
    lastName: from.last_name,
    fullName: [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Telegram Ads lead',
    phone: '',
    age: '',
    city: '',
    workStatus: '',
    experience: '',
    preferredTime: '',
    notes: 'User started the bot from Telegram Ads.',
    goal: '',
    paymentOption: '',
    status: 'Warm',
    source: 'telegram_ads',
    campaignId: ctx.session.campaignId,
    intent: 'telegram_ads',
    lastMessage: message,
    messages: [{ text: message, createdAt: now }],
    operatorNote: '',
    nextFollowUp: '',
    paymentStatus: '',
  };

  const saved = await store.upsert(lead);
  await followUpStore.upsert({ telegramId: from.id, startedAt: saved.lead.createdAt, count: 0 });
  await deliverLeadWebhook(leadWebhookUrl, failureStore, saved.created ? 'lead_created' : 'lead_updated', saved.lead);
  if (saved.created) await notifyAdmins(ctx, adminIds, saved.lead);
}

async function answerSalesAgent(ctx: BotContext, message: string, config: ReturnType<typeof loadConfig>, store: JsonLeadStore, failureStore: JsonWebhookFailureStore, followUpStore: JsonFollowUpStore): Promise<void> {
  if (isUnrelatedTopic(message)) {
    await ctx.reply(getUnrelatedTopicAnswer(message), mainMenu());
    return;
  }

  try {
    const result = await answerWithAiAgent(message, config.ai);
    await ctx.reply(result.answer, mainMenu());

    if ((result.score === 'HOT' || result.score === 'WARM') && ctx.from) {
      const now = new Date().toISOString();
      const existing = await store.getByTelegramId(ctx.from.id);
      const saved = await store.upsert({ id: randomUUID(), createdAt: now, updatedAt: now, telegramId: ctx.from.id, username: ctx.from.username, firstName: ctx.from.first_name, lastName: ctx.from.last_name, fullName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || (result.score === 'HOT' ? 'Hot lead' : 'Warm lead'), phone: extractPhoneNumber(message) ?? '', city: '', age: '', workStatus: '', experience: '', goal: '', paymentOption: '', status: result.score === 'HOT' ? 'Hot' : 'Warm', source: ctx.session.source ?? 'ai_chat', campaignId: ctx.session.campaignId, agentActionCount: (existing?.agentActionCount ?? 0) + 1, lastAgentAction: `AI reply (${result.score})`, lastAgentAt: now, intent: inferIntent(message), lastMessage: message, messages: [{ text: message, createdAt: now }], operatorNote: '', nextFollowUp: '', paymentStatus: '', preferredTime: '' });
      await followUpStore.ensure({ telegramId: ctx.from.id, startedAt: saved.lead.createdAt, count: 0 });
      await deliverLeadWebhook(config.leadWebhookUrl, failureStore, result.score === 'HOT' ? 'hot_lead' : (saved.created ? 'lead_created' : 'lead_updated'), saved.lead);
      if (result.score === 'HOT') await notifyHotLead(ctx, config.adminIds, {
        username: ctx.from?.username,
        telegramId: ctx.from?.id,
        message,
        reason: result.reason,
      });
    }
  } catch (error) {
    console.error('AI agent failed:', error instanceof Error ? error.message : error);
    await ctx.reply(getAiFallbackAnswer(message), mainMenu());
  }
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const store = new JsonLeadStore(config.leadsFile);
  const failureStore = new JsonWebhookFailureStore(config.webhookFailedFile);
  const followUpStore = new JsonFollowUpStore(config.followupsFile);
  const channelPosts = new JsonChannelPostStore(config.channelPostsFile);
  const bot = new Telegraf<BotContext>(config.botToken);
  const stage = new Scenes.Stage<BotContext>([createRegistrationScene(store, config.adminIds, config.leadWebhookUrl, failureStore, followUpStore)]);

  bot.use(session());
  bot.use(stage.middleware());

  bot.start(async (ctx) => {
    const tracking = parseTracking(ctx.message && 'text' in ctx.message ? ctx.message.text : undefined);
    ctx.session.source = tracking.source;
    ctx.session.campaignId = tracking.campaignId;
    if (ctx.session.source === 'telegram_ads') await saveTelegramAdsLead(ctx, store, failureStore, followUpStore, config.adminIds, config.leadWebhookUrl);
    await sendStart(ctx);
  });
  bot.hears('📝 Ro‘yxatdan o‘tish', (ctx) => ctx.scene.enter(REGISTRATION_SCENE_ID));
  bot.hears('📚 Kurs dasturi', (ctx) => ctx.reply(formatCourseProgram(), mainMenu()));
  bot.hears('💳 Narx va to‘lov', (ctx) => ctx.reply(formatPriceInfo(), mainMenu()));
  bot.hears('ℹ️ Kurs haqida', (ctx) => ctx.reply(formatCourseIntro(), mainMenu()));
  bot.hears('📞 Operator bilan bog‘lanish', async (ctx) => {
    await ctx.reply([`👨‍💼 Operator: ${courseInfo.operator}`, `📞 Telefon: ${courseInfo.phone}`, `📣 Kanal: ${courseInfo.channel}`].join('\n'), mainMenu());
  });

  registerAdminCommands(bot, store, config.adminIds, failureStore, config.leadWebhookUrl, channelPosts, config.channelChatId);

  bot.on('photo', async (ctx) => {
    if (!isAdmin(ctx, config.adminIds)) return;
    const caption = ctx.message?.caption?.trim() ?? '';
    if (!caption.startsWith('/channel_photo')) return;
    const text = caption.replace(/^\/channel_photo(?:@\w+)?\s*/i, '').trim();
    const photos = ctx.message?.photo ?? [];
    const photoFileId = photos[photos.length - 1]?.file_id;
    if (!photoFileId || text.length < 20 || text.length > 1024) return ctx.reply('Photo caption 20–1024 belgi bo‘lishi kerak.');
    const post = await channelPosts.create(text, photoFileId);
    return ctx.reply(`Rasmli draft saqlandi: ${post.id}\nYuborish: /channel_publish ${post.id}`);
  });

  bot.on('contact', async (ctx) => {
    const phone = ctx.message?.contact?.phone_number;
    if (!ctx.session.waitingForCallPhone || !phone) return;

    const originalMessage = ctx.session.waitingForCallPhone.message;
    ctx.session.waitingForCallPhone = undefined;
    await saveCallRequestLead(ctx, store, failureStore, config.adminIds, config.leadWebhookUrl, phone, originalMessage);
    await ctx.reply('Rahmat. Telefon raqamingiz qabul qilindi. Operatorimiz tez orada siz bilan bog‘lanadi.', mainMenu());
  });

  bot.on('text', async (ctx) => {
    const message = ctx.message?.text?.trim();

    if (!message || message.startsWith('/') || ctx.scene.current) return;

    if (ctx.session.waitingForCallPhone) {
      const phone = extractPhoneNumber(message);

      if (!phone) {
        if (isCallRequestCancel(message)) {
          ctx.session.waitingForCallPhone = undefined;
          await ctx.reply('Mayli. Kerak bo‘lsa, pastdagi menyudan kurs haqida so‘rashingiz yoki ro‘yxatdan o‘tishingiz mumkin.', mainMenu());
          return;
        }

        ctx.session.waitingForCallPhone = undefined;
        await answerSalesAgent(ctx, message, config, store, failureStore, followUpStore);
        return;
      }

      const originalMessage = ctx.session.waitingForCallPhone.message;
      ctx.session.waitingForCallPhone = undefined;
      await saveCallRequestLead(ctx, store, failureStore, config.adminIds, config.leadWebhookUrl, phone, originalMessage);
      await ctx.reply('Rahmat. Telefon raqamingiz qabul qilindi. Operatorimiz tez orada siz bilan bog‘lanadi.', mainMenu());
      return;
    }

    if (isCallRequest(message)) {
      const phone = extractPhoneNumber(message);

      if (!phone) {
        ctx.session.waitingForCallPhone = { message };
        await ctx.reply(getPhoneRequestAnswer(message), mainMenu());
        return;
      }

      await saveCallRequestLead(ctx, store, failureStore, config.adminIds, config.leadWebhookUrl, phone, message);
      await ctx.reply('Rahmat. Telefon raqamingiz qabul qilindi. Operatorimiz tez orada siz bilan bog‘lanadi.', mainMenu());
      return;
    }

    await answerSalesAgent(ctx, message, config, store, failureStore, followUpStore);
  });

  bot.catch((error, ctx) => {
    console.error(`Bot error for update ${ctx.update.update_id}:`, error);
  });

  await bot.telegram.setMyDescription(config.botDescription);
  const adminCommands = [
    { command: 'start', description: 'Botni boshlash va kurs haqida maʼlumot' },
    { command: 'id', description: 'Telegram ID ni ko‘rish' },
    { command: 'admin_help', description: 'Admin buyruqlari ro‘yxati (admin)' },
    { command: 'setup_status', description: 'Sozlamalar holatini tekshirish (admin)' },
    { command: 'health', description: 'Bot sog‘liq tekshiruvi (admin)' },
    { command: 'ads_check', description: 'Telegram Ads tayyorlik tekshiruvi (admin)' },
    { command: 'ads_stats', description: 'Telegram Ads lead statistikasi (admin)' },
    { command: 'channel_draft', description: 'Kanal posti draftini yaratish (admin)' },
    { command: 'channel_posts', description: 'Kanal postlari holati (admin)' },
    { command: 'channel_publish', description: 'Draftni kanalga yuborish (admin)' },
    { command: 'leads_today', description: 'Bugungi leadlar (admin)' },
    { command: 'last_leads', description: 'Oxirgi leadlar (admin)' },
    { command: 'hot_leads', description: 'Hot leadlar (admin)' },
    { command: 'call_requests', description: 'Call requestlar (admin)' },
    { command: 'stats', description: 'Lead statistikasi (admin)' },
    { command: 'sales_report', description: 'Sales funnel va active studentlar (admin)' },
    { command: 'set_student', description: 'O‘quvchi holatini yangilash (admin)' },
    { command: 'export_csv', description: 'Leadlarni CSV qilish (admin)' },
    { command: 'retry_webhooks', description: 'Webhook retry (admin)' },
    { command: 'lead', description: 'Leadni Telegram ID bilan topish (admin)' },
    { command: 'set_status', description: 'Lead statusini yangilash (admin)' },
    { command: 'operator_note', description: 'Leadga operator izohi (admin)' },
  ];
  await bot.telegram.setMyCommands([adminCommands[0]], { scope: { type: 'default' } });
  await Promise.all(config.adminIds.map((chatId) => bot.telegram.setMyCommands(adminCommands, { scope: { type: 'chat', chat_id: chatId } })));

  const followUpTimer = startFollowUpAutomation(bot, store, followUpStore);
  const dailyReportTimer = startDailyReport(bot, store, config.adminIds, config.dailyReportEnabled, config.dailyReportHour);

  await bot.launch({ dropPendingUpdates: config.isProduction });
  console.log('WST Academy qabul bot is running.');

  const shutdown = async (signal: NodeJS.Signals) => {
    console.log(`Received ${signal}. Stopping bot...`);
    clearInterval(followUpTimer);
    if (dailyReportTimer) clearInterval(dailyReportTimer);
    bot.stop(signal);
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

bootstrap().catch((error) => {
  console.error('Failed to start bot:', error);
  process.exit(1);
});

function parseTracking(text: string | undefined): { source: LeadSource; campaignId?: string } {
  const param = text?.split(/\s+/)[1];
  if (param === 'ads' || param?.startsWith('ads_') || param?.startsWith('telegram_ads')) {
    return { source: 'telegram_ads', campaignId: param === 'ads' ? 'legacy' : param };
  }
  if (param === 'channel') return { source: 'channel' };
  if (param === 'organic') return { source: 'organic' };
  if (param === 'registration') return { source: 'registration' };
  if (param === 'ai_chat') return { source: 'ai_chat' };
  if (param === 'call_request') return { source: 'call_request' };
  return { source: 'unknown' };
}

function inferIntent(message: string): string {
  if (/narx|qancha|to['‘’`]?lov|tolov/i.test(message)) return 'price';
  if (/dastur|programma|nima|kamera|dvr|nvr/i.test(message)) return 'program';
  return 'ai_chat';
}
