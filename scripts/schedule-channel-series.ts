import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JsonChannelPostStore } from '../src/channelPosts.js';

async function main(): Promise<void> {
  const root = path.resolve(process.cwd());
  execFileSync(process.execPath, [path.join(root, 'scripts', 'verify-channel-assets.mjs')], { cwd: root, stdio: 'inherit' });
  const manifest = JSON.parse(await readFile(path.join(root, 'assets', 'channel', 'manifest.json'), 'utf8')) as {
    assets: Array<{ contentKey: string; campaignId: string; scheduledAt: string; caption: string; png: string }>;
  };
  const store = new JsonChannelPostStore(process.env.CHANNEL_POSTS_FILE || path.join(root, 'data', 'channel_posts.json'));
  const existing = await store.all();
  const now = new Date();
  const scheduled: Array<{ id: string; contentKey: string; scheduledAt: string; image: string }> = [];

  for (const asset of manifest.assets) {
    const previous = existing.find((post) => post.contentKey === asset.contentKey);
    const localPath = path.relative(path.join(root, 'assets', 'channel'), path.join(root, asset.png)).replaceAll('\\', '/');
    if (previous) {
      if (previous.scheduledAt !== asset.scheduledAt || previous.photoSource?.kind !== 'local_path' || previous.photoSource.value !== localPath) {
        throw new Error(`Existing content ${asset.contentKey} does not match the verified manifest.`);
      }
      const reconciled = previous.text === asset.caption && previous.campaignId === asset.campaignId
        ? { ok: true, post: previous } as const
        : await store.refreshScheduledContent(asset.contentKey, asset.scheduledAt, asset.caption, { kind: 'local_path', value: localPath }, asset.campaignId);
      if (!reconciled.ok) throw new Error(`Existing content ${asset.contentKey} cannot be safely refreshed after publishing started.`);
      scheduled.push({ id: reconciled.post.id, contentKey: asset.contentKey, scheduledAt: reconciled.post.scheduledAt!, image: asset.png });
      continue;
    }
    if (new Date(asset.scheduledAt) <= now) throw new Error(`${asset.contentKey}: refusing to create a schedule in the past.`);
    if (existing.some((post) => post.scheduledAt === asset.scheduledAt)) throw new Error(`${asset.contentKey}: another post already occupies ${asset.scheduledAt}.`);
    const draft = await store.createFromSource(asset.caption, { kind: 'local_path', value: localPath }, 0, asset.contentKey);
    const result = await store.schedule(draft.id, asset.scheduledAt, 0, asset.campaignId);
    if (!result.ok) throw new Error(`${asset.contentKey}: failed to schedule ${draft.id}.`);
    existing.push(result.post);
    scheduled.push({ id: result.post.id, contentKey: asset.contentKey, scheduledAt: result.post.scheduledAt!, image: asset.png });
  }
  console.log(JSON.stringify({ scheduled }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
