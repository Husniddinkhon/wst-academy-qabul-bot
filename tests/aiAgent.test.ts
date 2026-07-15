import assert from 'node:assert/strict';
import test from 'node:test';
import { answerWithAiAgent, type AiConfig } from '../src/aiAgent.js';

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
  } finally {
    globalThis.fetch = originalFetch;
  }
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
