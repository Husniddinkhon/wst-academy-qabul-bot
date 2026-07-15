import { createHmac, randomUUID } from 'node:crypto';

const MAX_INCLUSIVE_DAYS = 31;
const REPORT_PATH = '/api/v1/bot-reports/academy-summary';
const FORBIDDEN_KEYS = new Set(['email', 'phone', 'full_name', 'telegram_id', 'telegram_username', 'user_id']);

export interface AcademyAggregateReport {
  timezone: 'Asia/Tashkent';
  date_from: string;
  date_to: string;
  inclusive_days: number;
  generated_at: string;
  admissions: {
    leads_created: number;
    by_current_status: Record<string, number>;
    attribution: {
      eligible_leads: number;
      source_present: number;
      campaign_present: number;
      source_coverage_percent: number | null;
      campaign_coverage_percent: number | null;
      definition: string;
    };
    operator_sla: {
      eligible_leads: number;
      missing_first_contact_timestamp: number;
      invalid_timestamp_rows_excluded: number;
      average_first_contact_seconds: number | null;
      contacted_within_15_minutes: number;
      contacted_within_60_minutes: number;
      within_15_minutes_percent: number | null;
      within_60_minutes_percent: number | null;
      definition: string;
    };
  };
  lead_cohort_funnel: {
    eligible_leads: number;
    contacted_leads: number;
    payment_reported_current_unverified: number;
    linked_enrollment_leads: number;
    active_enrollment_leads: number;
    verified_paid_leads: number;
    verified_paid_active_access_leads: number;
    contacted_percent: number | null;
    linked_enrollment_percent: number | null;
    verified_paid_active_access_percent: number | null;
    definition: string;
  };
  payments: {
    verified_in_range_by_currency: Array<{
      currency: string;
      verified_count: number;
      verified_amount_minor: number;
    }>;
    definition: string;
  };
  enrollments: {
    created: number;
    invoiced: number;
    fully_paid_from_created_cohort: number;
    verified_paid_conversion_percent: number | null;
    current_fully_paid_active: number;
    definition: string;
  };
}

export interface AcademyReportClientOptions {
  baseUrl: string;
  serviceId: string;
  serviceSecret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface AcademyReportClient {
  load(dateFrom: string, dateTo: string): Promise<AcademyAggregateReport>;
}

export function createAcademyReportClient(options: AcademyReportClientOptions): AcademyReportClient {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
  const serviceId = options.serviceId.trim();
  const serviceSecret = options.serviceSecret;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!/^https:\/\//i.test(baseUrl)) throw new Error('Academy report URL must use HTTPS.');
  if (!serviceId) throw new Error('Academy report service ID is required.');
  if (serviceSecret.length < 32) throw new Error('Academy report service secret is invalid.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 15_000) throw new Error('Academy report timeout must be 500–15000 ms.');

  return {
    async load(dateFrom: string, dateTo: string): Promise<AcademyAggregateReport> {
      validateRange(dateFrom, dateTo);
      const timestamp = Math.floor(Date.now() / 1_000).toString();
      const nonce = randomUUID();
      const signature = createHmac('sha256', serviceSecret)
        .update(`${timestamp}\n${nonce}\n`)
        .digest('hex');
      const query = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${REPORT_PATH}?${query.toString()}`, {
          method: 'GET',
          headers: {
            'X-Service-Id': serviceId,
            'X-Service-Timestamp': timestamp,
            'X-Service-Nonce': nonce,
            'X-Service-Signature': signature,
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new Error('Academy aggregate report is temporarily unavailable.');
      }
      if (!response.ok) throw new Error(`Academy aggregate report is temporarily unavailable (HTTP ${response.status}).`);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error('Academy aggregate report returned an invalid response.');
      }
      assertAggregateReport(payload, dateFrom, dateTo);
      return payload;
    },
  };
}

function validateRange(dateFrom: string, dateTo: string): void {
  const from = parseDateKey(dateFrom);
  const to = parseDateKey(dateTo);
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  if (days < 1 || days > MAX_INCLUSIVE_DAYS) throw new Error('Academy report range must be 1–31 inclusive days.');
}

function parseDateKey(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Academy report date must use YYYY-MM-DD.');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('Academy report date is invalid.');
  return parsed;
}

function assertAggregateReport(value: unknown, dateFrom: string, dateTo: string): asserts value is AcademyAggregateReport {
  assertObject(value, 'report');
  assertNoPiiKeys(value);
  if (value.timezone !== 'Asia/Tashkent' || value.date_from !== dateFrom || value.date_to !== dateTo) throw new Error('Academy aggregate report range does not match the request.');
  assertCount(value.inclusive_days, 'inclusive_days');
  if (typeof value.generated_at !== 'string' || !Number.isFinite(Date.parse(value.generated_at))) throw new Error('Academy aggregate report timestamp is invalid.');

  assertObject(value.admissions, 'admissions');
  assertCount(value.admissions.leads_created, 'leads_created');
  assertCountMap(value.admissions.by_current_status, 'by_current_status');
  assertObject(value.admissions.attribution, 'attribution');
  for (const key of ['eligible_leads', 'source_present', 'campaign_present'] as const) assertCount(value.admissions.attribution[key], key);
  assertNullableNumber(value.admissions.attribution.source_coverage_percent, 'source_coverage_percent');
  assertNullableNumber(value.admissions.attribution.campaign_coverage_percent, 'campaign_coverage_percent');
  assertString(value.admissions.attribution.definition, 'attribution.definition');

  assertObject(value.admissions.operator_sla, 'operator_sla');
  for (const key of ['eligible_leads', 'missing_first_contact_timestamp', 'invalid_timestamp_rows_excluded', 'contacted_within_15_minutes', 'contacted_within_60_minutes'] as const) assertCount(value.admissions.operator_sla[key], key);
  assertNullableNumber(value.admissions.operator_sla.average_first_contact_seconds, 'average_first_contact_seconds');
  assertNullableNumber(value.admissions.operator_sla.within_15_minutes_percent, 'within_15_minutes_percent');
  assertNullableNumber(value.admissions.operator_sla.within_60_minutes_percent, 'within_60_minutes_percent');
  assertString(value.admissions.operator_sla.definition, 'operator_sla.definition');

  assertObject(value.lead_cohort_funnel, 'lead_cohort_funnel');
  for (const key of ['eligible_leads', 'contacted_leads', 'payment_reported_current_unverified', 'linked_enrollment_leads', 'active_enrollment_leads', 'verified_paid_leads', 'verified_paid_active_access_leads'] as const) {
    assertCount(value.lead_cohort_funnel[key], `lead_cohort_funnel.${key}`);
  }
  for (const key of ['contacted_percent', 'linked_enrollment_percent', 'verified_paid_active_access_percent'] as const) {
    assertNullableNumber(value.lead_cohort_funnel[key], `lead_cohort_funnel.${key}`);
  }
  assertString(value.lead_cohort_funnel.definition, 'lead_cohort_funnel.definition');

  assertObject(value.payments, 'payments');
  if (!Array.isArray(value.payments.verified_in_range_by_currency)) throw new Error('Academy aggregate report currencies are invalid.');
  for (const item of value.payments.verified_in_range_by_currency) {
    assertObject(item, 'currency item');
    if (typeof item.currency !== 'string' || !/^[A-Z]{3}$/.test(item.currency)) throw new Error('Academy aggregate report currency is invalid.');
    assertCount(item.verified_count, 'verified_count');
    assertCount(item.verified_amount_minor, 'verified_amount_minor');
  }
  assertString(value.payments.definition, 'payments.definition');

  assertObject(value.enrollments, 'enrollments');
  for (const key of ['created', 'invoiced', 'fully_paid_from_created_cohort', 'current_fully_paid_active'] as const) assertCount(value.enrollments[key], key);
  assertNullableNumber(value.enrollments.verified_paid_conversion_percent, 'verified_paid_conversion_percent');
  assertString(value.enrollments.definition, 'enrollments.definition');
}

function assertNoPiiKeys(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(assertNoPiiKeys);
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new Error('Academy aggregate report unexpectedly contained identity data.');
    assertNoPiiKeys(child);
  }
}

function assertObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!isObject(value)) throw new Error(`Academy aggregate report ${name} is invalid.`);
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function assertCount(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Academy aggregate report ${name} is invalid.`);
}
function assertNullableNumber(value: unknown, name: string): void {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error(`Academy aggregate report ${name} is invalid.`);
}
function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value) throw new Error(`Academy aggregate report ${name} is invalid.`);
}
function assertCountMap(value: unknown, name: string): void {
  assertObject(value, name);
  for (const [key, count] of Object.entries(value)) {
    if (!/^[a-z_]+$/.test(key)) throw new Error(`Academy aggregate report ${name} key is invalid.`);
    assertCount(count, `${name}.${key}`);
  }
}
