import { GetObjectCommand, ListObjectsV2Command, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { SignatureV4 } from '@smithy/signature-v4';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import type { BackupEntry, BackupManifest, RehearsalReport } from './backupManifest.js';
import { computeManifest, decryptBackup, discoverBackups, encryptBackup, verifyManifest } from './backupManifest.js';

export const S3_RETRY_MAX = 3;
export const S3_UPLOAD_TIMEOUT_MS = 30_000;
export const S3_DOWNLOAD_TIMEOUT_MS = 30_000;
export const S3_LIST_TIMEOUT_MS = 15_000;

export interface S3TransportConfig {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3BackupError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'S3BackupError';
  }
}

export function parseS3Uri(uri: string): { bucket: string; prefix: string } {
  const match = uri.match(/^s3:\/\/([a-z0-9][a-z0-9.-]*[a-z0-9])\/(.*)$/);
  if (!match) throw new S3BackupError(`Invalid S3 URI: ${uri.slice(0, 20)}...`, 'INVALID_URI');
  let prefix = match[2];
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  return { bucket: match[1], prefix };
}

export function validateS3Config(config: Partial<S3TransportConfig>): S3TransportConfig {
  if (!config.endpoint) throw new S3BackupError('ACADEMY_BACKUP_S3_ENDPOINT is required', 'MISSING_ENDPOINT');
  if (!config.endpoint.startsWith('https://')) throw new S3BackupError('ACADEMY_BACKUP_S3_ENDPOINT must use HTTPS', 'HTTP_ENDPOINT_REJECTED');
  if (!config.region) throw new S3BackupError('ACADEMY_BACKUP_S3_REGION is required', 'MISSING_REGION');
  if (!config.bucket) throw new S3BackupError('ACADEMY_BACKUP_S3_BUCKET is required', 'MISSING_BUCKET');
  if (config.prefix === undefined) throw new S3BackupError('ACADEMY_BACKUP_S3_PREFIX is required', 'MISSING_PREFIX');
  if (config.prefix.startsWith('/') || config.prefix.includes('..')) throw new S3BackupError('Unsafe S3 prefix', 'UNSAFE_PREFIX');
  if (!config.accessKeyId) throw new S3BackupError('ACADEMY_BACKUP_S3_ACCESS_KEY_ID is required', 'MISSING_ACCESS_KEY');
  if (!config.secretAccessKey) throw new S3BackupError('ACADEMY_BACKUP_S3_SECRET_ACCESS_KEY is required', 'MISSING_SECRET_KEY');
  return config as S3TransportConfig;
}

let normalizedEndpoint = '';

export function getS3Endpoint(): string { return normalizedEndpoint; }

export function loadS3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3TransportConfig {
  return validateS3Config({
    endpoint: env.ACADEMY_BACKUP_S3_ENDPOINT,
    region: env.ACADEMY_BACKUP_S3_REGION,
    bucket: env.ACADEMY_BACKUP_S3_BUCKET,
    prefix: env.ACADEMY_BACKUP_S3_PREFIX,
    accessKeyId: env.ACADEMY_BACKUP_S3_ACCESS_KEY_ID,
    secretAccessKey: env.ACADEMY_BACKUP_S3_SECRET_ACCESS_KEY,
  });
}

function s3Key(prefix: string, relativePath: string): string {
  const cleanPrefix = prefix.startsWith('/') ? prefix.slice(1) : prefix;
  const cleanRel = relativePath.replace(/\\/g, '/');
  return cleanPrefix + cleanRel;
}

/* ── Raw S3 PUT with SigV4 (bypasses flexible-checksums middleware) ── */

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmacSha256(key: Buffer, data: string): Buffer {
  return Buffer.from(createHmac('sha256', key as unknown as string).update(data, 'utf8').digest('hex'), 'hex');
}

function getSignatureKey(key: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmacSha256(Buffer.from('AWS4' + key, 'utf8'), dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

async function s3PutObject(
  config: S3TransportConfig,
  bucket: string,
  key: string,
  body: string,
  contentType: string,
  timeoutMs: number,
): Promise<void> {
  const host = new URL(config.endpoint).host;
  const pathStr = '/' + bucket + '/' + key;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:.-]/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const bodyHash = sha256Hex(body);

  const headers: Record<string, string> = {
    'Host': host,
    'X-Amz-Date': amzDate,
    'X-Amz-Content-SHA256': bodyHash,
    'Content-Type': contentType,
    'Content-Length': String(Buffer.from(body, 'utf8').length),
  };

  const signedHeaders = Object.keys(headers).map((h) => h.toLowerCase()).sort().join(';');

  const canonicalRequest = [
    'PUT',
    pathStr,
    '',
    ...Object.entries(headers)
      .map(([k, v]) => k.toLowerCase() + ':' + v)
      .sort(),
    '',
    signedHeaders,
    bodyHash,
  ].join('\n');

  const credentialScope = [dateStamp, config.region, 's3', 'aws4_request'].join('/');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = getSignatureKey(config.secretAccessKey, dateStamp, config.region, 's3');
  const signature = hmacSha256(signingKey, stringToSign).toString('hex');

  headers['Authorization'] = 'AWS4-HMAC-SHA256 Credential=' + config.accessKeyId + '/' + credentialScope
    + ', SignedHeaders=' + signedHeaders
    + ', Signature=' + signature;

  await new Promise<void>((resolve, reject) => {
    const url = new URL(config.endpoint);
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: pathStr,
        method: 'PUT',
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let buf: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { buf.push(chunk); });
        res.on('end', () => {
          const body = Buffer.concat(buf).toString('utf8');
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new S3BackupError(`S3 PUT failed (${res.statusCode}): ${body.slice(0, 200)}`, 'S3_PUT_ERROR'));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new S3BackupError('S3 PUT timed out', 'S3_PUT_TIMEOUT')); });
    req.write(body, 'utf8');
    req.end();
  });
}

async function s3GetObject(
  config: S3TransportConfig,
  bucket: string,
  key: string,
  timeoutMs: number,
): Promise<string> {
  const host = new URL(config.endpoint).host;
  const pathStr = '/' + bucket + '/' + key;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:.-]/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    'Host': host,
    'X-Amz-Date': amzDate,
    'X-Amz-Content-SHA256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  };

  const signedHeaders = Object.keys(headers).map((h) => h.toLowerCase()).sort().join(';');

  const canonicalRequest = [
    'GET',
    pathStr,
    '',
    ...Object.entries(headers)
      .map(([k, v]) => k.toLowerCase() + ':' + v)
      .sort(),
    '',
    signedHeaders,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ].join('\n');

  const credentialScope = [dateStamp, config.region, 's3', 'aws4_request'].join('/');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = getSignatureKey(config.secretAccessKey, dateStamp, config.region, 's3');
  const signature = hmacSha256(signingKey, stringToSign).toString('hex');

  headers['Authorization'] = 'AWS4-HMAC-SHA256 Credential=' + config.accessKeyId + '/' + credentialScope
    + ', SignedHeaders=' + signedHeaders
    + ', Signature=' + signature;

  return new Promise<string>((resolve, reject) => {
    const url = new URL(config.endpoint);
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: pathStr,
        method: 'GET',
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let buf: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { buf.push(chunk); });
        res.on('end', () => {
          const data = Buffer.concat(buf).toString('utf8');
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new S3BackupError(`S3 GET failed (${res.statusCode}): ${data.slice(0, 200)}`, 'S3_GET_ERROR'));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new S3BackupError('S3 GET timed out', 'S3_GET_TIMEOUT')); });
    req.end();
  });
}

async function s3ListObjects(
  config: S3TransportConfig,
  bucket: string,
  prefix: string,
  timeoutMs: number,
): Promise<string[]> {
  const host = new URL(config.endpoint).host;
  const query = '?list-type=2&prefix=' + encodeURIComponent(prefix);
  const pathStr = '/' + bucket + query;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:.-]/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    'Host': host,
    'X-Amz-Date': amzDate,
    'X-Amz-Content-SHA256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  };

  const signedHeaders = Object.keys(headers).map((h) => h.toLowerCase()).sort().join(';');

  const canonicalQuery = 'list-type=2&prefix=' + encodeURIComponent(prefix);

  const canonicalRequest = [
    'GET',
    '/' + bucket,
    canonicalQuery,
    ...Object.entries(headers)
      .map(([k, v]) => k.toLowerCase() + ':' + v)
      .sort(),
    '',
    signedHeaders,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ].join('\n');

  const credentialScope = [dateStamp, config.region, 's3', 'aws4_request'].join('/');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = getSignatureKey(config.secretAccessKey, dateStamp, config.region, 's3');
  const signature = hmacSha256(signingKey, stringToSign).toString('hex');

  headers['Authorization'] = 'AWS4-HMAC-SHA256 Credential=' + config.accessKeyId + '/' + credentialScope
    + ', SignedHeaders=' + signedHeaders
    + ', Signature=' + signature;

  const response = await new Promise<string>((resolve, reject) => {
    const url = new URL(config.endpoint);
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: pathStr,
        method: 'GET',
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let buf: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { buf.push(chunk); });
        res.on('end', () => {
          const data = Buffer.concat(buf).toString('utf8');
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new S3BackupError(`S3 LIST failed (${res.statusCode}): ${data.slice(0, 200)}`, 'S3_LIST_ERROR'));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new S3BackupError('S3 LIST timed out', 'S3_LIST_TIMEOUT')); });
    req.end();
  });

  const keys: string[] = [];
  const keyRegex = /<Key>([^<]+)<\/Key>/g;
  let match: RegExpExecArray | null;
  while ((match = keyRegex.exec(response)) !== null) {
    keys.push(match[1]!);
  }
  return keys;
}

/* ── Public API ─────────────────────────────────────────────────── */

export function createS3Client(config: S3TransportConfig, _clientFactory?: (config: S3TransportConfig) => S3Client): S3Client {
  normalizedEndpoint = config.endpoint;
  if (_clientFactory) return _clientFactory(config);
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: true,
    maxAttempts: S3_RETRY_MAX,
  });
}

export async function copyToS3OffHost(
  entries: BackupEntry[],
  bucket: string,
  prefix: string,
  encryptionKey: string,
  config: S3TransportConfig,
  manifestCreatedAt?: string,
): Promise<string> {
  for (const entry of entries) {
    const relDir = entry.sourceName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `gen${entry.generation}-${path.basename(entry.backupPath)}`;
    const content = await readFile(entry.backupPath, 'utf8');
    const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
    if (contentHash !== entry.sha256) throw new S3BackupError(`Hash mismatch for ${entry.sourceName} gen ${entry.generation}`, 'CONTENT_HASH_MISMATCH');
    const enc = encryptBackup(content, encryptionKey);
    const pkgData = JSON.stringify({
      iv: enc.iv, tag: enc.tag, data: enc.ciphertext,
      sourceName: entry.sourceName, sha256: entry.sha256, size: entry.size, mtime: entry.mtime,
    });
    const objectKey = s3Key(prefix, `${relDir}/${fileName}.enc`);
    await s3PutObject(config, bucket, objectKey, pkgData, 'application/json', S3_UPLOAD_TIMEOUT_MS);
  }

  const manifest = computeManifest(entries, '');
  const manifestStr = JSON.stringify(manifest);
  const enc = encryptBackup(manifestStr, encryptionKey);
  const stamp = (manifestCreatedAt ?? manifest.createdAt).replace(/[:.]/g, '-');
  const manifestKeyPath = s3Key(prefix, `manifest.${stamp}.enc`);
  const manifestBody = JSON.stringify({ iv: enc.iv, tag: enc.tag, data: enc.ciphertext });
  await s3PutObject(config, bucket, manifestKeyPath, manifestBody, 'application/json', S3_UPLOAD_TIMEOUT_MS);

  return manifestKeyPath;
}

export async function restoreFromS3OffHost(
  bucket: string,
  prefix: string,
  restoreRoot: string,
  encryptionKey: string,
  config: S3TransportConfig,
): Promise<RehearsalReport> {
  const startTime = Date.now();
  await mkdir(restoreRoot, { recursive: true });

  const allKeys = await s3ListObjects(config, bucket, s3Key(prefix, ''), S3_LIST_TIMEOUT_MS);

  const manifestKeys = allKeys
    .filter((key) => path.basename(key).startsWith('manifest.') && key.endsWith('.enc'))
    .sort()
    .reverse();

  if (manifestKeys.length === 0) throw new S3BackupError('No encrypted manifest found in S3 bucket', 'MANIFEST_NOT_FOUND');

  const manifestKey = manifestKeys[0]!;
  const manifestEncStr = await s3GetObject(config, bucket, manifestKey, S3_DOWNLOAD_TIMEOUT_MS);
  if (!manifestEncStr) throw new S3BackupError('Empty manifest body from S3', 'EMPTY_MANIFEST');
  const manifestEnc = JSON.parse(manifestEncStr) as { iv: string; tag: string; data: string };
  const manifestStr = decryptBackup(manifestEnc.data, encryptionKey, manifestEnc.iv, manifestEnc.tag);
  const manifest = JSON.parse(manifestStr) as BackupManifest;

  const restored: RehearsalReport['restored'] = [];

  for (const entry of manifest.entries) {
    try {
      const relDir = entry.sourceName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileName = `gen${entry.generation}-${path.basename(entry.backupPath)}`;
      const objectKey = s3Key(prefix, `${relDir}/${fileName}.enc`);
      const pkgRaw = await s3GetObject(config, bucket, objectKey, S3_DOWNLOAD_TIMEOUT_MS);
      if (!pkgRaw) throw new Error('Empty object body from S3');
      const pkg = JSON.parse(pkgRaw) as { iv: string; tag: string; data: string; sha256: string };
      const decoded = decryptBackup(pkg.data, encryptionKey, pkg.iv, pkg.tag);
      const actualSha256 = createHash('sha256').update(decoded, 'utf8').digest('hex');
      if (actualSha256 !== entry.sha256) {
        throw new Error(`Hash mismatch after decrypt: expected ${entry.sha256.slice(0, 12)}..., got ${actualSha256.slice(0, 12)}...`);
      }
      const restoreFilePath = path.join(restoreRoot, relDir, path.basename(entry.backupPath));
      await mkdir(path.dirname(restoreFilePath), { recursive: true });
      await writeFile(restoreFilePath, decoded, 'utf8');
      restored.push({ entry, ok: true });
    } catch (err) {
      restored.push({ entry, ok: false, error: (err as Error).message });
    }
  }

  return {
    manifest,
    offHostPath: `s3://${bucket}/${prefix}`,
    restorePath: restoreRoot,
    restored,
    allOk: restored.every((r) => r.ok),
    rtoMs: Date.now() - startTime,
  };
}

export async function cleanupS3Restore(restorePath: string): Promise<void> {
  await rm(restorePath, { recursive: true, force: true });
}
