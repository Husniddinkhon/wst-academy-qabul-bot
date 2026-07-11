import type { Telegraf } from 'telegraf';
import type { JsonFollowUpStore, JsonLeadStore } from './storage.js';
import type { BotContext } from './types.js';

const INCOMPLETE_REGISTRATION_TEXT = 'Assalomu alaykum. WST Academy kursi bo‘yicha ro‘yxatdan o‘tishni boshlagan edingiz. Davom ettiramizmi?';
const WARM_NO_PHONE_TEXT = 'WST Academy kursiga qabul davom etmoqda. Kurs 1 oy, 12 dars, offline amaliyot. Savolingiz bo‘lsa, yozishingiz mumkin.';
const BLOCKED_STATUSES = new Set(['RegistrationCompleted', 'CallRequested', 'OperatorContacted', 'Paid', 'Rejected']);

export function startFollowUpAutomation(bot: Telegraf<BotContext>, leadStore: JsonLeadStore, followUpStore: JsonFollowUpStore): NodeJS.Timeout {
  const run = () => processFollowUps(bot, leadStore, followUpStore).catch((error) => console.error('Follow-up automation failed:', error instanceof Error ? error.message : String(error)));
  run();
  return setInterval(run, 15 * 60 * 1000);
}

async function processFollowUps(bot: Telegraf<BotContext>, leadStore: JsonLeadStore, followUpStore: JsonFollowUpStore): Promise<void> {
  const now = Date.now();
  const tashkentHour = new Date(now + 5 * 60 * 60 * 1000).getUTCHours();
  if (tashkentHour < 9 || tashkentHour >= 20) return;
  const states = await followUpStore.all();
  for (const state of states) {
    if (state.count >= 2) continue;
    if (state.lastSentAt && now - new Date(state.lastSentAt).getTime() < 24 * 60 * 60 * 1000) continue;
    const lead = await leadStore.getByTelegramId(state.telegramId);
    if (lead && BLOCKED_STATUSES.has(lead.status)) continue;
    const startedAt = new Date(state.startedAt).getTime();
    let text: string | undefined;
    if (!state.registrationCompleted && now - startedAt >= 2 * 60 * 60 * 1000) text = INCOMPLETE_REGISTRATION_TEXT;
    if (lead?.status === 'Warm' && !lead.phone && now - new Date(lead.updatedAt).getTime() >= 24 * 60 * 60 * 1000) text = WARM_NO_PHONE_TEXT;
    if (!text) continue;
    try {
      await bot.telegram.sendMessage(state.telegramId, text);
      await followUpStore.upsert({ ...state, count: state.count + 1, lastSentAt: new Date().toISOString() });
    } catch (error) {
      console.error(`Follow-up delivery failed for ${state.telegramId}:`, error instanceof Error ? error.message : String(error));
    }
  }
}
