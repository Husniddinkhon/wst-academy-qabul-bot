import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'content', 'channel-series-2026-07-16.json');
const outputDir = path.join(root, 'assets', 'channel');
const svgDir = path.join(outputDir, 'svg');
const chromium = process.env.CHROMIUM_BIN || '/snap/bin/chromium';
const series = JSON.parse(await readFile(sourcePath, 'utf8'));

const palette = {
  navy: '#07162D',
  panel: '#0E2547',
  cyan: '#20D6E8',
  blue: '#3A86FF',
  white: '#F7FBFF',
  muted: '#B7C7DA',
  green: '#42E6A4',
  orange: '#FFB547',
  red: '#FF6B6B',
};

const escapeXml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const text = (x, y, value, size, weight = 600, fill = palette.white, anchor = 'start') => `<text x="${x}" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
const line = (x1, y1, x2, y2, color = palette.cyan, width = 8, dash = '') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const rounded = (x, y, w, h, fill = palette.panel, stroke = '#284D78') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="28" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
const circle = (x, y, r, fill = palette.panel, stroke = palette.cyan, width = 6) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${width}"/>`;
const assertTextFits = (value, size, maxWidth, label) => {
  const estimatedWidth = [...String(value)].length * size * 0.64;
  if (estimatedWidth > maxWidth) throw new Error(`${label} exceeds its safe text width: ${Math.ceil(estimatedWidth)} > ${maxWidth}.`);
};

async function renderPng(svgPath, pngPath, size) {
  const renderRoot = chromium.includes('/snap/') ? path.join(homedir(), 'snap', 'chromium', 'common') : tmpdir();
  await mkdir(renderRoot, { recursive: true });
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const temporary = await mkdtemp(path.join(renderRoot, 'wst-channel-render-'));
    try {
      const input = path.join(temporary, 'input.svg');
      const output = path.join(temporary, 'output.png');
      await copyFile(svgPath, input);
      execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--run-all-compositor-stages-before-draw', '--virtual-time-budget=1000', `--user-data-dir=${path.join(temporary, 'profile')}`, '--force-device-scale-factor=1', `--window-size=${size},${size}`, `--screenshot=${output}`, pathToFileURL(input).href], { stdio: 'pipe' });
      execFileSync('python3', [path.join(root, 'scripts', 'check-render.py'), output, String(size)], { stdio: 'pipe' });
      await copyFile(output, pngPath);
      return;
    } catch (error) {
      lastError = error;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  throw new Error(`Unable to produce a complete ${size}x${size} PNG after three attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function camera(x, y) {
  return `<g transform="translate(${x} ${y})">${rounded(0, 0, 190, 105, '#132E55', palette.cyan)}<circle cx="70" cy="52" r="32" fill="#07162D" stroke="${palette.cyan}" stroke-width="8"/><circle cx="70" cy="52" r="12" fill="${palette.blue}"/><path d="M190 28 L244 6 L244 98 L190 77 Z" fill="#132E55" stroke="${palette.cyan}" stroke-width="6"/><path d="M102 105 L130 148 H58 L84 105" fill="#132E55" stroke="${palette.cyan}" stroke-width="6"/></g>`;
}

function nvr(x, y) {
  return `<g transform="translate(${x} ${y})">${rounded(0, 0, 250, 130, '#132E55', palette.blue)}<rect x="30" y="30" width="125" height="70" rx="12" fill="#07162D" stroke="#35577F" stroke-width="3"/><circle cx="197" cy="48" r="9" fill="${palette.green}"/><circle cx="223" cy="48" r="9" fill="${palette.cyan}"/><rect x="186" y="78" width="47" height="13" rx="6" fill="#35577F"/></g>`;
}

function switchIcon(x, y) {
  return `<g transform="translate(${x} ${y})">${rounded(0, 0, 250, 120, '#132E55', palette.green)}${[0, 1, 2, 3].map((i) => `<rect x="30" y="38" width="36" height="28" rx="4" fill="#07162D" stroke="${palette.green}" stroke-width="3" transform="translate(${i * 48} 0)"/>`).join('')}<circle cx="51" cy="88" r="6" fill="${palette.green}"/><circle cx="99" cy="88" r="6" fill="${palette.green}"/></g>`;
}

function shield(x, y) {
  return `<g transform="translate(${x} ${y})"><path d="M100 0 L190 34 V108 C190 172 150 216 100 242 C50 216 10 172 10 108 V34 Z" fill="#132E55" stroke="${palette.cyan}" stroke-width="8"/><rect x="62" y="94" width="76" height="70" rx="15" fill="${palette.navy}" stroke="${palette.green}" stroke-width="7"/><path d="M78 94 V72 A22 22 0 0 1 122 72 V94" fill="none" stroke="${palette.green}" stroke-width="10"/><circle cx="100" cy="126" r="10" fill="${palette.green}"/></g>`;
}

function disk(x, y) {
  return `<g transform="translate(${x} ${y})">${rounded(0, 0, 220, 250, '#132E55', palette.blue)}<circle cx="110" cy="108" r="72" fill="#07162D" stroke="${palette.blue}" stroke-width="8"/><circle cx="110" cy="108" r="18" fill="${palette.cyan}"/><path d="M110 108 L166 72" stroke="${palette.muted}" stroke-width="10" stroke-linecap="round"/><rect x="45" y="205" width="130" height="12" rx="6" fill="#35577F"/></g>`;
}

function diagram(item) {
  if (item.diagram === 'subnet') return [
    nvr(120, 610), camera(720, 610), line(375, 675, 710, 675, palette.cyan, 10),
    `<rect x="430" y="638" width="224" height="72" rx="36" fill="${palette.cyan}"/>`, text(542, 685, '/24 SUBNET', 28, 800, palette.navy, 'middle'),
  ].join('');
  if (item.diagram === 'poe') return [
    switchIcon(90, 625), camera(725, 615), line(350, 675, 714, 675, palette.green, 14),
    `<path d="M505 620 L462 690 H513 L485 752 L580 657 H528 L558 620 Z" fill="${palette.orange}"/>`,
    text(530, 790, 'DATA + QUVVAT', 30, 800, palette.muted, 'middle'),
  ].join('');
  if (item.diagram === 'password') return [
    shield(160, 590), nvr(645, 640), line(360, 710, 632, 710, palette.cyan, 9, '16 14'),
    circle(505, 710, 62, palette.navy, palette.green, 7), text(505, 724, '••••', 38, 800, palette.green, 'middle'),
  ].join('');
  if (item.diagram === 'storage') return [
    disk(120, 585), text(465, 675, '8 × 4 × 86 400 × 14', 31, 750, palette.white),
    line(465, 710, 875, 710, palette.cyan, 5), text(670, 755, '8 × 1 000 000', 31, 750, palette.muted, 'middle'),
    rounded(450, 800, 440, 95, palette.cyan, palette.cyan), text(670, 862, '≈ 4.84 TB', 44, 850, palette.navy, 'middle'),
  ].join('');
  return [
    ...item.labels.map((label, index) => {
      const y = 585 + index * 72;
      const colors = [palette.green, palette.cyan, palette.blue, palette.orange, palette.red];
      return `${circle(170, y, 25, colors[index], colors[index], 0)}${text(170, y + 9, index + 1, 25, 900, palette.navy, 'middle')}${line(202, y, 880, y, '#27486E', 3)}${text(235, y + 11, label.replace(/^\d\s+/, ''), 34, 750, palette.white)}`;
    }),
  ].join('');
}

function renderSvg(item) {
  const titleLines = item.title.split('\n');
  titleLines.forEach((value, index) => assertTextFits(value, 60, 936, `${item.slug} title line ${index + 1}`));
  assertTextFits(item.kicker, 22, 308, `${item.slug} kicker`);
  assertTextFits(item.labels[0], 31, 840, `${item.slug} primary label`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(item.topic)}</title><desc id="description">${escapeXml(item.altText)}</desc>
  <rect width="1080" height="1080" fill="${palette.navy}"/>
  <circle cx="945" cy="125" r="230" fill="#0A2142"/><circle cx="980" cy="940" r="310" fill="#091E3A"/>
  <rect x="72" y="60" width="10" height="64" rx="5" fill="${palette.cyan}"/>
  ${text(105, 92, 'WST', 36, 900, palette.white)}${text(105, 124, 'ACADEMY', 22, 800, palette.cyan)}
  ${rounded(668, 64, 340, 62, '#0C3158', '#1C4B78')}${text(838, 104, item.kicker, 22, 750, palette.muted, 'middle')}
  ${titleLines.map((value, index) => text(72, 245 + index * 78, value, 60, 820, palette.white)).join('')}
  ${rounded(72, 430, 936, 92, '#0C3158', '#1C4B78')}
  ${text(540, 488, item.labels[0], 31, 800, palette.cyan, 'middle')}
  ${diagram(item)}
  ${line(72, 972, 1008, 972, '#284D78', 2)}
  ${text(72, 1020, '@wst_academy_qabul_bot', 28, 750, palette.white)}
  ${text(1008, 1020, 'AMALIY BILIM • REAL USKUNA', 24, 700, palette.muted, 'end')}
  </svg>`;
}

function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map((part) => Number.parseInt(part, 16) / 255).map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
function contrast(a, b) { const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (lighter + 0.05) / (darker + 0.05); }

if (!Array.isArray(series) || series.length !== 5) throw new Error('Expected exactly five channel content records.');
if (contrast(palette.white, palette.navy) < 7 || contrast(palette.cyan, palette.navy) < 4.5 || contrast(palette.muted, palette.navy) < 4.5) throw new Error('Brand palette does not meet contrast targets.');
await mkdir(svgDir, { recursive: true });
const assets = [];
for (const item of series) {
  if (!item.caption.endsWith('@wst_academy_qabul_bot')) throw new Error(`${item.slug}: exact Academy CTA is required.`);
  if (item.caption.length > 1024) throw new Error(`${item.slug}: Telegram caption exceeds 1024 characters.`);
  if (!item.altText || item.altText.length < 40) throw new Error(`${item.slug}: meaningful accessibility description is required.`);
  const svgPath = path.join(svgDir, `${item.slug}.svg`);
  const pngPath = path.join(outputDir, `${item.slug}.png`);
  await writeFile(svgPath, `${renderSvg(item)}\n`, 'utf8');
  await renderPng(svgPath, pngPath, 1080);
  const png = await readFile(pngPath);
  assets.push({
    contentKey: item.contentKey,
    scheduledAt: item.scheduledAt,
    topic: item.topic,
    caption: item.caption,
    altText: item.altText,
    png: path.relative(root, pngPath).replaceAll('\\', '/'),
    svg: path.relative(root, svgPath).replaceAll('\\', '/'),
    sha256: sha256(png),
    bytes: png.length,
    width: 1080,
    height: 1080,
    sourceLedger: {
      creator: 'WST Academy in-repository renderer',
      source: 'Original SVG geometry and text authored for WST Academy',
      externalImagery: false,
      manufacturerAssets: false,
      license: 'WST-owned original artwork',
    },
  });
}
const avatarSvgPath = path.join(svgDir, 'wst-academy-channel-avatar.svg');
const avatarPngPath = path.join(outputDir, 'wst-academy-channel-avatar.png');
const avatarSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800" role="img" aria-labelledby="avatar-title avatar-description">
<title id="avatar-title">WST Academy channel avatar</title><desc id="avatar-description">Original WST Academy typographic wordmark on a dark blue circular-safe background.</desc>
<rect width="800" height="800" fill="${palette.navy}"/><circle cx="400" cy="400" r="350" fill="#0A2142" stroke="${palette.cyan}" stroke-width="18"/>
<circle cx="400" cy="268" r="82" fill="${palette.navy}" stroke="${palette.cyan}" stroke-width="16"/><circle cx="400" cy="268" r="32" fill="${palette.blue}"/><circle cx="400" cy="268" r="10" fill="${palette.white}"/>
${text(400, 485, 'WST', 188, 900, palette.white, 'middle')}${text(400, 585, 'ACADEMY', 64, 850, palette.cyan, 'middle')}
<rect x="246" y="630" width="308" height="12" rx="6" fill="${palette.blue}"/>
</svg>`;
await writeFile(avatarSvgPath, `${avatarSvg}\n`, 'utf8');
await renderPng(avatarSvgPath, avatarPngPath, 800);
const avatarPng = await readFile(avatarPngPath);
const avatar = {
  png: path.relative(root, avatarPngPath).replaceAll('\\', '/'),
  svg: path.relative(root, avatarSvgPath).replaceAll('\\', '/'),
  sha256: sha256(avatarPng),
  bytes: avatarPng.length,
  width: 800,
  height: 800,
  altText: 'Original WST Academy wordmark and camera-lens symbol on a dark blue background.',
  sourceLedger: {
    creator: 'WST Academy in-repository renderer',
    source: 'Original SVG geometry and typographic wordmark authored for WST Academy',
    externalImagery: false,
    manufacturerAssets: false,
    license: 'WST-owned original artwork',
  },
};
await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, series: 'academy-technical-2026-07-16-to-20', palette, minimumTextPx: 22, avatar, assets }, null, 2)}\n`, 'utf8');
console.log(`Rendered ${assets.length} channel previews and one channel avatar to ${outputDir}`);
