import { execFileSync } from 'node:child_process';
import path from 'node:path';
import policy from '../pm2Policy.cjs';
import ecosystem from '../ecosystem.config.cjs';

const processName = process.argv[2] || 'wst-academy-qabul-bot';
const raw = execFileSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
const processes = JSON.parse(raw);
const app = processes.find((candidate) => candidate.name === processName);
const declaration = ecosystem.apps.find((candidate) => candidate.name === processName);

if (!app) {
  console.error(`PM2 env audit failed: process not found: ${processName}`);
  process.exit(1);
}

if (!declaration) {
  console.error(`PM2 env audit failed: ecosystem declaration not found: ${processName}`);
  process.exit(1);
}

const expectedScript = path.resolve(declaration.cwd, declaration.script);
const runtimeMismatch = [
  app.pm2_env?.pm_cwd !== declaration.cwd ? 'cwd' : undefined,
  app.pm2_env?.pm_exec_path !== expectedScript ? 'script' : undefined,
  app.pm2_env?.exec_interpreter !== declaration.interpreter ? 'interpreter' : undefined,
  app.pm2_env?.autorestart !== true ? 'autorestart' : undefined,
  app.pm2_env?.merge_logs !== true ? 'merge_logs' : undefined,
].filter(Boolean);
if (runtimeMismatch.length > 0) {
  console.error(`PM2 env audit failed; runtime declaration mismatch: ${runtimeMismatch.join(', ')}`);
  process.exit(1);
}

if (app.pm2_env?.filter_env !== true) {
  console.error('PM2 env audit failed: runtime filter_env is not true.');
  process.exit(1);
}

const envNames = Object.keys(app.pm2_env ?? {});
const forbiddenNames = envNames.filter(policy.isForbiddenEnvName).sort();

if (forbiddenNames.length > 0) {
  console.error(`PM2 env audit failed; forbidden key names: ${forbiddenNames.join(', ')}`);
  process.exit(1);
}

console.log(`PM2 runtime audit OK: direct script/cwd/autorestart/merge_logs match; filter_env=true; ${envNames.length} key names inspected; no forbidden key names.`);
