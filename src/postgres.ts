import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { JsonFollowUpStore, JsonLeadStore, mergeLeadRecords, type LeadUpsertResult } from './storage.js';
import type { FollowUpState, Lead, LeadStatus } from './types.js';

export const SCHEMA_VERSION = 1;

export class PostgresStorage {
  readonly pool: Pool;
  constructor(databaseUrl: string) { this.pool = new Pool({ connectionString: databaseUrl, max: 10 }); }

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
  override async upsert(lead: Lead): Promise<LeadUpsertResult> {
    const client = await this.pg.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT payload FROM leads WHERE telegram_id=$1 FOR UPDATE', [lead.telegramId]);
      const created = current.rowCount === 0;
      const existing = current.rows[0]?.payload as Lead | undefined;
      const merged = existing ? mergeLeadRecords(existing, lead) : normalizeLead(lead);
      const hotEscalated = lead.aiLeadScore === 'HOT' && existing?.aiLeadScore !== 'HOT';
      await writeLead(client, merged);
      await client.query('INSERT INTO conversation_events(telegram_id,event_type,payload,idempotency_key) VALUES($1,$2,$3,$4) ON CONFLICT(idempotency_key) DO NOTHING', [lead.telegramId, created ? 'lead_created' : 'lead_updated', { message: lead.lastMessage, status: merged.status, intent: lead.intent, ai_score: lead.aiLeadScore, ai_reason: lead.aiLeadReason }, `${lead.telegramId}:${lead.updatedAt}:${lead.lastMessage}`]);
      await client.query('COMMIT');
      return { lead: merged, created, hotEscalated };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  override async add(lead: Lead): Promise<void> { await this.upsert(lead); }
  override async getByTelegramId(id: number): Promise<Lead | undefined> { const r = await this.pg.pool.query('SELECT payload FROM leads WHERE telegram_id=$1', [id]); return r.rows[0]?.payload as Lead | undefined; }
  override async updateByTelegramId(id: number, patch: Partial<Lead>): Promise<Lead | undefined> {
    const client = await this.pg.pool.connect(); try { await client.query('BEGIN'); const r = await client.query('SELECT payload FROM leads WHERE telegram_id=$1 FOR UPDATE',[id]); if (!r.rowCount) { await client.query('ROLLBACK'); return undefined; } const lead=normalizeLead({...(r.rows[0].payload as Lead),...patch,telegramId:id,updatedAt:new Date().toISOString()}); await writeLead(client,lead); await client.query('COMMIT'); return lead; } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
  }
  override async all(): Promise<Lead[]> { const r=await this.pg.pool.query('SELECT payload FROM leads ORDER BY created_at DESC'); return r.rows.map(x=>x.payload as Lead); }
  override async today(now=new Date()): Promise<Lead[]> { const start=new Date(now);start.setHours(0,0,0,0);const end=new Date(start);end.setDate(end.getDate()+1);return (await this.all()).filter(x=>new Date(x.createdAt)>=start&&new Date(x.createdAt)<end); }
  override async last(limit=10): Promise<Lead[]> { return (await this.all()).slice(0,limit); }
  override async stats(){const l=await this.all(),now=new Date(),d=new Date(now);d.setDate(d.getDate()-7);return{total:l.length,today:(await this.today(now)).length,last7Days:l.filter(x=>new Date(x.createdAt)>=d).length,hot:l.filter(x=>x.status==='Hot').length,callRequests:l.filter(x=>x.status==='CallRequested').length,completed:l.filter(x=>x.status==='RegistrationCompleted').length,noPhone:l.filter(x=>!x.phone).length};}
  override async toCsv(leads?: Lead[]): Promise<string> { return super.toCsv(leads ?? await this.all()); }
}

export class PostgresFollowUpStore extends JsonFollowUpStore {
  constructor(private readonly pg: PostgresStorage) { super('/dev/null'); }
  override async ensure(s:FollowUpState){await this.pg.pool.query('INSERT INTO followups(telegram_id,payload,count,last_sent_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[s.telegramId,s,s.count,s.lastSentAt??null]);}
  override async upsert(s:FollowUpState){const c=await this.pg.pool.connect();try{await c.query('BEGIN');const r=await c.query('SELECT payload FROM followups WHERE telegram_id=$1 FOR UPDATE',[s.telegramId]);const merged={...(r.rows[0]?.payload??{}),...s};await c.query('INSERT INTO followups(telegram_id,payload,count,last_sent_at,updated_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(telegram_id) DO UPDATE SET payload=EXCLUDED.payload,count=EXCLUDED.count,last_sent_at=EXCLUDED.last_sent_at,updated_at=now()',[s.telegramId,merged,merged.count,merged.lastSentAt??null]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
  override async all():Promise<FollowUpState[]>{const r=await this.pg.pool.query('SELECT payload FROM followups');return r.rows.map(x=>x.payload as FollowUpState);}
}

async function importJson(c:PoolClient,leadsFile:string,followupsFile:string){for(const lead of await jsonArray<Lead>(leadsFile,'leads'))await c.query('INSERT INTO leads(telegram_id,payload,status,source,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[lead.telegramId,normalizeLead(lead),lead.status,lead.source??'unknown',lead.createdAt,lead.updatedAt??lead.createdAt]);for(const f of await jsonArray<FollowUpState>(followupsFile,'followups'))await c.query('INSERT INTO followups(telegram_id,payload,count,last_sent_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[f.telegramId,f,f.count,f.lastSentAt??null]);}
async function jsonArray<T>(file:string,key:string):Promise<T[]>{try{const x=JSON.parse(await readFile(file,'utf8')) as Record<string,T[]>;return Array.isArray(x[key])?x[key]:[];}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return[];throw e;}}
async function writeLead(c:PoolClient,l:Lead){await c.query('INSERT INTO leads(telegram_id,payload,status,source,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(telegram_id) DO UPDATE SET payload=EXCLUDED.payload,status=EXCLUDED.status,source=EXCLUDED.source,updated_at=EXCLUDED.updated_at',[l.telegramId,l,l.status,l.source,l.createdAt,l.updatedAt]);}
function normalizeLead(l:Lead):Lead{return{...l,updatedAt:l.updatedAt??l.createdAt,city:l.city??'',workStatus:l.workStatus??'',goal:l.goal??'',paymentOption:l.paymentOption??'',status:(l.status as LeadStatus)??'New',source:l.source??'unknown',intent:l.intent??'',lastMessage:l.lastMessage??l.notes??'',messages:l.messages??[],operatorNote:l.operatorNote??'',nextFollowUp:l.nextFollowUp??'',paymentStatus:l.paymentStatus??'',preferredTime:l.preferredTime??'',phone:l.phone??'',age:l.age??'',experience:l.experience??'',fullName:l.fullName??''};}
