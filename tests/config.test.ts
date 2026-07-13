import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { loadConfig } from '../src/config.js';

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

test('signed webhook requires service id and secret together', () => {
  process.env.BOT_TOKEN = 'test-token';
  process.env.LEAD_WEBHOOK_URL = 'https://academy.example/api/v1/admissions/bot-leads';
  process.env.LEAD_WEBHOOK_SERVICE_ID = 'academy-bot';
  delete process.env.LEAD_WEBHOOK_SECRET;
  assert.throws(() => loadConfig(), /must be configured together/);
});

test('signed webhook rejects short secrets without exposing their value', () => {
  process.env.BOT_TOKEN = 'test-token';
  process.env.LEAD_WEBHOOK_URL = 'https://academy.example/api/v1/admissions/bot-leads';
  process.env.LEAD_WEBHOOK_SERVICE_ID = 'academy-bot';
  process.env.LEAD_WEBHOOK_SECRET = 'too-short';
  assert.throws(() => loadConfig(), (error: unknown) => error instanceof Error && /at least 32/.test(error.message) && !error.message.includes('too-short'));
});

test('unsigned webhook remains valid when signing variables are absent', () => {
  process.env.BOT_TOKEN = 'test-token';
  process.env.LEAD_WEBHOOK_URL = 'https://n8n.example/leads';
  delete process.env.LEAD_WEBHOOK_SERVICE_ID;
  delete process.env.LEAD_WEBHOOK_SECRET;
  const config = loadConfig();
  assert.equal(config.leadWebhookServiceId, undefined);
  assert.equal(config.leadWebhookSecret, undefined);
});
