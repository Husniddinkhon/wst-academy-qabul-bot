import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readJson } from './safeJson.js';

export type MigrationState = 'pending' | 'running' | 'completed' | 'failed' | 'rolled_back';

export interface MigrationManifest {
  schemaVersion: number;
  migrationId: string;
  plan: MigrationPlanEntry[];
  startedAt: string;
  completedAt?: string;
  state: MigrationState;
  rolledBackAt?: string;
  hash?: string;
}

export interface MigrationPlanEntry {
  store: string;
  fromVersion: number | null;
  toVersion: number;
  backupPath?: string;
  state: MigrationState;
}

export interface BackupSnapshot {
  store: string;
  filePath: string;
  backupPath: string;
  contentHash: string;
  size: number;
  backedUpAt: string;
}

export interface MigrationLock {
  lockPath: string;
  token: string;
  acquiredAt: string;
}

export interface StoreMigrationHandler {
  name: string;
  filePath: string;
  currentVersion: number;
  detectVersion(): Promise<number | null>;
  migrate(dryRun: boolean): Promise<{ backupHash: string; backupPath: string } | null>;
  rollback(backupPath: string): Promise<void>;
  verify(): Promise<{ ok: boolean; errors: string[] }>;
}

export interface MigrationPlan {
  store: string;
  fromVersion: number | null;
  toVersion: number;
  handler: StoreMigrationHandler;
}

export class MigrationEngine {
  private readonly handlers = new Map<string, StoreMigrationHandler>();
  private manifestPath: string;

  constructor(private readonly migrationDir: string) {
    this.manifestPath = path.join(migrationDir, 'manifest.json');
  }

  register(handler: StoreMigrationHandler): void {
    this.handlers.set(handler.name, handler);
  }

  async inspect(): Promise<{ name: string; currentVersion: number; detectedVersion: number | null; needsMigration: boolean }[]> {
    const results: { name: string; currentVersion: number; detectedVersion: number | null; needsMigration: boolean }[] = [];
    for (const handler of this.handlers.values()) {
      const detected = await handler.detectVersion();
      const needsMigration = detected === null || detected < handler.currentVersion;
      results.push({ name: handler.name, currentVersion: handler.currentVersion, detectedVersion: detected, needsMigration });
    }
    return results;
  }

  async plan(): Promise<MigrationPlan[]> {
    const plans: MigrationPlan[] = [];
    for (const handler of this.handlers.values()) {
      const detected = await handler.detectVersion();
      if (detected === null || detected < handler.currentVersion) {
        plans.push({ store: handler.name, fromVersion: detected, toVersion: handler.currentVersion, handler });
      }
    }
    return plans;
  }

  async execute(plan: MigrationPlan): Promise<MigrationManifest> {
    const migrationId = randomUUID();
    const startedAt = new Date().toISOString();
    const entry: MigrationPlanEntry = {
      store: plan.store, fromVersion: plan.fromVersion, toVersion: plan.toVersion, state: 'pending',
    };
    const manifest: MigrationManifest = {
      schemaVersion: 1, migrationId, plan: [entry], startedAt, state: 'running',
    };
    await this.ensureManifestDir();
    await this.writeManifest(manifest);

    try {
      entry.state = 'running';
      await this.writeManifest(manifest);
      const result = await plan.handler.migrate(false);
      entry.state = 'completed';
      entry.backupPath = result?.backupPath;
      manifest.completedAt = new Date().toISOString();
      manifest.state = 'completed';
      manifest.hash = this.hashManifest(manifest);
      await this.writeManifest(manifest);
    } catch (error) {
      entry.state = 'failed';
      manifest.state = 'failed';
      manifest.completedAt = new Date().toISOString();
      manifest.hash = this.hashManifest(manifest);
      await this.writeManifest(manifest);
      throw new MigrationError(`Migration failed for ${plan.store}: ${error instanceof Error ? error.message : String(error)}`, migrationId);
    }
    return manifest;
  }

  async executeAll(): Promise<MigrationManifest[]> {
    const plans = await this.plan();
    const results: MigrationManifest[] = [];
    for (const plan of plans) {
      const manifest = await this.execute(plan);
      results.push(manifest);
    }
    return results;
  }

  async rollback(migrationId: string): Promise<void> {
    const manifest = await this.readManifest(migrationId);
    if (!manifest) throw new MigrationError(`Migration ${migrationId} not found.`, migrationId);
    if (manifest.state !== 'completed') throw new MigrationError(`Cannot rollback migration in state: ${manifest.state}.`, migrationId);

    for (const entry of manifest.plan) {
      if (entry.state !== 'completed') continue;
      const handler = this.handlers.get(entry.store);
      if (!handler) throw new MigrationError(`Handler not found for store: ${entry.store}`, migrationId);
      if (!entry.backupPath) throw new MigrationError(`No backup available for ${entry.store}.`, migrationId);
      const planEntry = manifest.plan.find((e) => e.store === entry.store);
      if (!planEntry?.backupPath) throw new MigrationError(`No backup path for ${entry.store}.`, migrationId);
      const backupContent = await readFile(planEntry.backupPath, 'utf8').catch(() => { throw new MigrationError(`Backup file missing: ${planEntry.backupPath}`, migrationId); });
      const expectedHash = planEntry.backupPath.endsWith('.empty') ? undefined : createHash('sha256').update(backupContent, 'utf8').digest('hex');
      await handler.rollback(planEntry.backupPath);
      entry.state = 'rolled_back';
    }
    manifest.state = 'rolled_back';
    manifest.rolledBackAt = new Date().toISOString();
    manifest.hash = this.hashManifest(manifest);
    await this.writeManifest(manifest);
  }

  async verify(): Promise<{ ok: boolean; results: { store: string; ok: boolean; errors: string[] }[] }> {
    const results: { store: string; ok: boolean; errors: string[] }[] = [];
    let allOk = true;
    for (const handler of this.handlers.values()) {
      const result = await handler.verify();
      if (!result.ok) allOk = false;
      results.push({ store: handler.name, ...result });
    }
    return { ok: allOk, results };
  }

  async status(): Promise<{ name: string; currentVersion: number; detectedVersion: number | null; needsMigration: boolean; lastMigration?: { id: string; state: MigrationState; completedAt?: string } }[]> {
    const inspects = await this.inspect();
    const completedManifests = await this.listCompletedManifests();
    return inspects.map((inspect) => {
      const last = completedManifests.find((m) => m.plan.some((e) => e.store === inspect.name && e.state === 'completed'));
      return {
        ...inspect,
        lastMigration: last ? { id: last.migrationId, state: last.state, completedAt: last.completedAt } : undefined,
      };
    });
  }

  async verifyStartupCompatibility(): Promise<{ ok: boolean; guidance: string[] }> {
    const errors: string[] = [];
    for (const handler of this.handlers.values()) {
      const detected = await handler.detectVersion();
      if (detected === null) {
        errors.push(`[${handler.name}] No data found — will be initialized on first write (fresh deployment).`);
      } else if (detected < handler.currentVersion) {
        errors.push(`[${handler.name}] Schema version ${detected} < current ${handler.currentVersion}. MIGRATION REQUIRED. Run: node dist/migrationCli.js migrate`);
      } else if (detected > handler.currentVersion) {
        errors.push(`[${handler.name}] Schema version ${detected} > current ${handler.currentVersion}. UNSUPPORTED — this binary cannot read this data.`);
      }
    }
    const blockStartup = errors.some((e) => e.includes('MIGRATION REQUIRED') || e.includes('UNSUPPORTED'));
    return { ok: !blockStartup, guidance: errors };
  }

  private async ensureManifestDir(): Promise<void> {
    await mkdir(this.migrationDir, { recursive: true });
    await chmod(this.migrationDir, 0o700);
  }

  private async writeManifest(manifest: MigrationManifest): Promise<void> {
    const filePath = path.join(this.migrationDir, `${manifest.migrationId}.json`);
    await writeFile(filePath, JSON.stringify(manifest, null, 2), 'utf8');
    await chmod(filePath, 0o600);
  }

  private async readManifest(migrationId: string): Promise<MigrationManifest | undefined> {
    const filePath = path.join(this.migrationDir, `${migrationId}.json`);
    try {
      const content = await readFile(filePath, 'utf8');
      return JSON.parse(content) as MigrationManifest;
    } catch {
      return undefined;
    }
  }

  private async listCompletedManifests(): Promise<MigrationManifest[]> {
    const { readdir } = await import('node:fs/promises');
    try {
      const files = await readdir(this.migrationDir);
      const manifests: MigrationManifest[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = await readFile(path.join(this.migrationDir, file), 'utf8');
          const manifest = JSON.parse(content) as MigrationManifest;
          if (manifest.state === 'completed') manifests.push(manifest);
        } catch { }
      }
      manifests.sort((a, b) => new Date(a.completedAt ?? a.startedAt).getTime() - new Date(b.completedAt ?? b.startedAt).getTime());
      return manifests;
    } catch {
      return [];
    }
  }

  private hashManifest(manifest: MigrationManifest): string {
    return createHash('sha256').update(JSON.stringify(manifest), 'utf8').digest('hex').slice(0, 16);
  }
}

export class MigrationError extends Error {
  constructor(message: string, public readonly migrationId: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export class MigrationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationRequiredError';
  }
}

export async function peekJsonSchemaVersion(filePath: string, normalizeVersion?: (raw: Record<string, unknown>) => number | null): Promise<number | null> {
  try {
    const raw = await readJson<Record<string, unknown>>(filePath, {});
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const sv = (raw as Record<string, unknown>).schemaVersion;
      if (typeof sv === 'number') return sv;
      if (normalizeVersion) return normalizeVersion(raw);
    }
    return null;
  } catch {
    return null;
  }
}

export async function backupStoreFile(filePath: string, backupDir: string, storeName: string): Promise<{ backupPath: string; contentHash: string; size: number }> {
  await mkdir(backupDir, { recursive: true });
  await chmod(backupDir, 0o700);
  const stamp = Date.now();
  const backupFileName = `${storeName}-${stamp}.bak`;
  const backupPath = path.join(backupDir, backupFileName);
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { backupPath: `${backupPath}.empty`, contentHash: 'EMPTY', size: 0 };
    }
    throw error;
  }
  const hash = createHash('sha256').update(content, 'utf8').digest('hex');
  await writeFile(backupPath, content, 'utf8');
  await chmod(backupPath, 0o600);
  return { backupPath, contentHash: hash, size: content.length };
}

export async function restoreStoreFile(backupPath: string, targetPath: string, expectedHash?: string): Promise<void> {
  if (expectedHash) {
    const content = await readFile(backupPath, 'utf8');
    const actualHash = createHash('sha256').update(content, 'utf8').digest('hex');
    if (actualHash !== expectedHash) {
      throw new Error(`Backup hash mismatch: expected ${expectedHash.slice(0, 12)}..., got ${actualHash.slice(0, 12)}...`);
    }
  }
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(backupPath, targetPath);
  await chmod(targetPath, 0o600);
}
