import type { Telegraf } from 'telegraf';
import type { JsonLeadStore } from './storage.js';
import type { BotContext } from './types.js';

export const REPORT_TIME_ZONE = 'Asia/Tashkent';

const tashkentDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const tashkentHourFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TIME_ZONE,
  hour: '2-digit',
  hourCycle: 'h23',
});

export function getTashkentDateKey(date: Date): string {
  const parts = tashkentDateFormatter.formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) throw new Error('Could not determine the Tashkent calendar date.');
  return `${year}-${month}-${day}`;
}

export function getTashkentHour(date: Date): number {
  const hour = Number(tashkentHourFormatter.formatToParts(date).find((part) => part.type === 'hour')?.value);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('Could not determine the Tashkent hour.');
  return hour;
}

export async function getTashkentDayLeads(store: JsonLeadStore, now: Date): Promise<Awaited<ReturnType<JsonLeadStore['all']>>> {
  const todayKey = getTashkentDateKey(now);
  return (await store.all()).filter((lead) => {
    const createdAt = new Date(lead.createdAt);
    return Number.isFinite(createdAt.getTime()) && getTashkentDateKey(createdAt) === todayKey;
  });
}

export function startDailyReport(bot: Telegraf<BotContext>, store: JsonLeadStore, recipients: number[] | (() => Promise<number[]>), enabled: boolean, hour: number): NodeJS.Timeout | undefined {
  if (!enabled || (Array.isArray(recipients) && recipients.length === 0)) return undefined;
  let lastSentDate = '';
  let sending = false;
  return setInterval(async () => {
    if (sending) return;
    const now = new Date();
    const todayKey = getTashkentDateKey(now);
    if (getTashkentHour(now) !== hour || lastSentDate === todayKey) return;
    sending = true;
    try {
      const recipientIds = Array.isArray(recipients) ? recipients : await recipients();
      if (recipientIds.length === 0) return;
      const leads = await getTashkentDayLeads(store, now);
      const byIntent = (intent: string) => leads.filter((lead) => lead.intent === intent).length;
      const text = ['📊 WST Academy Daily Report','',`New leads: ${leads.filter((l) => l.status === 'New').length}`,`Hot leads: ${leads.filter((l) => l.status === 'Hot').length}`,`Call requests: ${leads.filter((l) => l.status === 'CallRequested').length}`,`Completed registrations: ${leads.filter((l) => l.status === 'RegistrationCompleted').length}`,`No phone leads: ${leads.filter((l) => !l.phone).length}`,`Total leads today: ${leads.length}`,'','Top intents:',`- price: ${byIntent('price')}`,`- program: ${byIntent('program')}`,`- call request: ${byIntent('call request')}`,`- registration: ${byIntent('registration')}`].join('\n');
      const deliveries = await Promise.allSettled(recipientIds.map((id) => bot.telegram.sendMessage(id, text)));
      if (deliveries.some((delivery) => delivery.status === 'fulfilled')) lastSentDate = todayKey;
      else console.error(`Daily report delivery failed for all admins (${todayKey}, ${REPORT_TIME_ZONE}).`);
    } catch (error) {
      console.error('Daily report failed:', error instanceof Error ? error.message : String(error));
    } finally {
      sending = false;
    }
  }, 60 * 1000);
}
