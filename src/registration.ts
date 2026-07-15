import { randomUUID } from 'node:crypto';
import { Markup, Scenes } from 'telegraf';
import { courseInfo, formatCourseIntro } from './course.js';
import { notifyAdmins } from './admin.js';
import { deliverLeadWebhook } from './webhook.js';
import type { JsonFollowUpStore, JsonLeadStore, JsonWebhookFailureStore } from './storage.js';
import type { BotContext, Lead } from './types.js';
import { CALCULATOR_BUTTON, LESSON_BUTTON, QUIZ_BUTTON } from './learning.js';
import { parseStartAttribution, resetSessionForStart } from './startFlow.js';

const registerButton = Markup.keyboard([
  [LESSON_BUTTON, QUIZ_BUTTON],
  [CALCULATOR_BUTTON],
  ['Kurs dasturi', 'Narx va to‘lov'],
  ['Kurs haqida', 'Manzil va jadval'],
  ['Maxfiylik'],
  ['Ro‘yxatdan o‘tish', 'Operator bilan bog‘lanish'],
]).resize();
const cancelButton = Markup.keyboard([['Bekor qilish']]).resize();
const phoneButton = Markup.keyboard([[Markup.button.contactRequest('Telefon raqamni yuborish')], ['Bekor qilish']]).resize();

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

export async function markRegistrationConsent(followUpStore: JsonFollowUpStore, telegramId: number, startedAt = new Date().toISOString()): Promise<void> {
  await followUpStore.upsert({ telegramId, startedAt, count: 0 });
}

export function createRegistrationScene(store: JsonLeadStore, adminIds: number[], leadWebhookUrl: string | undefined, failureStore: JsonWebhookFailureStore, followUpStore: JsonFollowUpStore): Scenes.WizardScene<BotContext> {
  return new Scenes.WizardScene<BotContext>(
    REGISTRATION_SCENE_ID,
    async (ctx) => {
      ctx.scene.session.leadDraft = {};
      if (ctx.from?.id) await markRegistrationConsent(followUpStore, ctx.from.id);
      await ctx.reply('Ro‘yxatdan o‘tishni boshladingiz. Ism-familiyangizni kiriting:', cancelButton);
      return ctx.wizard.next();
    },
    async (ctx) => { if (await handleCancel(ctx)) return; ctx.scene.session.leadDraft = { ...ctx.scene.session.leadDraft, fullName: getText(ctx) }; await ctx.reply('Telefon raqamingizni yuboring yoki yozing:', phoneButton); return ctx.wizard.next(); },
    async (ctx) => { if (await handleCancel(ctx)) return; const phone = ctx.message && 'contact' in ctx.message && ctx.message.contact ? ctx.message.contact.phone_number : getText(ctx); ctx.scene.session.leadDraft = { ...ctx.scene.session.leadDraft, phone }; await ctx.reply('Yoshingiz nechida?', cancelButton); return ctx.wizard.next(); },
    async (ctx) => { if (await handleCancel(ctx)) return; ctx.scene.session.leadDraft = { ...ctx.scene.session.leadDraft, age: getText(ctx) }; await ctx.reply('Qaysi hudud/tumandansiz?', cancelButton); return ctx.wizard.next(); },
    async (ctx) => { if (await handleCancel(ctx)) return; ctx.scene.session.leadDraft = { ...ctx.scene.session.leadDraft, city: getText(ctx) }; await ctx.reply('Videokuzatuv, IT yoki texnika bo‘yicha tajribangiz bormi?', cancelButton); return ctx.wizard.next(); },
    async (ctx) => { if (await handleCancel(ctx)) return; ctx.scene.session.leadDraft = { ...ctx.scene.session.leadDraft, experience: getText(ctx) }; await ctx.reply('Sizga qaysi vaqt darsga kelish qulay?', cancelButton); return ctx.wizard.next(); },
    async (ctx) => { if (await handleCancel(ctx)) return; ctx.scene.session.leadDraft = { ...ctx.scene.session.leadDraft, preferredTime: getText(ctx) }; await ctx.reply('Qo‘shimcha izohingiz bo‘lsa yozing. Bo‘lmasa “yo‘q” deb yuboring.', cancelButton); return ctx.wizard.next(); },
    async (ctx) => {
      if (await handleCancel(ctx)) return;
      const draft = { ...ctx.scene.session.leadDraft, notes: getText(ctx) };
      const from = ctx.from;
      if (!from || !draft.fullName || !draft.phone || !draft.age || !draft.city || !draft.experience || !draft.preferredTime) { await ctx.reply('Ma’lumotlar to‘liq emas. /start orqali qayta urinib ko‘ring.', mainMenu()); return ctx.scene.leave(); }
      const now = new Date().toISOString();
      const lead: Lead = { id: randomUUID(), createdAt: now, updatedAt: now, telegramId: from.id, username: from.username, firstName: from.first_name, lastName: from.last_name, fullName: draft.fullName, phone: draft.phone, age: draft.age, city: draft.city, workStatus: '', experience: draft.experience, preferredTime: draft.preferredTime, notes: /^yo['‘’]?q$/i.test(draft.notes ?? '') ? undefined : draft.notes, goal: '', paymentOption: '', status: 'RegistrationCompleted', source: ctx.session.source ?? 'registration', campaignId: ctx.session.campaignId, intent: 'registration', lastMessage: draft.notes ?? 'registration completed', messages: [{ text: draft.notes ?? 'registration completed', createdAt: now }], operatorNote: '', nextFollowUp: '', paymentStatus: '' };
      const saved = await store.upsert(lead);
      await followUpStore.upsert({ telegramId: from.id, startedAt: saved.lead.createdAt, count: 0, registrationCompleted: true });
      await deliverLeadWebhook(leadWebhookUrl, failureStore, saved.created ? 'lead_created' : 'lead_updated', saved.lead);
      await notifyAdmins(ctx, adminIds, saved.lead);
      await ctx.reply(['Arizangiz qabul qilindi.', 'Operator tez orada siz bilan bog‘lanadi.', `Operator: ${courseInfo.operator}`, `Telefon: ${courseInfo.phone}`].join('\n'), mainMenu());
      return ctx.scene.leave();
    },
  );
}

export async function sendStart(ctx: BotContext): Promise<void> { await ctx.reply(formatCourseIntro(), startInlineMenu()); }
function getText(ctx: BotContext): string { return ctx.message && 'text' in ctx.message && ctx.message.text ? ctx.message.text.trim() : ''; }
async function handleCancel(ctx: BotContext): Promise<boolean> {
  const text = getText(ctx);
  if (/^\/start(?:\s|$)/i.test(text)) {
    const attribution = parseStartAttribution(text);
    resetSessionForStart(ctx.session, attribution);
    await ctx.scene.leave();
    await sendStart(ctx);
    return true;
  }
  if (text.toLowerCase() !== 'bekor qilish' && !/^\/cancel(?:@\w+)?$/i.test(text)) return false;
  ctx.scene.session.leadDraft = undefined;
  await ctx.scene.leave();
  await ctx.reply('Ro‘yxatdan o‘tish bekor qilindi.', mainMenu());
  return true;
}
