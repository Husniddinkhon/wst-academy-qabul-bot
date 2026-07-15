import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSalesReport, formatSalesReport, parseSalesReportRange, type AcademyReportMetrics } from '../src/salesReporting.js';
import type { FunnelEventMetrics, JsonLeadStore, JsonWebhookFailureStore } from '../src/storage.js';
import type { Lead } from '../src/types.js';

function lead(id: number, createdAt: string, source: Lead['source'], campaignId?: string): Lead {
  return { id:String(id),createdAt,updatedAt:createdAt,telegramId:id,fullName:'Hidden',phone:'',city:'',age:'',workStatus:'',experience:'',goal:'',paymentOption:'',status:'New',source,campaignId,intent:'',lastMessage:'',messages:[],operatorNote:'',nextFollowUp:'',paymentStatus:'',preferredTime:'' };
}

const academy: AcademyReportMetrics = {
  available: true,
  admissions: 4,
  admissionsByStatus: { new: 1, contacted: 3 },
  sourceAttributionPresent: 4,
  campaignAttributionPresent: 2,
  sourceCoveragePercent: 100,
  campaignCoveragePercent: 50,
  slaEligible: 3,
  slaMissing: 1,
  slaInvalid: 0,
  averageFirstContactMinutes: 90,
  contactedWithin15Minutes: 1,
  contactedWithin60Minutes: 2,
  within15MinutesPercent: 33.33,
  within60MinutesPercent: 66.67,
  enrollmentsCreated: 3,
  invoicedEnrollments: 2,
  verifiedPaidConversions: 2,
  verifiedPaidConversionPercent: 100,
  activeFullyPaidStudents: 3,
  verifiedReceipts: [{ currency: 'UZS', count: 2, amountMinor: 250_000_000 }],
};

test('date range uses inclusive Asia/Tashkent calendar days', () => {
  const range = parseSalesReportRange(['2026-07-10', '2026-07-15']);
  assert.equal(range.from.toISOString(), '2026-07-09T19:00:00.000Z');
  assert.equal(range.toExclusive.toISOString(), '2026-07-15T19:00:00.000Z');
  assert.throws(() => parseSalesReportRange(['2026-02-30']), /Noto‘g‘ri sana/);
  assert.throws(() => parseSalesReportRange(['2026-07-15', '2026-07-14']), /1–31/);
  assert.throws(() => parseSalesReportRange(['2026-06-01', '2026-07-15']), /1–31/);
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
  assert.match(text, /Admissions status \(current\): new: 1, contacted: 3/);
  assert.match(text, /Campaign attribution: 2\/4 \(50.0%\)/);
  assert.match(text, /Verified-paid conversion: 2\/2 \(100.0%\)/);
  assert.match(text, /UZS 2,500,000 \(2 ta\)/);
  assert.match(text, /First contact ≤15 min: 1\/3 \(33.3%\)/);
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
