import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = join(repoRoot, 'dist', 'index.js');
const envFile = join(repoRoot, '.env');
const requiredEnv = ['BOT_TOKEN'];

function fail(code, detail) {
  console.error(code + ': ' + detail);
  process.exitCode = 1;
  throw new Error(code);
}
async function readable(path, code) {
  try { await access(path, constants.R_OK); }
  catch { fail(code, path); }
}
function envKeys(text) {
  const keys = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match && match[2].trim()) keys.add(match[1]);
  }
  return keys;
}
async function main() {
  if (resolve(process.cwd()) !== repoRoot) fail('PRECHECK_CWD_INVALID', process.cwd());
  await readable(entrypoint, 'PRECHECK_ARTIFACT_MISSING');
  await readable(envFile, 'PRECHECK_ENV_FILE_MISSING');
  const keys = envKeys(await readFile(envFile, 'utf8'));
  for (const name of requiredEnv) {
    if (!process.env[name] && !keys.has(name)) fail('PRECHECK_ENV_VAR_MISSING', name);
  }
  if (typeof process.version !== 'string' || !process.version.startsWith('v')) {
    fail('PRECHECK_NODE_RUNTIME_MISSING', 'node');
  }
  console.log('PRECHECK_OK');
  if (process.argv.includes('--check-only') || process.env.PREFLIGHT_ONLY === '1') {
    return;
  }
  await import(entrypoint);
}
main().catch((error) => {
  if (!process.exitCode) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
});
