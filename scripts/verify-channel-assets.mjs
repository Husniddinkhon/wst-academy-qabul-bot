import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonExecutable = process.env.PYTHON_EXECUTABLE?.trim() || 'python3';
const manifest = JSON.parse(await readFile(path.join(root, 'assets', 'channel', 'manifest.json'), 'utf8'));
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets) || manifest.assets.length !== 5) throw new Error('Invalid channel asset manifest.');
if (!manifest.avatar || manifest.avatar.width !== 800 || manifest.avatar.height !== 800) throw new Error('Invalid channel avatar manifest.');
const keys = new Set();
for (const asset of manifest.assets) {
  if (keys.has(asset.contentKey)) throw new Error(`Duplicate content key: ${asset.contentKey}`);
  keys.add(asset.contentKey);
  const data = await readFile(path.join(root, asset.png));
  const svg = await readFile(path.join(root, asset.svg), 'utf8');
  const signature = data.subarray(0, 8).toString('hex');
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const hash = createHash('sha256').update(data).digest('hex');
  if (signature !== '89504e470d0a1a0a') throw new Error(`${asset.png}: not a PNG.`);
  if (width !== 1080 || height !== 1080) throw new Error(`${asset.png}: expected 1080x1080, got ${width}x${height}.`);
  if (hash !== asset.sha256 || data.length !== asset.bytes) throw new Error(`${asset.png}: checksum or size mismatch.`);
  const expectedCampaignId = `channel_${asset.contentKey.replaceAll('-', '_')}`;
  const expectedDeepLink = `https://t.me/wst_academy_qabul_bot?start=${expectedCampaignId}`;
  if (asset.campaignId !== expectedCampaignId || !asset.caption.endsWith(expectedDeepLink) || asset.caption.length > 1024) throw new Error(`${asset.png}: invalid tracked Telegram caption.`);
  if (!asset.altText || asset.altText.length < 40) throw new Error(`${asset.png}: accessibility description missing.`);
  if (asset.sourceLedger?.externalImagery !== false || asset.sourceLedger?.manufacturerAssets !== false) throw new Error(`${asset.png}: source ledger is not original-only.`);
  for (const requiredNode of ['>WST</text>', '>ACADEMY</text>', '>@wst_academy_qabul_bot</text>', '>AMALIY BILIM • REAL USKUNA</text>']) {
    if (!svg.includes(requiredNode)) throw new Error(`${asset.svg}: shared WST wordmark or footer node is missing: ${requiredNode}`);
  }
  execFileSync(pythonExecutable, [path.join(root, 'scripts', 'check-render.py'), path.join(root, asset.png), '1080'], { stdio: 'pipe' });
  for (const match of svg.matchAll(/<text\s+x="([\d.]+)"\s+y="([\d.]+)"[^>]*font-size="([\d.]+)"/g)) {
    const [, xText, yText, sizeText] = match;
    const [x, y, size] = [Number(xText), Number(yText), Number(sizeText)];
    if (x < 56 || x > 1024 || y - size < 40 || y > 1024) throw new Error(`${asset.svg}: text baseline leaves the 40px safe area at x=${x}, y=${y}, size=${size}.`);
  }
}
const avatar = await readFile(path.join(root, manifest.avatar.png));
const avatarHash = createHash('sha256').update(avatar).digest('hex');
if (avatar.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || avatar.readUInt32BE(16) !== 800 || avatar.readUInt32BE(20) !== 800) throw new Error('Channel avatar must be an 800x800 PNG.');
if (avatarHash !== manifest.avatar.sha256 || avatar.length !== manifest.avatar.bytes) throw new Error('Channel avatar checksum or size mismatch.');
if (manifest.avatar.sourceLedger?.externalImagery !== false || manifest.avatar.sourceLedger?.manufacturerAssets !== false) throw new Error('Channel avatar source ledger is not original-only.');
execFileSync(pythonExecutable, [path.join(root, 'scripts', 'check-render.py'), path.join(root, manifest.avatar.png), '800'], { stdio: 'pipe' });
console.log(`Verified ${manifest.assets.length} channel PNG assets and one avatar: dimensions, captions, accessibility metadata and SHA-256 checksums are valid.`);
