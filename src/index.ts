import { randomUUID } from 'node:crypto';
import { Telegraf, Scenes, session, Markup } from 'telegraf';
import { loadConfig, runtimeEnvironmentEvent } from './config.js';
import { formatCourseIntro, formatCourseProgram, formatLocationAndSchedule, formatPriceInfo, formatPrivacyInfo } from './course.js';
import { isAdmin, notifyCallRequestLead, notifyScoredHotLead, registerAdminCommands } from './admin.js';
import { JsonFollowUpStore, JsonLeadStore, JsonWebhookFailureStore } from './storage.js';
import { createRegistrationScene, mainMenu, phoneRequestKeyboard, REGISTRATION_SCENE_ID, sendStart } from './registration.js';
import { answerWithAiAgent, getTruthfulFallbackAnswer, getUnrelatedTopicAnswer, isCallRequest, isCallRequestCancel, isUnrelatedTopic, scoreLead } from './aiAgent.js';
import { configureLeadWebhookRetryPolicy, configureLeadWebhookSigning, deliverLeadWebhook } from './webhook.js';
import type { BotContext, BotSession, Lead, LeadSource } from './types.js';
import { startFollowUpAutomation } from './followups.js';
import { startDailyReport } from './dailyReport.js';
import { PostgresFollowUpStore, PostgresLeadStore, PostgresStorage } from './postgres.js';
import { JsonChannelPostStore } from './channelPosts.js';
import { PublisherRuntime } from './channelPublisher.js';
import { BACK_BUTTON, CALCULATOR_BUTTON, LESSON_BUTTON, MENU_BUTTON, NEXT_BUTTON, QUIZ, QUIZ_BUTTON, lessonKeyboard, lessonText, quizKeyboard, quizText, startCalculator, startLesson, startQuiz, storageTerabytes, validateCalculatorValue } from './learning.js';
import { explicitLeadSource, parseStartAttribution, resetSessionForStart } from './startFlow.js';
import { getProductSalesAnswer, isProductSalesQuestion } from './productSales.js';
import { isPermittedSalesConversation, persistSalesConversation } from './salesConversation.js';
import { startChannelScheduler } from './channelScheduler.js';
import { createAcademyMetricsLoader } from './salesReporting.js';
import { getBotLaunchOptions } from './botLaunch.js';
import { launchWithShutdownGate } from './telegramLifecycle.js';
import { JsonOperationalAlertStore } from './operationalAlerts.js';
import { startLeadSlaEscalation } from './leadSla.js';
import { startQabulOpsAggregateServer } from './opsAggregateServer.js';
import { createTelegramUpdateMiddleware, currentUpdateIdempotencyKey, installIdempotentTelegramApi, JsonTelegramSessionStore, runCurrentUpdateEffect, startTelegramUpdateRecovery, TelegramUpdateJournal, telegramUpdateTimestamp } from './telegramUpdates.js';
import { CONSENT_NOTICES, deriveAuthoritativeTelegramIdentity, JsonApplicantIdentityStore, withdrawnLeadAnonymizationPatch } from './applicantIdentity.js';
import { maskPhone, validateApplicantMessage } from './applicantValidation.js';

const callApplicationConsentKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('Roziman', 'call_consent_application_accept'), Markup.button.callback('Rad etaman', 'call_consent_application_decline')],
]);
const callOutboundConsentKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('Bog\u2018lanishga roziman', 'call_consent_outbound_accept'), Markup.button.callback('Bog\u2018lanmang', 'call_consent_outbound_decline')],
]);

function authoritativeActor(ctx: BotContext): { telegramUserId: number; telegramChatId: number; username?: string; chatType?: string } | undefined {
  return deriveAuthoritativeTelegramIdentity(ctx);
}

function correlationId(ctx: BotContext, label: string): string { return currentUpdateIdempotencyKey(label) ?? `telegram-update:${ctx.update.update_id}:${label}`; }

async function ensureApplicantIdentity(ctx: BotContext, identities: JsonApplicantIdentityStore, label: string) {
  const actor = authoritativeActor(ctx);
  if (!actor) return undefined;
  const result = await identities.identify(actor, correlationId(ctx, label), new Date(telegramUpdateTimestamp(ctx.update)), currentUpdateIdempotencyKey(label));
  return result.ok ? result.applicant : undefined;
}

async function startCallRequestConsent(ctx: BotContext, identities: JsonApplicantIdentityStore): Promise<void> {
  const applicant = await ensureApplicantIdentity(ctx, identities, 'identity:call-request');
  if (!applicant) { await ctx.reply('Operator so\u2018rovi faqat o\u2018zingizning shaxsiy Telegram chatingizda ishlaydi.', mainMenu()); return; }
  ctx.session.waitingForCallPhone = { message: 'explicit operator request', applicantId: applicant.applicantId };
  ctx.session.pendingConsentIntent = 'call_request_application';
  await ctx.reply([CONSENT_NOTICES.application.text, '', 'Operator so\u2018rovi uchun ham bu rozilik alohida tasdiqlanishi kerak.'].join('\n'), callApplicationConsentKeyboard);
}


async function saveCallRequestLead(ctx: BotContext, store: JsonLeadStore, failureStore: JsonWebhookFailureStore, adminIds: number[], leadWebhookUrl: string | undefined, applicantId: string, phone: string, message: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const lead: Lead = {
    id: randomUUID(), applicantId,
    createdAt: telegramUpdateTimestamp(ctx.update),
    updatedAt: telegramUpdateTimestamp(ctx.update),
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

  const saved = await store.upsert(lead, currentUpdateIdempotencyKey('applicant:call-request'));
  await deliverLeadWebhook(leadWebhookUrl, failureStore, 'call_request', saved.lead, undefined, currentUpdateIdempotencyKey('webhook:call-request'));

  await notifyCallRequestLead(ctx, adminIds, {
    username: from.username,
    telegramId: from.id,
    phone: maskPhone(phone),
    message: 'Explicit call request',
    reason: 'User asked for a call.',
  });
}

async function answerSalesAgent(ctx: BotContext, message: string, config: ReturnType<typeof loadConfig>, store: JsonLeadStore, failureStore: JsonWebhookFailureStore, identities: JsonApplicantIdentityStore): Promise<void> {
  if (isUnrelatedTopic(message)) {
    await ctx.reply(getUnrelatedTopicAnswer(message), mainMenu());
    return;
  }

  let result;
  try {
    result = await runCurrentUpdateEffect('ai:sales-answer', () => answerWithAiAgent(message, config.ai, { actorId: ctx.from?.id ? String(ctx.from.id) : undefined }));
  } catch (error) {
    console.error('AI agent failed:', error instanceof Error ? error.message : error);
    result = { answer: getTruthfulFallbackAnswer(message), ...scoreLead(message) };
  }
  await ctx.reply(result.answer, mainMenu());
  if (!isPermittedSalesConversation(message, result.score)) return;

  const from = ctx.from;
  if (!from) return;
  const identity = await identities.getByTelegramUserId(from.id);
  if (!identity || !(await identities.mayProcessApplication(from.id))) return;
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
    phone: identity.verificationStatus === 'CONTACT_VERIFIED' ? identity.normalizedPhone : undefined,
    now: telegramUpdateTimestamp(ctx.update),
    idempotencyKey: currentUpdateIdempotencyKey('applicant:sales-conversation'),
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
  ctx.session.pendingConsentIntent = undefined;
  ctx.session.outboundConsentAccepted = undefined;
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
  const environmentEvent = runtimeEnvironmentEvent(config);
  if (environmentEvent) console.warn(JSON.stringify(environmentEvent));
  configureLeadWebhookSigning(config.leadWebhookServiceId && config.leadWebhookSecret ? {
    serviceId: config.leadWebhookServiceId,
    secret: config.leadWebhookSecret,
  } : undefined);
  configureLeadWebhookRetryPolicy({
    maxAttempts: config.webhookMaxAttempts,
    retentionMs: config.webhookRetentionMs,
    retryBaseMs: config.webhookRetryBaseMs,
    retryMaxMs: config.webhookRetryMaxMs,
    claimLeaseMs: config.webhookClaimLeaseMs,
    maxManualReplays: config.webhookMaxManualReplays,
  });
  const postgres = config.databaseUrl ? new PostgresStorage(config.databaseUrl) : undefined;
  if (postgres) await postgres.migrate(config.leadsFile, config.followupsFile);
  const store = postgres ? new PostgresLeadStore(postgres) : new JsonLeadStore(config.leadsFile);
  const identities = new JsonApplicantIdentityStore(config.applicantIdentitiesFile);
  const failureStore = new JsonWebhookFailureStore(config.webhookFailedFile);
  const followUpStore = postgres ? new PostgresFollowUpStore(postgres) : new JsonFollowUpStore(config.followupsFile);
  const channelPosts = new JsonChannelPostStore(config.channelPostsFile);
  const publisherRuntime = new PublisherRuntime();
  const operationalAlerts = new JsonOperationalAlertStore(config.opsAlertsFile);
  const opsAggregateServer = config.opsAggregatePort && config.opsAggregateServiceId && config.opsAggregateSecret
    ? startQabulOpsAggregateServer({ port: config.opsAggregatePort, serviceId: config.opsAggregateServiceId, secret: config.opsAggregateSecret, leads: store, alerts: operationalAlerts, followUps: followUpStore, webhookFailures: failureStore })
    : undefined;
  const bot = new Telegraf<BotContext>(config.botToken);
  const stage = new Scenes.Stage<BotContext>([createRegistrationScene(store, config.adminIds, config.leadWebhookUrl, failureStore, followUpStore, identities)]);
  const updateJournal = new TelegramUpdateJournal(config.telegramUpdatesFile, {
    leaseMs: config.telegramUpdateLeaseMs,
    maxCompletedUpdates: config.telegramUpdateRetention,
  });

  installIdempotentTelegramApi(bot.telegram);
  bot.use(createTelegramUpdateMiddleware(updateJournal));
  bot.use(session<BotSession, BotContext>({ store: new JsonTelegramSessionStore(updateJournal) }));
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
  bot.command('withdraw_consent', async (ctx) => {
    const applicant = ctx.from?.id ? await identities.getByTelegramUserId(ctx.from.id) : undefined;
    if (!applicant) return ctx.reply('Faol ariza roziligi topilmadi.', mainMenu());
    const result = await identities.withdraw(applicant.applicantId, correlationId(ctx, 'consent:withdraw'), new Date(telegramUpdateTimestamp(ctx.update)), currentUpdateIdempotencyKey('consent:withdraw'));
    ctx.session.leadDraft = undefined;
    ctx.session.waitingForCallPhone = undefined;
    ctx.session.pendingConsentIntent = undefined;
    await followUpStore.cancelDelivery(ctx.from!.id, 'Applicant withdrew consent.', new Date(telegramUpdateTimestamp(ctx.update)));
    if (result.ok) await store.updateByTelegramId(ctx.from!.id, withdrawnLeadAnonymizationPatch(), currentUpdateIdempotencyKey('applicant:withdraw-anonymize'));
    return ctx.reply(result.ok ? 'Roziligingiz qaytarib olindi. Kelajakdagi ixtiyoriy xabarlar bloklandi; minimal audit dalili saqlanadi.' : 'Rozilikni qaytarib olishni xavfsiz yakunlab bo\u2018lmadi.', mainMenu());
  });
  bot.action('academy_lesson', async (ctx) => { await ctx.answerCbQuery(); await startLesson(ctx); });
  bot.action('academy_quiz', async (ctx) => { await ctx.answerCbQuery(); await startQuiz(ctx); });
  bot.action('academy_calculator', async (ctx) => { await ctx.answerCbQuery(); await startCalculator(ctx); });
  bot.action('academy_program', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply(formatCourseProgram(), mainMenu()); });
  bot.action('academy_price', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply(formatPriceInfo(), mainMenu()); });
  bot.action('academy_schedule', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply(formatLocationAndSchedule(), mainMenu()); });
  bot.action('academy_register', async (ctx) => { await ctx.answerCbQuery(); await ctx.scene.enter(REGISTRATION_SCENE_ID); });
  bot.action('call_consent_application_accept', async (ctx) => {
    await ctx.answerCbQuery();
    const applicant = await ensureApplicantIdentity(ctx, identities, 'identity:call-consent');
    if (!applicant || ctx.session.pendingConsentIntent !== 'call_request_application') return ctx.reply('Rozilik sessiyasi topilmadi. Operator so\u2018rovini qayta boshlang.', mainMenu());
    const result = await identities.recordConsent(applicant.applicantId, CONSENT_NOTICES.application, true, true, 'telegram_callback', correlationId(ctx, 'consent:call-application'), new Date(telegramUpdateTimestamp(ctx.update)), currentUpdateIdempotencyKey('consent:call-application'));
    if (!result.ok) return ctx.reply('Ariza roziligini xavfsiz saqlab bo\u2018lmadi.', mainMenu());
    ctx.session.pendingConsentIntent = 'call_request_outbound';
    return ctx.reply([CONSENT_NOTICES.outbound.text, 'Bu tanlov ariza ma\u2019lumotlarini saqlash roziligidan alohida.'].join('\n'), callOutboundConsentKeyboard);
  });
  bot.action('call_consent_application_decline', async (ctx) => {
    await ctx.answerCbQuery();
    const applicant = await ensureApplicantIdentity(ctx, identities, 'identity:call-decline');
    if (applicant) await identities.recordConsent(applicant.applicantId, CONSENT_NOTICES.application, false, true, 'telegram_callback', correlationId(ctx, 'consent:call-application-decline'), new Date(telegramUpdateTimestamp(ctx.update)), currentUpdateIdempotencyKey('consent:call-application-decline'));
    ctx.session.waitingForCallPhone = undefined;
    ctx.session.pendingConsentIntent = undefined;
    return ctx.reply('Rozilik berilmadi. Telefon yoki ariza ma\u2019lumotlari yig\u2018ilmadi.', mainMenu());
  });
  bot.action('call_consent_outbound_accept', async (ctx) => {
    await ctx.answerCbQuery();
    const applicant = await ensureApplicantIdentity(ctx, identities, 'identity:call-outbound');
    if (!applicant || ctx.session.pendingConsentIntent !== 'call_request_outbound' || !ctx.session.waitingForCallPhone) return ctx.reply('Rozilik sessiyasi topilmadi. Operator so\u2018rovini qayta boshlang.', mainMenu());
    const result = await identities.recordConsent(applicant.applicantId, CONSENT_NOTICES.outbound, true, true, 'telegram_callback', correlationId(ctx, 'consent:call-outbound'), new Date(telegramUpdateTimestamp(ctx.update)), currentUpdateIdempotencyKey('consent:call-outbound'));
    if (!result.ok) return ctx.reply('Bog\u2018lanish roziligini xavfsiz saqlab bo\u2018lmadi.', mainMenu());
    ctx.session.pendingConsentIntent = undefined;
    ctx.session.waitingForCallPhone.applicantId = applicant.applicantId;
    return ctx.reply('Pastdagi tugma orqali faqat o\u2018zingizga tegishli Telegram kontaktini yuboring.', phoneRequestKeyboard());
  });
  bot.action('call_consent_outbound_decline', async (ctx) => {
    await ctx.answerCbQuery();
    const applicant = await ensureApplicantIdentity(ctx, identities, 'identity:call-outbound-decline');
    if (applicant) await identities.recordConsent(applicant.applicantId, CONSENT_NOTICES.outbound, false, true, 'telegram_callback', correlationId(ctx, 'consent:call-outbound-decline'), new Date(telegramUpdateTimestamp(ctx.update)), currentUpdateIdempotencyKey('consent:call-outbound-decline'));
    ctx.session.waitingForCallPhone = undefined;
    ctx.session.pendingConsentIntent = undefined;
    return ctx.reply('Bog\u2018lanish roziligi berilmadi. Operator so\u2018rovi yuborilmadi.', mainMenu());
  });
  bot.hears(LESSON_BUTTON, startLesson);
  bot.hears(QUIZ_BUTTON, startQuiz);
  bot.hears(CALCULATOR_BUTTON, startCalculator);
  bot.hears('Ro‘yxatdan o‘tish', (ctx) => ctx.scene.enter(REGISTRATION_SCENE_ID));
  bot.hears('Kurs dasturi', (ctx) => ctx.reply(formatCourseProgram(), mainMenu()));
  bot.hears('Narx va to‘lov', (ctx) => ctx.reply(formatPriceInfo(), mainMenu()));
  bot.hears('Kurs haqida', (ctx) => ctx.reply(formatCourseIntro(), mainMenu()));
  bot.hears('Manzil va jadval', (ctx) => ctx.reply(formatLocationAndSchedule(), mainMenu()));
  bot.hears('Maxfiylik', (ctx) => ctx.reply(formatPrivacyInfo(), mainMenu()));
  bot.hears('Operator bilan bog‘lanish', (ctx) => startCallRequestConsent(ctx, identities));

  const channelMediaPolicy = { assetRoot: config.channelAssetRoot, allowedHttpsHosts: config.channelImageHosts };
  const academyMetrics = config.academyReportBaseUrl && config.leadWebhookServiceId && config.leadWebhookSecret
    ? createAcademyMetricsLoader({
        baseUrl: config.academyReportBaseUrl,
        serviceId: config.leadWebhookServiceId,
        serviceSecret: config.leadWebhookSecret,
        timeoutMs: config.academyReportTimeoutMs,
      })
    : undefined;
  registerAdminCommands(bot, store, config.adminIds, failureStore, config.leadWebhookUrl, channelPosts, config.channelChatId, config.botToken, channelMediaPolicy, academyMetrics, operationalAlerts, {
    runtime: publisherRuntime,
    claimLeaseMs: config.channelClaimLeaseMs,
    claimRenewMs: config.channelClaimRenewMs,
    uncertainWindowMs: config.channelUncertainWindowMs,
  });

  bot.on('photo', async (ctx) => {
    if (!isAdmin(ctx, config.adminIds)) return;
    const caption = ctx.message?.caption?.trim() ?? '';
    if (!caption.startsWith('/channel_photo')) return;
    const text = caption.replace(/^\/channel_photo(?:@\w+)?\s*/i, '').trim();
    const photos = ctx.message?.photo ?? [];
    const photoFileId = photos[photos.length - 1]?.file_id;
    if (!photoFileId || text.length < 20 || text.length > 1024) return ctx.reply('Photo caption 20–1024 belgi bo‘lishi kerak.');
    const post = await channelPosts.create(text, photoFileId, ctx.from?.id, currentUpdateIdempotencyKey('channel:photo-draft'));
    return ctx.reply(`Rasmli draft saqlandi: ${post.id}\nYuborish: /channel_publish ${post.id}`);
  });

  bot.on('contact', async (ctx) => {
    const pending = ctx.session.waitingForCallPhone;
    const contact = ctx.message?.contact;
    const actor = authoritativeActor(ctx);
    if (!pending?.applicantId || !contact || !actor) return;
    const forwarded = Boolean(ctx.message?.forward_origin || ctx.message?.forward_from || ctx.message?.forward_sender_name);
    const verified = await identities.attachTelegramContact(pending.applicantId, contact.phone_number, { senderUserId: actor.telegramUserId, contactUserId: contact.user_id, forwarded }, correlationId(ctx, 'identity:call-contact'), new Date(telegramUpdateTimestamp(ctx.update)), currentUpdateIdempotencyKey('identity:call-contact'));
    if (!verified.ok) return ctx.reply(verified.reason === 'conflict' ? 'Bu telefon boshqa identifikatsiya bilan bog‘langan. Avtomatik birlashtirish bloklandi.' : 'Kontakt egasi Telegram yuboruvchisi bilan mos kelmadi. Faqat o‘zingizning kontakt tugmangizdan foydalaning.', phoneRequestKeyboard());
    if (!verified.applicant.normalizedPhone) return ctx.reply('Telefon raqamini tasdiqlab bo‘lmadi.', phoneRequestKeyboard());
    if (!(await identities.mayProcessApplication(actor.telegramUserId)) || !(await identities.hasConsent(actor.telegramUserId, CONSENT_NOTICES.outbound))) return ctx.reply('Operator so‘rovi uchun ariza va bog‘lanish roziliklari faol bo‘lishi kerak.', mainMenu());
    ctx.session.waitingForCallPhone = undefined;
    await saveCallRequestLead(ctx, store, failureStore, config.adminIds, config.leadWebhookUrl, pending.applicantId, verified.applicant.normalizedPhone, pending.message);
    await ctx.reply('Rahmat. Tasdiqlangan telefon raqamingiz qabul qilindi. Roziligingizga muvofiq operator bog‘lanishi mumkin.', mainMenu());
  });

  bot.on('text', async (ctx) => {
    const rawMessage = ctx.message?.text?.trim();

    if (!rawMessage || rawMessage.startsWith('/') || ctx.scene.current) return;
    const validatedMessage = validateApplicantMessage(rawMessage);
    if (!validatedMessage.ok) return ctx.reply(validatedMessage.message, mainMenu());
    const message = validatedMessage.value;
    const telegramContext = ctx as unknown as { chat?: { id: number; type: string }; from?: { is_bot?: boolean } };
    if (telegramContext.chat?.type !== 'private') {
      if (telegramContext.chat?.id !== config.salesDiscussionChatId || telegramContext.from?.is_bot || !isProductSalesQuestion(message)) return;
      await ctx.reply(getProductSalesAnswer(message, config.operatorUsername));
      return;
    }
    if (await handleLearningText(ctx, message)) return;

    if (ctx.session.waitingForCallPhone) {
      if (isCallRequestCancel(message)) {
        ctx.session.waitingForCallPhone = undefined;
        ctx.session.pendingConsentIntent = undefined;
        await ctx.reply('Mayli. Operator so‘rovi bekor qilindi.', mainMenu());
        return;
      }
      await ctx.reply('Yozilgan raqam telefon egaligini tasdiqlamaydi. Pastdagi tugma orqali faqat o‘zingizning Telegram kontaktingizni yuboring.', phoneRequestKeyboard());
      return;
    }

    if (isCallRequest(message)) {
      await startCallRequestConsent(ctx, identities);
      return;
    }

    await answerSalesAgent(ctx, message, config, store, failureStore, identities);
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
    { command: 'withdraw_consent', description: 'Ariza roziligini qaytarib olish' },
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
    { command: 'channel_reconcile', description: 'Noaniq kanal yuborilishini reconciled qilish (admin)' },
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
    { command: 'webhook_failures', description: 'Webhook retry/dead-letter holatlari (admin)' },
    { command: 'replay_webhook', description: 'Webhook manual replay (admin)' },
    { command: 'lead', description: 'Leadni Telegram ID bilan topish (admin)' },
    { command: 'set_status', description: 'Lead statusini yangilash (admin)' },
    { command: 'operator_note', description: 'Leadga operator izohi (admin)' },
    { command: 'channel_schedule', description: 'Tasdiqlangan postni rejalash (admin)' },
    { command: 'channel_cancel', description: 'Rejalangan postni bekor qilish (admin)' },
  ];
  await bot.telegram.setMyCommands(publicCommands, { scope: { type: 'default' } });
  await Promise.all(config.adminIds.map((chatId) => bot.telegram.setMyCommands([...publicCommands, ...adminCommands.slice(1)], { scope: { type: 'chat', chat_id: chatId } })));

  const followUpTimer = startFollowUpAutomation(bot, store, followUpStore, {
    claimLeaseMs: config.followUpClaimLeaseMs,
    maxAttempts: config.followUpMaxAttempts,
    retryBaseMs: config.followUpRetryBaseMs,
    retryMaxMs: config.followUpRetryMaxMs,
    canSendNonEssential: (telegramId) => identities.maySendFollowUp(telegramId),
  });
  const leadSlaTimer = startLeadSlaEscalation(store, operationalAlerts, bot.telegram, config.adminIds);
  const dailyReportTimer = startDailyReport(bot, store, config.adminIds, config.dailyReportEnabled, config.dailyReportHour);
  const channelSchedulerTimer = config.channelSchedulerEnabled
    ? startChannelScheduler(channelPosts, bot.telegram, config.channelChatId, config.channelSchedulerPollMs, config.channelClaimLeaseMs, channelMediaPolicy, { store: operationalAlerts, adminIds: config.adminIds }, { runtime: publisherRuntime, claimRenewMs: config.channelClaimRenewMs, uncertainWindowMs: config.channelUncertainWindowMs })
    : undefined;

  let telegramUpdateRecoveryTimer: NodeJS.Timeout | undefined;
  let botRunning = false;
  let shutdownRequested = false;
  let shutdownInFlight: Promise<void> | undefined;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    shutdownRequested = true;
    console.log(JSON.stringify({ event: 'shutdown_started', signal }));
    channelSchedulerTimer?.stopAccepting();
    publisherRuntime.stopAccepting();
    followUpTimer.stopAccepting();
    if (botRunning) {
      try { bot.stop(signal); } catch (error) { console.error('Telegram polling stop failed:', error instanceof Error ? error.message : String(error)); }
      botRunning = false;
    }
    if (telegramUpdateRecoveryTimer) clearInterval(telegramUpdateRecoveryTimer);
    clearInterval(leadSlaTimer);
    if (dailyReportTimer) clearInterval(dailyReportTimer);
    const [schedulerDrain, publisherDrain, followUpDrain] = await Promise.all([
      channelSchedulerTimer?.stopAndDrain(config.shutdownDrainTimeoutMs) ?? Promise.resolve({ drained: true, timedOut: false, durationMs: 0 }),
      publisherRuntime.drain(config.shutdownDrainTimeoutMs),
      followUpTimer.stopAndDrain(config.shutdownDrainTimeoutMs),
    ]);
    console.log(JSON.stringify({ event: 'shutdown_drain_completed', scheduler: schedulerDrain, publisher: publisherDrain, followUp: followUpDrain }));
    if (opsAggregateServer) await new Promise<void>((resolve) => opsAggregateServer.close(() => resolve()));
    if (postgres) await postgres.close();
    process.exit(schedulerDrain.timedOut || publisherDrain.timedOut || followUpDrain.timedOut ? 1 : 0);
  };

  const requestShutdown = (signal: NodeJS.Signals) => {
    shutdownInFlight ??= shutdown(signal).catch((error) => {
      console.error('Graceful shutdown failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  };
  process.once('SIGINT', requestShutdown);
  process.once('SIGTERM', requestShutdown);
  await launchWithShutdownGate(bot, getBotLaunchOptions(config), () => shutdownRequested, () => {
    botRunning = true;
    telegramUpdateRecoveryTimer = startTelegramUpdateRecovery(bot, updateJournal);
    console.log('WST Academy qabul bot is running.');
  });
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
