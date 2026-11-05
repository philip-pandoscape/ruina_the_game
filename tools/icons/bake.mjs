// Bakes the game's pixel icons: every "icon" emoji in shared/*.json, plus the extras below, drawn
// from Twemoji (CC-BY 4.0, see tools/icons/twemoji/LICENSE-GRAPHICS.txt) at 16 x 16, with a hard
// edge, a shaded lower-right and a one-pixel outline in the UI's ink. Seed packets show the crop
// they grow; a few icons are drawn for the game instead (DRAWN). Writes src/ui/theme/icons.gen.ts.
// Run: npm run icons (needs the network the first time a new emoji appears, to fetch its SVG; the
// SVGs are kept in tools/icons/twemoji/).
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const SVG_DIR = path.join(ROOT, 'tools/icons/twemoji');
const OUT = path.join(ROOT, 'src/ui/theme/icons.gen.ts');

// Icons the UI needs beyond what content names: empty equipment slots, skill tree notables and
// keystones, and better art for a couple of skills.
const EXTRA = ['🪖', '👕', '🧤', '👖', '🥾', '🛡️', '🔨', '🐎', '📦', '🪁', '🗡️', '🪄', '🏹', '⚔️', '💪', '💥', '🌪️', '💧', '🍀', '🌿', '💚', '🔥', '🌋', '☀️', '🧠', '🎯', '👁️', '🐾', '💨', '🌟', '🧿', '❄️', '🗝️', '🏃', '📖', '⚙️'];
// Seed packets: the band colour for the crop each seed grows.
const BANDS = { sunroot: ['#6aa84f', '#3f7a2e'], barley: ['#d9a53a', '#a8741c'], flax: ['#4a86c8', '#2e5c94'], emberberry: ['#c8423a', '#8e2a24'] };
// Icons drawn for the game rather than taken from Twemoji, under the emoji content names them by:
// colour pixels on 14 x 14 ('.' is clear), finished like the rest (shaded lower-right, outlined in
// ink). The emoji still shows wherever text can't hold the art (the big map writes emoji as text).
const DRAWN = {
  // The farm cart as it is in the world (src/render/models/vehicles.ts), facing left: lantern and
  // seat at the front, the green bed with its cream trim, red spoked wheels, the pennant at the back.
  '🚜': {
    pal: { g: '#5aab5f', G: '#3f8046', c: '#f2e2b0', d: '#734828', D: '#4f3121', r: '#d8603f', R: '#a83c28', y: '#e0ac3a', f: '#d9473b', l: '#ffd47e' },
    rows: [
      '...........dff',
      '...........dff',
      '...........df.',
      '...yD......d..',
      'D..yD..D...d.D',
      'lyyyDggggggggg',
      'DgggDccccccccc',
      'DGGGGGGGGGGGGG',
      '.rrrrDDDDrrrr.',
      'rR..RrDDrR..Rr',
      'r.RR.r..r.RR.r',
      'r.RR.r..r.RR.r',
      'rR..Rr..rR..Rr',
      '.rrrr....rrrr.',
    ],
  },
};

const codeOf = (e) => [...e].map((c) => c.codePointAt(0).toString(16)).filter((x) => x !== 'fe0f').join('-');

function collect() {
  const icons = new Set(EXTRA);
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) k === 'icon' && typeof x === 'string' ? icons.add(x) : walk(x);
  };
  const files = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? files(path.join(d, f.name)) : f.name.endsWith('.json') ? [path.join(d, f.name)] : []));
  for (const f of files(path.join(ROOT, 'shared'))) walk(JSON.parse(fs.readFileSync(f, 'utf8')));
  return [...icons].filter((e) => /\p{Extended_Pictographic}/u.test(e));
}

async function svgFor(code) {
  const file = path.join(SVG_DIR, `${code}.svg`);
  if (!fs.existsSync(file)) {
    const res = await fetch(`https://raw.githubusercontent.com/jdecked/twemoji/main/assets/svg/${code}.svg`);
    if (!res.ok) throw new Error(`no Twemoji SVG for ${code} (${res.status})`);
    fs.writeFileSync(file, await res.text());
  }
  return `data:image/svg+xml;base64,${fs.readFileSync(file).toString('base64')}`;
}

const emojis = collect();
fs.mkdirSync(SVG_DIR, { recursive: true });
const svgs = {};
const fromTwemoji = emojis.filter((e) => !DRAWN[e]);
for (const e of fromTwemoji) svgs[e] = await svgFor(codeOf(e));
// Keep only the SVGs in use, so the folder says exactly what the game draws.
const used = new Set(fromTwemoji.map((e) => `${codeOf(e)}.svg`));
for (const f of fs.readdirSync(SVG_DIR)) if (f.endsWith('.svg') && !used.has(f)) fs.unlinkSync(path.join(SVG_DIR, f));
const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/items.json'), 'utf8')).items;
const packets = items.filter((i) => i.id.startsWith('seed.') && i.plants && items.some((p) => p.id === i.plants)).map((i) => ({ id: i.id, crop: items.find((p) => p.id === i.plants).icon, band: BANDS[i.plants] ?? ['#8a5a32', '#5a3720'] }));

const drawn = Object.fromEntries(Object.entries(DRAWN).filter(([e]) => emojis.includes(e)));

const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
const page = await browser.newPage();
await page.setContent('<!doctype html><body></body>');
const result = await page.evaluate(async ({ svgs, packets, drawn }) => {
  const load = async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  };
  // Every icon's finish: the art's lower-right edges shaded, and a one-pixel outline in ink.
  function finish(od, solid, size, shade = true, ink = [43, 26, 14]) {
    if (shade) {
      for (let p = 0; p < size * size; p++) {
        if (!solid[p]) continue;
        const x = p % size;
        const y = Math.floor(p / size);
        if (y + 1 >= size || !solid[p + size] || x + 1 >= size || !solid[p + 1]) for (let c = 0; c < 3; c++) od.data[p * 4 + c] = Math.round(od.data[p * 4 + c] * 0.72);
      }
    }
    for (let p = 0; p < size * size; p++) {
      if (solid[p]) continue;
      const x = p % size;
      const y = Math.floor(p / size);
      if ((x > 0 && solid[p - 1]) || (x < size - 1 && solid[p + 1]) || (y > 0 && solid[p - size]) || (y < size - 1 && solid[p + size])) od.data.set([...ink, 255], p * 4);
    }
  }
  async function pixel(url, { size = 16, inner = 14, levels = 7, cut = 120, shade = true, ink = [43, 26, 14] } = {}) {
    const img = await load(url);
    const big = document.createElement('canvas');
    big.width = big.height = inner * 8;
    big.getContext('2d').drawImage(img, 0, 0, inner * 8, inner * 8);
    const small = document.createElement('canvas');
    small.width = small.height = inner;
    const sg = small.getContext('2d');
    sg.imageSmoothingQuality = 'high';
    sg.drawImage(big, 0, 0, inner, inner);
    const src = sg.getImageData(0, 0, inner, inner).data;
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const og = out.getContext('2d');
    const od = og.createImageData(size, size);
    const solid = new Uint8Array(size * size);
    const off = Math.floor((size - inner) / 2);
    const q = (v) => Math.round(Math.round((v / 255) * (levels - 1)) * (255 / (levels - 1)));
    for (let y = 0; y < inner; y++) {
      for (let x = 0; x < inner; x++) {
        const i = (y * inner + x) * 4;
        if (src[i + 3] < cut) continue;
        const p = (y + off) * size + (x + off);
        od.data.set([q(src[i]), q(src[i + 1]), q(src[i + 2]), 255], p * 4);
        solid[p] = 1;
      }
    }
    finish(od, solid, size, shade, ink);
    og.putImageData(od, 0, 0);
    return out;
  }
  // Art drawn for the game: its rows of colour pixels in the middle of a 16 x 16 tile, finished the same.
  function draw({ pal, rows }) {
    const size = 16;
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const og = out.getContext('2d');
    const od = og.createImageData(size, size);
    const solid = new Uint8Array(size * size);
    rows.forEach((row, y) =>
      [...row].forEach((ch, x) => {
        if (ch === '.') return;
        const p = (y + 1) * size + (x + 1);
        od.data.set([...rgb(pal[ch]), 255], p * 4);
        solid[p] = 1;
      }),
    );
    finish(od, solid, size);
    og.putImageData(od, 0, 0);
    return out;
  }
  const PACKET = ['................', '..############..', '..#bBbBbBbBbB#..', '..#bbbbbbbbbb#..', '..#pwwwwwwwwp#..', '..#pwwwwwwwwp#..', '..#pwwwwwwwwp#..', '..#pwwwwwwwwp#..', '..#pwwwwwwwwp#..', '..#pwwwwwwwwp#..', '..#pwwwwwwwwp#..', '..#pwwwwwwwwp#..', '..#ppppppppPP#..', '..#PPPPPPPPPP#..', '..############..', '................'];
  const rgb = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  const out = { emoji: {}, item: {} };
  for (const [e, url] of Object.entries(svgs)) out.emoji[e] = (await pixel(url)).toDataURL('image/png');
  for (const [e, art] of Object.entries(drawn)) out.emoji[e] = draw(art).toDataURL('image/png');
  for (const p of packets) {
    const pal = { '#': [58, 36, 18], b: rgb(p.band[0]), B: rgb(p.band[1]), p: [236, 215, 168], P: [201, 164, 108], w: [255, 246, 223] };
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d');
    const img = g.createImageData(16, 16);
    PACKET.forEach((row, y) => [...row].forEach((ch, x) => ch !== '.' && img.data.set([...pal[ch], 255], (y * 16 + x) * 4)));
    g.putImageData(img, 0, 0);
    g.drawImage(await pixel(svgs[p.crop], { size: 8, inner: 7, shade: false }), 4, 4);
    out.item[p.id] = c.toDataURL('image/png');
  }
  return out;
}, { svgs, packets, drawn });
await browser.close();

const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
fs.writeFileSync(
  OUT,
  `// Generated by tools/icons/bake.mjs from Twemoji (CC-BY 4.0, https://github.com/jdecked/twemoji), with a few drawn for the game. Do not edit.\n` +
    `// Each is a 16 x 16 PNG. EMOJI_ICONS is keyed by the emoji content uses; ITEM_ICONS overrides by item id.\n\n` +
    `export const EMOJI_ICONS: Record<string, string> = ${JSON.stringify(sorted(result.emoji), null, 1)};\n\n` +
    `export const ITEM_ICONS: Record<string, string> = ${JSON.stringify(sorted(result.item), null, 1)};\n`,
);
console.log(`baked ${Object.keys(result.emoji).length} emoji and ${Object.keys(result.item).length} seed packets into ${path.relative(ROOT, OUT)}`);
