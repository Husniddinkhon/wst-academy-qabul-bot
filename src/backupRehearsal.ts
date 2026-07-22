import { loadConfig } from './config.js';
import { discoverBackups, computeManifest, verifyManifest, copyToOffHost, restoreFromOffHost, cleanupRestore } from './backupManifest.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';

function getBackupKey(config: { backupEncryptionKey?: string }): string {
  const hex = config.backupEncryptionKey;
  if (!hex) throw new Error('ACADEMY_BACKUP_KEY is required');
  return hex;
}

async function cmdDiscover(dataDir: string, migrationDir: string): Promise<void> {
  const entries = await discoverBackups(dataDir, migrationDir);
  const manifest = computeManifest(entries, hostname());
  console.log(JSON.stringify(manifest, null, 2));
}

async function cmdVerify(dataDir: string, migrationDir: string): Promise<void> {
  const entries = await discoverBackups(dataDir, migrationDir);
  const manifest = computeManifest(entries, hostname());
  const result = await verifyManifest(manifest);
  if (result.ok) {
    console.log(`All ${manifest.entryCount} backups verified OK (total ${(manifest.totalSize / 1024).toFixed(1)} KB)`);
  } else {
    for (const err of result.errors) console.error(`FAIL: ${err}`);
    process.exitCode = 1;
  }
}

async function cmdOffHost(dataDir: string, migrationDir: string, offHostDir: string, config: { backupEncryptionKey?: string }): Promise<void> {
  const key = getBackupKey(config);
  const entries = await discoverBackups(dataDir, migrationDir);
  const manifest = computeManifest(entries, hostname());
  const result = await verifyManifest(manifest);
  if (!result.ok) {
    for (const err of result.errors) console.error(`Pre-copy verify FAIL: ${err}`);
    process.exitCode = 1;
    return;
  }
  await copyToOffHost(entries, offHostDir, key);
  console.log(`Copied ${manifest.entryCount} encrypted backups to ${offHostDir}`);
  console.log(`Manifest checksum: ${manifest.hash.slice(0, 16)}...`);
}

async function cmdRehearse(offHostDir: string, restoreRoot: string, config: { backupEncryptionKey?: string }): Promise<void> {
  const key = getBackupKey(config);
  const report = await restoreFromOffHost(offHostDir, restoreRoot, key);
  console.log(`Restored ${report.restored.length} entries in ${report.rtoMs}ms`);
  console.log(`All OK: ${report.allOk}`);
  if (!report.allOk) {
    for (const r of report.restored) {
      if (!r.ok) console.error(`  FAIL: ${r.entry.sourceName} gen ${r.entry.generation}: ${r.error}`);
    }
    process.exitCode = 1;
  }
}

async function cmdFullRehearse(dataDir: string, migrationDir: string, offHostDir: string, config: { backupEncryptionKey?: string }): Promise<void> {
  const key = getBackupKey(config);
  console.log('Phase 1: Discovering backups...');
  const entries = await discoverBackups(dataDir, migrationDir);
  console.log(`  Found ${entries.length} backup artifacts`);

  console.log('Phase 2: Creating checksummed manifest...');
  const manifest = computeManifest(entries, hostname());

  console.log('Phase 3: Verifying local backup integrity...');
  const verifyResult = await verifyManifest(manifest);
  if (!verifyResult.ok) {
    for (const err of verifyResult.errors) console.error(`  FAIL: ${err}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  All ${manifest.entryCount} entries verified (${(manifest.totalSize / 1024).toFixed(1)} KB)`);

  console.log('Phase 4: Encrypting and copying to off-host...');
  await copyToOffHost(entries, offHostDir, key);
  console.log(`  Stored at: ${offHostDir}`);

  console.log('Phase 5: Isolated restore rehearsal...');
  const restoreRoot = path.join(mkdtempSync(path.join(tmpdir(), 'backup-restore-')), 'restored');
  const start = Date.now();
  const report = await restoreFromOffHost(offHostDir, restoreRoot, key);
  const rto = Date.now() - start;
  await cleanupRestore(restoreRoot);

  if (report.allOk) {
    console.log(`  SUCCESS: ${report.restored.length}/${report.restored.length} entries restored and verified`);
    console.log(`  RTO: ${rto}ms`);
    console.log(`  RPO: all entries match their on-disk SHA-256 (point-in-time: ${manifest.createdAt})`);
    console.log(`  Manifest checksum: ${manifest.hash.slice(0, 16)}...`);
    console.log(`\nBackup rehearsal PASSED`);
  } else {
    for (const r of report.restored) {
      if (!r.ok) console.error(`  FAIL: ${r.entry.sourceName} gen ${r.entry.generation}: ${r.error}`);
    }
    process.exitCode = 1;
  }
}

const USAGE = `
Usage: tsx src/backupRehearsal.ts <command> [options]

Commands:
  discover              Create checksummed manifest of all backup artifacts
  verify                Verify local backup integrity
  offhost <dir>         Encrypt and copy backups to off-host directory
  rehearse <dir> <out>  Restore and verify from off-host directory
  full <dir>            Run full rehearsal (discover -> verify -> offhost -> restore)
  help                  Show this help
`;

async function main(): Promise<void> {
  const config = loadConfig();
  const dataDir = path.resolve(path.dirname(config.leadsFile));
  const migrationDir = path.resolve('data/migrations');
  const cmd = process.argv[2];

  switch (cmd) {
    case 'discover': await cmdDiscover(dataDir, migrationDir); break;
    case 'verify': await cmdVerify(dataDir, migrationDir); break;
    case 'offhost': {
      const dir = process.argv[3];
      if (!dir) { console.error('Usage: tsx src/backupRehearsal.ts offhost <dir>'); process.exitCode = 1; break; }
      await cmdOffHost(dataDir, migrationDir, dir, config); break;
    }
    case 'rehearse': {
      const dir = process.argv[3];
      const out = process.argv[4] || path.join(mkdtempSync(path.join(tmpdir(), 'backup-restore-')), 'restored');
      if (!dir) { console.error('Usage: tsx src/backupRehearsal.ts rehearse <dir> [restore-path]'); process.exitCode = 1; break; }
      await cmdRehearse(dir, out, config); break;
    }
    case 'full': {
      const dir = process.argv[3];
      if (!dir) { console.error('Usage: tsx src/backupRehearsal.ts full <dir>'); process.exitCode = 1; break; }
      await cmdFullRehearse(dataDir, migrationDir, dir, config); break;
    }
    default:
      console.log(USAGE);
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
