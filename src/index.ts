import { Telegraf, Scenes, session } from 'telegraf';
import { loadConfig } from './config.js';
import { courseInfo } from './course.js';
import { registerAdminCommands } from './admin.js';
import { JsonLeadStore } from './storage.js';
import { createRegistrationScene, mainMenu, REGISTRATION_SCENE_ID, sendStart } from './registration.js';
import type { BotContext } from './types.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const store = new JsonLeadStore(config.leadsFile);
  const bot = new Telegraf<BotContext>(config.botToken);
  const stage = new Scenes.Stage<BotContext>([createRegistrationScene(store, config.adminIds, config.leadWebhookUrl)]);

  bot.use(session());
  bot.use(stage.middleware());

  bot.start(sendStart);
  bot.hears('📝 Ro‘yxatdan o‘tish', (ctx) => ctx.scene.enter(REGISTRATION_SCENE_ID));
  bot.hears('📞 Operator bilan bog‘lanish', async (ctx) => {
    await ctx.reply([`👨‍💼 Operator: ${courseInfo.operator}`, `📞 Telefon: ${courseInfo.phone}`, `📣 Kanal: ${courseInfo.channel}`].join('\n'), mainMenu());
  });

  registerAdminCommands(bot, store, config.adminIds);

  bot.catch((error, ctx) => {
    console.error(`Bot error for update ${ctx.update.update_id}:`, error);
  });

  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Botni boshlash va kurs haqida maʼlumot' },
    { command: 'id', description: 'Telegram ID ni ko‘rish' },
    { command: 'leads_today', description: 'Bugungi leadlar (admin)' },
    { command: 'last_leads', description: 'Oxirgi leadlar (admin)' },
    { command: 'export_csv', description: 'Leadlarni CSV qilish (admin)' },
    { command: 'stats', description: 'Lead statistikasi (admin)' },
  ]);

  await bot.launch({ dropPendingUpdates: config.isProduction });
  console.log('WST Academy qabul bot is running.');

  const shutdown = async (signal: NodeJS.Signals) => {
    console.log(`Received ${signal}. Stopping bot...`);
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
