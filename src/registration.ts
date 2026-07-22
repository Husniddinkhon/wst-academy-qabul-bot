import { randomUUID } from 'node:crypto';
import { Markup, Scenes } from 'telegraf';
import { courseInfo, formatCourseIntro } from './course.js';
import { notifyAdmins } from './admin.js';
import { deliverLeadWebhook } from './webhook.js';
import type { JsonFollowUpStore, JsonLeadStore, JsonWebhookFailureStore } from './storage.js';
import type { BotContext, Lead } from './types.js';
import { CALCULATOR_BUTTON, LESSON_BUTTON, QUIZ_BUTTON } from './learning.js';
import { parseStartAttribution, resetSessionForStart } from './startFlow.js';
import { currentUpdateIdempotencyKey, telegramUpdateTimestamp } from './telegramUpdates.js';
import { CONSENT_NOTICES, deriveAuthoritativeTelegramIdentity, JsonApplicantIdentityStore } from './applicantIdentity.js';
import { enforceApplicantDataMinimization, validateApplicantAge, validateApplicantName, validateFreeText, validateRegion } from './applicantValidation.js';

const CONSENT_ACCEPT = 'Roziman';
const CONSENT_DECLINE = 'Rad etaman';
const OUTBOUND_ACCEPT = 'Bog\u2018lanishga roziman';
const OUTBOUND_DECLINE = 'Bog\u2018lanmang';
const FOLLOWUP_ACCEPT = 'Eslatmaga roziman';
const FOLLOWUP_DECLINE = 'Eslatma kerak emas';

const registerButton = Markup.keyboard([
  [LESSON_BUTTON, QUIZ_BUTTON],
  [CALCULATOR_BUTTON],
  ['Kurs dasturi', 'Narx va to\u2018lov'],
  ['Kurs haqida', 'Manzil va jadval'],
  ['Maxfiylik'],
  ['Ro\u2018yxatdan o\u2018tish', 'Operator bilan bog\u2018lanish'],
]).resize();
const cancelButton = Markup.keyboard([['Bekor qilish']]).resize();
const phoneButton = Markup.keyboard([[Markup.button.contactRequest('O\u2018z telefon raqamimni yuborish')], ['Bekor qilish']]).resize();
const applicationConsentKeyboard = Markup.keyboard([[CONSENT_ACCEPT, CONSENT_DECLINE], ['Bekor qilish']]).resize();
const outboundConsentKeyboard = Markup.keyboard([[OUTBOUND_ACCEPT, OUTBOUND_DECLINE], ['Bekor qilish']]).resize();
const followUpConsentKeyboard = Markup.keyboard([[FOLLOWUP_ACCEPT, FOLLOWUP_DECLINE], ['Bekor qilish']]).resize();

export const REGISTRATION_SCENE_ID = 'registration';
export function mainMenu() { return registerButton; }
export function phoneRequestKeyboard() { return phoneButton; }
export function startInlineMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Bepul mini-dars', 'academy_lesson'), Markup.button.callback('Bilim testi', 'academy_quiz')],
    [Markup.button.callback('Kurs dasturi', 'academy_program'), Markup.button.callback('Narx va to\u2018lov', 'academy_price')],
    [Markup.button.callback('Manzil va jadval', 'academy_schedule'), Markup.button.callback('Xotira kalkulyatori', 'academy_calculator')],
    [Markup.button.callback('Ro\u2018yxatdan o\u2018tish', 'academy_register')],
  ]);
}

export async function markRegistrationFollowUpOptIn(followUpStore: JsonFollowUpStore, identities: JsonApplicantIdentityStore, telegramId: number, startedAt = new Date().toISOString(), idempotencyKey?: string): Promise<boolean> {
  if (!(await identities.maySendFollowUp(telegramId))) return false;
  await followUpStore.upsert({ telegramId, startedAt, count: 0 }, idempotencyKey);
  return true;
}

export function createRegistrationScene(store: JsonLeadStore, notificationRecipients: (lead: Lead) => Promise<number[]>, leadWebhookUrl: string | undefined, failureStore: JsonWebhookFailureStore, followUpStore: JsonFollowUpStore, identities: JsonApplicantIdentityStore): Scenes.WizardScene<BotContext> {
  return new Scenes.WizardScene<BotContext>(
    REGISTRATION_SCENE_ID,
    async (ctx) => {
      ctx.scene.session.leadDraft = {};
      const actor = authoritativeActor(ctx);
      if (!actor) return leaveWith(ctx, 'Ro\u2018yxatdan o\u2018tish faqat o\u2018zingizning shaxsiy Telegram chatingizda ishlaydi.');
      const correlation = correlationId(ctx, 'identity:start');
      const identified = await identities.identify(actor, correlation, updateDate(ctx), currentUpdateIdempotencyKey('identity:start'));
      if (!identified.ok) return leaveWith(ctx, identityFailureMessage(identified.reason));
      ctx.scene.session.applicantId = identified.applicant.applicantId;
      await ctx.reply([CONSENT_NOTICES.application.text, '', `Rozilik versiyasi: ${CONSENT_NOTICES.application.version}`, 'Rozilik ixtiyoriy. Rad etsangiz, ariza ma\u2019lumotlari yig\u2018ilmaydi.'].join('\n'), applicationConsentKeyboard);
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (await handleCancel(ctx)) return;
      const choice = getText(ctx);
      if (![CONSENT_ACCEPT, CONSENT_DECLINE].includes(choice)) return ctx.reply('Iltimos, \u201cRoziman\u201d yoki \u201cRad etaman\u201d tugmasini tanlang.', applicationConsentKeyboard);
      const applicantId = ctx.scene.session.applicantId;
      if (!applicantId) return leaveWith(ctx, 'Ariza identifikatori topilmadi. /start orqali qayta boshlang.');
      const accepted = choice === CONSENT_ACCEPT;
      const result = await identities.recordConsent(applicantId, CONSENT_NOTICES.application, accepted, true, 'telegram_wizard', correlationId(ctx, 'consent:application'), updateDate(ctx), currentUpdateIdempotencyKey('consent:application'));
      if (!result.ok) return leaveWith(ctx, identityFailureMessage(result.reason));
      if (!accepted) return leaveWith(ctx, 'Tushunarli. Rozilik berilmadi va ariza ma\u2019lumotlari yig\u2018ilmadi. Keyin istasangiz qayta boshlashingiz mumkin.');
      await ctx.reply([CONSENT_NOTICES.outbound.text, 'Bu rozilik arizani saqlash roziligidan alohida.'].join('\n'), outboundConsentKeyboard);
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (await handleCancel(ctx)) return;
      const choice = getText(ctx);
      if (![OUTBOUND_ACCEPT, OUTBOUND_DECLINE].includes(choice)) return ctx.reply('Bog\u2018lanish bo\u2018yicha variantlardan birini tanlang.', outboundConsentKeyboard);
      const applicantId = ctx.scene.session.applicantId!;
      const accepted = choice === OUTBOUND_ACCEPT;
      const result = await identities.recordConsent(applicantId, CONSENT_NOTICES.outbound, accepted, true, 'telegram_wizard', correlationId(ctx, 'consent:outbound'), updateDate(ctx), currentUpdateIdempotencyKey('consent:outbound'));
      if (!result.ok) return leaveWith(ctx, identityFailureMessage(result.reason));
      ctx.scene.session.outboundConsentAccepted = accepted;
      await ctx.reply([CONSENT_NOTICES.followUp.text, 'Bu tanlov ham alohida va ixtiyoriy.'].join('\n'), followUpConsentKeyboard);
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (await handleCancel(ctx)) return;
      const choice = getText(ctx);
      if (![FOLLOWUP_ACCEPT, FOLLOWUP_DECLINE].includes(choice)) return ctx.reply('Eslatma bo\u2018yicha variantlardan birini tanlang.', followUpConsentKeyboard);
      const requested = choice === FOLLOWUP_ACCEPT;
      const accepted = requested && ctx.scene.session.outboundConsentAccepted === true;
      const result = await identities.recordConsent(ctx.scene.session.applicantId!, CONSENT_NOTICES.followUp, accepted, true, 'telegram_wizard', correlationId(ctx, 'consent:followup'), updateDate(ctx), currentUpdateIdempotencyKey('consent:followup'));
      if (!result.ok) return leaveWith(ctx, identityFailureMessage(result.reason));
      if (requested && !accepted) await ctx.reply('Eslatma yuborish uchun bog\u2018lanish roziligi ham kerak. Eslatmalar yoqilmadi.');
      if (accepted && ctx.from?.id) await markRegistrationFollowUpOptIn(followUpStore, identities, ctx.from.id, telegramUpdateTimestamp(ctx.update), currentUpdateIdempotencyKey('followup:registration-opt-in'));
      await ctx.reply('Ism-familiyangizni kiriting:', cancelButton);
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (await handleCancel(ctx)) return;
      const value = validateApplicantName(getText(ctx));
      if (!value.ok) return ctx.reply(value.message, cancelButton);
      ctx.scene.session.leadDraft = { ...ctx.scene.session.leadDraft, fullName: value.value };
      await ctx.reply('Pastdagi tugma orqali faqat o\u2018zingizga tegishli Telegram kontaktini yuboring. Yozib yuborilgan yoki boshqa odamga tegishli raqam qabul qilinmaydi.', phoneButton);
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (await handleCancel(ctx)) return;
      const actor = authoritativeActor(ctx);
      const contact = ctx.message?.contact;
      if (!actor || !contact) return ctx.reply('Telefon egaligini tasdiqlash uchun \u201cO\u2018z telefon raqamimni yuborish\u201d tugmasidan foydalaning.', phoneButton);
      const forwarded = Boolean(ctx.message?.forward_origin || ctx.message?.forward_from || ctx.message?.forward_sender_name);
      const result = await identities.attachTelegramContact(ctx.scene.session.applicantId!, contact.phone_number, { senderUserId: actor.telegramUserId, contactUserId: contact.user_id, forwarded }, correlationId(ctx, 'identity:contact'), updateDate(ctx), currentUpdateIdempotencyKey('identity:contact'));
      if (!result.ok) return ctx.reply(result.reason === 'conflict' ? 'Bu telefon boshqa identifikatsiya bilan bog\u2018langan. Avtomatik birlashtirish bloklandi; inson ko\u2018rigi kerak.' : 'Kontakt sizning Telegram hisobingizga tegishli ekanini tasdiqlab bo\u2018lmadi. O\u2018zingizning kontakt tugmangizdan foydalaning.', phoneButton);
      const started = await identities.beginApplication(result.applicant.applicantId, correlationId(ctx, 'application:draft'), updateDate(ctx), currentUpdateIdempotencyKey('application:draft'));
      if (!started.ok) return leaveWith(ctx, identityFailureMessage(started.reason));
      ctx.scene.session.leadDraft = { ...ctx.scene.session.leadDraft, phone: result.applicant.normalizedPhone };
      await ctx.reply('Yoshingiz nechida? (16-80)', cancelButton);
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (await handleCancel(ctx)) return;
      const value = validateApplicantAge(getText(ctx));
      if (!value.ok) return ctx.reply(value.message, cancelButton);
      ctx.scene.session.leadDraft = { ...ctx.scene.session.leadDraft, age: value.value };
      await ctx.reply('Qaysi hudud yoki tumandansiz?', cancelButton);
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (await handleCancel(ctx)) return;
      const value = validateRegion(getText(ctx));
      if (!value.ok) return ctx.reply(value.message, cancelButton);
      ctx.scene.session.leadDraft = { ...ctx.scene.session.leadDraft, city: value.value };
      await ctx.reply('Videokuzatuv, IT yoki texnika bo\u2018yicha tajribangizni qisqa yozing.', cancelButton);
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (await handleCancel(ctx)) return;
      const value = validateFreeText(getText(ctx), { required: true, maxLength: 300 });
      if (!value.ok) return ctx.reply(value.message, cancelButton);
      ctx.scene.session.leadDraft = { ...ctx.scene.session.leadDraft, experience: value.value };
      await ctx.reply('Sizga qaysi vaqt darsga kelish qulay?', cancelButton);
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (await handleCancel(ctx)) return;
      const value = validateFreeText(getText(ctx), { required: true, maxLength: 120 });
      if (!value.ok) return ctx.reply(value.message, cancelButton);
      ctx.scene.session.leadDraft = { ...ctx.scene.session.leadDraft, preferredTime: value.value };
      await ctx.reply('Qo\u2018shimcha izohingiz bo\u2018lsa yozing. Bo\u2018lmasa \u201cyo\u2018q\u201d deb yuboring.', cancelButton);
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (await handleCancel(ctx)) return;
      const notes = validateFreeText(getText(ctx), { required: true, maxLength: 500 });
      if (!notes.ok) return ctx.reply(notes.message, cancelButton);
      const draft = { ...ctx.scene.session.leadDraft, notes: notes.value };
      const from = ctx.from;
      const applicantId = ctx.scene.session.applicantId;
      if (!from || !applicantId || !draft.fullName || !draft.phone || !draft.age || !draft.city || !draft.experience || !draft.preferredTime) return leaveWith(ctx, 'Ma\u2019lumotlar to\u2018liq emas. /start orqali qayta urinib ko\u2018ring.');
      const now = telegramUpdateTimestamp(ctx.update);
      const minimized = enforceApplicantDataMinimization({ fullName: draft.fullName, phone: draft.phone, age: draft.age, region: draft.city, program: 'cctv', experience: draft.experience, preferredTime: draft.preferredTime, notes: draft.notes });
      if (!minimized.ok) return leaveWith(ctx, minimized.message);
      const submissionKey = correlationId(ctx, 'application:submission');
      const submitted = await identities.submitApplication(applicantId, submissionKey, submissionKey, updateDate(ctx), currentUpdateIdempotencyKey('application:submission'));
      if (!submitted.ok) return leaveWith(ctx, submitted.reason === 'duplicate_submission' ? 'Bu ariza avval yuborilgan. Takroriy yuborish bloklandi.' : identityFailureMessage(submitted.reason));
      const lead: Lead = {
        id: randomUUID(), applicantId, createdAt: now, updatedAt: now, telegramId: from.id, username: from.username,
        fullName: draft.fullName, phone: draft.phone, age: draft.age, city: draft.city, workStatus: '', experience: draft.experience,
        preferredTime: draft.preferredTime, notes: /^yo['\u2018\u2019]?q$/iu.test(draft.notes ?? '') ? undefined : draft.notes,
        goal: 'cctv', paymentOption: '', status: 'RegistrationCompleted', source: ctx.session.source ?? 'registration', campaignId: ctx.session.campaignId,
        intent: 'registration', lastMessage: 'application submitted', messages: [], operatorNote: '', nextFollowUp: '', paymentStatus: '',
      };
      const saved = await store.upsert(lead, currentUpdateIdempotencyKey('applicant:registration-complete'));
      if (await identities.maySendFollowUp(from.id)) await followUpStore.upsert({ telegramId: from.id, startedAt: saved.lead.createdAt, count: 0, registrationCompleted: true }, currentUpdateIdempotencyKey('followup:registration-complete'));
      await deliverLeadWebhook(leadWebhookUrl, failureStore, saved.created ? 'lead_created' : 'lead_updated', saved.lead, undefined, currentUpdateIdempotencyKey('webhook:registration-complete'));
      await notifyAdmins(ctx, await notificationRecipients(saved.lead), saved.lead);
      ctx.scene.session.leadDraft = undefined;
      await ctx.reply(['Arizangiz qabul qilindi.', 'Rozilik bergan bo\u2018lsangiz, operator siz bilan bog\u2018lanadi.', `Operator: ${courseInfo.operator}`, `Telefon: ${courseInfo.phone}`].join('\n'), mainMenu());
      return ctx.scene.leave();
    },
  );
}

export async function sendStart(ctx: BotContext): Promise<void> { await ctx.reply(formatCourseIntro(), startInlineMenu()); }
function getText(ctx: BotContext): string { return ctx.message?.text?.trim() ?? ''; }
function updateDate(ctx: BotContext): Date { return new Date(telegramUpdateTimestamp(ctx.update)); }
function correlationId(ctx: BotContext, label: string): string { return currentUpdateIdempotencyKey(label) ?? `telegram-update:${ctx.update.update_id}:${label}`; }
function authoritativeActor(ctx: BotContext) { return deriveAuthoritativeTelegramIdentity(ctx); }
function identityFailureMessage(reason: string): string { if (reason === 'blocked') return 'Bu identifikatsiya bloklangan. Operator ko\u2018rigi kerak.'; if (reason === 'conflict') return 'Identifikatsiya ziddiyati aniqlandi. Avtomatik birlashtirish bloklandi; inson ko\u2018rigi kerak.'; if (reason === 'duplicate_submission') return 'Bu ariza avval yuborilgan.'; if (reason === 'consent_required') return 'Davom etish uchun amaldagi aniq rozilik kerak.'; if (reason === 'identity_unverified') return 'Telefon egaligi tasdiqlanmaguncha davom etib bo\u2018lmaydi.'; return 'Identifikatsiyani xavfsiz tasdiqlab bo\u2018lmadi. /start orqali qayta urinib ko\u2018ring.'; }
async function leaveWith(ctx: BotContext, message: string): Promise<unknown> { ctx.scene.session.leadDraft = undefined; await ctx.scene.leave(); return ctx.reply(message, mainMenu()); }
async function handleCancel(ctx: BotContext): Promise<boolean> {
  const text = getText(ctx);
  if (/^\/start(?:\s|$)/i.test(text)) { const attribution = parseStartAttribution(text); resetSessionForStart(ctx.session, attribution); await ctx.scene.leave(); await sendStart(ctx); return true; }
  if (text.toLowerCase() !== 'bekor qilish' && !/^\/cancel(?:@\w+)?$/i.test(text)) return false;
  ctx.scene.session.leadDraft = undefined;
  await ctx.scene.leave();
  await ctx.reply('Ro\u2018yxatdan o\u2018tish bekor qilindi. Saqlangan rozilikni /withdraw_consent orqali qaytarib olishingiz mumkin.', mainMenu());
  return true;
}
