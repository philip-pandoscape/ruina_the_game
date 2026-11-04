// Renders the island for the design bible: the real terrain generator, the real recipe, drawn as
// shaded relief, plus the lines and points the page overlays (roads, the ledge path, places).
// Bundled and run by design/build.mjs; not part of the game.

import { deflateSync } from 'node:zlib';
import recipe from '../shared/zones/emberholm.json' with { type: 'json' };
import { generateZone } from '../src/sim/zone/generate';
import { SURFACE } from '../src/sim/terrain';
import type { ZoneRecipe } from '../src/sim/zone/types';

const SURF: Record<number, [number, number, number]> = {
  [SURFACE.grass]: [134, 194, 92],
  [SURFACE.road]: [201, 166, 116],
  [SURFACE.sand]: [234, 216, 162],
  [SURFACE.rock]: [152, 152, 146],
  [SURFACE.soil]: [124, 88, 58],
  [SURFACE.plaza]: [216, 206, 184],
  [SURFACE.forest]: [92, 154, 76],
};

function png(width: number, height: number, rgb: Uint8Array): string {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const v of b) c = table[(c ^ v) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

export function renderMap(size = 640) {
  const z = recipe as unknown as ZoneRecipe;
  const gen = generateZone(z);
  const hf = gen.terrain;
  // Crop to the island and its waters rather than the whole square of sea.
  const half = 640;
  const span = half * 2;
  const rgb = new Uint8Array(size * size * 3);
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      // North up, east to the right: east is -X in the world.
      const x = half - ((px + 0.5) / size) * span;
      const zz = half - ((py + 0.5) / size) * span;
      const h = hf.height(x, zz);
      let c: [number, number, number];
      if (h < hf.water) {
        const d = Math.min(1, (hf.water - h) / 22);
        c = [Math.round(122 - 70 * d), Math.round(206 - 96 * d), Math.round(216 - 52 * d)];
      } else {
        const base = SURF[hf.surfaceAt(x, zz)] ?? SURF[SURFACE.grass];
        const g = hf.gradient(x, zz);
        const shade = Math.max(0.55, Math.min(1.3, 1 + g.x * 0.5 - g.z * 0.5));
        const lift = Math.min(1.18, 0.92 + h / 220);
        c = [0, 1, 2].map((i) => Math.max(0, Math.min(255, Math.round(base[i] * shade * lift)))) as [number, number, number];
      }
      rgb.set(c, (py * size + px) * 3);
    }
  const thin = (pts: Array<[number, number]>, every: number) => pts.filter((_, i) => i % every === 0 || i === pts.length - 1).map(([x, zz]) => [Math.round(x), Math.round(zz)]);
  let maxH = 0;
  for (const v of hf.heights) maxH = Math.max(maxH, v);
  return {
    png: png(size, size, rgb),
    size,
    half,
    roads: gen.roads.map((r) => ({ id: r.id, points: thin(r.points, 4) })),
    ramps: gen.ramps.map((r) => thin(r, 12)),
    stats: { trees: gen.obstacles.filter((o) => o.kind === 'tree').length, rocks: gen.obstacles.filter((o) => o.kind === 'rock').length, peak: Math.round(maxH), cell: hf.cell, cells: hf.cells },
  };
}
