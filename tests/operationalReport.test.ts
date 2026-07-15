import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOperationalReport, formatOperationalReport } from '../src/operationalReport.js';
import { parseSalesReportRange, type AcademyReportMetrics } from '../src/salesReporting.js';
import type { JsonChannelPostStore } from '../src/channelPosts.js';
import type { JsonLeadStore, JsonWebhookFailureStore } from '../src/storage.js';

const range = parseSalesReportRange(['2026-07-15'], new Date('2026-07-15T07:00:00.000Z'));
const academy: AcademyReportMetrics = {
  available: true,
  admissions: 4,
  admissionsByStatus: { new: 1, contacted: 3 },
  sourceAttributionPresent: 4,
  campaignAttributionPresent: 2,
  slaEligible: 3,
  slaMissing: 1,
  slaInvalid: 0,
  contactedWithin15Minutes: 1,
  contactedWithin60Minutes: 2,
  enrollmentsCreated: 3,
  invoicedEnrollments: 2,
  verifiedPaidConversions: 2,
  activeFullyPaidStudents: 3,
  verifiedReceipts: [],
};

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    channelPosts: { all: async () => [
      { id: 'post-1', text: 'Private caption', contentKey: 'ip-subnet', status: 'Scheduled', createdAt: '2026-07-14T00:00:00.000Z', scheduledAt: '2026-07-16T05:00:00.000Z', attempts: 0 },
      { id: 'post-2', text: 'Old post', status: 'Published', createdAt: '2026-07-10T00:00:00.000Z', attempts: 1 },
    ] } as Pick<JsonChannelPostStore, 'all'>,
    sales: {
      store: {
        all: async () => [{ id: 'lead-secret', telegramId: 777, fullName: 'Hidden Person', phone: '+998900000000', source: 'organic', createdAt: '2026-07-15T06:00:00.000Z', updatedAt: '2026-07-15T06:00:00.000Z' }],
        getFunnelEventMetrics: async () => ({ available: true, leadCreationsTracked: 1, hotEscalations: 1, registrations: 0 }),
      } as Pick<JsonLeadStore, 'all' | 'getFunnelEventMetrics'>,
      failureStore: { all: async () => [] } as unknown as Pick<JsonWebhookFailureStore, 'all'>,
      academyMetrics: async () => academy,
    },
    botHealth: async () => ({ botReachable: true, channelReachable: true, subscriberCount: 123 }),
    alerts: { stats: async () => ({ records: 1, recipientsDelivered: 2, recipientsPending: 0, recipientsReady: 0 }) },
    ...overrides,
  };
}

test('formats a privacy-safe aggregate operational report with explicit Ads boundary', async () => {
  const snapshot = await buildOperationalReport(range, dependencies(), new Date('2026-07-15T07:00:00.000Z'));
  const text = formatOperationalReport(snapshot);
  assert.equal(snapshot.status, 'OK');
  assert.match(text, /Scheduled 1/);
  assert.match(text, /Next: .*ip-subnet/);
  assert.match(text, /New leads: 1/);
  assert.match(text, /Admissions 4 .* Verified paid 2/);
  assert.match(text, /ads\.telegram\.org kabinetida qo‘lda tekshiriladi/);
  assert.match(text, /CAC\/ROAS: ad spend integratsiyasisiz hisoblanmaydi/);
  assert.match(text, /Operational alert recipients: delivered 2 \| pending 0 \| ready 0/);
  assert.doesNotMatch(text, /Hidden Person|998900000000|777|lead-secret|Private caption/);
});

test('isolates section failures and never presents unavailable Academy metrics as zero', async () => {
  const snapshot = await buildOperationalReport(range, dependencies({
    channelPosts: { all: async () => { throw new Error('path with secret'); } },
    sales: {
      store: { all: async () => [], getFunnelEventMetrics: async () => ({ available: false, leadCreationsTracked: 0, hotEscalations: 0, registrations: 0 }) },
      failureStore: { all: async () => [{ failedAt: '2026-07-15T06:00:00.000Z' }] },
    },
    botHealth: async () => { throw new Error('token leaked here'); },
  }), new Date('2026-07-15T07:00:00.000Z'));
  const text = formatOperationalReport(snapshot);
  assert.equal(snapshot.status, 'DEGRADED');
  assert.match(text, /Content storage: UNAVAILABLE/);
  assert.match(text, /Bot API: UNAVAILABLE/);
  assert.match(text, /Academy aggregate: UNAVAILABLE/);
  assert.match(text, /Webhook retry\/outbox queue now: 1/);
  assert.doesNotMatch(text, /Admissions 0|Verified paid 0|path with secret|token leaked here/);
});

test('marks queued delivery or due content for attention without inventing a system outage', async () => {
  const snapshot = await buildOperationalReport(range, dependencies({
    channelPosts: { all: async () => [{ id: 'due', text: 'Due', status: 'Scheduled', createdAt: '2026-07-14T00:00:00.000Z', scheduledAt: '2026-07-15T06:00:00.000Z', attempts: 0 }] },
    sales: {
      store: { all: async () => [], getFunnelEventMetrics: async () => ({ available: true, leadCreationsTracked: 0, hotEscalations: 0, registrations: 0 }) },
      failureStore: { all: async () => [{ failedAt: '2026-07-15T06:00:00.000Z' }] },
      academyMetrics: async () => academy,
    },
  }), new Date('2026-07-15T07:00:00.000Z'));
  assert.equal(snapshot.status, 'ATTENTION');
  assert.equal(snapshot.content.counts.due, 1);
  assert.equal(snapshot.sales?.webhookFailuresQueued, 1);
});
