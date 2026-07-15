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

test('fallback AI provider must be configured as a complete set', () => {
  process.env.BOT_TOKEN = 'test-token';
  process.env.AI_FALLBACK_API_KEY = 'fallback-key';
  delete process.env.AI_FALLBACK_BASE_URL;
  delete process.env.AI_FALLBACK_MODEL;
  assert.throws(() => loadConfig(), /must be configured together/);
});

test('loads a complete fallback AI provider configuration', () => {
  process.env.BOT_TOKEN = 'test-token';
  process.env.AI_FALLBACK_API_KEY = 'fallback-key';
  process.env.AI_FALLBACK_BASE_URL = 'https://qwen.example/compatible-mode/v1';
  process.env.AI_FALLBACK_MODEL = 'qwen-flash';
  process.env.AI_FALLBACK_TEMPERATURE = '0.2';

  const config = loadConfig();
  assert.equal(config.ai.fallback?.baseUrl, 'https://qwen.example/compatible-mode/v1');
  assert.equal(config.ai.fallback?.model, 'qwen-flash');
  assert.equal(config.ai.fallback?.temperature, 0.2);
});

test('loads bounded AI reliability and provider cost controls', () => {
  process.env.BOT_TOKEN = 'test-token';
  process.env.AI_REQUEST_TIMEOUT_MS = '12000';
  process.env.AI_MAX_OUTPUT_TOKENS = '256';
  process.env.AI_MAX_OUTPUT_TOKENS_ENABLED = 'false';
  process.env.AI_RATE_LIMIT_MAX_REQUESTS = '4';
  process.env.AI_RATE_LIMIT_WINDOW_MS = '90000';
  process.env.AI_CIRCUIT_FAILURE_THRESHOLD = '2';
  process.env.AI_CIRCUIT_BASE_BACKOFF_MS = '5000';
  process.env.AI_CIRCUIT_MAX_BACKOFF_MS = '60000';
  const config = loadConfig();
  assert.equal(config.ai.requestTimeoutMs, 12_000);
  assert.equal(config.ai.maxOutputTokens, 256);
  assert.equal(config.ai.supportsMaxOutputTokens, false);
  assert.deepEqual(config.ai.reliability, {
    rateLimitMaxRequests: 4,
    rateLimitWindowMs: 90_000,
    circuitFailureThreshold: 2,
    circuitBaseBackoffMs: 5_000,
    circuitMaxBackoffMs: 60_000,
  });
});

test('rejects unsafe AI reliability control values without printing secrets', () => {
  process.env.BOT_TOKEN = 'test-token';
  process.env.AI_API_KEY = 'secret-value-must-not-appear';
  process.env.AI_REQUEST_TIMEOUT_MS = '999999';
  assert.throws(() => loadConfig(), (error: unknown) => error instanceof Error && /AI_REQUEST_TIMEOUT_MS/.test(error.message) && !error.message.includes('secret-value-must-not-appear'));
  process.env.AI_REQUEST_TIMEOUT_MS = '15000';
  process.env.AI_MAX_OUTPUT_TOKENS = '0';
  assert.throws(() => loadConfig(), /AI_MAX_OUTPUT_TOKENS/);
});
