import 'dotenv/config';
import { Pool } from 'pg';
import { runPostgresLeadCreationBackfill } from './backfillEvents.js';

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) if (arg !== '--apply') throw new Error(`Unknown argument: ${arg}. Only --apply is supported.`);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await runPostgresLeadCreationBackfill({
      pool,
      apply: args.has('--apply'),
      backupDir: process.env.BACKFILL_BACKUP_DIR || './backups',
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
