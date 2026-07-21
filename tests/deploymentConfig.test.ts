import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { getBotLaunchOptions } from '../src/botLaunch.js';

const require = createRequire(import.meta.url);
const ecosystem = require('../ecosystem.config.cjs') as { apps: Array<Record<string, unknown>> };
const policy = require('../pm2Policy.cjs') as {
  DROP_ALL_GLOBAL_ENV: boolean;
  FORBIDDEN_ENV_EXACT: string[];
  FORBIDDEN_ENV_PREFIXES: string[];
  isForbiddenEnvName: (name: string) => boolean;
};

test('PM2 drops inherited server environment and injects only non-secret app metadata', () => {
  assert.equal(ecosystem.apps.length, 1);
  const app = ecosystem.apps[0];
  assert.equal(app.name, 'wst-academy-qabul-bot');
  assert.equal(app.script, 'scripts/preflight-startup.mjs');
  assert.equal(app.interpreter, '/usr/bin/node');
  assert.equal(app.autorestart, true);
  assert.equal(app.merge_logs, true);
  assert.equal(app.watch, false);
  assert.equal(app.filter_env, true);
  assert.equal(policy.DROP_ALL_GLOBAL_ENV, true);
  assert.deepEqual(app.env, { NODE_ENV: 'production' });
  assert.deepEqual(app.env_production, { NODE_ENV: 'production' });

  const inherited = Object.fromEntries([
    ...policy.FORBIDDEN_ENV_EXACT,
    ...policy.FORBIDDEN_ENV_PREFIXES.map((prefix) => `${prefix}EXAMPLE`),
    'UNRELATED_SERVICE_TOKEN',
  ].map((name) => [name, 'must-not-survive']));
  const filtered = app.filter_env === true ? {} : inherited;
  const effective = {
    ...filtered,
    ...(app.env as Record<string, string>),
    ...(app.env_production as Record<string, string>),
  };
  assert.deepEqual(Object.keys(effective), ['NODE_ENV']);
  assert.equal(Object.keys(effective).some(policy.isForbiddenEnvName), false);
});

test('production PM2 reload preserves pending Telegram updates', () => {
  assert.deepEqual(getBotLaunchOptions({ isProduction: true }), { dropPendingUpdates: false });
});

test('systemd failure notifier is non-recursive and uses the durable protected state path', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const notifier = readFileSync(path.join(root, 'deploy/systemd/wst-academy-ops-alert@.service'), 'utf8');
  const dropIn = readFileSync(path.join(root, 'deploy/systemd/ops-alert.conf'), 'utf8');
  assert.match(notifier, /ExecStart=\/usr\/bin\/node .*notify-systemd-failure\.mjs %i/);
  assert.match(notifier, /UMask=0077/);
  assert.match(notifier, /ReadWritePaths=\/opt\/wst-academy-qabul-bot\/data/);
  assert.doesNotMatch(notifier, /OnFailure=/);
  assert.equal(dropIn.replace(/\r\n/g, '\n').trim(), '[Unit]\nOnFailure=wst-academy-ops-alert@%n.service');
});

test('runtime JSON recovery artifacts and lock directories stay outside Git', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ignore = readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^\/data\/\*\.json\.bak$/m);
  assert.match(ignore, /^\/data\/\*\.json\.bak\.\*$/m);
  assert.match(ignore, /^\/data\/\*\.json\.lock\/$/m);
  assert.match(ignore, /^\/data\/\*\.json\.\*\.tmp$/m);
});
