import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../dist/config.js';
import { deliverOperationalAlert, JsonOperationalAlertStore } from '../dist/operationalAlerts.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const unit = args.find((arg) => arg !== '--dry-run');

if (!unit || !/^[A-Za-z0-9_.@-]+\.service$/.test(unit)) {
  console.error('Operational alert rejected: invalid systemd service name.');
  process.exit(2);
}

const invocationId = execFileSync('/usr/bin/systemctl', ['show', unit, '-p', 'InvocationID', '--value'], {
  encoding: 'utf8',
  timeout: 5_000,
}).trim();
const occurrence = createHash('sha256').update(invocationId || `${unit}:${new Date().toISOString().slice(0, 13)}`).digest('hex').slice(0, 20);

if (dryRun) {
  console.log(JSON.stringify({ ok: true, dryRun: true, unit, occurrenceAvailable: Boolean(invocationId) }));
  process.exit(0);
}

const config = loadConfig();
if (config.adminIds.length === 0) {
  console.error('Operational alert delivery unavailable: no admins configured.');
  process.exit(1);
}

const alertStore = new JsonOperationalAlertStore(config.opsAlertsFile);
const result = await deliverOperationalAlert({
  key: `systemd:${unit}:${occurrence}`,
  cooldownGroup: `systemd:${unit}`,
  cooldownMs: 60 * 60_000,
  message: [
    '🚨 WST operational service failure',
    `Unit: ${unit}`,
    'Holat: failed.',
    `Tekshirish: systemctl status ${unit}`,
    'Maxfiy qiymatlar ва raw error бу хабарга киритилмаган.',
  ].join('\n'),
  adminIds: config.adminIds,
  sender: async (adminId, message) => {
    const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: adminId, text: message }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok || !body || body.ok !== true) throw new Error('Telegram operational alert delivery failed.');
  },
  store: alertStore,
});

console.log(JSON.stringify({ ok: result.failed === 0, attempted: result.attempted, sent: result.sent, failed: result.failed, suppressed: result.suppressed }));
if (result.failed > 0) process.exitCode = 1;
