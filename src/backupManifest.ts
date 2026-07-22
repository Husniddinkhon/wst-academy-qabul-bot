import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readdir, readFile, stat, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm' as const;
const IV_LENGTH = 12;

export interface BackupEntry {
  sourceName: string;
  filePath: string;
  backupPath: string;
  sha256: string;
  size: number;
  mtime: string;
  generation: number;
}

export interface BackupManifest {
  schemaVersion: number;
  createdAt: string;
  hostname: string;
  totalSize: number;
  entryCount: number;
  entries: BackupEntry[];
  hash: string;
}

export interface RehearsalReport {
  manifest: BackupManifest;
  offHostPath: string;
  restorePath: string;
  restored: { entry: BackupEntry; ok: boolean; error?: string }[];
  allOk: boolean;
  rtoMs: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bufFromHex(hex: string): any {
  return Buffer.from(hex, 'hex');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bufFromStr(s: string): any {
  return Buffer.from(s, 'utf8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hexFromBuf(b: any): string {
  return b.toString('hex');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function strFromBuf(b: any): string {
  return b.toString('utf8');
}

export async function discoverBackups(dataDir: string, migrationDir: string): Promise<BackupEntry[]> {
  const entries: BackupEntry[] = [];

  const dataFiles = await readdir(dataDir).catch<never[]>(() => []);
  const bakMap = new Map<string, { bak: string; bak1: string }>();

  for (const f of dataFiles) {
    if (f.endsWith('.bak.1')) {
      const base = f.slice(0, -'.bak.1'.length);
      if (!bakMap.has(base)) bakMap.set(base, { bak: '', bak1: '' });
      bakMap.get(base)!.bak1 = f;
    }
  }
  for (const f of dataFiles) {
    if (f.endsWith('.bak') && !f.endsWith('.bak.1')) {
      const base = f.slice(0, -'.bak'.length);
      if (!bakMap.has(base)) bakMap.set(base, { bak: '', bak1: '' });
      bakMap.get(base)!.bak = f;
    }
  }

  for (const [base, gens] of bakMap) {
    for (const gen of [0, 1] as const) {
      const fileName = gen === 0 ? gens.bak : gens.bak1;
      if (!fileName) continue;
      const fullPath = path.join(dataDir, fileName);
      try {
        const s = await stat(fullPath);
        const content = await readFile(fullPath, 'utf8');
        const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
        entries.push({
          sourceName: base,
          filePath: path.join(dataDir, base),
          backupPath: fullPath,
          sha256,
          size: s.size,
          mtime: s.mtime.toISOString(),
          generation: gen,
        });
      } catch { /* skip unreadable */ }
    }
  }

  try {
    const migrationFiles = await readdir(migrationDir);
    for (const f of migrationFiles) {
      if (!f.endsWith('.json') || f === '.gitkeep') continue;
      const fullPath = path.join(migrationDir, f);
      try {
        const s = await stat(fullPath);
        const content = await readFile(fullPath, 'utf8');
        const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
        entries.push({
          sourceName: `migration:${f.replace('.json', '')}`,
          filePath: fullPath,
          backupPath: fullPath,
          sha256,
          size: s.size,
          mtime: s.mtime.toISOString(),
          generation: 0,
        });
      } catch { /* skip */ }
    }
  } catch { /* no migration dir */ }

  return entries.sort((a, b) => a.sourceName.localeCompare(b.sourceName));
}

export function computeManifest(entries: BackupEntry[], hostname: string): BackupManifest {
  const manifest: Omit<BackupManifest, 'hash'> = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    hostname,
    totalSize: entries.reduce((s, e) => s + e.size, 0),
    entryCount: entries.length,
    entries,
  };
  const hash = createHash('sha256').update(JSON.stringify(manifest), 'utf8').digest('hex');
  return { ...manifest, hash };
}

export async function verifyManifest(manifest: BackupManifest): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  for (const entry of manifest.entries) {
    try {
      const content = await readFile(entry.backupPath, 'utf8');
      const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
      if (sha256 !== entry.sha256) {
        errors.push(`Hash mismatch for ${entry.sourceName} (gen ${entry.generation}): expected ${entry.sha256.slice(0, 12)}..., got ${sha256.slice(0, 12)}...`);
      }
    } catch (err) {
      errors.push(`Cannot read ${entry.sourceName} (gen ${entry.generation}): ${(err as Error).message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function encryptBackup(content: string, key: string): { ciphertext: string; iv: string; tag: string } {
  const keyBuf = bufFromHex(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyBuf, iv);
  const encrypted = cipher.update(bufFromStr(content), 'utf8');
  const final = cipher.final();
  const combined = hexFromBuf(encrypted) + hexFromBuf(final);
  const tag = cipher.getAuthTag();
  return { ciphertext: combined, iv: hexFromBuf(iv), tag: hexFromBuf(tag) };
}

export function decryptBackup(ciphertextHex: string, key: string, ivHex: string, tagHex: string): string {
  const keyBuf = bufFromHex(key);
  const iv = bufFromHex(ivHex);
  const tag = bufFromHex(tagHex);
  const decipher = createDecipheriv(ALGORITHM, keyBuf, iv);
  decipher.setAuthTag(tag);
  const rawHex = bufFromHex(ciphertextHex);
  const decrypted = decipher.update(rawHex);
  const final = decipher.final('utf8');
  return strFromBuf(decrypted) + final;
}

export async function copyToOffHost(entries: BackupEntry[], offHostDir: string, encryptionKey: string): Promise<void> {
  await mkdir(offHostDir, { recursive: true });

  for (const entry of entries) {
    const relDir = entry.sourceName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const targetDir = path.join(offHostDir, relDir);
    await mkdir(targetDir, { recursive: true });
    const fileName = `gen${entry.generation}-${path.basename(entry.backupPath)}`;
    const content = await readFile(entry.backupPath, 'utf8');
    const enc = encryptBackup(content, encryptionKey);
    const pkgData = JSON.stringify({
      iv: enc.iv, tag: enc.tag, data: enc.ciphertext,
      sourceName: entry.sourceName, sha256: entry.sha256, size: entry.size, mtime: entry.mtime,
    });
    await writeFile(path.join(targetDir, `${fileName}.enc`), pkgData, 'utf8');
  }

  const manifest = computeManifest(entries, '');
  const manifestStr = JSON.stringify(manifest);
  const enc = encryptBackup(manifestStr, encryptionKey);
  const manifestPath = path.join(offHostDir, `manifest.${manifest.createdAt.replace(/[:.]/g, '-')}.enc`);
  await writeFile(manifestPath, JSON.stringify({ iv: enc.iv, tag: enc.tag, data: enc.ciphertext }), 'utf8');
}

export async function restoreFromOffHost(offHostDir: string, restoreRoot: string, encryptionKey: string): Promise<RehearsalReport> {
  const startTime = Date.now();
  await mkdir(restoreRoot, { recursive: true });

  const encFiles = (await readdir(offHostDir)).filter((f) => f.startsWith('manifest.') && f.endsWith('.enc')).sort().reverse();
  if (encFiles.length === 0) throw new Error('No encrypted manifest found in off-host directory');

  const manifestEncRaw = await readFile(path.join(offHostDir, encFiles[0]), 'utf8');
  const manifestEnc = JSON.parse(manifestEncRaw) as { iv: string; tag: string; data: string };
  const manifestStr = decryptBackup(manifestEnc.data, encryptionKey, manifestEnc.iv, manifestEnc.tag);
  const manifest = JSON.parse(manifestStr) as BackupManifest;

  const restored: RehearsalReport['restored'] = [];

  for (const entry of manifest.entries) {
    try {
      const relDir = entry.sourceName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileName = `gen${entry.generation}-${path.basename(entry.backupPath)}`;
      const pkgPath = path.join(offHostDir, relDir, `${fileName}.enc`);
      const pkgRaw = await readFile(pkgPath, 'utf8');
      const pkg = JSON.parse(pkgRaw) as { iv: string; tag: string; data: string; sha256: string };
      const decoded = decryptBackup(pkg.data, encryptionKey, pkg.iv, pkg.tag);
      const actualSha256 = createHash('sha256').update(decoded, 'utf8').digest('hex');
      if (actualSha256 !== entry.sha256) {
        throw new Error(`Hash mismatch after decrypt: expected ${entry.sha256.slice(0, 12)}..., got ${actualSha256.slice(0, 12)}...`);
      }
      const restorePath = path.join(restoreRoot, entry.sourceName.replace(/[^a-zA-Z0-9_-]/g, '_'), path.basename(entry.backupPath));
      await mkdir(path.dirname(restorePath), { recursive: true });
      await writeFile(restorePath, decoded, 'utf8');
      restored.push({ entry, ok: true });
    } catch (err) {
      restored.push({ entry, ok: false, error: (err as Error).message });
    }
  }

  return {
    manifest,
    offHostPath: offHostDir,
    restorePath: restoreRoot,
    restored,
    allOk: restored.every((r) => r.ok),
    rtoMs: Date.now() - startTime,
  };
}

export async function cleanupRestore(restorePath: string): Promise<void> {
  await rm(restorePath, { recursive: true, force: true });
}
