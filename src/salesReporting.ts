import { Pool, type PoolClient } from 'pg';
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
  linkedAdmissions: number;
  contacted: number;
  contactedWithin24Hours: number;
  overdueUncontacted: number;
  overdueFollowUps: number;
  medianFirstContactMinutes?: number;
  verifiedPaidConversions: number;
  attributedVerifiedPaidConversions: number;
  activeFullyPaidStudents: number;
  attributedActiveStudents: number;
  verifiedReceipts: Array<{ currency: string; amountMinor: number }>;
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
  linkedAdmissions: 0,
  contacted: 0,
  contactedWithin24Hours: 0,
  overdueUncontacted: 0,
  overdueFollowUps: 0,
  verifiedPaidConversions: 0,
  attributedVerifiedPaidConversions: 0,
  activeFullyPaidStudents: 0,
  attributedActiveStudents: 0,
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
  if (days < 1 || days > 366) throw new Error('Sana oralig‘i 1–366 kun bo‘lishi kerak.');
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

export function createAcademyMetricsLoader(connectionString: string | undefined): SalesReportDependencies['academyMetrics'] | undefined {
  if (!connectionString) return undefined;
  return (range, now) => loadAcademyMetrics(connectionString, range, now);
}

async function loadAcademyMetrics(connectionString: string, range: SalesReportRange, now: Date): Promise<AcademyReportMetrics> {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 3_000, statement_timeout: 5_000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await assertReadOnlyReporter(client);
    const referenceTime = new Date(Math.min(now.getTime(), range.toExclusive.getTime()));
    const admissions = await client.query(`
      SELECT count(*)::int AS admissions,
        count(*) FILTER (WHERE ta.user_id IS NOT NULL)::int AS linked_admissions,
        count(*) FILTER (WHERE a.last_contacted_at IS NOT NULL)::int AS contacted,
        count(*) FILTER (WHERE a.last_contacted_at <= a.created_at + interval '24 hours')::int AS contacted_within_24h,
        count(*) FILTER (WHERE a.last_contacted_at IS NULL AND a.created_at < $3 - interval '24 hours')::int AS overdue_uncontacted,
        count(*) FILTER (WHERE a.next_follow_up_at IS NOT NULL AND a.next_follow_up_at < $3 AND a.status NOT IN ('ENROLLED','LOST'))::int AS overdue_followups,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (a.last_contacted_at - a.created_at)) / 60.0)
          FILTER (WHERE a.last_contacted_at IS NOT NULL) AS median_first_contact_minutes
      FROM admissions_leads a
      LEFT JOIN telegram_accounts ta ON ta.telegram_user_id = a.telegram_id
      WHERE a.created_at >= $1 AND a.created_at < $2
    `, [range.from, range.toExclusive, referenceTime]);
    const payments = await client.query(`
      WITH ordered AS (
        SELECT p.id, p.enrollment_id, p.verified_at, i.amount_minor AS invoice_amount,
          sum(p.amount_minor) OVER (PARTITION BY p.enrollment_id ORDER BY p.verified_at, p.id) AS paid_to_date
        FROM payment_verifications p
        JOIN invoices i ON i.enrollment_id = p.enrollment_id
        WHERE p.status = 'VERIFIED' AND p.verified_at IS NOT NULL
      ), full_paid AS (
        SELECT DISTINCT ON (enrollment_id) enrollment_id, verified_at AS converted_at
        FROM ordered WHERE paid_to_date >= invoice_amount
        ORDER BY enrollment_id, verified_at, id
      ), linked AS (
        SELECT DISTINCT e.id AS enrollment_id
        FROM enrollments e
        JOIN telegram_accounts ta ON ta.user_id = e.user_id
        JOIN admissions_leads a ON a.telegram_id = ta.telegram_user_id
      )
      SELECT count(*) FILTER (WHERE f.converted_at >= $1 AND f.converted_at < $2)::int AS verified_paid,
        count(*) FILTER (WHERE f.converted_at >= $1 AND f.converted_at < $2 AND l.enrollment_id IS NOT NULL)::int AS attributed_verified_paid
      FROM full_paid f LEFT JOIN linked l ON l.enrollment_id = f.enrollment_id
    `, [range.from, range.toExclusive]);
    const active = await client.query(`
      WITH paid AS (
        SELECT p.enrollment_id, sum(p.amount_minor) AS paid_amount
        FROM payment_verifications p WHERE p.status = 'VERIFIED' GROUP BY p.enrollment_id
      ), linked AS (
        SELECT DISTINCT e.id AS enrollment_id
        FROM enrollments e
        JOIN telegram_accounts ta ON ta.user_id = e.user_id
        JOIN admissions_leads a ON a.telegram_id = ta.telegram_user_id
      )
      SELECT count(*)::int AS active_paid,
        count(*) FILTER (WHERE l.enrollment_id IS NOT NULL)::int AS attributed_active
      FROM enrollments e
      JOIN invoices i ON i.enrollment_id = e.id
      JOIN paid p ON p.enrollment_id = e.id AND p.paid_amount >= i.amount_minor
      LEFT JOIN linked l ON l.enrollment_id = e.id
      WHERE e.status = 'ACTIVE'
    `);
    const receipts = await client.query(`
      SELECT currency, sum(amount_minor)::bigint AS amount_minor
      FROM payment_verifications
      WHERE status = 'VERIFIED' AND verified_at >= $1 AND verified_at < $2
      GROUP BY currency ORDER BY currency
    `, [range.from, range.toExclusive]);
    await client.query('COMMIT');
    const a = admissions.rows[0] ?? {};
    const p = payments.rows[0] ?? {};
    const s = active.rows[0] ?? {};
    return {
      available: true,
      admissions: Number(a.admissions ?? 0),
      linkedAdmissions: Number(a.linked_admissions ?? 0),
      contacted: Number(a.contacted ?? 0),
      contactedWithin24Hours: Number(a.contacted_within_24h ?? 0),
      overdueUncontacted: Number(a.overdue_uncontacted ?? 0),
      overdueFollowUps: Number(a.overdue_followups ?? 0),
      medianFirstContactMinutes: a.median_first_contact_minutes == null ? undefined : Number(a.median_first_contact_minutes),
      verifiedPaidConversions: Number(p.verified_paid ?? 0),
      attributedVerifiedPaidConversions: Number(p.attributed_verified_paid ?? 0),
      activeFullyPaidStudents: Number(s.active_paid ?? 0),
      attributedActiveStudents: Number(s.attributed_active ?? 0),
      verifiedReceipts: receipts.rows.map((row) => ({ currency: String(row.currency), amountMinor: Number(row.amount_minor) })),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function assertReadOnlyReporter(client: Pick<PoolClient, 'query'>): Promise<void> {
  const state = await client.query(`
    SELECT current_setting('transaction_read_only') AS read_only,
      has_table_privilege(current_user, 'admissions_leads', 'INSERT,UPDATE,DELETE') OR
      has_table_privilege(current_user, 'enrollments', 'INSERT,UPDATE,DELETE') OR
      has_table_privilege(current_user, 'payment_verifications', 'INSERT,UPDATE,DELETE') AS has_write
  `);
  if (state.rows[0]?.read_only !== 'on' || state.rows[0]?.has_write) throw new Error('Academy reporting database role is not least-privilege read-only.');
}

function formatAcademy(metrics: AcademyReportMetrics): string[] {
  const contactRate = metrics.admissions ? ((metrics.contactedWithin24Hours / metrics.admissions) * 100).toFixed(1) : '0.0';
  const coverage = metrics.admissions ? ((metrics.linkedAdmissions / metrics.admissions) * 100).toFixed(1) : '0.0';
  const receipts = metrics.verifiedReceipts.length
    ? metrics.verifiedReceipts.map((item) => `${item.currency} ${formatMinor(item.amountMinor)}`).join(', ')
    : '0';
  return [
    `Academy admissions: ${metrics.admissions}`,
    `Telegram attribution coverage: ${metrics.linkedAdmissions}/${metrics.admissions} (${coverage}%)`,
    `Verified-paid conversion: ${metrics.verifiedPaidConversions} (attributed: ${metrics.attributedVerifiedPaidConversions})`,
    `Active fully-paid students (current): ${metrics.activeFullyPaidStudents} (attributed: ${metrics.attributedActiveStudents})`,
    `Verified receipts: ${receipts}`,
    `Operator contacted: ${metrics.contacted}/${metrics.admissions}`,
    `First contact ≤24h: ${metrics.contactedWithin24Hours}/${metrics.admissions} (${contactRate}%)`,
    `Median first contact: ${metrics.medianFirstContactMinutes == null ? 'mavjud emas' : `${Math.round(metrics.medianFirstContactMinutes)} min`}`,
    `Overdue uncontacted: ${metrics.overdueUncontacted}`,
    `Overdue follow-ups: ${metrics.overdueFollowUps}`,
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
