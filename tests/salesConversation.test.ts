import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isPermittedSalesConversation, persistSalesConversation, type SalesConversationInput } from '../src/salesConversation.js';
import { JsonLeadStore, type JsonWebhookFailureStore } from '../src/storage.js';
import type { Lead, LeadWebhookEvent } from '../src/types.js';

const base: SalesConversationInput = {
  telegramId: 7001,
  username: 'student',
  firstName: 'Test',
  message: 'Kurs haqida ayting',
  score: 'COLD',
  reason: 'General course question',
  intent: 'ai_chat',
  source: 'telegram_ads',
  campaignId: 'ads_july',
  now: '2026-07-15T10:00:00.000Z',
};

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'wst-sales-chat-'));
  const store = new JsonLeadStore(path.join(dir, 'leads.json'));
  const webhooks: Lead[] = [];
  const notifications: Lead[] = [];
  const dependencies = {
    store,
    failureStore: {} as JsonWebhookFailureStore,
    leadWebhookUrl: 'https://academy.example/leads',
    deliverWebhook: async (_url: string | undefined, _failures: JsonWebhookFailureStore, _event: LeadWebhookEvent, lead: Lead) => { webhooks.push(lead); },
    notifyHotLead: async (lead: Lead) => { notifications.push(lead); },
  };
  return { store, webhooks, notifications, dependencies };
}

test('privacy gate permits course sales chat and rejects unrelated cold chat', () => {
  assert.equal(isPermittedSalesConversation('Kurs haqida ayting', 'COLD'), true);
  assert.equal(isPermittedSalesConversation('Курс ҳақида айтинг', 'COLD'), true);
  assert.equal(isPermittedSalesConversation('Bugun ob-havo qanday?', 'COLD'), false);
  assert.equal(isPermittedSalesConversation('Narxi qancha?', 'HOT'), true);
});

test('ordinary permitted private course chat creates one scored lead and webhook event', async () => {
  const { store, webhooks, notifications, dependencies } = await setup();
  const result = await persistSalesConversation(base, dependencies);
  const leads = await store.all();
  assert.equal(result.errors.length, 0);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].source, 'telegram_ads');
  assert.equal(leads[0].campaignId, 'ads_july');
  assert.equal(leads[0].aiLeadScore, 'COLD');
  assert.equal(leads[0].aiLeadReason, 'General course question');
  assert.equal(webhooks.length, 1);
  assert.equal(notifications.length, 0);
});

test('repeated chat updates one lead instead of creating a duplicate', async () => {
  const { store, dependencies } = await setup();
  await persistSalesConversation(base, dependencies);
  await persistSalesConversation({ ...base, message: 'Darslar nechta?', score: 'WARM', reason: 'Program interest', now: '2026-07-15T10:01:00.000Z' }, dependencies);
  const leads = await store.all();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].messages.length, 2);
  assert.equal(leads[0].aiLeadScore, 'WARM');
});

test('hot intent alerts admins exactly once for a meaningful score escalation', async () => {
  const { notifications, dependencies } = await setup();
  await persistSalesConversation({ ...base, score: 'HOT', reason: 'Asked for price' }, dependencies);
  await persistSalesConversation({ ...base, message: 'Narxni yana ayting', score: 'HOT', reason: 'Repeated price question', now: '2026-07-15T10:02:00.000Z' }, dependencies);
  assert.equal(notifications.length, 1);
});

test('storage and admin failures are contained without rejecting the chat handler', async () => {
  const storageFailure = await persistSalesConversation(base, {
    store: { getByTelegramId: async () => undefined, upsert: async () => { throw new Error('db down'); } },
    failureStore: {} as JsonWebhookFailureStore,
    notifyHotLead: async () => undefined,
  });
  assert.deepEqual(storageFailure.errors, ['storage']);

  const { dependencies } = await setup();
  const adminFailure = await persistSalesConversation({ ...base, score: 'HOT' }, {
    ...dependencies,
    notifyHotLead: async () => { throw new Error('telegram down'); },
  });
  assert.deepEqual(adminFailure.errors, ['admin']);
  assert.ok(adminFailure.saved);
});
