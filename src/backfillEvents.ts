import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';

export interface LeadCreationEvidence { telegramId: number; createdAt: string }
export interface SyntheticLeadCreatedEvent {
  telegramId: number;
  eventType: 'lead_created';
  createdAt: string;
  idempotencyKey: string;
  payload: { provenance: 'synthetic_backfill_v1'; inferred: false; evidence: { leadCreatedAt: string } };
}
export interface BackfillCoverage { totalLeads: number; trackedLeadCreations: number; missingLeadCreations: number }
export interface BackfillResult {
  mode: 'dry-run' | 'apply';
  before: BackfillCoverage;
  projectedAfter: BackfillCoverage;
  after: BackfillCoverage;
  planned: number;
  inserted: number;
  backupPath?: string;
}

export function syntheticLeadCreatedKey(lead: LeadCreationEvidence): string {
  return `backfill:v1:lead_created:${lead.telegramId}:${lead.createdAt}`;
}

export function planSyntheticLeadCreatedEvents(leads: LeadCreationEvidence[]): SyntheticLeadCreatedEvent[] {
  return [...leads].sort((a, b) => a.telegramId - b.telegramId).map((lead) => {
    if (!Number.isSafeInteger(lead.telegramId) || lead.telegramId <= 0) throw new Error('Invalid Telegram id in lead evidence.');
    const createdAt = new Date(lead.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== lead.createdAt) throw new Error(`Invalid createdAt evidence for Telegram id ${lead.telegramId}.`);
    return {
      telegramId: lead.telegramId,
      eventType: 'lead_created',
      createdAt: lead.createdAt,
      idempotencyKey: syntheticLeadCreatedKey(lead),
      payload: { provenance: 'synthetic_backfill_v1', inferred: false, evidence: { leadCreatedAt: lead.createdAt } },
    };
  });
}

export async function runPostgresLeadCreationBackfill(options: {
  pool: Pool;
  apply: boolean;
  backupDir: string;
  now?: Date;
}): Promise<BackfillResult> {
  const client = await options.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query('SELECT pg_advisory_xact_lock(937422)');
    const before = await coverage(client);
    const missing = await client.query(`
      SELECT l.telegram_id, l.created_at
      FROM leads l
      WHERE NOT EXISTS (
        SELECT 1 FROM conversation_events e
        WHERE e.telegram_id = l.telegram_id AND e.event_type = 'lead_created'
      )
      ORDER BY l.telegram_id
      FOR SHARE OF l
    `);
    const plan = planSyntheticLeadCreatedEvents(missing.rows.map((row) => ({
      telegramId: Number(row.telegram_id),
      createdAt: new Date(row.created_at).toISOString(),
    })));
    const projectedAfter = { totalLeads: before.totalLeads, trackedLeadCreations: before.trackedLeadCreations + plan.length, missingLeadCreations: 0 };
    if (!options.apply) {
      await client.query('ROLLBACK');
      return { mode: 'dry-run', before, projectedAfter, after: before, planned: plan.length, inserted: 0 };
    }

    const backupPath = await writeBackup(options.backupDir, options.now ?? new Date(), before, plan);
    let inserted = 0;
    for (const event of plan) {
      const result = await client.query(`
        INSERT INTO conversation_events(telegram_id, event_type, payload, idempotency_key, created_at)
        VALUES($1, $2, $3, $4, $5)
        ON CONFLICT(idempotency_key) DO NOTHING
      `, [event.telegramId, event.eventType, event.payload, event.idempotencyKey, event.createdAt]);
      inserted += result.rowCount ?? 0;
    }
    const after = await coverage(client);
    if (after.missingLeadCreations !== 0 || after.trackedLeadCreations !== projectedAfter.trackedLeadCreations) {
      throw new Error('Backfill coverage verification failed; transaction rolled back.');
    }
    await client.query('COMMIT');
    return { mode: 'apply', before, projectedAfter, after, planned: plan.length, inserted, backupPath };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function coverage(client: PoolClient): Promise<BackfillCoverage> {
  const result = await client.query(`
    SELECT count(*)::int AS total_leads,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM conversation_events e
        WHERE e.telegram_id = l.telegram_id AND e.event_type = 'lead_created'
      ))::int AS tracked
    FROM leads l
  `);
  const totalLeads = Number(result.rows[0]?.total_leads ?? 0);
  const trackedLeadCreations = Number(result.rows[0]?.tracked ?? 0);
  return { totalLeads, trackedLeadCreations, missingLeadCreations: totalLeads - trackedLeadCreations };
}

async function writeBackup(dir: string, now: Date, before: BackfillCoverage, plan: SyntheticLeadCreatedEvent[]): Promise<string> {
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const target = path.resolve(dir, `lead-created-backfill-${stamp}.json`);
  const artifact = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    purpose: 'Rollback manifest for synthetic lead_created events',
    before,
    rollbackIdempotencyKeys: plan.map((event) => event.idempotencyKey),
    plannedEvents: plan,
  };
  await writeFile(target, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  await chmod(target, 0o600);
  return target;
}
