import type { Context, Telegraf } from 'telegraf';

export class TelegramLaunchCancelledError extends Error {
  constructor() {
    super('Telegram launch cancelled because graceful shutdown has started.');
    this.name = 'TelegramLaunchCancelledError';
  }
}

/**
 * Telegraf calls onLaunch before its awaited deleteWebhook and before polling.
 * This wrapper adds cancellation checkpoints on both sides of that await so a
 * shutdown request cannot later fall through into startPolling.
 */
export async function launchWithShutdownGate<C extends Context>(
  bot: Telegraf<C>,
  options: Parameters<Telegraf<C>['launch']>[0],
  isShutdownRequested: () => boolean,
  onLaunch: () => void,
): Promise<'stopped' | 'cancelled'> {
  type MutableCallApi = { callApi: (method: string, ...args: unknown[]) => Promise<unknown> };
  const telegram = bot.telegram as unknown as MutableCallApi;
  const originalCallApi = telegram.callApi;
  telegram.callApi = async (method, ...args) => {
    const result = await originalCallApi.call(bot.telegram, method, ...args);
    if (method === 'deleteWebhook' && isShutdownRequested()) throw new TelegramLaunchCancelledError();
    return result;
  };
  try {
    await bot.launch(options, () => {
      if (isShutdownRequested()) throw new TelegramLaunchCancelledError();
      onLaunch();
    });
    return 'stopped';
  } catch (error) {
    if (error instanceof TelegramLaunchCancelledError) return 'cancelled';
    throw error;
  } finally {
    telegram.callApi = originalCallApi;
  }
}
