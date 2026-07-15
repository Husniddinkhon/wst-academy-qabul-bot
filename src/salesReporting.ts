import { createAcademyReportClient, type AcademyReportClientOptions } from './academyReportClient.js';
import { getTashkentDateKey, REPORT_TIME_ZONE } from './dailyReport.js';
import type { FunnelEventMetrics, JsonLeadStore, JsonWebhookFailureStore } from './storage.js';
import type { Lead } from './types.js';

export interface SalesReportRange {
  fromKey: string;
  toKey: string;
  from: Date;
  toExclusive: Date;
}

export interface AcademyReportMetrics {
  available: boolean;
  admissions: number;
  admissionsByStatus: Record<string, number>;
  sourceAttributionPresent: number;
  campaignAttributionPresent: number;
  sourceCoveragePercent?: number;
  campaignCoveragePercent?: number;
  slaEligible: number;
  slaMissing: number;
  slaInvalid: number;
  averageFirstContactMinutes?: number;
  contactedWithin15Minutes: number;
  contactedWithin60Minutes: number;
  within15MinutesPercent?: number;
  within60MinutesPercent?: number;
  enrollmentsCreated: number;
  invoicedEnrollments: number;
  verifiedPaidConversions: number;
  verifiedPaidConversionPercent?: number;
  activeFullyPaidStudents: number;
  verifiedReceipts: Array<{ currency: string; count: number; amountMinor: number }>;
}

export interface SalesReportDependencies {
  store: Pick<JsonLeadStore, 'all' | 'getFunnelEventMetrics'>;
  failureStore: Pick<JsonWebhookFailureStore, 'all'>;
  academyMetrics?: (range: SalesReportRange, now: Date) => Promise<AcademyReportMetrics>;
}

export interface SalesReportSnapshot {
  range: SalesReportRange;
  leadCount: number;
  leadsByAttribution: Array<{ source: string; campaign: string; count: number }>;
  eventMetrics: FunnelEventMetrics;
  webhookFailuresInRange: number;
  webhookFailuresQueued: number;
  academy: AcademyReportMetrics;
}

const UNAVAILABLE_ACADEMY: AcademyReportMetrics = {
  available: false,
  admissions: 0,
  admissionsByStatus: {},
  sourceAttributionPresent: 0,
  campaignAttributionPresent: 0,
  slaEligible: 0,
  slaMissing: 0,
  slaInvalid: 0,
  contactedWithin15Minutes: 0,
  contactedWithin60Minutes: 0,
  enrollmentsCreated: 0,
  invoicedEnrollments: 0,
  verifiedPaidConversions: 0,
  activeFullyPaidStudents: 0,
  verifiedReceipts: [],
};

export function parseSalesReportRange(args: string[], now = new Date()): SalesReportRange {
  if (args.length > 2) throw new Error('Format: /sales_report [YYYY-MM-DD] [YYYY-MM-DD]');
  const todayKey = getTashkentDateKey(now);
  const fromKey = args[0] || addCalendarDays(todayKey, -6);
  const toKey = args[1] || todayKey;
  validateDateKey(fromKey);
  validateDateKey(toKey);
  const from = dateKeyToUtc(fromKey);
  const toExclusive = dateKeyToUtc(addCalendarDays(toKey, 1));
  const days = Math.round((toExclusive.getTime() - from.getTime()) / 86_400_000);
  if (days < 1 || days > 31) throw new Error('Sana oralig‘i 1–31 kun bo‘lishi kerak.');
  return { fromKey, toKey, from, toExclusive };
}

export async function buildSalesReport(range: SalesReportRange, dependencies: SalesReportDependencies, now = new Date()): Promise<SalesReportSnapshot> {
  const [allLeads, eventMetrics, failedWebhooks, academy] = await Promise.all([
    dependencies.store.all(),
    dependencies.store.getFunnelEventMetrics(range.from, range.toExclusive),
    dependencies.failureStore.all(),
    dependencies.academyMetrics ? dependencies.academyMetrics(range, now).catch(() => UNAVAILABLE_ACADEMY) : Promise.resolve(UNAVAILABLE_ACADEMY),
  ]);
  const leads = allLeads.filter((lead) => inRange(lead.createdAt, range));
  return {
    range,
    leadCount: leads.length,
    leadsByAttribution: groupAttribution(leads),
    eventMetrics,
    webhookFailuresInRange: failedWebhooks.filter((failure) => inRange(failure.failedAt, range)).length,
    webhookFailuresQueued: failedWebhooks.length,
    academy,
  };
}

export function formatSalesReport(snapshot: SalesReportSnapshot): string {
  const attribution = snapshot.leadsByAttribution.length
    ? snapshot.leadsByAttribution.slice(0, 15).map((item) => `- ${item.source} / ${item.campaign}: ${item.count}`)
    : ['- lead yo‘q'];
  const eventLines = snapshot.eventMetrics.available
    ? [`Event tracking coverage: ${snapshot.eventMetrics.leadCreationsTracked}/${snapshot.leadCount} new lead`, `Hot escalation (event-tracked): ${snapshot.eventMetrics.hotEscalations}`, `Ro‘yxatdan o‘tish conversion (event-tracked): ${snapshot.eventMetrics.registrations}`]
    : ['Hot escalation: mavjud emas (event storage yo‘q)', 'Ro‘yxatdan o‘tish conversion: mavjud emas (event storage yo‘q)'];
  const academyLines = snapshot.academy.available ? formatAcademy(snapshot.academy) : [
    'Academy enrollment/payment: integration mavjud emas',
    'Verified-paid conversion: mavjud emas',
    'Active student: mavjud emas',
    'Operator SLA: mavjud emas',
  ];
  return [
    `📈 Sales KPI | ${snapshot.range.fromKey} — ${snapshot.range.toKey}`,
    `Vaqt zonasi: ${REPORT_TIME_ZONE}`,
    '',
    `Yangi leadlar: ${snapshot.leadCount}`,
    ...attribution,
    ...eventLines,
    '',
    ...academyLines,
    '',
    `Webhook failures (oralig‘da): ${snapshot.webhookFailuresInRange}`,
    `Webhook retry queue (hozir): ${snapshot.webhookFailuresQueued}`,
    '',
    'Ad spend: mavjud emas',
    'CAC/ROAS: hisoblanmaydi (ad spend ma’lumoti yo‘q)',
    'Даромад/фойда: ҳисобланмайди (тасдиқланган тўлов бухгалтерия даромади дегани эмас)',
  ].join('\n');
}

export function createAcademyMetricsLoader(options: AcademyReportClientOptions | undefined): SalesReportDependencies['academyMetrics'] | undefined {
  if (!options) return undefined;
  const client = createAcademyReportClient(options);
  return async (range) => {
    const report = await client.load(range.fromKey, range.toKey);
    const attribution = report.admissions.attribution;
    const sla = report.admissions.operator_sla;
    return {
      available: true,
      admissions: report.admissions.leads_created,
      admissionsByStatus: report.admissions.by_current_status,
      sourceAttributionPresent: attribution.source_present,
      campaignAttributionPresent: attribution.campaign_present,
      sourceCoveragePercent: attribution.source_coverage_percent ?? undefined,
      campaignCoveragePercent: attribution.campaign_coverage_percent ?? undefined,
      slaEligible: sla.eligible_leads,
      slaMissing: sla.missing_first_contact_timestamp,
      slaInvalid: sla.invalid_timestamp_rows_excluded,
      averageFirstContactMinutes: sla.average_first_contact_seconds == null ? undefined : sla.average_first_contact_seconds / 60,
      contactedWithin15Minutes: sla.contacted_within_15_minutes,
      contactedWithin60Minutes: sla.contacted_within_60_minutes,
      within15MinutesPercent: sla.within_15_minutes_percent ?? undefined,
      within60MinutesPercent: sla.within_60_minutes_percent ?? undefined,
      enrollmentsCreated: report.enrollments.created,
      invoicedEnrollments: report.enrollments.invoiced,
      verifiedPaidConversions: report.enrollments.fully_paid_from_created_cohort,
      verifiedPaidConversionPercent: report.enrollments.verified_paid_conversion_percent ?? undefined,
      activeFullyPaidStudents: report.enrollments.current_fully_paid_active,
      verifiedReceipts: report.payments.verified_in_range_by_currency.map((item) => ({ currency: item.currency, count: item.verified_count, amountMinor: item.verified_amount_minor })),
    };
  };
}

function formatAcademy(metrics: AcademyReportMetrics): string[] {
  const statuses = Object.entries(metrics.admissionsByStatus).filter(([, count]) => count > 0).map(([status, count]) => `${status}: ${count}`).join(', ') || 'yo‘q';
  const receipts = metrics.verifiedReceipts.length
    ? metrics.verifiedReceipts.map((item) => `${item.currency} ${formatMinor(item.amountMinor)} (${item.count} ta)`).join(', ')
    : '0';
  return [
    `Academy admissions: ${metrics.admissions}`,
    `Admissions status (current): ${statuses}`,
    `Source attribution: ${metrics.sourceAttributionPresent}/${metrics.admissions} (${formatPercent(metrics.sourceCoveragePercent)})`,
    `Campaign attribution: ${metrics.campaignAttributionPresent}/${metrics.admissions} (${formatPercent(metrics.campaignCoveragePercent)})`,
    `Range enrollment cohort: ${metrics.enrollmentsCreated} created, ${metrics.invoicedEnrollments} invoiced`,
    `Verified-paid conversion: ${metrics.verifiedPaidConversions}/${metrics.invoicedEnrollments} (${formatPercent(metrics.verifiedPaidConversionPercent)})`,
    `Active fully-paid students (current): ${metrics.activeFullyPaidStudents}`,
    `Verified receipts: ${receipts}`,
    `First-contact SLA eligible: ${metrics.slaEligible}; missing: ${metrics.slaMissing}; invalid excluded: ${metrics.slaInvalid}`,
    `First contact ≤15 min: ${metrics.contactedWithin15Minutes}/${metrics.slaEligible} (${formatPercent(metrics.within15MinutesPercent)})`,
    `First contact ≤60 min: ${metrics.contactedWithin60Minutes}/${metrics.slaEligible} (${formatPercent(metrics.within60MinutesPercent)})`,
    `Average first contact: ${metrics.averageFirstContactMinutes == null ? 'mavjud emas' : `${Math.round(metrics.averageFirstContactMinutes)} min`}`,
  ];
}

function groupAttribution(leads: Lead[]): SalesReportSnapshot['leadsByAttribution'] {
  const grouped = new Map<string, { source: string; campaign: string; count: number }>();
  for (const lead of leads) {
    const source = lead.source || 'unknown';
    const campaign = lead.campaignId || 'none';
    const key = `${source}\u0000${campaign}`;
    const item = grouped.get(key) ?? { source, campaign, count: 0 };
    item.count += 1;
    grouped.set(key, item);
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source) || a.campaign.localeCompare(b.campaign));
}

function inRange(value: string, range: SalesReportRange): boolean {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp >= range.from.getTime() && timestamp < range.toExclusive.getTime();
}

function validateDateKey(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || getTashkentDateKey(dateKeyToUtc(value)) !== value) throw new Error(`Noto‘g‘ri sana: ${value}. YYYY-MM-DD formatidan foydalaning.`);
}

function dateKeyToUtc(value: string): Date { return new Date(`${value}T00:00:00+05:00`); }
function addCalendarDays(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
function formatMinor(value: number): string { return (value / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
function formatPercent(value: number | undefined): string { return value == null ? 'mavjud emas' : `${value.toFixed(1)}%`; }
