import assert from 'node:assert/strict';
import test from 'node:test';
import { AiCircuitOpenError, AiRateLimitError, AiReliabilityController, type AiReliabilityControls } from '../src/aiReliability.js';

const controls: AiReliabilityControls = {
  rateLimitMaxRequests: 2,
  rateLimitWindowMs: 1_000,
  circuitFailureThreshold: 2,
  circuitBaseBackoffMs: 100,
  circuitMaxBackoffMs: 200,
};
const provider = { provider: 'deepseek', model: 'deepseek-v4-flash' };

test('per-user fixed-window limit isolates users and exposes retry delay without actor data', () => {
  let now = 5_000;
  const records: Record<string, unknown>[] = [];
  const runtime = new AiReliabilityController(() => now, (record) => records.push(record));
  runtime.consumeRateLimit('user-secret-1', provider, controls);
  runtime.consumeRateLimit('user-secret-1', provider, controls);
  assert.throws(() => runtime.consumeRateLimit('user-secret-1', provider, controls), (error) => error instanceof AiRateLimitError && error.retryAfterMs === 1_000);
  runtime.consumeRateLimit('other-user', provider, controls);
  now += 1_000;
  runtime.consumeRateLimit('user-secret-1', provider, controls);
  assert.equal(runtime.snapshot()[0].rateLimited, 1);
  assert.doesNotMatch(JSON.stringify(records), /user-secret|message|api.?key|base.?url/i);
});

test('circuit opens after bounded failures, admits one probe and caps exponential backoff', () => {
  let now = 0;
  const runtime = new AiReliabilityController(() => now, () => undefined);
  let attempt = runtime.beforeProvider(provider);
  now = 10;
  runtime.finishProvider(provider, attempt, 'network_error', controls);
  attempt = runtime.beforeProvider(provider);
  now = 20;
  runtime.finishProvider(provider, attempt, 'http_error', controls);
  assert.throws(() => runtime.beforeProvider(provider), (error) => error instanceof AiCircuitOpenError && error.retryAfterMs === 100);

  now = 120;
  attempt = runtime.beforeProvider(provider);
  assert.equal(attempt.probe, true);
  now = 130;
  runtime.finishProvider(provider, attempt, 'timeout', controls);
  assert.equal(runtime.snapshot()[0].circuitOpenUntil, 330);

  now = 330;
  attempt = runtime.beforeProvider(provider);
  now = 340;
  runtime.finishProvider(provider, attempt, 'network_error', controls);
  const metric = runtime.snapshot()[0];
  assert.equal(metric.circuitOpenUntil, 540);
  assert.equal(metric.attempts, 4);
  assert.equal(metric.failures, 4);
  assert.equal(metric.timeouts, 1);
  assert.equal(metric.circuitSkips, 1);
  assert.equal(metric.totalLatencyMs, 40);
});

test('metrics aggregate provider/model outcomes, latency and token usage only', () => {
  let now = 100;
  const records: Record<string, unknown>[] = [];
  const runtime = new AiReliabilityController(() => now, (record) => records.push(record));
  const attempt = runtime.beforeProvider(provider);
  now = 137;
  runtime.finishProvider(provider, attempt, 'success', controls, { promptTokens: 120, completionTokens: 20, totalTokens: 140 });
  const metric = runtime.snapshot()[0];
  assert.deepEqual({
    provider: metric.provider,
    model: metric.model,
    attempts: metric.attempts,
    successes: metric.successes,
    lastLatencyMs: metric.lastLatencyMs,
    totalTokens: metric.totalTokens,
  }, {
    provider: 'deepseek', model: 'deepseek-v4-flash', attempts: 1, successes: 1, lastLatencyMs: 37, totalTokens: 140,
  });
  assert.equal(records[0].event, 'ai_provider_outcome');
  assert.equal('message' in records[0], false);
});
