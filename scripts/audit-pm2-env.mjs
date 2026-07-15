import { execFileSync } from 'node:child_process';
import policy from '../pm2Policy.cjs';

const processName = process.argv[2] || 'wst-academy-qabul-bot';
const raw = execFileSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
const processes = JSON.parse(raw);
const app = processes.find((candidate) => candidate.name === processName);

if (!app) {
  console.error(`PM2 env audit failed: process not found: ${processName}`);
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

console.log(`PM2 env audit OK: runtime filter_env=true; ${envNames.length} key names inspected; no forbidden key names.`);
