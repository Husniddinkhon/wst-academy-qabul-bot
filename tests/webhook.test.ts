import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { configureLeadWebhookSigning, createAcademyHeaders, deliverLeadWebhook, retryFailedWebhooks, sendLeadWebhook, toAcademyWebhookPayload } from '../src/webhook.js';
import { JsonWebhookFailureStore, type FailedWebhookPayload } from '../src/storage.js';
import type { Lead } from '../src/types.js';

const lead: Lead = {
  id: 'lead-1', createdAt: '2026-07-12T10:00:00.000Z', updatedAt: '2026-07-12T10:05:00.000Z',
  telegramId: 922337203, username: 'student', fullName: 'Test Student', phone: '+998901234567', city: 'Toshkent', age: '25', workStatus: 'Ishlaydi', experience: 'Boshlang‘ich', goal: 'CCTV kursi', paymentOption: 'Bo‘lib', status: 'Warm', source: 'telegram_ads', campaignId: 'august-2026', intent: 'registration', lastMessage: 'Kursga yozilaman', messages: [], operatorNote: '', nextFollowUp: '', paymentStatus: 'pending', preferredTime: '',
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  configureLeadWebhookSigning(undefined);
  globalThis.fetch = originalFetch;
});

test('Academy signature covers the exact JSON body bytes', () => {
  const body = JSON.stringify({ telegram_id: 123, source: 'telegram_ads' });
  const config = { serviceId: 'academy-bot', secret: '0123456789abcdef0123456789abcdef' };
  const headers = createAcademyHeaders(body, config, 1_720_000_000, '1234567890abcdef');
  const expected = createHmac('sha256', config.secret).update(`1720000000\n1234567890abcdef\n${body}`, 'utf8').digest('hex');
  assert.equal(headers['X-Service-Signature'], expected);
  assert.equal(headers['X-Service-Timestamp'], '1720000000');
  assert.equal(headers['X-Service-Nonce'], '1234567890abcdef');
  assert.equal(headers['X-Service-Id'], 'academy-bot');
  assert.match(headers['Idempotency-Key'] ?? '', /^lead-[a-f0-9]{64}$/);
});

test('signed delivery sends Academy payload and matching HMAC headers', async () => {
  let request: { headers: Record<string, string>; body: string } | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    request = { headers: init?.headers as Record<string, string>, body: String(init?.body) };
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;
  const secret = 'abcdef0123456789abcdef0123456789';
  configureLeadWebhookSigning({ serviceId: 'academy-bot', secret });
  await sendLeadWebhook('https://academy.example/api/v1/admissions/bot-leads', 'lead_updated', lead, undefined, 'telegram-update:77:webhook:lead');
  assert.ok(request);
  const parsed = JSON.parse(request.body);
  assert.equal(parsed.telegram_id, lead.telegramId);
  assert.equal(typeof parsed.telegram_id, 'number');
  assert.equal(parsed.telegram_username, lead.username);
  assert.equal(parsed.campaign, lead.campaignId);
  assert.equal(parsed.username, undefined);
  const canonical = `${request.headers['X-Service-Timestamp']}\n${request.headers['X-Service-Nonce']}\n${request.body}`;
  assert.equal(request.headers['X-Service-Signature'], createHmac('sha256', secret).update(canonical, 'utf8').digest('hex'));
  assert.equal(request.headers['Idempotency-Key'], 'telegram-update:77:webhook:lead');
});

test('unsigned delivery preserves the legacy generic webhook payload', async () => {
  let body = '';
  let headers: Record<string, string> = {};
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = String(init?.body); headers = init?.headers as Record<string, string>;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;
  await sendLeadWebhook('https://n8n.example/leads', 'lead_created', lead);
  const parsed = JSON.parse(body);
  assert.equal(parsed.telegram_id, String(lead.telegramId));
  assert.equal(parsed.username, lead.username);
  assert.equal(headers['X-Service-Signature'], undefined);
  assert.match(headers['Idempotency-Key'] ?? '', /^lead-[a-f0-9]{64}$/);
});

test('Academy payload omits absent optional values and never grants access', () => {
  const payload = toAcademyWebhookPayload('lead_created', { ...lead, username: undefined, phone: '', paymentStatus: 'paid' });
  assert.equal(payload.telegram_username, undefined);
  assert.equal(payload.phone, undefined);
  assert.equal(payload.payment_status, 'paid');
  assert.equal('enrollment_status' in payload, false);
  assert.equal('course_access' in payload, false);
});

test('timed out webhook is persisted and returns control to the lead flow', async () => {
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  })) as typeof fetch;
  const failures: unknown[] = [];
  const store = { async add(value: unknown) { failures.push(value); } } as JsonWebhookFailureStore;

  await deliverLeadWebhook('https://academy.example/api/v1/admissions/bot-leads', store, 'lead_created', lead, 5);

  assert.equal(failures.length, 1);
  assert.match(String((failures[0] as { lastError?: string }).lastError), /timed out/);
  assert.equal((failures[0] as { outcomeUncertain?: boolean }).outcomeUncertain, true);
});

test('uncertain failed webhook remains queued and is not automatically resent', async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls += 1; return { ok: true, status: 200 } as Response; }) as typeof fetch;
  let queued = [{ event: 'lead_created' as const, lead, failedAt: '2026-07-21T10:00:00.000Z', attempts: 1, idempotencyKey: 'telegram-update:80:webhook:lead', outcomeUncertain: true }];
  const store = {
    async all() { return queued; },
    async claimRetryable() { return []; },
  } as JsonWebhookFailureStore;
  const result = await retryFailedWebhooks('https://academy.example/api/v1/admissions/bot-leads', store);
  assert.deepEqual(result, { attempted: 0, sent: 0, remaining: 1 });
  assert.equal(fetchCalls, 0);
  assert.equal(queued.length, 1);
});

test('definite HTTP failure retries once with the original idempotency key', async () => {
  const headers: Record<string, string>[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    headers.push(init?.headers as Record<string, string>);
    return { ok: headers.length > 1, status: headers.length > 1 ? 200 : 500 } as Response;
  }) as typeof fetch;
  const queued: Array<{ event: 'lead_created'; lead: Lead; failedAt: string; attempts: number; idempotencyKey?: string; outcomeUncertain?: boolean }> = [];
  const store = {
    async add(item: Omit<(typeof queued)[number], 'failedAt' | 'attempts'>) { queued.push({ ...item, failedAt: '2026-07-21T10:00:00.000Z', attempts: 1 }); },
    async all() { return queued; },
    async claimRetryable() { queued[0].retryToken = 'claim-1'; return [{ ...queued[0] }]; },
    async finishRetry(_item: FailedWebhookPayload, outcome: { sent: boolean }) { if (outcome.sent) queued.splice(0); },
  } as JsonWebhookFailureStore;
  await deliverLeadWebhook('https://academy.example/api/v1/admissions/bot-leads', store, 'lead_created', lead, 1_000, 'telegram-update:81:webhook:lead');
  assert.equal(queued[0]?.outcomeUncertain, false);
  const result = await retryFailedWebhooks('https://academy.example/api/v1/admissions/bot-leads', store);
  assert.deepEqual(result, { attempted: 1, sent: 1, remaining: 0 });
  assert.equal(headers[0]['Idempotency-Key'], 'telegram-update:81:webhook:lead');
  assert.equal(headers[1]['Idempotency-Key'], 'telegram-update:81:webhook:lead');
});

test('a retry transport failure is reclassified uncertain and cannot be sent again', async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error('connection closed after request write'); }) as typeof fetch;
  let queued = [{ event: 'lead_created' as const, lead, failedAt: '2026-07-21T10:00:00.000Z', attempts: 1, idempotencyKey: 'telegram-update:82:webhook:lead', outcomeUncertain: false }];
  const store = {
    async all() { return queued; },
    async claimRetryable() {
      const eligible = queued.filter(item => !item.outcomeUncertain).map(item => ({ ...item, retryToken: 'claim-2' }));
      if (eligible.length) queued[0] = { ...queued[0], retryToken: 'claim-2' };
      return eligible;
    },
    async finishRetry(_item: FailedWebhookPayload, outcome: { sent: boolean; error?: string; outcomeUncertain?: boolean }) {
      if (outcome.sent) queued.splice(0);
      else queued[0] = { ...queued[0], attempts: queued[0].attempts + 1, lastError: outcome.error, outcomeUncertain: outcome.outcomeUncertain, retryToken: undefined };
    },
  } as JsonWebhookFailureStore;
  assert.deepEqual(await retryFailedWebhooks('https://academy.example/api/v1/admissions/bot-leads', store), { attempted: 1, sent: 0, remaining: 1 });
  assert.equal(queued[0].outcomeUncertain, true);
  assert.deepEqual(await retryFailedWebhooks('https://academy.example/api/v1/admissions/bot-leads', store), { attempted: 0, sent: 0, remaining: 1 });
  assert.equal(fetchCalls, 1);
});

test('retry completion cannot erase a webhook failure appended concurrently', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'webhook-retry-'));
  try {
    const store = new JsonWebhookFailureStore(path.join(directory, 'failures.json'));
    await store.add({ event: 'lead_created', lead, idempotencyKey: 'first', outcomeUncertain: false });
    let releaseFetch!: () => void;
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseFetch = resolve; });
    globalThis.fetch = (async () => { fetchStarted(); await release; return { ok: true, status: 200 } as Response; }) as typeof fetch;
    const retry = retryFailedWebhooks('https://academy.example/api/v1/admissions/bot-leads', store);
    await started;
    await store.add({ event: 'lead_updated', lead: { ...lead, lastMessage: 'new concurrent failure' }, idempotencyKey: 'second', outcomeUncertain: false });
    releaseFetch();
    assert.deepEqual(await retry, { attempted: 1, sent: 1, remaining: 1 });
    assert.deepEqual((await store.all()).map(item => item.idempotencyKey), ['second']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('stale webhook retry ownership fails closed without another send', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'webhook-stale-'));
  try {
    const store = new JsonWebhookFailureStore(path.join(directory, 'failures.json'));
    await store.add({ event: 'lead_created', lead, idempotencyKey: 'stale', outcomeUncertain: false });
    assert.equal((await store.claimRetryable(new Date('2026-07-21T10:00:00.000Z'))).length, 1);
    assert.equal((await store.claimRetryable(new Date('2026-07-21T10:10:00.001Z'))).length, 0);
    const item = (await store.all())[0];
    assert.equal(item.outcomeUncertain, true);
    assert.match(item.lastError ?? '', /evidence review/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
