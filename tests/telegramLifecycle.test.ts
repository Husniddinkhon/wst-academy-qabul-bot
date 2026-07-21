import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context, Telegraf } from 'telegraf';
import { launchWithShutdownGate } from '../src/telegramLifecycle.js';

interface FakeBot {
  telegram: { callApi(method: string): Promise<boolean> };
  launch(options: { dropPendingUpdates: false }, onLaunch?: () => void): Promise<void>;
}

function asTelegraf(bot: FakeBot): Telegraf<Context> {
  return bot as unknown as Telegraf<Context>;
}

test('shutdown requested during getMe cancels before webhook cleanup or polling', async () => {
  let shutdownRequested = true;
  let deleteCalls = 0;
  let pollingStarted = false;
  const bot: FakeBot = {
    telegram: { async callApi(method) { assert.equal(method, 'deleteWebhook'); deleteCalls += 1; return true; } },
    async launch(_options, onLaunch) { onLaunch?.(); await this.telegram.callApi('deleteWebhook'); pollingStarted = true; },
  };
  const result = await launchWithShutdownGate(asTelegraf(bot), { dropPendingUpdates: false }, () => shutdownRequested, () => undefined);
  assert.equal(result, 'cancelled');
  assert.equal(deleteCalls, 0);
  assert.equal(pollingStarted, false);
  shutdownRequested = false;
});

test('shutdown requested during deleteWebhook cancels before polling starts', async () => {
  let shutdownRequested = false;
  let releaseDelete!: () => void;
  const deletePending = new Promise<void>((resolve) => { releaseDelete = resolve; });
  let pollingStarted = false;
  const bot: FakeBot = {
    telegram: { async callApi(method) { assert.equal(method, 'deleteWebhook'); await deletePending; return true; } },
    async launch(_options, onLaunch) { onLaunch?.(); await this.telegram.callApi('deleteWebhook'); pollingStarted = true; },
  };
  const launched = launchWithShutdownGate(asTelegraf(bot), { dropPendingUpdates: false }, () => shutdownRequested, () => undefined);
  shutdownRequested = true;
  releaseDelete();
  assert.equal(await launched, 'cancelled');
  assert.equal(pollingStarted, false);
});
