import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { claimFollowUpState, finishFollowUpState, JsonFollowUpStore, JsonLeadStore, mergeLeadRecords, normalizeFollowUpState, type FollowUpClaimOptions, type FollowUpClaimResult, type FollowUpDeliveryClaim, type FollowUpDeliveryOutcome, type FollowUpDeliveryRequest, type FunnelEventMetrics, type LeadUpsertResult } from './storage.js';
import type { FollowUpState, Lead, LeadStatus } from './types.js';

export const SCHEMA_VERSION = 2;

export const POSTGRES_MIGRATION_DIR = 'data/migrations/postgres';

export class PostgresStorage {
  readonly pool: Pool;
  constructor(databaseUrl: string) { this.pool = new Pool({ connectionString: databaseUrl, max: 10 }); }

  async detectVersion(): Promise<number | null> {
    try {
      const result = await this.pool.query('SELECT max(version) as version FROM schema_migrations');
      return result.rows[0]?.version ?? 0;
    } catch {
      return 0;
    }
  }

  async migrateStore(dryRun: boolean, leadsFile?: string, followupsFile?: string): Promise<{ backupHash: string; backupPath: string } | null> {
    const detected = await this.detectVersion();
    if (detected !== null && detected >= SCHEMA_VERSION) return null;
    const backupDir = POSTGRES_MIGRATION_DIR;
    await mkdir(backupDir, { recursive: true });
    await chmod(backupDir, 0o700);
    const stamp = Date.now();
    const backupPath = path.join(backupDir, `postgres-schema-${stamp}.sql`);
    if (!dryRun) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(937421)');
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
        await client.query(`CREATE TABLE IF NOT EXISTS leads (telegram_id bigint PRIMARY KEY, payload jsonb NOT NULL, status text NOT NULL, source text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`);
        await client.query(`CREATE INDEX IF NOT EXISTS leads_status_idx ON leads(status); CREATE INDEX IF NOT EXISTS leads_source_idx ON leads(source); CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads(created_at DESC)`);
        await client.query(`CREATE TABLE IF NOT EXISTS followups (telegram_id bigint PRIMARY KEY, payload jsonb NOT NULL, count integer NOT NULL CHECK (count >= 0), last_sent_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now())`);
        await client.query(`CREATE INDEX IF NOT EXISTS followups_due_idx ON followups(last_sent_at, count)`);
        await client.query(`CREATE TABLE IF NOT EXISTS conversation_events (id bigserial PRIMARY KEY, telegram_id bigint NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb, idempotency_key text UNIQUE, created_at timestamptz NOT NULL DEFAULT now())`);
        await client.query(`CREATE INDEX IF NOT EXISTS conversation_events_lead_idx ON conversation_events(telegram_id, created_at DESC)`);
        await client.query(`CREATE INDEX IF NOT EXISTS conversation_events_created_at_idx ON conversation_events(created_at DESC)`);
        if (leadsFile && followupsFile) await importJson(client, leadsFile, followupsFile);
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING', [SCHEMA_VERSION]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    await writeFile(backupPath, `-- Postgres schema migration backup\n-- Version: ${detected} -> ${SCHEMA_VERSION}\n-- Timestamp: ${new Date().toISOString()}\n`, 'utf8');
    await chmod(backupPath, 0o600);
    return { backupHash: `schema-v${SCHEMA_VERSION}`, backupPath };
  }

  async rollbackStore(backupPath: string): Promise<void> {
    console.warn(`Postgres rollback from ${backupPath} is a no-op. Manual database restore required.`);
  }

  async verifyStore(): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];
    try {
      const version = await this.detectVersion();
      if (version === null) {
        errors.push('No schema_migrations table found. Migration not applied.');
        return { ok: false, errors };
      }
      if (version !== SCHEMA_VERSION) {
        errors.push(`Schema version ${version} != expected ${SCHEMA_VERSION}.`);
        return { ok: false, errors };
      }
      const tables = ['leads', 'followups', 'conversation_events'];
      for (const table of tables) {
        const result = await this.pool.query(`SELECT to_regclass('${table}')`);
        if (!result.rows[0]?.to_regclass) errors.push(`Table '${table}' does not exist.`);
      }
    } catch (error) {
      errors.push(`Verification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ok: errors.length === 0, errors };
  }

  async migrate(leadsFile: string, followupsFile: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(937421)');
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      await client.query(`CREATE TABLE IF NOT EXISTS leads (telegram_id bigint PRIMARY KEY, payload jsonb NOT NULL, status text NOT NULL, source text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`);
      await client.query(`CREATE INDEX IF NOT EXISTS leads_status_idx ON leads(status); CREATE INDEX IF NOT EXISTS leads_source_idx ON leads(source); CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads(created_at DESC)`);
      await client.query(`CREATE TABLE IF NOT EXISTS followups (telegram_id bigint PRIMARY KEY, payload jsonb NOT NULL, count integer NOT NULL CHECK (count >= 0), last_sent_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now())`);
      await client.query(`CREATE INDEX IF NOT EXISTS followups_due_idx ON followups(last_sent_at, count)`);
      await client.query(`CREATE TABLE IF NOT EXISTS conversation_events (id bigserial PRIMARY KEY, telegram_id bigint NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb, idempotency_key text UNIQUE, created_at timestamptz NOT NULL DEFAULT now())`);
      await client.query(`CREATE INDEX IF NOT EXISTS conversation_events_lead_idx ON conversation_events(telegram_id, created_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS conversation_events_created_at_idx ON conversation_events(created_at DESC)`);
      await importJson(client, leadsFile, followupsFile);
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING', [SCHEMA_VERSION]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}

export class PostgresLeadStore extends JsonLeadStore {
  constructor(private readonly pg: PostgresStorage) { super('/dev/null'); }
  override async upsert(lead: Lead, idempotencyKey?: string): Promise<LeadUpsertResult> {
    const client = await this.pg.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lead.telegramId]);
      const current = await client.query('SELECT payload FROM leads WHERE telegram_id=$1 FOR UPDATE', [lead.telegramId]);
      const created = current.rowCount === 0;
      const existing = current.rows[0]?.payload as Lead | undefined;
      const merged = existing ? mergeLeadRecords(existing, lead) : normalizeLead(lead);
      const hotEscalated = lead.aiLeadScore === 'HOT' && existing?.aiLeadScore !== 'HOT';
      if (idempotencyKey) {
        const result = { lead: merged, created, hotEscalated };
        const claimed = await client.query('INSERT INTO conversation_events(telegram_id,event_type,payload,idempotency_key) VALUES($1,$2,$3,$4) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id', [lead.telegramId, 'telegram_update_claim', { result }, idempotencyKey]);
        if (claimed.rowCount === 0) {
          const priorClaim = await client.query('SELECT payload FROM conversation_events WHERE idempotency_key=$1', [idempotencyKey]);
          await client.query('COMMIT');
          const prior = priorClaim.rows[0]?.payload?.result as LeadUpsertResult | undefined;
          if (!prior?.lead) throw new Error(`Idempotent lead result missing for ${idempotencyKey}.`);
          return prior;
        }
      }
      await writeLead(client, merged);
      await client.query('INSERT INTO conversation_events(telegram_id,event_type,payload,idempotency_key) VALUES($1,$2,$3,$4) ON CONFLICT(idempotency_key) DO NOTHING', [lead.telegramId, created ? 'lead_created' : 'lead_updated', { message: lead.lastMessage, status: merged.status, intent: lead.intent, ai_score: lead.aiLeadScore, ai_reason: lead.aiLeadReason }, `${lead.telegramId}:${lead.updatedAt}:${lead.lastMessage}`]);
      await client.query('COMMIT');
      return { lead: merged, created, hotEscalated };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  override async add(lead: Lead): Promise<void> { await this.upsert(lead); }
  override async getByTelegramId(id: number): Promise<Lead | undefined> { const r = await this.pg.pool.query('SELECT payload FROM leads WHERE telegram_id=$1', [id]); return r.rows[0]?.payload as Lead | undefined; }
  override async updateByTelegramId(id: number, patch: Partial<Lead>, idempotencyKey?: string): Promise<Lead | undefined> {
    const client = await this.pg.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [id]);
      const current = await client.query('SELECT payload FROM leads WHERE telegram_id=$1 FOR UPDATE', [id]);
      const result = current.rowCount ? normalizeLead({ ...(current.rows[0].payload as Lead), ...patch, telegramId: id, updatedAt: new Date().toISOString() }) : undefined;
      if (idempotencyKey) {
        const claimed = await client.query('INSERT INTO conversation_events(telegram_id,event_type,payload,idempotency_key) VALUES($1,$2,$3,$4) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id', [id, 'telegram_admin_claim', { result: result ?? null }, idempotencyKey]);
        if (!claimed.rowCount) {
          const prior = await client.query('SELECT payload FROM conversation_events WHERE idempotency_key=$1', [idempotencyKey]);
          await client.query('COMMIT');
          return (prior.rows[0]?.payload?.result as Lead | null | undefined) ?? undefined;
        }
      }
      if (result) await writeLead(client, result);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  override async all(): Promise<Lead[]> { const r=await this.pg.pool.query('SELECT payload FROM leads ORDER BY created_at DESC'); return r.rows.map(x=>x.payload as Lead); }
  override async today(now=new Date()): Promise<Lead[]> { const start=new Date(now);start.setHours(0,0,0,0);const end=new Date(start);end.setDate(end.getDate()+1);return (await this.all()).filter(x=>new Date(x.createdAt)>=start&&new Date(x.createdAt)<end); }
  override async last(limit=10): Promise<Lead[]> { return (await this.all()).slice(0,limit); }
  override async stats(){const l=await this.all(),now=new Date(),d=new Date(now);d.setDate(d.getDate()-7);return{total:l.length,today:(await this.today(now)).length,last7Days:l.filter(x=>new Date(x.createdAt)>=d).length,hot:l.filter(x=>x.status==='Hot').length,callRequests:l.filter(x=>x.status==='CallRequested').length,completed:l.filter(x=>x.status==='RegistrationCompleted').length,noPhone:l.filter(x=>!x.phone).length};}
  override async toCsv(leads?: Lead[]): Promise<string> { return super.toCsv(leads ?? await this.all()); }
  override async getFunnelEventMetrics(from: Date, toExclusive: Date): Promise<FunnelEventMetrics> {
    const result = await this.pg.pool.query(`
      WITH first_transitions AS (
        SELECT telegram_id,
          min(created_at) FILTER (WHERE event_type = 'lead_created') AS lead_created_at,
          min(created_at) FILTER (WHERE payload->>'ai_score' = 'HOT') AS first_hot_at,
          min(created_at) FILTER (WHERE payload->>'status' = 'RegistrationCompleted') AS first_registration_at
        FROM conversation_events
        WHERE created_at < $2
        GROUP BY telegram_id
      )
      SELECT
        count(*) FILTER (WHERE lead_created_at >= $1 AND lead_created_at < $2)::int AS lead_creations_tracked,
        count(*) FILTER (WHERE first_hot_at >= $1 AND first_hot_at < $2)::int AS hot_escalations,
        count(*) FILTER (WHERE first_registration_at >= $1 AND first_registration_at < $2)::int AS registrations
      FROM first_transitions
    `, [from, toExclusive]);
    return {
      available: true,
      leadCreationsTracked: Number(result.rows[0]?.lead_creations_tracked ?? 0),
      hotEscalations: Number(result.rows[0]?.hot_escalations ?? 0),
      registrations: Number(result.rows[0]?.registrations ?? 0),
    };
  }
}

export class PostgresFollowUpStore extends JsonFollowUpStore {
  constructor(private readonly pg: PostgresStorage) { super('/dev/null'); }
  override async ensure(s: FollowUpState, idempotencyKey?: string): Promise<void> { await this.writeIdempotently(s, idempotencyKey, true); }
  override async upsert(s: FollowUpState, idempotencyKey?: string): Promise<void> { await this.writeIdempotently(s, idempotencyKey, false); }
  override async all():Promise<FollowUpState[]>{const r=await this.pg.pool.query('SELECT payload FROM followups');return r.rows.map(x=>x.payload as FollowUpState);}
  override async claimDelivery(request: FollowUpDeliveryRequest, options: FollowUpClaimOptions): Promise<FollowUpClaimResult> {
    return this.mutateState(request.telegramId, (current) => current
      ? claimFollowUpState(current, request, options, options.now ?? new Date())
      : { ok: false, reason: 'not_found' } as const);
  }
  override async markDeliverySending(claim: FollowUpDeliveryClaim, now = new Date()): Promise<FollowUpState | undefined> {
    return this.mutateState(claim.telegramId, (current) => {
      if (!current || current.followUpId !== claim.followUpId || current.claimToken !== claim.claimToken || current.deliveryState !== 'Claimed') return undefined;
      return pgFollowUpAudit({ ...current, deliveryState: 'Sending' }, 'delivery_send_started', now, current.claimWorkerId);
    });
  }
  override async finishDelivery(claim: FollowUpDeliveryClaim, outcome: FollowUpDeliveryOutcome, now = new Date()): Promise<FollowUpState | undefined> {
    return this.mutateState(claim.telegramId, (current) => {
      if (!current || current.followUpId !== claim.followUpId || current.claimToken !== claim.claimToken || current.deliveryState !== 'Sending') return undefined;
      return finishFollowUpState(current, outcome, now);
    });
  }
  override async cancelDelivery(telegramId: number, reason: string, now = new Date()): Promise<FollowUpState | undefined> {
    return this.mutateState(telegramId, (current) => {
      if (!current || !['Pending', 'Claimed', 'RetryWait'].includes(current.deliveryState ?? 'Pending')) return current;
      return pgFollowUpAudit({ ...pgClearFollowUpClaim(current), deliveryState: 'Cancelled', terminalAt: now.toISOString(), lastError: reason }, 'delivery_cancelled', now, undefined, reason);
    });
  }
  override async abandonDeliveryForShutdown(claim: FollowUpDeliveryClaim, now = new Date()): Promise<FollowUpState | undefined> {
    return this.mutateState(claim.telegramId, (current) => {
      if (!current || current.followUpId !== claim.followUpId || current.claimToken !== claim.claimToken || !['Claimed', 'Sending'].includes(current.deliveryState ?? '')) return undefined;
      return current.deliveryState === 'Sending'
        ? pgFollowUpAudit({ ...pgClearFollowUpClaim(current), deliveryState: 'Uncertain', terminalAt: now.toISOString(), lastError: 'Shutdown drain expired after follow-up send started; outcome requires evidence review.' }, 'shutdown_delivery_uncertain', now, current.claimWorkerId)
        : pgFollowUpAudit({ ...pgClearFollowUpClaim(current), deliveryState: 'RetryWait', nextRetryAt: now.toISOString(), lastError: 'Shutdown drain expired before follow-up send started.' }, 'shutdown_delivery_released_safe', now, current.claimWorkerId);
    });
  }
  override async recoverExpiredDeliveryClaims(now = new Date()): Promise<FollowUpState[]> {
    const candidates = (await this.all()).filter((state) => ['Claimed', 'Sending'].includes(state.deliveryState ?? '') && state.leaseExpiresAt && new Date(state.leaseExpiresAt) <= now);
    const recovered: FollowUpState[] = [];
    for (const candidate of candidates) {
      const updated = await this.mutateState(candidate.telegramId, (current) => {
        if (!current || !['Claimed', 'Sending'].includes(current.deliveryState ?? '') || !current.leaseExpiresAt || new Date(current.leaseExpiresAt) > now) return undefined;
        return current.deliveryState === 'Sending'
          ? pgFollowUpAudit({ ...pgClearFollowUpClaim(current), deliveryState: 'Uncertain', terminalAt: now.toISOString(), lastError: 'Follow-up claim expired after Telegram send started; outcome requires evidence review.' }, 'stale_delivery_uncertain', now, current.claimWorkerId)
          : pgFollowUpAudit({ ...pgClearFollowUpClaim(current), deliveryState: 'RetryWait', nextRetryAt: now.toISOString(), lastError: 'Follow-up claim expired before Telegram send started.' }, 'stale_delivery_recovered_safe', now, current.claimWorkerId);
      });
      if (updated) recovered.push(updated);
    }
    return recovered;
  }
  private async writeIdempotently(s: FollowUpState, idempotencyKey: string | undefined, ensureOnly: boolean): Promise<void> {
    const client = await this.pg.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [s.telegramId]);
      const current = await client.query('SELECT payload FROM followups WHERE telegram_id=$1 FOR UPDATE', [s.telegramId]);
      let merged = normalizeFollowUpState(ensureOnly && current.rowCount ? current.rows[0].payload as FollowUpState : { ...(current.rows[0]?.payload ?? {}), ...s });
      const prior = current.rows[0]?.payload as FollowUpState | undefined;
      if (s.registrationCompleted && prior && ['Pending', 'Claimed', 'RetryWait'].includes(prior.deliveryState ?? 'Pending')) merged = pgFollowUpAudit({ ...pgClearFollowUpClaim(merged), deliveryState: 'Cancelled', terminalAt: new Date().toISOString(), lastError: 'Registration completed before follow-up delivery.' }, 'delivery_cancelled_registration_complete');
      if (idempotencyKey) {
        const claimed = await client.query('INSERT INTO conversation_events(telegram_id,event_type,payload,idempotency_key) VALUES($1,$2,$3,$4) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id', [s.telegramId, 'telegram_followup_claim', { result: merged }, idempotencyKey]);
        if (!claimed.rowCount) { await client.query('COMMIT'); return; }
      }
      if (!ensureOnly || !current.rowCount) await client.query('INSERT INTO followups(telegram_id,payload,count,last_sent_at,updated_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(telegram_id) DO UPDATE SET payload=EXCLUDED.payload,count=EXCLUDED.count,last_sent_at=EXCLUDED.last_sent_at,updated_at=now()', [s.telegramId, merged, merged.count, merged.lastSentAt ?? null]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  private async mutateState<T>(telegramId: number, operation: (current: FollowUpState | undefined) => T): Promise<T> {
    const client = await this.pg.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [telegramId]);
      const row = await client.query('SELECT payload FROM followups WHERE telegram_id=$1 FOR UPDATE', [telegramId]);
      const current = row.rowCount ? normalizeFollowUpState(row.rows[0].payload as FollowUpState) : undefined;
      const result = operation(current);
      const updated = result && typeof result === 'object' && 'state' in result && (result as { state?: FollowUpState }).state
        ? (result as { state: FollowUpState }).state
        : isFollowUpState(result) ? result : undefined;
      if (updated) await client.query('UPDATE followups SET payload=$2,count=$3,last_sent_at=$4,updated_at=now() WHERE telegram_id=$1', [telegramId, updated, updated.count, updated.lastSentAt ?? null]);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}

function isFollowUpState(value: unknown): value is FollowUpState { return Boolean(value && typeof value === 'object' && 'telegramId' in value && 'startedAt' in value && 'count' in value); }
function pgClearFollowUpClaim(state: FollowUpState): FollowUpState { return { ...state, claimToken: undefined, claimWorkerId: undefined, claimedAt: undefined, leaseExpiresAt: undefined }; }
function pgFollowUpAudit(state: FollowUpState, event: string, now = new Date(), workerId?: string, reason?: string): FollowUpState { return { ...state, audit: [...(state.audit ?? []), { at: now.toISOString(), event, workerId, followUpId: state.followUpId, reason }].slice(-100) }; }

async function importJson(c:PoolClient,leadsFile:string,followupsFile:string){for(const lead of await jsonArray<Lead>(leadsFile,'leads'))await c.query('INSERT INTO leads(telegram_id,payload,status,source,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[lead.telegramId,normalizeLead(lead),lead.status,lead.source??'unknown',lead.createdAt,lead.updatedAt??lead.createdAt]);for(const f of await jsonArray<FollowUpState>(followupsFile,'followups'))await c.query('INSERT INTO followups(telegram_id,payload,count,last_sent_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[f.telegramId,f,f.count,f.lastSentAt??null]);}
async function jsonArray<T>(file:string,key:string):Promise<T[]>{try{const x=JSON.parse(await readFile(file,'utf8')) as Record<string,T[]>;return Array.isArray(x[key])?x[key]:[];}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return[];throw e;}}
async function writeLead(c:PoolClient,l:Lead){await c.query('INSERT INTO leads(telegram_id,payload,status,source,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(telegram_id) DO UPDATE SET payload=EXCLUDED.payload,status=EXCLUDED.status,source=EXCLUDED.source,updated_at=EXCLUDED.updated_at',[l.telegramId,l,l.status,l.source,l.createdAt,l.updatedAt]);}
function normalizeLead(l:Lead):Lead{return{...l,updatedAt:l.updatedAt??l.createdAt,city:l.city??'',workStatus:l.workStatus??'',goal:l.goal??'',paymentOption:l.paymentOption??'',status:(l.status as LeadStatus)??'New',source:l.source??'unknown',intent:l.intent??'',lastMessage:l.lastMessage??l.notes??'',messages:l.messages??[],operatorNote:l.operatorNote??'',nextFollowUp:l.nextFollowUp??'',paymentStatus:l.paymentStatus??'',preferredTime:l.preferredTime??'',phone:l.phone??'',age:l.age??'',experience:l.experience??'',fullName:l.fullName??''};}
