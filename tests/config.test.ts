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

test('Academy aggregate reporting reuses signed service identity and validates HTTPS', () => {
  process.env.BOT_TOKEN = 'test-token';
  process.env.LEAD_WEBHOOK_URL = 'https://academy.example/api/v1/admissions/bot-leads';
  process.env.LEAD_WEBHOOK_SERVICE_ID = 'academy-bot';
  process.env.LEAD_WEBHOOK_SECRET = 'academy-report-secret-at-least-32-characters';
  process.env.ACADEMY_REPORT_BASE_URL = 'https://academy.example/academy-api/';
  process.env.ACADEMY_REPORT_TIMEOUT_MS = '4000';
  const config = loadConfig();
  assert.equal(config.academyReportBaseUrl, 'https://academy.example/academy-api');
  assert.equal(config.academyReportTimeoutMs, 4_000);
  process.env.ACADEMY_REPORT_BASE_URL = 'http://academy.example';
  assert.throws(() => loadConfig(), /must use HTTPS/);
});

test('Academy reporting cannot be enabled without signed service identity', () => {
  process.env.BOT_TOKEN = 'test-token';
  process.env.ACADEMY_REPORT_BASE_URL = 'https://academy.example/academy-api';
  delete process.env.LEAD_WEBHOOK_SERVICE_ID;
  delete process.env.LEAD_WEBHOOK_SECRET;
  assert.throws(() => loadConfig(), /requires the existing signed webhook service ID and secret/);
});

test('unsigned webhook remains valid when signing variables are absent', () => {
  process.env.BOT_TOKEN = 'test-token';
  process.env.LEAD_WEBHOOK_URL = 'https://n8n.example/leads';
  delete process.env.ACADEMY_REPORT_BASE_URL;
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

test('loads bounded channel scheduler controls', () => {
  process.env.BOT_TOKEN = 'test-token';
  process.env.CHANNEL_SCHEDULER_ENABLED = 'false';
  process.env.CHANNEL_SCHEDULER_POLL_MS = '45000';
  process.env.CHANNEL_PUBLISH_STALE_MS = '900000';
  process.env.CHANNEL_CLAIM_RENEW_MS = '120000';
  process.env.CHANNEL_UNCERTAIN_WINDOW_MS = '172800000';
  process.env.SHUTDOWN_DRAIN_TIMEOUT_MS = '20000';
  const config = loadConfig();
  assert.equal(config.channelSchedulerEnabled, false);
  assert.equal(config.channelSchedulerPollMs, 45_000);
  assert.equal(config.channelPublishStaleMs, 900_000);
  assert.equal(config.channelClaimLeaseMs, 900_000);
  assert.equal(config.channelClaimRenewMs, 120_000);
  assert.equal(config.channelUncertainWindowMs, 172_800_000);
  assert.equal(config.shutdownDrainTimeoutMs, 20_000);
});

test('rejects unsafe channel scheduler controls', () => {
  process.env.BOT_TOKEN = 'test-token';
  process.env.CHANNEL_SCHEDULER_POLL_MS = '100';
  assert.throws(() => loadConfig(), /CHANNEL_SCHEDULER_POLL_MS/);
  process.env.CHANNEL_SCHEDULER_POLL_MS = '30000';
  process.env.CHANNEL_PUBLISH_STALE_MS = '0';
  assert.throws(() => loadConfig(), /CHANNEL_PUBLISH_STALE_MS/);
});

test('rejects claim renewal that is not shorter than the lease', () => {
  process.env.BOT_TOKEN = 'test-token';
  process.env.CHANNEL_CLAIM_LEASE_MS = '60000';
  process.env.CHANNEL_CLAIM_RENEW_MS = '60000';
  assert.throws(() => loadConfig(), /must be shorter/);
});

test('loads and validates bounded follow-up delivery controls', () => {
  process.env.BOT_TOKEN = 'test-token';
  process.env.FOLLOWUP_CLAIM_LEASE_MS = '120000';
  process.env.FOLLOWUP_MAX_ATTEMPTS = '4';
  process.env.FOLLOWUP_RETRY_BASE_MS = '2000';
  process.env.FOLLOWUP_RETRY_MAX_MS = '8000';
  const config = loadConfig();
  assert.equal(config.followUpClaimLeaseMs, 120_000);
  assert.equal(config.followUpMaxAttempts, 4);
  assert.equal(config.followUpRetryBaseMs, 2_000);
  assert.equal(config.followUpRetryMaxMs, 8_000);
  process.env.FOLLOWUP_RETRY_MAX_MS = '1000';
  assert.throws(() => loadConfig(), /must be greater than or equal/);
});

test('loads bounded durable Telegram update controls', () => {
  process.env.BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_UPDATES_FILE = './private/update-ledger.json';
  process.env.TELEGRAM_UPDATE_LEASE_MS = '120000';
  process.env.TELEGRAM_UPDATE_RETENTION = '25000';
  const config = loadConfig();
  assert.equal(config.telegramUpdatesFile, './private/update-ledger.json');
  assert.equal(config.telegramUpdateLeaseMs, 120_000);
  assert.equal(config.telegramUpdateRetention, 25_000);
});

test('rejects unsafe Telegram update lease and retention values', () => {
  process.env.BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_UPDATE_LEASE_MS = '1000';
  assert.throws(() => loadConfig(), /TELEGRAM_UPDATE_LEASE_MS/);
  process.env.TELEGRAM_UPDATE_LEASE_MS = '300000';
  process.env.TELEGRAM_UPDATE_RETENTION = '100';
  assert.throws(() => loadConfig(), /TELEGRAM_UPDATE_RETENTION/);
});
