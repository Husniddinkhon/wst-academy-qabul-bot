import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installStagingProcessEnvironment, loadStagingSecrets, resolveStagingPaths, stagingAdminIds } from '../src/stagingConfig.js';
import { runReadOnlyTelegramPreflight } from '../src/stagingTelegramPreflight.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secretPath = path.join(repoRoot, '.env.staging.local');

async function main(): Promise<void> {
  const secrets = loadStagingSecrets(secretPath, repoRoot);
  installStagingProcessEnvironment(secrets);
  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();
  if (config.environment !== 'staging' || config.isProduction) throw new Error('Staging environment validation failed closed.');
  if (!config.stagingDataDir || !config.stagingMediaDir || !config.stagingBackupDir) throw new Error('Staging path isolation is incomplete.');
  for (const directory of resolveStagingPaths(secrets, repoRoot)) await mkdir(directory, { recursive: true });
  const report = await runReadOnlyTelegramPreflight({ token: secrets.BOT_TOKEN, channelId: secrets.CHANNEL_CHAT_ID, adminIds: stagingAdminIds(secrets) });
  console.log(JSON.stringify({ ...report, storage: { isolated: true, directories: 3 } }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Staging read-only preflight failed.');
  process.exitCode = 1;
});
