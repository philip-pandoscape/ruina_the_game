import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test } from 'vitest';
import { makeRng } from '../../src/util/rng';
import { EMBERHOLM } from '../../src/sim/zone/world';
import { generateZone } from '../../src/sim/zone/generate';

// The server runs the island's rules on the same island as the browser: it reads Emberholm from
// crates/engine/data/emberholm.zone, baked from the TypeScript generator (src/sim/zone/generate.ts), and
// samples the ground on the same triangles (crates/engine/src/open/zone.rs). After changing the island
// or its generator, rebake:
//   npm run bake
//
// File: b"RUZN", u32 version (1), u32 cells, f64 cell size, f64 water level, f64 world X/Z of
// vertex (0, 0); (cells + 1)^2 f32 heights, row by row; cells^2 u8 surfaces; cells^2 u8 "kept
// clear" flags; u32 count + obstacles (u8 kind, f64 x, z, r); then u32 count + boxes and u32 count
// + decks (f64 x, z, hw, hd, rot, cos, sin, top). Little-endian throughout.

const FILE = 'crates/engine/data/emberholm.zone';
const CHECK = `target/release/terraincheck${process.platform === 'win32' ? '.exe' : ''}`;
/** Obstacle kinds by number, in the order crates/engine/src/open/zone.rs reads them. */
const KINDS = ['tree', 'rock', 'crate', 'hay', 'post'];

function bake(): Buffer {
  // Grown afresh rather than taken from makeZoneWorld(), whose cached copy the rules add to.
  const gen = generateZone(EMBERHOLM);
  const hf = gen.terrain;
  const head = Buffer.alloc(36);
  head.write('RUZN', 0, 'latin1');
  head.writeUInt32LE(1, 4);
  head.writeUInt32LE(hf.cells, 8);
  head.writeDoubleLE(hf.cell, 12);
  head.writeDoubleLE(hf.water, 20);
  head.writeDoubleLE(hf.min, 28);
  const bytes = (a: Float32Array | Uint8Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  const obstacles = Buffer.alloc(4 + gen.obstacles.length * 25);
  obstacles.writeUInt32LE(gen.obstacles.length, 0);
  gen.obstacles.forEach((o, i) => {
    const at = 4 + i * 25;
    const kind = KINDS.indexOf(o.kind);
    if (kind < 0) throw new Error(`obstacle kind "${o.kind}" has no number in KINDS`);
    obstacles.writeUInt8(kind, at);
    obstacles.writeDoubleLE(o.x, at + 1);
    obstacles.writeDoubleLE(o.z, at + 9);
    obstacles.writeDoubleLE(o.r, at + 17);
  });
  const rects = (list: typeof gen.boxes) => {
    const out = Buffer.alloc(4 + list.length * 64);
    out.writeUInt32LE(list.length, 0);
    list.forEach((b, i) => [b.x, b.z, b.hw, b.hd, b.rot, b.cos, b.sin, b.top].forEach((v, k) => out.writeDoubleLE(v, 4 + i * 64 + k * 8)));
    return out;
  };
  return Buffer.concat([head, bytes(hf.heights), bytes(hf.surface), bytes(gen.clear), obstacles, rects(gen.boxes), rects(gen.decks)]);
}

test("the server's copy of the island is current", () => {
  const want = bake();
  if (process.env.BAKE) {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, want);
  }
  const have = existsSync(FILE) ? readFileSync(FILE) : Buffer.alloc(0);
  expect(have.equals(want), `${FILE} is stale: run npm run bake`).toBe(true);
});

test('the server and the browser agree on the ground', (ctx) => {
  ctx.skip(!existsSync(CHECK), 'build the server first: cargo build --release');
  const gen = generateZone(EMBERHOLM);
  const hf = gen.terrain;
  const rng = makeRng(20261104);
  const points: Array<[number, number]> = [];
  for (let i = 0; i < 2000; i++) points.push([hf.min - 20 + rng() * (hf.size + 40), hf.min - 20 + rng() * (hf.size + 40)]);
  // And densely over the waterfalls' slots, ledges and pools, a small patch the scatter above may miss.
  for (const f of gen.falls)
    for (let k = 0; k < 400; k++) {
      const s = f.lip - 8 + rng() * (f.foot - f.lip + 12);
      const t = (rng() - 0.5) * (f.width + 8);
      points.push([f.cx + f.ux * s + f.vx * t, f.cz + f.uz * s + f.vz * t]);
    }
  // Heights, slopes and surfaces at each point.
  const server = JSON.parse(execFileSync(CHECK, { input: JSON.stringify(points) }).toString()) as Array<[number, number, number]>;
  let worst = 0;
  points.forEach(([x, z], i) => {
    const [h, slope, surface] = server[i];
    worst = Math.max(worst, Math.abs(h - hf.height(x, z)), Math.abs(slope - hf.slope(x, z)));
    expect(surface, `surface at ${x}, ${z}`).toBe(hf.surfaceAt(x, z));
  });
  expect(worst).toBeLessThan(1e-9);
});
