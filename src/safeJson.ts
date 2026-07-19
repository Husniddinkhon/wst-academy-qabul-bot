import { copyFile, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 5 * 60_000;

export async function withFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  await mkdir(path.dirname(filePath), { recursive: true });
  const started = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error(`JSON storage lock timeout: ${path.basename(filePath)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try { return await operation(); } finally { await unlink(lockPath).catch(() => undefined); }
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    try { return JSON.parse(await readFile(filePath + '.bak', 'utf8')); } catch { throw new Error('JSON storage read failed for ' + path.basename(filePath)); }
  }
}

export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  try { await copyFile(filePath, `${filePath}.bak`); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, filePath);
  const directory = await open(path.dirname(filePath), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
