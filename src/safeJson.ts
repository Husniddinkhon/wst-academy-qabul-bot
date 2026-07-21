import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_RETRY_MS = 50;

interface LockOwner {
  token: string;
  pid: number;
  createdAt: string;
  createdAtMs: number;
}

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
  tokenFactory?: () => string;
  processAlive?: (pid: number) => boolean;
}

export type AtomicWriteStep = 'backup_committed' | 'before_primary_commit';

export interface AtomicWriteJsonOptions {
  onStep?: (step: AtomicWriteStep) => void | Promise<void>;
}

export async function withFileLock<T>(filePath: string, operation: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const tokenFactory = options.tokenFactory ?? randomUUID;
  const token = tokenFactory();
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const processAlive = options.processAlive ?? isProcessAlive;
  await mkdir(path.dirname(filePath), { recursive: true });
  const started = Date.now();

  while (true) {
    try {
      await mkdir(lockPath);
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
      const reclaimed = await reclaimAbandonedLock(lockPath, staleMs, tokenFactory, processAlive);
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

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  let primaryMissing = false;
  let backupPresent = false;
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    primaryMissing = (error as NodeJS.ErrnoException).code === 'ENOENT';
  }

  for (const backupPath of backupGenerationPaths(filePath)) {
    try {
      const contents = await readFile(backupPath, 'utf8');
      backupPresent = true;
      return JSON.parse(contents) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') backupPresent = true;
      // Continue to the next independently preserved generation.
    }
  }

  if (primaryMissing && !backupPresent) return fallback;
  throw new Error('JSON storage read failed for ' + path.basename(filePath));
}

export async function atomicWriteJson(filePath: string, data: unknown, options: AtomicWriteJsonOptions = {}): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  const temporary = temporaryPath(filePath);
  await writeDurableFile(temporary, serialized);

  try {
    const currentPrimary = await readValidJsonText(filePath);
    if (currentPrimary !== undefined) {
      await commitBackupGeneration(filePath, currentPrimary);
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

async function commitBackupGeneration(filePath: string, primaryText: string): Promise<void> {
  const backupPath = `${filePath}.bak`;
  const previousPath = `${filePath}.bak.1`;
  const candidatePath = temporaryPath(backupPath);
  await writeDurableFile(candidatePath, primaryText);

  try {
    const currentBackup = await readValidJsonText(backupPath);
    if (currentBackup !== undefined) {
      await unlink(previousPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      await rename(backupPath, previousPath);
    } else {
      await unlink(backupPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
    await rename(candidatePath, backupPath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await unlink(candidatePath).catch(() => undefined);
  }
}

async function readValidJsonText(filePath: string): Promise<string | undefined> {
  try {
    const contents = await readFile(filePath, 'utf8');
    JSON.parse(contents);
    return contents;
  } catch {
    return undefined;
  }
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

async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8')) as Partial<LockOwner>;
    if (typeof parsed.token !== 'string' || !Number.isInteger(parsed.pid) || typeof parsed.createdAt !== 'string' || !Number.isFinite(parsed.createdAtMs)) return undefined;
    return parsed as LockOwner;
  } catch {
    return undefined;
  }
}

async function reclaimAbandonedLock(lockPath: string, staleMs: number, tokenFactory: () => string, processAlive: (pid: number) => boolean): Promise<boolean> {
  const lockStat = await stat(lockPath).catch(() => undefined);
  if (!lockStat || Date.now() - lockStat.mtimeMs <= staleMs) return false;
  const observedOwner = await readLockOwner(lockPath);
  if (observedOwner && processAlive(observedOwner.pid)) return false;

  const reclaimToken = tokenFactory();
  const reclaimPath = path.join(lockPath, `.reclaim-${reclaimToken}`);
  let reclaimHandle;
  try {
    reclaimHandle = await open(reclaimPath, 'wx', 0o600);
    await reclaimHandle.writeFile(`${JSON.stringify({ token: reclaimToken, observedOwnerToken: observedOwner?.token, pid: process.pid, createdAtMs: Date.now() })}\n`, 'utf8');
    await reclaimHandle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally {
    await reclaimHandle?.close();
  }

  try {
    const currentOwner = await readLockOwner(lockPath);
    if (observedOwner?.token !== currentOwner?.token) return false;
    if (currentOwner && processAlive(currentOwner.pid)) return false;
    await unlink(path.join(lockPath, 'owner.json')).catch(() => undefined);
  } finally {
    await unlink(reclaimPath).catch(() => undefined);
    await removeAbandonedReclaimMarkers(lockPath);
    await rmdir(lockPath).catch(() => undefined);
  }
  return !(await stat(lockPath).catch(() => undefined));
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  const owner = await readLockOwner(lockPath);
  if (owner?.token !== token) return;
  const entries = await readdir(lockPath).catch((): string[] => []);
  for (const entry of entries.filter((item) => item.startsWith('.reclaim-'))) {
    const markerPath = path.join(lockPath, entry);
    const marker = await readReclaimMarker(markerPath);
    if (marker?.observedOwnerToken === token) return;
    await unlink(markerPath).catch(() => undefined);
  }
  if ((await readLockOwner(lockPath))?.token !== token) return;
  await unlink(path.join(lockPath, 'owner.json')).catch(() => undefined);
  await rmdir(lockPath).catch(() => undefined);
}

async function readReclaimMarker(markerPath: string): Promise<{ observedOwnerToken?: string } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(markerPath, 'utf8')) as { observedOwnerToken?: unknown };
    return typeof parsed.observedOwnerToken === 'string' ? { observedOwnerToken: parsed.observedOwnerToken } : {};
  } catch {
    return undefined;
  }
}

async function removeAbandonedReclaimMarkers(lockPath: string): Promise<void> {
  const entries = await readdir(lockPath).catch((): string[] => []);
  if (entries.includes('owner.json')) return;
  await Promise.all(entries.filter((entry) => entry.startsWith('.reclaim-')).map((entry) => unlink(path.join(lockPath, entry)).catch(() => undefined)));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
