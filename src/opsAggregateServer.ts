import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

const PATH = '/v1/ops/aggregate';
const MAX_SKEW_MS = 60_000;

export interface UnifiedOpsAggregate {
  schemaVersion: 1;
  service: string;
  generatedAt: string;
  sla: { eligibleOpen: number; stages: Array<{ stage: string; delivered: number; pending: number; terminal: number | null }> };
  recipientDelivery: { delivered: number; pending: number; terminal: number | null; terminalSupported: boolean };
  followUp: { pending: number | null; delivered: number | null; cancelled: number | null; terminal: number | null; definition: string };
  handoff: { pending: number | null; delivered: number | null; terminal: number | null; definition: string };
}

interface Dependencies {
  serviceId: string;
  secret: string;
  port: number;
  leads: { all(): Promise<Array<{ status: string; createdAt: string }>> };
  alerts: { snapshot(): Promise<{ records: Record<string, { recipients: Record<string, { deliveredAt?: string }> }> }> };
  followUps: { all(): Promise<Array<{ registrationCompleted?: boolean; lastSentAt?: string }>> };
  webhookFailures: { all(): Promise<unknown[]> };
}

export async function buildQabulOpsAggregate(deps: Pick<Dependencies, 'serviceId' | 'leads' | 'alerts' | 'followUps' | 'webhookFailures'>, now = new Date()): Promise<UnifiedOpsAggregate> {
  const [leads, alertDb, followUps, failures] = await Promise.all([
    deps.leads.all(), deps.alerts.snapshot(), deps.followUps.all(), deps.webhookFailures.all(),
  ]);
  const waiting = leads.filter((lead) => ['New', 'Warm', 'Hot', 'RegistrationCompleted', 'CallRequested'].includes(lead.status));
  const alertEntries = Object.entries(alertDb.records).filter(([key]) => key.startsWith('lead-sla:'));
  const stages = ['15m', '60m', '24h'].map((stage) => {
    const recipients = alertEntries.filter(([key]) => key.endsWith(`:${stage}`)).flatMap(([, record]) => Object.values(record.recipients));
    return { stage, delivered: recipients.filter((item) => item.deliveredAt).length, pending: recipients.filter((item) => !item.deliveredAt).length, terminal: null };
  });
  const allRecipients = Object.values(alertDb.records).flatMap((record) => Object.values(record.recipients));
  return {
    schemaVersion: 1,
    service: deps.serviceId,
    generatedAt: now.toISOString(),
    sla: { eligibleOpen: waiting.length, stages },
    recipientDelivery: {
      delivered: allRecipients.filter((item) => item.deliveredAt).length,
      pending: allRecipients.filter((item) => !item.deliveredAt).length,
      terminal: null,
      terminalSupported: false,
    },
    followUp: {
      pending: followUps.filter((item) => !item.registrationCompleted).length,
      delivered: followUps.filter((item) => Boolean(item.lastSentAt)).length,
      cancelled: null,
      terminal: null,
      definition: 'Legacy registration follow-up records are normalized read-only; cancellation and terminal states were not historically recorded.',
    },
    handoff: {
      pending: failures.length,
      delivered: null,
      terminal: null,
      definition: 'Pending is the durable failed-webhook retry queue. Successful historical deliveries and terminal outcomes were not persisted.',
    },
  };
}

export function startQabulOpsAggregateServer(deps: Dependencies): Server {
  if (deps.secret.length < 32) throw new Error('OPS_AGGREGATE_SECRET must contain at least 32 characters.');
  const nonces = new Map<string, number>();
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    if (request.method !== 'GET' || request.url !== PATH) return write(response, 404, { error: 'not_found' });
    const timestamp = header(request.headers['x-ops-timestamp']);
    const nonce = header(request.headers['x-ops-nonce']);
    const service = header(request.headers['x-ops-service']);
    const signature = header(request.headers['x-ops-signature']);
    const parsedTimestamp = Number(timestamp);
    prune(nonces);
    const canonical = `${service}\n${timestamp}\n${nonce}\nGET\n${PATH}`;
    if (service !== deps.serviceId || !/^[a-f0-9]{32}$/.test(nonce) || !Number.isFinite(parsedTimestamp) || Math.abs(Date.now() - parsedTimestamp) > MAX_SKEW_MS || nonces.has(nonce) || !valid(signature, sign(deps.secret, canonical))) {
      return write(response, 401, { error: 'unauthorized' });
    }
    nonces.set(nonce, Date.now() + MAX_SKEW_MS);
    try {
      const body = JSON.stringify(await buildQabulOpsAggregate(deps));
      response.setHeader('x-ops-response-signature', sign(deps.secret, `${deps.serviceId}\n${timestamp}\n${nonce}\n${body}`));
      response.statusCode = 200;
      response.end(body);
    } catch {
      write(response, 503, { error: 'aggregate_unavailable' });
    }
  });
  server.listen(deps.port, '127.0.0.1');
  return server;
}

function header(value: string | string[] | undefined): string { return typeof value === 'string' ? value : ''; }
function sign(secret: string, value: string): string { return createHmac('sha256', secret).update(value).digest('hex'); }
function valid(received: string, expected: string): boolean { if (!/^[a-f0-9]{64}$/.test(received) || received.length !== expected.length) return false; let difference = 0; for (let index = 0; index < expected.length; index += 1) difference |= received.charCodeAt(index) ^ expected.charCodeAt(index); return difference === 0; }
function prune(nonces: Map<string, number>): void { const now = Date.now(); for (const [nonce, expires] of nonces) if (expires <= now) nonces.delete(nonce); }
function write(response: import('node:http').ServerResponse, status: number, body: object): void { response.statusCode = status; response.end(JSON.stringify(body)); }
export function createOpsRequestHeaders(serviceId: string, secret: string, timestamp = String(Date.now()), nonce = randomBytes(16).toString('hex')): Record<string, string> {
  return { 'x-ops-service': serviceId, 'x-ops-timestamp': timestamp, 'x-ops-nonce': nonce, 'x-ops-signature': sign(secret, `${serviceId}\n${timestamp}\n${nonce}\nGET\n${PATH}`) };
}
