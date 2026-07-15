import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { planSyntheticLeadCreatedEvents, runPostgresLeadCreationBackfill } from '../src/backfillEvents.js';

test('JSON lead evidence creates deterministic non-inferred lead_created events only', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wst-backfill-json-'));
  const file = path.join(dir, 'leads.json');
  await writeFile(file, JSON.stringify({ leads: [
    { telegramId: 22, createdAt: '2026-07-12T10:00:00.000Z', status: 'Hot', aiLeadScore: 'HOT' },
    { telegramId: 11, createdAt: '2026-07-11T10:00:00.000Z', status: 'RegistrationCompleted' },
  ] }));
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { leads: Array<{ telegramId: number; createdAt: string }> };
  const first = planSyntheticLeadCreatedEvents(parsed.leads);
  const second = planSyntheticLeadCreatedEvents(parsed.leads);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((event) => event.telegramId), [11, 22]);
  assert.ok(first.every((event) => event.eventType === 'lead_created' && event.payload.inferred === false));
  assert.ok(first.every((event) => !('status' in event.payload) && !('aiLeadScore' in event.payload)));
  assert.throws(() => planSyntheticLeadCreatedEvents([{ telegramId: 1, createdAt: 'not-a-date' }]), /Invalid createdAt/);
});

const url = process.env.TEST_DATABASE_URL;
test('PostgreSQL backfill defaults to dry-run, applies transactionally and is idempotent', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url, max: 2 });
  const id = 980_000_000 + Math.floor(Math.random() * 1_000_000);
  const createdAt = '2026-07-10T05:00:00.000Z';
  const backupDir = await mkdtemp(path.join(tmpdir(), 'wst-backfill-pg-'));
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS leads (telegram_id bigint PRIMARY KEY, payload jsonb NOT NULL, status text NOT NULL, source text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS conversation_events (id bigserial PRIMARY KEY, telegram_id bigint NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb, idempotency_key text UNIQUE, created_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query('INSERT INTO leads(telegram_id,payload,status,source,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)', [id, { telegramId: id, createdAt }, 'Hot', 'unknown', createdAt]);
    const dry = await runPostgresLeadCreationBackfill({ pool, apply: false, backupDir });
    assert.equal(dry.mode, 'dry-run');
    assert.equal(dry.inserted, 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM conversation_events WHERE telegram_id=$1', [id])).rows[0].n, 0);
    const applied = await runPostgresLeadCreationBackfill({ pool, apply: true, backupDir, now: new Date('2026-07-15T10:00:00.000Z') });
    assert.equal(applied.inserted, 1);
    const row = (await pool.query('SELECT event_type,payload,created_at,idempotency_key FROM conversation_events WHERE telegram_id=$1', [id])).rows[0];
    assert.equal(row.event_type, 'lead_created');
    assert.equal(row.created_at.toISOString(), createdAt);
    assert.equal(row.payload.provenance, 'synthetic_backfill_v1');
    assert.equal(row.payload.inferred, false);
    assert.match(row.idempotency_key, /^backfill:v1:lead_created:/);
    assert.ok(applied.backupPath);
    const again = await runPostgresLeadCreationBackfill({ pool, apply: true, backupDir, now: new Date('2026-07-15T10:00:01.000Z') });
    assert.equal(again.planned, 0);
    assert.equal(again.inserted, 0);
  } finally {
    await pool.query('DELETE FROM conversation_events WHERE telegram_id=$1', [id]).catch(() => undefined);
    await pool.query('DELETE FROM leads WHERE telegram_id=$1', [id]).catch(() => undefined);
    await pool.end();
  }
});
