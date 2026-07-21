import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const LOCK_TIMEOUT_MS = 60_000;
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_RETRY_MS = 50;

interface LockOwner {
  token: string;
  pid: number;
  createdAt: string;
  createdAtMs: number;
}

export type LockReclaimStep = 'claim_acquired' | 'before_owner_remove';

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
  tokenFactory?: () => string;
  processAlive?: (pid: number) => boolean;
  /** Fault-injection hook used by deterministic lock-race tests. */
  onReclaimStep?: (step: LockReclaimStep) => void | Promise<void>;
}

export type AtomicWriteStep = 'backup_previous_preserved' | 'before_backup_commit' | 'backup_committed' | 'before_primary_commit';

export type Utf8FileReader = (filePath: string, encoding: 'utf8') => Promise<string>;

type JsonGeneration = { kind: 'valid'; text: string; value: unknown }
  | { kind: 'missing' | 'malformed' };

export interface AtomicWriteJsonOptions {
  onStep?: (step: AtomicWriteStep) => void | Promise<void>;
  /** Fault-injection reader used to prove non-ENOENT I/O failures fail closed. */
  readFile?: Utf8FileReader;
}

export interface ReadJsonOptions { readFile?: Utf8FileReader }

export async function withFileLock<T>(filePath: string, operation: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const tokenFactory = options.tokenFactory ?? randomUUID;
  const token = tokenFactory();
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const processAlive = options.processAlive ?? isProcessAlive;
  await ensurePrivateDirectory(path.dirname(filePath));
  const started = Date.now();

  while (true) {
    try {
      await mkdir(lockPath, 0o700);
      await chmod(lockPath, 0o700);
      try {
        await writeLockOwner(lockPath, { token, pid: process.pid, createdAt: new Date().toISOString(), createdAtMs: Date.now() });
      } catch (error) {
        await unlink(path.join(lockPath, 'owner.json')).catch(() => undefined);
        await rmdir(lockPath).catch(() => undefined);
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const reclaimed = await reclaimAbandonedLock(lockPath, staleMs, tokenFactory, processAlive, options.onReclaimStep);
      if (reclaimed) continue;
      if (Date.now() - started > timeoutMs) throw new Error(`JSON storage lock timeout: ${path.basename(filePath)}`);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }

  try {
    return await operation();
  } finally {
    await releaseOwnedLock(lockPath, token);
  }
}

export async function readJson<T>(filePath: string, fallback: T, options: ReadJsonOptions = {}): Promise<T> {
  const reader = options.readFile ?? readUtf8File;
  const primary = await inspectJsonGeneration(filePath, reader);
  if (primary.kind === 'valid') return primary.value as T;
  let backupPresent = false;

  for (const backupPath of backupGenerationPaths(filePath)) {
    const backup = await inspectJsonGeneration(backupPath, reader);
    if (backup.kind !== 'missing') backupPresent = true;
    if (backup.kind === 'valid') return backup.value as T;
  }

  if (primary.kind === 'missing' && !backupPresent) return fallback;
  throw new Error('JSON storage read failed for ' + path.basename(filePath));
}

export async function atomicWriteJson(filePath: string, data: unknown, options: AtomicWriteJsonOptions = {}): Promise<void> {
  await ensurePrivateDirectory(path.dirname(filePath));
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  const temporary = temporaryPath(filePath);
  await writeDurableFile(temporary, serialized);
  const reader = options.readFile ?? readUtf8File;

  try {
    const currentPrimary = await inspectJsonGeneration(filePath, reader);
    if (currentPrimary.kind === 'valid') {
      await commitBackupGeneration(filePath, currentPrimary.text, reader, options.onStep);
      await options.onStep?.('backup_committed');
    }
    await options.onStep?.('before_primary_commit');
    await rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function backupGenerationPaths(filePath: string): string[] {
  return [`${filePath}.bak`, `${filePath}.bak.1`];
}

async function commitBackupGeneration(filePath: string, primaryText: string, reader: Utf8FileReader, onStep?: AtomicWriteJsonOptions['onStep']): Promise<void> {
  const backupPath = `${filePath}.bak`;
  const previousPath = `${filePath}.bak.1`;
  const candidatePath = temporaryPath(backupPath);
  await writeDurableFile(candidatePath, primaryText);

  try {
    const currentBackup = await inspectJsonGeneration(backupPath, reader);
    if (currentBackup.kind === 'valid') {
      await unlink(previousPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      await rename(backupPath, previousPath);
      await chmod(previousPath, 0o600);
      await onStep?.('backup_previous_preserved');
    } else {
      await unlink(backupPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
    await onStep?.('before_backup_commit');
    await rename(candidatePath, backupPath);
    await chmod(backupPath, 0o600);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await unlink(candidatePath).catch(() => undefined);
  }
}

async function inspectJsonGeneration(filePath: string, reader: Utf8FileReader): Promise<JsonGeneration> {
  let contents: string;
  try {
    contents = await reader(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  try {
    return { kind: 'valid', text: contents, value: JSON.parse(contents) };
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: 'malformed' };
    throw error;
  }
}

async function readUtf8File(filePath: string, encoding: 'utf8'): Promise<string> {
  return readFile(filePath, encoding);
}

async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true });
  await chmod(directoryPath, 0o700);
}

async function writeDurableFile(filePath: string, contents: string): Promise<void> {
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, 'r');
  try {
    try {
      await directory.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EINVAL' && code !== 'ENOTSUP')) throw error;
    }
  } finally {
    await directory.close();
  }
}

function temporaryPath(filePath: string): string {
  return `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
}

async function writeLockOwner(lockPath: string, owner: LockOwner): Promise<void> {
  const ownerPath = path.join(lockPath, 'owner.json');
  const handle = await open(ownerPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(lockPath, 0o700);
}

interface ReclaimMarker {
  token: string;
  observedOwnerToken?: string;
  pid: number;
  createdAtMs: number;
}

async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
  let contents: string;
  try {
    contents = await readFile(path.join(lockPath, 'owner.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const parsed = JSON.parse(contents) as Partial<LockOwner>;
    if (typeof parsed.token !== 'string' || !Number.isInteger(parsed.pid) || typeof parsed.createdAt !== 'string' || !Number.isFinite(parsed.createdAtMs)) return undefined;
    return parsed as LockOwner;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function reclaimAbandonedLock(
  lockPath: string,
  staleMs: number,
  tokenFactory: () => string,
  processAlive: (pid: number) => boolean,
  onStep?: FileLockOptions['onReclaimStep'],
): Promise<boolean> {
  const lockStat = await statIfExists(lockPath);
  if (!lockStat || Date.now() - lockStat.mtimeMs <= staleMs) return false;
  const observedOwner = await readLockOwner(lockPath);
  if (observedOwner && processAlive(observedOwner.pid)) return false;

  const claim = await acquireReclaimClaim(lockPath, observedOwner?.token, staleMs, tokenFactory, processAlive);
  if (!claim) return false;
  try {
    const currentOwner = await readLockOwner(lockPath);
    await onStep?.('claim_acquired');
    if (observedOwner?.token !== currentOwner?.token) return false;
    if (currentOwner && processAlive(currentOwner.pid)) return false;
    if ((await readReclaimMarker(claim.path))?.token !== claim.token) return false;
    await onStep?.('before_owner_remove');
    await unlinkIfExists(path.join(lockPath, 'owner.json'));
  } finally {
    await releaseReclaimClaim(claim.path, claim.token);
    if (!(await readLockOwner(lockPath))) await removeEmptyLockDirectory(lockPath);
  }
  return !(await statIfExists(lockPath));
}

async function acquireReclaimClaim(
  lockPath: string,
  observedOwnerToken: string | undefined,
  staleMs: number,
  tokenFactory: () => string,
  processAlive: (pid: number) => boolean,
): Promise<{ path: string; token: string } | undefined> {
  const reclaimPath = path.join(lockPath, '.reclaim');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = tokenFactory();
    let handle;
    try {
      handle = await open(reclaimPath, 'wx', 0o600);
      const marker: ReclaimMarker = { token, observedOwnerToken, pid: process.pid, createdAtMs: Date.now() };
      await handle.writeFile(`${JSON.stringify(marker)}\n`, 'utf8');
      await handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (handle) {
          await handle.close();
          handle = undefined;
          await unlinkIfExists(reclaimPath);
        }
        throw error;
      }
      const existing = await readReclaimMarker(reclaimPath);
      if (existing && processAlive(existing.pid)) return undefined;
      const markerStat = await statIfExists(reclaimPath);
      if (!existing && markerStat && Date.now() - markerStat.mtimeMs <= staleMs) return undefined;
      await unlinkIfExists(reclaimPath);
      continue;
    } finally {
      await handle?.close();
    }
    if ((await readReclaimMarker(reclaimPath))?.token === token) return { path: reclaimPath, token };
  }
  return undefined;
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  const owner = await readLockOwner(lockPath);
  if (owner?.token !== token) return;
  const reclaimPath = path.join(lockPath, '.reclaim');
  const deadline = Date.now() + 5_000;
  while (true) {
    const marker = await readReclaimMarker(reclaimPath);
    if (!marker) break;
    if (marker.observedOwnerToken === token) return;
    if (!isProcessAlive(marker.pid)) {
      await releaseReclaimClaim(reclaimPath, marker.token);
      continue;
    }
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
  if ((await readLockOwner(lockPath))?.token !== token) return;
  await unlinkIfExists(path.join(lockPath, 'owner.json'));
  await removeEmptyLockDirectory(lockPath);
}

async function readReclaimMarker(markerPath: string): Promise<ReclaimMarker | undefined> {
  let contents: string;
  try {
    contents = await readFile(markerPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const parsed = JSON.parse(contents) as Partial<ReclaimMarker>;
    if (typeof parsed.token !== 'string' || !Number.isInteger(parsed.pid) || !Number.isFinite(parsed.createdAtMs)) return undefined;
    if (parsed.observedOwnerToken !== undefined && typeof parsed.observedOwnerToken !== 'string') return undefined;
    return parsed as ReclaimMarker;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function releaseReclaimClaim(reclaimPath: string, token: string): Promise<void> {
  if ((await readReclaimMarker(reclaimPath))?.token === token) await unlinkIfExists(reclaimPath);
}

async function statIfExists(filePath: string) {
  try {
    return await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function removeEmptyLockDirectory(lockPath: string): Promise<void> {
  try {
    await rmdir(lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
