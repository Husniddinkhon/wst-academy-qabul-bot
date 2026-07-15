import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { buildQabulOpsAggregate, createOpsRequestHeaders, startQabulOpsAggregateServer } from '../src/opsAggregateServer.js';

const secret = 'a-production-length-test-secret-with-entropy';
const serviceId = 'wst-academy-qabul-bot';
const deps = {
  serviceId,
  secret,
  port: 0,
  leads: { all: async () => [{ status: 'New', createdAt: '2026-07-15T00:00:00Z', phone: 'must-not-leak' }] },
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
