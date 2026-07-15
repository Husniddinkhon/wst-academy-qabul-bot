import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test, { afterEach } from 'node:test';
import { configureLeadWebhookSigning, createAcademyHeaders, deliverLeadWebhook, sendLeadWebhook, toAcademyWebhookPayload } from '../src/webhook.js';
import type { JsonWebhookFailureStore } from '../src/storage.js';
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
  await sendLeadWebhook('https://academy.example/api/v1/admissions/bot-leads', 'lead_updated', lead);
  assert.ok(request);
  const parsed = JSON.parse(request.body);
  assert.equal(parsed.telegram_id, lead.telegramId);
  assert.equal(typeof parsed.telegram_id, 'number');
  assert.equal(parsed.telegram_username, lead.username);
  assert.equal(parsed.campaign, lead.campaignId);
  assert.equal(parsed.username, undefined);
  const canonical = `${request.headers['X-Service-Timestamp']}\n${request.headers['X-Service-Nonce']}\n${request.body}`;
  assert.equal(request.headers['X-Service-Signature'], createHmac('sha256', secret).update(canonical, 'utf8').digest('hex'));
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
});
