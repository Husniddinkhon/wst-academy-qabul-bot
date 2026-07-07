import { randomUUID } from 'node:crypto';
import { Markup, Scenes } from 'telegraf';
import { courseInfo, formatCourseIntro } from './course.js';
import { notifyAdmins } from './admin.js';
import { sendLeadWebhook } from './webhook.js';
import type { JsonLeadStore } from './storage.js';
import type { BotContext, Lead } from './types.js';

const registerButton = Markup.keyboard([['📝 Ro‘yxatdan o‘tish'], ['📞 Operator bilan bog‘lanish']]).resize();
const cancelButton = Markup.keyboard([['Bekor qilish']]).resize();
const phoneButton = Markup.keyboard([[Markup.button.contactRequest('📱 Telefon raqamni yuborish')], ['Bekor qilish']]).resize();

export const REGISTRATION_SCENE_ID = 'registration';

export function mainMenu() {
  return registerButton;
}

export function createRegistrationScene(store: JsonLeadStore, adminIds: number[], leadWebhookUrl?: string): Scenes.WizardScene<BotContext> {
  return new Scenes.WizardScene<BotContext>(
    REGISTRATION_SCENE_ID,
    async (ctx) => {
      ctx.scene.session.leadDraft = {};
      await ctx.reply('Ism-familiyangizni kiriting:', cancelButton);
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (await handleCancel(ctx)) return;
      ctx.scene.session.leadDraft = { ...ctx.scene.session.leadDraft, fullName: getText(ctx) };
      await ctx.reply('Telefon raqamingizni yuboring yoki yozing:', phoneButton);
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (await handleCancel(ctx)) return;
      const phone = ctx.message && 'contact' in ctx.message && ctx.message.contact ? ctx.message.contact.phone_number : getText(ctx);
      ctx.scene.session.leadDraft = { ...ctx.scene.session.leadDraft, phone };
      await ctx.reply('Yoshingiz nechida?', cancelButton);
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (await handleCancel(ctx)) return;
      ctx.scene.session.leadDraft = { ...ctx.scene.session.leadDraft, age: getText(ctx) };
      await ctx.reply('Qaysi hudud/tumandansiz?', cancelButton);
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (await handleCancel(ctx)) return;
      ctx.scene.session.leadDraft = { ...ctx.scene.session.leadDraft, district: getText(ctx) };
      await ctx.reply('Videokuzatuv, IT yoki texnika bo‘yicha tajribangiz bormi?', cancelButton);
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (await handleCancel(ctx)) return;
      ctx.scene.session.leadDraft = { ...ctx.scene.session.leadDraft, experience: getText(ctx) };
      await ctx.reply('Sizga qaysi vaqt darsga kelish qulay?', cancelButton);
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (await handleCancel(ctx)) return;
      ctx.scene.session.leadDraft = { ...ctx.scene.session.leadDraft, preferredTime: getText(ctx) };
      await ctx.reply('Qo‘shimcha izohingiz bo‘lsa yozing. Bo‘lmasa “yo‘q” deb yuboring.', cancelButton);
      return ctx.wizard.next();
    },
    async (ctx) => {
      if (await handleCancel(ctx)) return;
      const draft = { ...ctx.scene.session.leadDraft, notes: getText(ctx) };
      const from = ctx.from;

      if (!from || !draft.fullName || !draft.phone || !draft.age || !draft.district || !draft.experience || !draft.preferredTime) {
        await ctx.reply('Maʼlumotlar to‘liq emas. Iltimos, /start orqali qayta urinib ko‘ring.', mainMenu());
        return ctx.scene.leave();
      }

      const lead: Lead = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        telegramId: from.id,
        username: from.username,
        firstName: from.first_name,
        lastName: from.last_name,
        fullName: draft.fullName,
        phone: draft.phone,
        age: draft.age,
        district: draft.district,
        experience: draft.experience,
        preferredTime: draft.preferredTime,
        notes: draft.notes?.toLowerCase() === 'yo‘q' || draft.notes?.toLowerCase() === "yo'q" ? undefined : draft.notes,
        source: 'telegram_bot',
        status: 'new',
      };

      await store.add(lead);

      try {
        await sendLeadWebhook(leadWebhookUrl, lead);
      } catch (error) {
        console.error('Lead webhook delivery failed:', error);
      }

      await notifyAdmins(ctx, adminIds, lead);
      await ctx.reply(
        [
          '✅ Arizangiz qabul qilindi!',
          'Operator tez orada siz bilan bog‘lanadi.',
          '',
          `👨‍💼 Operator: ${courseInfo.operator}`,
          `📞 Telefon: ${courseInfo.phone}`,
        ].join('\n'),
        mainMenu(),
      );
      return ctx.scene.leave();
    },
  );
}

export async function sendStart(ctx: BotContext): Promise<void> {
  await ctx.reply(formatCourseIntro(), mainMenu());
}

function getText(ctx: BotContext): string {
  if (ctx.message && 'text' in ctx.message && ctx.message.text) return ctx.message.text.trim();
  return '';
}

async function handleCancel(ctx: BotContext): Promise<boolean> {
  if (getText(ctx).toLowerCase() !== 'bekor qilish') return false;
  await ctx.reply('Ro‘yxatdan o‘tish bekor qilindi. Qayta boshlash uchun tugmadan foydalaning.', mainMenu());
  await ctx.scene.leave();
  return true;
}
