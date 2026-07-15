import { randomUUID } from 'node:crypto';
import { Telegraf, Scenes, session } from 'telegraf';
import { loadConfig } from './config.js';
import { formatCourseIntro, formatCourseProgram, formatLocationAndSchedule, formatPriceInfo, formatPrivacyInfo } from './course.js';
import { isAdmin, notifyCallRequestLead, notifyHotLead, notifyScoredHotLead, registerAdminCommands } from './admin.js';
import { JsonFollowUpStore, JsonLeadStore, JsonWebhookFailureStore } from './storage.js';
import { createRegistrationScene, mainMenu, phoneRequestKeyboard, REGISTRATION_SCENE_ID, sendStart } from './registration.js';
import { answerWithAiAgent, extractPhoneNumber, getPhoneRequestAnswer, getTruthfulFallbackAnswer, getUnrelatedTopicAnswer, isCallRequest, isCallRequestCancel, isUnrelatedTopic, scoreLead } from './aiAgent.js';
import { configureLeadWebhookSigning, deliverLeadWebhook } from './webhook.js';
import type { BotContext, Lead, LeadSource } from './types.js';
import { startFollowUpAutomation } from './followups.js';
import { startDailyReport } from './dailyReport.js';
import { PostgresFollowUpStore, PostgresLeadStore, PostgresStorage } from './postgres.js';
import { JsonChannelPostStore } from './channelPosts.js';
import { BACK_BUTTON, CALCULATOR_BUTTON, LESSON_BUTTON, MENU_BUTTON, NEXT_BUTTON, QUIZ, QUIZ_BUTTON, lessonKeyboard, lessonText, quizKeyboard, quizText, startCalculator, startLesson, startQuiz, storageTerabytes, validateCalculatorValue } from './learning.js';
import { explicitLeadSource, parseStartAttribution, resetSessionForStart } from './startFlow.js';
import { classifyProductLead, getProductSalesAnswer, isProductSalesQuestion, productLeadReason, UNV_CAMPAIGN_ID } from './productSales.js';
import { isPermittedSalesConversation, persistSalesConversation } from './salesConversation.js';
import { startChannelScheduler } from './channelScheduler.js';
import { createAcademyMetricsLoader } from './salesReporting.js';
import { getBotLaunchOptions } from './botLaunch.js';
import { JsonOperationalAlertStore } from './operationalAlerts.js';
import { startLeadSlaEscalation } from './leadSla.js';
import { startQabulOpsAggregateServer } from './opsAggregateServer.js';


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
    source: explicitLeadSource(ctx.session.source, 'call_request'),
    campaignId: ctx.session.campaignId,
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

async function saveProductSalesLead(ctx: BotContext, store: JsonLeadStore, failureStore: JsonWebhookFailureStore, adminIds: number[], leadWebhookUrl: string | undefined, message: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const now = new Date().toISOString();
  const status = classifyProductLead(message);
  const phone = extractPhoneNumber(message) ?? '';
  const lead: Lead = {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
    lastName: from.last_name,
    fullName: [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Telegram subscriber',
    phone,
    age: '',
    city: '',
    workStatus: '',
    experience: '',
    preferredTime: '',
    notes: productLeadReason(message),
    goal: 'UNV Uho-P1G-M3F4D-EU xaridi',
    paymentOption: '',
    status,
    source: 'channel',
    campaignId: UNV_CAMPAIGN_ID,
    intent: 'product_sales',
    lastMessage: message,
    messages: [{ text: message, createdAt: now }],
    operatorNote: '',
    nextFollowUp: '',
    paymentStatus: '',
  };

  const saved = await store.upsert(lead);
  await deliverLeadWebhook(leadWebhookUrl, failureStore, saved.created ? 'lead_created' : 'lead_updated', saved.lead);
  if (status === 'Hot') {
    await notifyHotLead(ctx, adminIds, {
      username: from.username,
      telegramId: from.id,
      phone: phone || undefined,
      message,
      reason: productLeadReason(message),
    });
  }
}

async function answerSalesAgent(ctx: BotContext, message: string, config: ReturnType<typeof loadConfig>, store: JsonLeadStore, failureStore: JsonWebhookFailureStore): Promise<void> {
  if (isUnrelatedTopic(message)) {
    await ctx.reply(getUnrelatedTopicAnswer(message), mainMenu());
    return;
  }

  let result;
  try {
    result = await answerWithAiAgent(message, config.ai, { actorId: ctx.from?.id ? String(ctx.from.id) : undefined });
  } catch (error) {
    console.error('AI agent failed:', error instanceof Error ? error.message : error);
    result = { answer: getTruthfulFallbackAnswer(message), ...scoreLead(message) };
  }
  await ctx.reply(result.answer, mainMenu());
  if (!isPermittedSalesConversation(message, result.score)) return;

  const from = ctx.from;
  if (!from) return;
  await persistSalesConversation({
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
    lastName: from.last_name,
    message,
    score: result.score,
    reason: result.reason,
    intent: inferIntent(message),
    source: ctx.session.source,
    campaignId: ctx.session.campaignId,
    phone: extractPhoneNumber(message),
  }, {
    store,
    failureStore,
    leadWebhookUrl: config.leadWebhookUrl,
    notifyHotLead: (lead) => notifyScoredHotLead(ctx, config.adminIds, {
      username: lead.username,
      telegramId: lead.telegramId,
      phone: lead.phone || undefined,
      message: lead.lastMessage,
      reason: lead.aiLeadReason || 'High sales intent.',
    }),
  });
  }

async function cancelActiveFlow(ctx: BotContext): Promise<void> {
  ctx.session.leadDraft = undefined;
  ctx.session.waitingForCallPhone = undefined;
  ctx.session.lessonIndex = undefined;
  ctx.session.quizIndex = undefined;
  ctx.session.quizScore = undefined;
  ctx.session.calculator = undefined;
  if (ctx.scene.current) await ctx.scene.leave();
  await ctx.reply('Joriy amal bekor qilindi. Asosiy menyu ochildi.', mainMenu());
}

async function handleLearningText(ctx: BotContext, message: string): Promise<boolean> {
  if (message === MENU_BUTTON) { await cancelActiveFlow(ctx); return true; }
  if (ctx.session.lessonIndex !== undefined) {
    if (message !== NEXT_BUTTON && message !== BACK_BUTTON) { await ctx.reply('Mini-darsni davom ettirish uchun tugmalardan foydalaning.', lessonKeyboard(ctx.session.lessonIndex)); return true; }
    const delta = message === NEXT_BUTTON ? 1 : -1;
    const index = Math.max(0, Math.min(2, ctx.session.lessonIndex + delta));
    ctx.session.lessonIndex = index;
    await ctx.reply(lessonText(index), lessonKeyboard(index));
    return true;
  }
  if (ctx.session.quizIndex !== undefined) {
    const index = ctx.session.quizIndex;
    const answer = QUIZ[index].options.indexOf(message as never);
    if (answer < 0) { await ctx.reply('Javob variantlaridan birini tanlang.', quizKeyboard(index)); return true; }
    const correct = answer === QUIZ[index].correct;
    ctx.session.quizScore = (ctx.session.quizScore ?? 0) + (correct ? 1 : 0);
    await ctx.reply(`${correct ? 'To‘g‘ri.' : 'Noto‘g‘ri.'} ${QUIZ[index].explanation}`);
    if (index === QUIZ.length - 1) {
      const score = ctx.session.quizScore;
      ctx.session.quizIndex = undefined;
      ctx.session.quizScore = undefined;
      await ctx.reply(`Natija: ${score}/5. Javoblaringiz saqlanmadi.`, mainMenu());
    } else {
      ctx.session.quizIndex = index + 1;
      await ctx.reply(quizText(index + 1), quizKeyboard(index + 1));
    }
    return true;
  }
  const calculator = ctx.session.calculator;
  if (calculator) {
    const value = Number(message.replace(',', '.'));
    try { validateCalculatorValue(calculator.step, value); } catch { await ctx.reply(calculator.step === 'cameras' ? '1–128 oralig‘ida butun kamera sonini kiriting.' : calculator.step === 'bitrate' ? '0.25–32 oralig‘ida bitrate kiriting.' : '1–365 oralig‘ida butun kun kiriting.'); return true; }
    if (calculator.step === 'cameras') { ctx.session.calculator = { step: 'bitrate', cameras: value }; await ctx.reply('Har bir kamera bitrate qiymatini Mbps’da kiriting (0.25–32). Masalan: 4'); return true; }
    if (calculator.step === 'bitrate') { ctx.session.calculator = { step: 'days', cameras: calculator.cameras, bitrate: value }; await ctx.reply('Yozuv saqlanadigan kunlar sonini kiriting (1–365):'); return true; }
    const tb = storageTerabytes(calculator.cameras!, calculator.bitrate!, value);
    ctx.session.calculator = undefined;
    await ctx.reply(`Taxminiy xotira: ${tb.toFixed(2)} TB. Hisob doimiy bitrate asosida; real hajm kodek, harakat va sozlamalarga qarab farq qiladi.`, mainMenu());
    return true;
  }
  return false;
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  configureLeadWebhookSigning(config.leadWebhookServiceId && config.leadWebhookSecret ? {
    serviceId: config.leadWebhookServiceId,
    secret: config.leadWebhookSecret,
  } : undefined);
  const postgres = config.databaseUrl ? new PostgresStorage(config.databaseUrl) : undefined;
  if (postgres) await postgres.migrate(config.leadsFile, config.followupsFile);
  const store = postgres ? new PostgresLeadStore(postgres) : new JsonLeadStore(config.leadsFile);
  const failureStore = new JsonWebhookFailureStore(config.webhookFailedFile);
  const followUpStore = postgres ? new PostgresFollowUpStore(postgres) : new JsonFollowUpStore(config.followupsFile);
  const channelPosts = new JsonChannelPostStore(config.channelPostsFile);
  const operationalAlerts = new JsonOperationalAlertStore(config.opsAlertsFile);
  const opsAggregateServer = config.opsAggregatePort && config.opsAggregateServiceId && config.opsAggregateSecret
    ? startQabulOpsAggregateServer({ port: config.opsAggregatePort, serviceId: config.opsAggregateServiceId, secret: config.opsAggregateSecret, leads: store, alerts: operationalAlerts, followUps: followUpStore, webhookFailures: failureStore })
    : undefined;
  const bot = new Telegraf<BotContext>(config.botToken);
  const stage = new Scenes.Stage<BotContext>([createRegistrationScene(store, config.adminIds, config.leadWebhookUrl, failureStore, followUpStore)]);

  bot.use(session());
  bot.use(stage.middleware());

  bot.start(async (ctx) => {
    if (ctx.scene.current) await ctx.scene.leave();
    const tracking = parseStartAttribution(ctx.message && 'text' in ctx.message ? ctx.message.text : undefined);
    resetSessionForStart(ctx.session, tracking);
    await sendStart(ctx);
  });
  bot.command('help', (ctx) => ctx.reply('Bepul funksiyalar: /lesson, /quiz, /calculator. /cancel joriy amalni bekor qiladi. Kurs ma’lumotlari va ro‘yxatdan o‘tish menyuda mavjud.', mainMenu()));
  bot.command('lesson', startLesson);
  bot.command('quiz', startQuiz);
  bot.command('calculator', startCalculator);
  bot.command('cancel', cancelActiveFlow);
  bot.action('academy_lesson', async (ctx) => { await ctx.answerCbQuery(); await startLesson(ctx); });
  bot.action('academy_quiz', async (ctx) => { await ctx.answerCbQuery(); await startQuiz(ctx); });
  bot.action('academy_calculator', async (ctx) => { await ctx.answerCbQuery(); await startCalculator(ctx); });
  bot.action('academy_program', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply(formatCourseProgram(), mainMenu()); });
  bot.action('academy_price', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply(formatPriceInfo(), mainMenu()); });
  bot.action('academy_schedule', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply(formatLocationAndSchedule(), mainMenu()); });
  bot.action('academy_register', async (ctx) => { await ctx.answerCbQuery(); await ctx.scene.enter(REGISTRATION_SCENE_ID); });
  bot.hears(LESSON_BUTTON, startLesson);
  bot.hears(QUIZ_BUTTON, startQuiz);
  bot.hears(CALCULATOR_BUTTON, startCalculator);
  bot.hears('Ro‘yxatdan o‘tish', (ctx) => ctx.scene.enter(REGISTRATION_SCENE_ID));
  bot.hears('Kurs dasturi', (ctx) => ctx.reply(formatCourseProgram(), mainMenu()));
  bot.hears('Narx va to‘lov', (ctx) => ctx.reply(formatPriceInfo(), mainMenu()));
  bot.hears('Kurs haqida', (ctx) => ctx.reply(formatCourseIntro(), mainMenu()));
  bot.hears('Manzil va jadval', (ctx) => ctx.reply(formatLocationAndSchedule(), mainMenu()));
  bot.hears('Maxfiylik', (ctx) => ctx.reply(formatPrivacyInfo(), mainMenu()));
  bot.hears('Operator bilan bog‘lanish', async (ctx) => {
    ctx.session.waitingForCallPhone = { message: 'Operator bilan bog‘lanish' };
    await ctx.reply(getPhoneRequestAnswer('Operator bilan bog‘lanish'), phoneRequestKeyboard());
  });

  const channelMediaPolicy = { assetRoot: config.channelAssetRoot, allowedHttpsHosts: config.channelImageHosts };
  const academyMetrics = config.academyReportBaseUrl && config.leadWebhookServiceId && config.leadWebhookSecret
    ? createAcademyMetricsLoader({
        baseUrl: config.academyReportBaseUrl,
        serviceId: config.leadWebhookServiceId,
        serviceSecret: config.leadWebhookSecret,
        timeoutMs: config.academyReportTimeoutMs,
      })
    : undefined;
  registerAdminCommands(bot, store, config.adminIds, failureStore, config.leadWebhookUrl, channelPosts, config.channelChatId, config.botToken, channelMediaPolicy, academyMetrics, operationalAlerts);

  bot.on('photo', async (ctx) => {
    if (!isAdmin(ctx, config.adminIds)) return;
    const caption = ctx.message?.caption?.trim() ?? '';
    if (!caption.startsWith('/channel_photo')) return;
    const text = caption.replace(/^\/channel_photo(?:@\w+)?\s*/i, '').trim();
    const photos = ctx.message?.photo ?? [];
    const photoFileId = photos[photos.length - 1]?.file_id;
    if (!photoFileId || text.length < 20 || text.length > 1024) return ctx.reply('Photo caption 20–1024 belgi bo‘lishi kerak.');
    const post = await channelPosts.create(text, photoFileId, ctx.from?.id);
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
    const telegramContext = ctx as unknown as { chat?: { id: number; type: string }; from?: { is_bot?: boolean } };
    if (telegramContext.chat?.type !== 'private') {
      if (telegramContext.chat?.id !== config.salesDiscussionChatId || telegramContext.from?.is_bot || !isProductSalesQuestion(message)) return;
      await saveProductSalesLead(ctx, store, failureStore, config.adminIds, config.leadWebhookUrl, message);
      await ctx.reply(getProductSalesAnswer(message, config.operatorUsername));
      return;
    }
    if (await handleLearningText(ctx, message)) return;

    if (ctx.session.waitingForCallPhone) {
      const phone = extractPhoneNumber(message);

      if (!phone) {
        if (isCallRequestCancel(message)) {
          ctx.session.waitingForCallPhone = undefined;
          await ctx.reply('Mayli. Kerak bo‘lsa, pastdagi menyudan kurs haqida so‘rashingiz yoki ro‘yxatdan o‘tishingiz mumkin.', mainMenu());
          return;
        }

        ctx.session.waitingForCallPhone = undefined;
        await answerSalesAgent(ctx, message, config, store, failureStore);
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

    await answerSalesAgent(ctx, message, config, store, failureStore);
  });

  bot.catch((error, ctx) => {
    console.error(`Bot error for update ${ctx.update.update_id}:`, error);
  });

  await bot.telegram.setMyDescription(config.botDescription);
  await bot.telegram.setMyShortDescription(config.botShortDescription);
  const publicCommands = [
    { command: 'start', description: 'Asosiy menyuni ochish' },
    { command: 'help', description: 'Bot imkoniyatlari' },
    { command: 'lesson', description: 'Bepul CCTV mini-dars' },
    { command: 'quiz', description: 'CCTV bilim testi' },
    { command: 'calculator', description: 'Kamera xotirasini hisoblash' },
    { command: 'cancel', description: 'Joriy amalni bekor qilish' },
  ];
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
    { command: 'channel_retry', description: 'Xato kanal postini qayta yuborish (admin)' },
    { command: 'channel_report', description: 'Kanal obunachi va lead hisoboti (admin)' },
    { command: 'leads_today', description: 'Bugungi leadlar (admin)' },
    { command: 'last_leads', description: 'Oxirgi leadlar (admin)' },
    { command: 'hot_leads', description: 'Hot leadlar (admin)' },
    { command: 'call_requests', description: 'Call requestlar (admin)' },
    { command: 'stats', description: 'Lead statistikasi (admin)' },
    { command: 'sales_report', description: 'Sales funnel va active studentlar (admin)' },
    { command: 'ops_report', description: 'Yagona operational status (admin)' },
    { command: 'set_student', description: 'O‘quvchi holatini yangilash (admin)' },
    { command: 'export_csv', description: 'Leadlarni CSV qilish (admin)' },
    { command: 'retry_webhooks', description: 'Webhook retry (admin)' },
    { command: 'lead', description: 'Leadni Telegram ID bilan topish (admin)' },
    { command: 'set_status', description: 'Lead statusini yangilash (admin)' },
    { command: 'operator_note', description: 'Leadga operator izohi (admin)' },
    { command: 'channel_schedule', description: 'Tasdiqlangan postni rejalash (admin)' },
    { command: 'channel_cancel', description: 'Rejalangan postni bekor qilish (admin)' },
  ];
  await bot.telegram.setMyCommands(publicCommands, { scope: { type: 'default' } });
  await Promise.all(config.adminIds.map((chatId) => bot.telegram.setMyCommands([...publicCommands, ...adminCommands.slice(1)], { scope: { type: 'chat', chat_id: chatId } })));

  const followUpTimer = startFollowUpAutomation(bot, store, followUpStore);
  const leadSlaTimer = startLeadSlaEscalation(store, operationalAlerts, bot.telegram, config.adminIds);
  const dailyReportTimer = startDailyReport(bot, store, config.adminIds, config.dailyReportEnabled, config.dailyReportHour);
  const channelSchedulerTimer = config.channelSchedulerEnabled
    ? startChannelScheduler(channelPosts, bot.telegram, config.channelChatId, config.channelSchedulerPollMs, config.channelPublishStaleMs, channelMediaPolicy, { store: operationalAlerts, adminIds: config.adminIds })
    : undefined;

  await bot.launch(getBotLaunchOptions(config));
  console.log('WST Academy qabul bot is running.');

  const shutdown = async (signal: NodeJS.Signals) => {
    console.log(`Received ${signal}. Stopping bot...`);
    clearInterval(followUpTimer);
    clearInterval(leadSlaTimer);
    if (dailyReportTimer) clearInterval(dailyReportTimer);
    if (channelSchedulerTimer) clearInterval(channelSchedulerTimer);
    if (opsAggregateServer) await new Promise<void>((resolve) => opsAggregateServer.close(() => resolve()));
    bot.stop(signal);
    if (postgres) await postgres.close();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

bootstrap().catch((error) => {
  console.error('Failed to start bot:', error);
  process.exit(1);
});

function inferIntent(message: string): string {
  if (/narx|qancha|to['‘’`]?lov|tolov/i.test(message)) return 'price';
  if (/dastur|programma|nima|kamera|dvr|nvr/i.test(message)) return 'program';
  return 'ai_chat';
}
