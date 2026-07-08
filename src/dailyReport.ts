import type { Telegraf } from 'telegraf';
import type { JsonLeadStore } from './storage.js';
import type { BotContext } from './types.js';

export function startDailyReport(bot: Telegraf<BotContext>, store: JsonLeadStore, adminIds: number[], enabled: boolean, hour: number): NodeJS.Timeout | undefined {
  if (!enabled || adminIds.length === 0) return undefined;
  let lastSentDate = '';
  return setInterval(async () => {
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
    if (now.getHours() !== hour || lastSentDate === todayKey) return;
    lastSentDate = todayKey;
    const leads = await store.today(now);
    const byIntent = (intent: string) => leads.filter((lead) => lead.intent === intent).length;
    const text = ['📊 WST Academy Daily Report','',`New leads: ${leads.filter((l) => l.status === 'New').length}`,`Hot leads: ${leads.filter((l) => l.status === 'Hot').length}`,`Call requests: ${leads.filter((l) => l.status === 'CallRequested').length}`,`Completed registrations: ${leads.filter((l) => l.status === 'RegistrationCompleted').length}`,`No phone leads: ${leads.filter((l) => !l.phone).length}`,`Total leads today: ${leads.length}`,'','Top intents:',`- price: ${byIntent('price')}`,`- program: ${byIntent('program')}`,`- call request: ${byIntent('call request')}`,`- registration: ${byIntent('registration')}`].join('\n');
    await Promise.allSettled(adminIds.map((id) => bot.telegram.sendMessage(id, text)));
  }, 60 * 1000);
}
