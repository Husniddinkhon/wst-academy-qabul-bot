import { loadConfig } from './config.js';
import { MigrationEngine, type StoreMigrationHandler } from './migrationEngine.js';
import { JsonApplicantIdentityStore, APPLICANT_IDENTITY_SCHEMA_VERSION } from './applicantIdentity.js';
import { JsonAuthorizationStore, AUTHORIZATION_SCHEMA_VERSION } from './authorization.js';
import { PostgresStorage, SCHEMA_VERSION as POSTGRES_SCHEMA_VERSION } from './postgres.js';
import { authorizationCallbackSecret } from './authorization.js';

const COMMANDS = ['inspect', 'plan', 'migrate', 'verify', 'rollback', 'status', 'help'] as const;
type Command = typeof COMMANDS[number];

function usage(): void {
  console.log(`Usage: node dist/migrationCli.js <command> [options]

Commands:
  inspect              Show current schema versions for all stores
  plan                 Show what migrations need to run
  migrate [--apply]    Dry-run migration (default) or apply with --apply
  verify               Verify all stores are at expected versions
  status               Show full migration status
  rollback <id>        Rollback a specific migration
  help                 Show this help
`);
}

async function createEngine(): Promise<MigrationEngine> {
  const config = loadConfig();
  const engine = new MigrationEngine('data/migrations');
  const postgres = config.databaseUrl ? new PostgresStorage(config.databaseUrl) : undefined;

  engine.register({
    name: 'postgres',
    filePath: config.databaseUrl ?? 'postgres://',
    currentVersion: POSTGRES_SCHEMA_VERSION,
    detectVersion: async () => postgres ? await postgres.detectVersion() : null,
    migrate: async (dryRun) => {
      if (!postgres) return null;
      return await postgres.migrateStore(dryRun, config.leadsFile, config.followupsFile);
    },
    rollback: async (backupPath) => {
      if (!postgres) return;
      await postgres.rollbackStore(backupPath);
    },
    verify: async () => {
      if (!postgres) return { ok: true, errors: [] };
      return await postgres.verifyStore();
    },
  });

  const identities = new JsonApplicantIdentityStore(config.applicantIdentitiesFile);
  engine.register({
    name: 'applicant-identity',
    filePath: config.applicantIdentitiesFile,
    currentVersion: APPLICANT_IDENTITY_SCHEMA_VERSION,
    detectVersion: async () => identities.detectVersion(),
    migrate: async (dryRun) => identities.migrateStore(dryRun),
    rollback: async (backupPath) => identities.rollbackStore(backupPath),
    verify: async () => identities.verifyStore(),
  });

  const authorization = new JsonAuthorizationStore(config.authorizationFile, authorizationCallbackSecret(config.botToken));
  engine.register({
    name: 'authorization',
    filePath: config.authorizationFile,
    currentVersion: AUTHORIZATION_SCHEMA_VERSION,
    detectVersion: async () => authorization.detectVersion(),
    migrate: async (dryRun) => authorization.migrateStore(dryRun),
    rollback: async (backupPath) => authorization.rollbackStore(backupPath),
    verify: async () => authorization.verifyStore(),
  });

  return engine;
}

async function cmdInspect(engine: MigrationEngine): Promise<void> {
  const results = await engine.inspect();
  console.log('Store                    Current  Detected  Needs Migration');
  console.log('───────────────────────────────────────────────────────────');
  for (const r of results) {
    const needs = r.needsMigration ? 'YES' : 'no';
    const detected = r.detectedVersion !== null ? String(r.detectedVersion) : 'none';
    console.log(`${r.name.padEnd(24)} v${r.currentVersion}    ${detected.padEnd(8)} ${needs}`);
  }
}

async function cmdPlan(engine: MigrationEngine): Promise<void> {
  const plans = await engine.plan();
  if (plans.length === 0) {
    console.log('All stores are up to date. No migrations needed.');
    return;
  }
  console.log('Planned migrations:');
  console.log('Store                    From     To');
  console.log('─────────────────────────────────────');
  for (const p of plans) {
    const from = p.fromVersion !== null ? `v${p.fromVersion}` : 'new';
    console.log(`${p.store.padEnd(24)} ${from.padEnd(7)} v${p.toVersion}`);
  }
  console.log(`\nRun: node dist/migrationCli.js migrate --apply`);
}

async function cmdMigrate(engine: MigrationEngine, apply: boolean): Promise<void> {
  const plans = await engine.plan();
  if (plans.length === 0) {
    console.log('All stores are up to date. Nothing to migrate.');
    return;
  }

  console.log(`\nPlanned migrations (${plans.length}):`);
  for (const plan of plans) {
    const from = plan.fromVersion !== null ? `v${plan.fromVersion}` : 'new';
    console.log(`  [${plan.store}] ${from} -> v${plan.toVersion}`);
  }

  if (!apply) {
    console.log(`\nDry-run complete. To apply: node dist/migrationCli.js migrate --apply`);
    return;
  }

  console.log(`\nApplying migrations...`);
  for (const plan of plans) {
    const from = plan.fromVersion !== null ? `v${plan.fromVersion}` : 'new';
    console.log(`\n[${plan.store}] Migrating from ${from} to v${plan.toVersion}...`);
    try {
      const manifest = await engine.execute(plan);
      console.log(`  OK — migration ${manifest.migrationId} completed.`);
      console.log(`  Backup stored in manifest.`);
    } catch (error) {
      console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }
}

async function cmdVerify(engine: MigrationEngine): Promise<void> {
  const result = await engine.verify();
  for (const r of result.results) {
    const status = r.ok ? 'OK' : 'FAIL';
    console.log(`[${status}] ${r.store}: ${r.errors.length ? r.errors.join('; ') : 'verified'}`);
  }
  if (!result.ok) {
    console.log('\nVerification FAILED. Some stores need attention.');
    process.exit(1);
  }
}

async function cmdStatus(engine: MigrationEngine): Promise<void> {
  const statuses = await engine.status();
  console.log('Store                    Version    Detected   Needs Migr  Last Migration');
  console.log('────────────────────────────────────────────────────────────────────────────');
  for (const s of statuses) {
    const needs = s.needsMigration ? 'YES    ' : 'no     ';
    const last = s.lastMigration ? `${s.lastMigration.state} ${s.lastMigration.completedAt?.slice(0, 10) ?? ''}` : 'none';
    const detected = s.detectedVersion !== null ? `v${s.detectedVersion}` : 'none';
    console.log(`${s.name.padEnd(24)} v${s.currentVersion}    ${detected.padEnd(8)} ${needs} ${last}`);
  }

  const compat = await engine.verifyStartupCompatibility();
  if (!compat.ok) {
    console.log('\nStartup compatibility check FAILED:');
    for (const line of compat.guidance) console.log(`  ${line}`);
    console.log('\nRun: node dist/migrationCli.js migrate --apply');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] as Command | undefined;

  if (!command || command === 'help' || !COMMANDS.includes(command)) {
    usage();
    process.exit(command && command !== 'help' ? 1 : 0);
  }

  const engine = await createEngine();

  switch (command) {
    case 'inspect':
      await cmdInspect(engine);
      break;
    case 'plan':
      await cmdPlan(engine);
      break;
    case 'migrate': {
      const apply = args.includes('--apply');
      await cmdMigrate(engine, apply);
      break;
    }
    case 'verify':
      await cmdVerify(engine);
      break;
    case 'status':
      await cmdStatus(engine);
      break;
    case 'rollback': {
      const id = args[1];
      if (!id) { console.error('Usage: node dist/migrationCli.js rollback <migration-id>'); process.exit(1); }
      await engine.rollback(id);
      console.log(`Rollback of ${id} completed.`);
      break;
    }
  }
}

main().catch((error) => {
  console.error('Migration CLI failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
