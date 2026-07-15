import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { createAcademyReportClient } from '../src/academyReportClient.js';

const secret = 'academy-test-service-secret-at-least-32-chars';

function report() {
  return {
    timezone: 'Asia/Tashkent', date_from: '2026-07-01', date_to: '2026-07-15', inclusive_days: 15, generated_at: '2026-07-15T08:00:00Z',
    admissions: {
      leads_created: 10,
      by_current_status: { new: 3, contacted: 7 },
      attribution: { eligible_leads: 10, source_present: 10, campaign_present: 8, source_coverage_percent: 100, campaign_coverage_percent: 80, definition: 'aggregate' },
      operator_sla: { eligible_leads: 6, missing_first_contact_timestamp: 4, invalid_timestamp_rows_excluded: 0, average_first_contact_seconds: 600, contacted_within_15_minutes: 5, contacted_within_60_minutes: 6, within_15_minutes_percent: 83.33, within_60_minutes_percent: 100, definition: 'real timestamps' },
    },
    lead_cohort_funnel: {
      eligible_leads: 10, contacted_leads: 6, payment_reported_current_unverified: 1,
      linked_enrollment_leads: 4, active_enrollment_leads: 3, verified_paid_leads: 3,
      verified_paid_active_access_leads: 2, contacted_percent: 60,
      linked_enrollment_percent: 40, verified_paid_active_access_percent: 20,
      definition: 'exact Telegram account linkage; unverified is never revenue',
    },
    payments: { verified_in_range_by_currency: [{ currency: 'UZS', verified_count: 2, verified_amount_minor: 250_000_000 }], definition: 'verified only' },
    enrollments: { created: 4, invoiced: 4, fully_paid_from_created_cohort: 2, verified_paid_conversion_percent: 50, current_fully_paid_active: 3, definition: 'same currency cumulative' },
  };
}

test('signs an empty GET body with cryptographic nonce and validates aggregate response', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const client = createAcademyReportClient({
    baseUrl: 'https://pilot.example/academy-api/', serviceId: 'academy-bot', serviceSecret: secret,
    fetchImpl: async (url, init) => { seenUrl = String(url); seenInit = init; return new Response(JSON.stringify(report()), { status: 200, headers: { 'content-type': 'application/json' } }); },
  });
  const result = await client.load('2026-07-01', '2026-07-15');
  assert.equal(result.enrollments.current_fully_paid_active, 3);
  assert.equal(result.lead_cohort_funnel.verified_paid_active_access_leads, 2);
  assert.equal(seenUrl, 'https://pilot.example/academy-api/api/v1/bot-reports/academy-summary?date_from=2026-07-01&date_to=2026-07-15');
  assert.equal(seenInit?.method, 'GET');
  assert.equal(seenInit?.body, undefined);
  assert.ok(seenInit?.signal instanceof AbortSignal);
  const headers = seenInit?.headers as Record<string, string>;
  assert.match(headers['X-Service-Nonce'], /^[0-9a-f-]{36}$/);
  const expected = createHmac('sha256', secret).update(`${headers['X-Service-Timestamp']}\n${headers['X-Service-Nonce']}\n`).digest('hex');
  assert.equal(headers['X-Service-Signature'], expected);
});

test('rejects ranges outside API bounds before making a request', async () => {
  let calls = 0;
  const client = createAcademyReportClient({ baseUrl: 'https://pilot.example', serviceId: 'bot', serviceSecret: secret, fetchImpl: async () => { calls += 1; return new Response('{}'); } });
  await assert.rejects(client.load('2026-07-15', '2026-07-14'), /1–31/);
  await assert.rejects(client.load('2026-06-01', '2026-07-15'), /1–31/);
  await assert.rejects(client.load('2026-02-30', '2026-03-01'), /date is invalid/);
  assert.equal(calls, 0);
});

test('uses safe unavailable errors and rejects PII-shaped payloads', async () => {
  const unavailable = createAcademyReportClient({ baseUrl: 'https://pilot.example', serviceId: 'bot', serviceSecret: secret, fetchImpl: async () => new Response('database password leaked', { status: 503 }) });
  await assert.rejects(unavailable.load('2026-07-01', '2026-07-15'), (error: Error) => error.message === 'Academy aggregate report is temporarily unavailable (HTTP 503).');
  const withPii = report() as ReturnType<typeof report> & { phone?: string };
  withPii.phone = '+998-secret';
  const invalid = createAcademyReportClient({ baseUrl: 'https://pilot.example', serviceId: 'bot', serviceSecret: secret, fetchImpl: async () => new Response(JSON.stringify(withPii)) });
  await assert.rejects(invalid.load('2026-07-01', '2026-07-15'), /identity data/);
});
