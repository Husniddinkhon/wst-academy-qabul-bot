import assert from 'node:assert/strict';
import test from 'node:test';
import { answerWithAiAgent, getTruthfulFallbackAnswer, type AiConfig } from '../src/aiAgent.js';
import { AiRateLimitError, AiReliabilityController } from '../src/aiReliability.js';

const baseConfig: AiConfig = {
  enabled: true,
  provider: 'openai_compatible',
  apiKey: 'test-key-that-is-never-sent',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  temperature: 0.3,
};

test('DeepSeek requests explicitly disable thinking mode for short sales replies', async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;

  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Ro‘yxatdan o‘tish tugmasini bosing.' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await answerWithAiAgent('Менга ёрдам берасизми?', baseConfig);
    assert.equal(result.answer, 'Ro‘yxatdan o‘tish tugmasini bosing.');
    assert.deepEqual(body?.thinking, { type: 'disabled' });
    assert.equal(body?.max_tokens, 300);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('omits max_tokens only when the provider is configured as unsupported', async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Tayyor.' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await answerWithAiAgent('Yordam bera olasizmi?', { ...baseConfig, supportsMaxOutputTokens: false });
    assert.equal('max_tokens' in (body ?? {}), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('enforces per-user limits before a second provider charge and isolates another user', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const runtime = new AiReliabilityController(() => 1_000, () => undefined);
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Tayyor.' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const config: AiConfig = { ...baseConfig, reliability: { rateLimitMaxRequests: 1, rateLimitWindowMs: 60_000 } };
  try {
    await answerWithAiAgent('Yordam bera olasizmi?', config, { actorId: 'user-1', reliability: runtime });
    await assert.rejects(() => answerWithAiAgent('Yana savol bor', config, { actorId: 'user-1', reliability: runtime }), AiRateLimitError);
    await answerWithAiAgent('Yordam bera olasizmi?', config, { actorId: 'user-2', reliability: runtime });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('uses configured timeout and records a timeout outcome without request content', async () => {
  const originalFetch = globalThis.fetch;
  const records: Record<string, unknown>[] = [];
  const runtime = new AiReliabilityController(Date.now, (record) => records.push(record));
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  try {
    await assert.rejects(() => answerWithAiAgent('private customer message', { ...baseConfig, requestTimeoutMs: 5 }, { actorId: 'user-1', reliability: runtime }), /timed out/);
    const metric = runtime.snapshot()[0];
    assert.equal(metric.timeouts, 1);
    assert.equal(metric.failures, 1);
    assert.doesNotMatch(JSON.stringify(records), /private customer message|test-key-that-is-never-sent/i);
  } finally { globalThis.fetch = originalFetch; }
});

test('records successful latency and token counters without logging content or secrets', async () => {
  const originalFetch = globalThis.fetch;
  let now = 100;
  const records: Record<string, unknown>[] = [];
  const runtime = new AiReliabilityController(() => now, (record) => records.push(record));
  globalThis.fetch = async () => {
    now = 125;
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Safe answer.' } }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await answerWithAiAgent('private secret question', baseConfig, { actorId: 'user-1', reliability: runtime });
    const metric = runtime.snapshot()[0];
    assert.equal(metric.lastLatencyMs, 25);
    assert.equal(metric.totalTokens, 60);
    assert.doesNotMatch(JSON.stringify(records), /private secret question|test-key-that-is-never-sent|api.deepseek.com/i);
  } finally { globalThis.fetch = originalFetch; }
});

test('truthful outage fallback offers operator handoff without claiming submission', () => {
  const answer = getTruthfulFallbackAnswer('savol');
  assert.match(answer, /@hr_wst|Operator bilan bog‘lanish/);
  assert.match(answer, /ariza yuborilganini anglatmaydi/);
});

test('other OpenAI-compatible providers do not receive a DeepSeek-only parameter', async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;

  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Tayyor.' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    await answerWithAiAgent('Yordam bera olasizmi?', {
      ...baseConfig,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4-mini',
    });
    assert.equal('thinking' in (body ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('uses the fallback provider when the primary provider fails', async () => {
  const originalFetch = globalThis.fetch;
  const calledUrls: string[] = [];

  globalThis.fetch = async (input) => {
    const url = String(input);
    calledUrls.push(url);
    if (url.startsWith('https://api.deepseek.com')) {
      return new Response('unavailable', { status: 503 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Qwen fallback javobi.' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await answerWithAiAgent('Yordam bera olasizmi?', {
      ...baseConfig,
      fallback: {
        provider: 'openai_compatible',
        apiKey: 'fallback-test-key',
        baseUrl: 'https://qwen.example/compatible-mode/v1',
        model: 'qwen-flash',
        temperature: 0.3,
      },
    });
    assert.equal(result.answer, 'Qwen fallback javobi.');
    assert.deepEqual(calledUrls, [
      'https://api.deepseek.com/chat/completions',
      'https://qwen.example/compatible-mode/v1/chat/completions',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('does not call fallback when the primary provider succeeds', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  globalThis.fetch = async () => {
    callCount += 1;
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Primary javob.' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await answerWithAiAgent('Yordam bera olasizmi?', {
      ...baseConfig,
      fallback: {
        provider: 'openai_compatible',
        apiKey: 'fallback-test-key',
        baseUrl: 'https://qwen.example/compatible-mode/v1',
        model: 'qwen-flash',
        temperature: 0.3,
      },
    });
    assert.equal(result.answer, 'Primary javob.');
    assert.equal(callCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
