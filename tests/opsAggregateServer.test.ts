import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { buildQabulOpsAggregate, buildQabulReconciliationSnapshot, createOpsRequestHeaders, createSignedGetHeaders, RECONCILIATION_PATH, startQabulOpsAggregateServer } from '../src/opsAggregateServer.js';

const secret = 'a-production-length-test-secret-with-entropy';
const serviceId = 'wst-academy-qabul-bot';
const deps = {
  serviceId,
  secret,
  port: 0,
  leads: { all: async () => [{ telegramId: 99887766, status: 'New', source: 'telegram_ads', campaignId: 'channel_academy_tech_01', createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:10:00.000Z', phone: '+998 90 123 45 67' }] },
  alerts: { snapshot: async () => ({ records: { 'lead-sla:OPAQUE:15m': { recipients: { hidden: { deliveredAt: '2026-07-15T01:00:00Z' }, hidden2: {} } } } }) },
  followUps: { all: async () => [{ registrationCompleted: false }, { registrationCompleted: true, lastSentAt: '2026-07-15T02:00:00Z' }] },
  webhookFailures: { all: async () => [{ payload: { phone: 'must-not-leak' } }] },
};

test('normalizes legacy qabul state without returning identities or invented terminal counts', async () => {
  const aggregate = await buildQabulOpsAggregate(deps, new Date('2026-07-15T03:00:00Z'));
  assert.equal(aggregate.sla.eligibleOpen, 1);
  assert.deepEqual(aggregate.sla.stages[0], { stage: '15m', delivered: 1, pending: 1, terminal: null });
  assert.equal(aggregate.followUp.pending, 1);
  assert.equal(aggregate.handoff.pending, 1);
  assert.doesNotMatch(JSON.stringify(aggregate), /must-not-leak|hidden2|OPAQUE/);
});

test('reconciliation snapshot exposes only masked deterministic exact evidence', async () => {
  const snapshot = await buildQabulReconciliationSnapshot(deps, new Date('2026-07-15T03:00:00.000Z'));
  assert.equal(snapshot.candidates.length, 1);
  const candidate = snapshot.candidates[0];
  assert.match(candidate.botLeadRef, /^[a-f0-9]{64}$/);
  assert.match(candidate.telegramFingerprint, /^[a-f0-9]{64}$/);
  assert.match(candidate.phoneFingerprint ?? '', /^[a-f0-9]{64}$/);
  assert.equal(candidate.maskedPhone, '+998 ** *** ** 67');
  assert.equal(candidate.source, 'telegram_ads');
  assert.equal(candidate.campaign, 'channel_academy_tech_01');
  assert.doesNotMatch(JSON.stringify(snapshot), /99887766|901234567|must-not-leak/);
});

test('requires valid signed request, rejects replay and signs exact response body', async () => {
  const server = startQabulOpsAggregateServer(deps);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/v1/ops/aggregate`;
  const headers = createOpsRequestHeaders(serviceId, secret);
  const response = await fetch(url, { headers });
  const body = await response.text();
  assert.equal(response.status, 200);
  const expected = createHmac('sha256', secret).update(`${serviceId}\n${headers['x-ops-timestamp']}\n${headers['x-ops-nonce']}\n${body}`).digest('hex');
  assert.equal(response.headers.get('x-ops-response-signature'), expected);
  assert.equal((await fetch(url, { headers })).status, 401);
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: createOpsRequestHeaders(serviceId, secret, String(Date.now() - 120_000)) })).status, 401);
  assert.equal((await fetch(url, { headers: createOpsRequestHeaders(serviceId, 'different-production-length-secret-value') })).status, 401);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('serves short-lived reconciliation candidates only with a path-bound signature', async () => {
  const server = startQabulOpsAggregateServer(deps);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}${RECONCILIATION_PATH}`;
  const headers = createSignedGetHeaders(serviceId, secret, RECONCILIATION_PATH);
  const response = await fetch(url, { headers });
  const body = await response.text();
  assert.equal(response.status, 200);
  const expected = createHmac('sha256', secret).update(`${serviceId}\n${headers['x-ops-timestamp']}\n${headers['x-ops-nonce']}\n${body}`).digest('hex');
  assert.equal(response.headers.get('x-ops-response-signature'), expected);
  assert.equal((await fetch(url, { headers: createOpsRequestHeaders(serviceId, secret) })).status, 401);
  assert.equal((await fetch(url, { headers })).status, 401);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
