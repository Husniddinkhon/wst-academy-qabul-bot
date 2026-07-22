import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(PROJECT_ROOT, 'src');

const ALLOWED_RAW_FETCH_FILES = new Set([
  'egressPolicy.ts',
  'egressPolicy.test.ts',
  'ambient.d.ts',
]);

const ALLOWED_RAW_CALLAPI_FILES = new Set([
  'telegramUpdates.ts',
  'ambient.d.ts',
]);

function walkTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkTsFiles(full));
    } else if (extname(entry.name) === '.ts' && entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

const files = walkTsFiles(SRC);

describe('Egress architecture — no raw fetch() outside egressPolicy', () => {
  for (const fullPath of files) {
    const relativePath = sep === '/' ? fullPath.replace(PROJECT_ROOT.replace(/\\/g, '/'), '') : fullPath.replace(PROJECT_ROOT, '');
    const content = readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');
    const basename = fullPath.split(sep).pop()!;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const trimmed = line.trim();

      const isImportLine = trimmed.startsWith('import') ||
        trimmed.startsWith('export') ||
        trimmed.startsWith('import type') ||
        trimmed.includes('from') ||
        trimmed.startsWith('///') ||
        trimmed.startsWith('//');

      if (trimmed.includes('fetch(') || trimmed.includes('fetch (')) {
        it(`${relativePath}:${lineNum} — raw fetch()`, () => {
          const allowed = ALLOWED_RAW_FETCH_FILES.has(basename);
          const hasEgressOk = trimmed.includes('EGRESS-OK');
          const isEgressClientCall = trimmed.includes('egressHttpClient.fetch(') || trimmed.includes('egressHttpClient!.fetch(') || trimmed.includes('client.fetch(') || trimmed.includes('adminEgressHttpClient.fetch(');
          if (!allowed && !isImportLine && !hasEgressOk && !isEgressClientCall) {
            assert.fail(`Raw fetch() call at ${relativePath}:${lineNum}: "${trimmed}" — use EgressHttpClient`);
          }
        });
      }

      if (trimmed.includes('callApi(') || trimmed.includes('.callApi(')) {
        it(`${relativePath}:${lineNum} — direct callApi()`, () => {
          const allowed = ALLOWED_RAW_CALLAPI_FILES.has(basename);
          if (!allowed) {
            assert.fail(`Direct callApi() at ${relativePath}:${lineNum}: "${trimmed}" — route through Telegram egress proxy`);
          }
        });
      }
    }
  }
});

describe('Egress architecture — bypass scan sanity', () => {
  it('should have scanned at least some files', () => {
    assert.ok(files.length > 0, 'No TypeScript files found in src/');
  });
});
