import assert from 'node:assert/strict';
import test from 'node:test';
import { assertReadOnlyReporter, buildSalesReport, formatSalesReport, parseSalesReportRange, type AcademyReportMetrics } from '../src/salesReporting.js';
import type { FunnelEventMetrics, JsonLeadStore, JsonWebhookFailureStore } from '../src/storage.js';
import type { Lead } from '../src/types.js';

function lead(id: number, createdAt: string, source: Lead['source'], campaignId?: string): Lead {
  return { id:String(id),createdAt,updatedAt:createdAt,telegramId:id,fullName:'Hidden',phone:'',city:'',age:'',workStatus:'',experience:'',goal:'',paymentOption:'',status:'New',source,campaignId,intent:'',lastMessage:'',messages:[],operatorNote:'',nextFollowUp:'',paymentStatus:'',preferredTime:'' };
}

const academy: AcademyReportMetrics = {
  available: true,
  admissions: 4,
  linkedAdmissions: 2,
  contacted: 3,
  contactedWithin24Hours: 2,
  overdueUncontacted: 1,
  overdueFollowUps: 1,
  medianFirstContactMinutes: 90,
  verifiedPaidConversions: 2,
  attributedVerifiedPaidConversions: 1,
  activeFullyPaidStudents: 3,
  attributedActiveStudents: 1,
  verifiedReceipts: [{ currency: 'UZS', amountMinor: 250_000_000 }],
};

test('date range uses inclusive Asia/Tashkent calendar days', () => {
  const range = parseSalesReportRange(['2026-07-10', '2026-07-15']);
  assert.equal(range.from.toISOString(), '2026-07-09T19:00:00.000Z');
  assert.equal(range.toExclusive.toISOString(), '2026-07-15T19:00:00.000Z');
  assert.throws(() => parseSalesReportRange(['2026-02-30']), /Noto‘g‘ri sana/);
  assert.throws(() => parseSalesReportRange(['2026-07-15', '2026-07-14']), /1–366/);
});

test('report aggregates sources, campaign, events and webhook failures without PII', async () => {
  const range = parseSalesReportRange(['2026-07-10', '2026-07-15']);
  const leads = [
    lead(1, '2026-07-09T19:00:00.000Z', 'telegram_ads', 'campaign-a'),
    lead(2, '2026-07-12T08:00:00.000Z', 'telegram_ads', 'campaign-a'),
    lead(3, '2026-07-14T08:00:00.000Z', 'organic'),
    lead(4, '2026-07-15T19:00:00.000Z', 'channel'),
  ];
  const eventMetrics: FunnelEventMetrics = { available: true, leadCreationsTracked: 2, hotEscalations: 2, registrations: 1 };
  const store = { all: async () => leads, getFunnelEventMetrics: async () => eventMetrics } as Pick<JsonLeadStore, 'all' | 'getFunnelEventMetrics'>;
  const failureStore = { all: async () => [
    { failedAt: '2026-07-12T00:00:00.000Z' },
    { failedAt: '2026-07-01T00:00:00.000Z' },
  ] } as unknown as Pick<JsonWebhookFailureStore, 'all'>;
  const snapshot = await buildSalesReport(range, { store, failureStore, academyMetrics: async () => academy });
  const text = formatSalesReport(snapshot);
  assert.equal(snapshot.leadCount, 3);
  assert.deepEqual(snapshot.leadsByAttribution[0], { source: 'telegram_ads', campaign: 'campaign-a', count: 2 });
  assert.equal(snapshot.webhookFailuresInRange, 1);
  assert.match(text, /Event tracking coverage: 2\/3/);
  assert.match(text, /Hot escalation \(event-tracked\): 2/);
  assert.match(text, /Verified-paid conversion: 2 \(attributed: 1\)/);
  assert.match(text, /UZS 2,500,000/);
  assert.match(text, /CAC\/ROAS: hisoblanmaydi/);
  assert.doesNotMatch(text, /Hidden|telegramId|phone/i);
});

test('missing Academy integration is explicit and never invents paid or SLA metrics', async () => {
  const range = parseSalesReportRange(['2026-07-15']);
  const store = { all: async () => [], getFunnelEventMetrics: async () => ({ available: false, leadCreationsTracked: 0, hotEscalations: 0, registrations: 0 }) } as Pick<JsonLeadStore, 'all' | 'getFunnelEventMetrics'>;
  const failureStore = { all: async () => [] } as unknown as Pick<JsonWebhookFailureStore, 'all'>;
  const text = formatSalesReport(await buildSalesReport(range, { store, failureStore }));
  assert.match(text, /Academy enrollment\/payment: integration mavjud emas/);
  assert.match(text, /Verified-paid conversion: mavjud emas/);
  assert.match(text, /Operator SLA: mavjud emas/);
  assert.doesNotMatch(text, /Verified-paid conversion: 0/);
});

test('Academy adapter rejects a database role with write privilege', async () => {
  const unsafeClient = { query: async () => ({ rows: [{ read_only: 'on', has_write: true }] }) };
  await assert.rejects(assertReadOnlyReporter(unsafeClient as never), /least-privilege read-only/);
  const safeClient = { query: async () => ({ rows: [{ read_only: 'on', has_write: false }] }) };
  await assert.doesNotReject(assertReadOnlyReporter(safeClient as never));
});
