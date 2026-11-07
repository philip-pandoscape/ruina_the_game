import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, test } from 'vitest';
import { makeRng } from '../../src/util/rng';
import { EMBERHOLM, generateZone } from '../../src/engine/zone';

// The server and the browser play the same island: the engine grows it from its recipe
// (crates/engine/src/open/generate.rs), natively on the server and in the browser through its
// WebAssembly (generateZone, src/engine/wasm.ts). Here the browser's is held to the server's, all
// of what grows and handed over, and the ground as the TypeScript rules sample it (src/engine/world/terrain.ts)
// to the engine's sampling, until the browser's rules are the engine's too.

const CHECK = `target/release/terraincheck${process.platform === 'win32' ? '.exe' : ''}`;

/**
 * Where two values differ, as paths, numbers within a part in a billion (the generator's sines and
 * cosines come from libm in Rust and from V8 here, and a few differ in the last bit). A field one
 * side leaves out and the other has as nothing (undefined, null) is the same.
 */
function differences(a: unknown, b: unknown, path: string, out: string[]): void {
  if (out.length > 20) return;
  if (typeof a === 'number' && typeof b === 'number') {
    if (!(a === b || (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))))
      out.push(`${path}: ${a} != ${b}`);
    return;
  }
  if (Array.isArray(a) || ArrayBuffer.isView(a)) {
    const x = Array.from(a as ArrayLike<unknown>);
    const y = Array.isArray(b) || ArrayBuffer.isView(b) ? Array.from(b as ArrayLike<unknown>) : null;
    if (!y || x.length !== y.length) {
      out.push(`${path}: ${x.length} items != ${y ? y.length : typeof b}`);
      return;
    }
    x.forEach((v, i) => differences(v, y[i], `${path}[${i}]`, out));
    return;
  }
  if (a && typeof a === 'object' && b && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const va = (a as Record<string, unknown>)[k];
      const vb = (b as Record<string, unknown>)[k];
      if (va == null && vb == null) continue;
      differences(va, vb, `${path}.${k}`, out);
    }
    return;
  }
  if (a !== b) out.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}

test('the browser grows the island the server does: ground, colliders, roads, placements, waterfalls, buildings', (ctx) => {
  ctx.skip(!existsSync(CHECK), 'build the server first: cargo build --release');
  const gen = generateZone(EMBERHOLM);
  const hf = gen.terrain;
  const rust = JSON.parse(execFileSync(CHECK, ['--zone'], { maxBuffer: 1 << 26 }).toString());
  expect([rust.cells, rust.cell, rust.water, rust.minX, rust.minZ]).toEqual([hf.cells, hf.cell, hf.water, hf.minX, hf.minZ]);
  // Heights are kept as f32 on both sides: to the bit.
  let heights = 0;
  hf.heights.forEach((h, i) => {
    if (Math.fround(rust.heights[i]) !== h) heights++;
  });
  expect(heights, 'heights that differ').toBe(0);
  expect(rust.heights.length).toBe(hf.heights.length);
  expect(Buffer.from(Uint8Array.from(rust.surface)).equals(Buffer.from(hf.surface)), 'surfaces').toBe(true);
  expect(Buffer.from(Uint8Array.from(rust.clear)).equals(Buffer.from(gen.clear)), 'cells kept clear').toBe(true);
  const out: string[] = [];
  differences(rust.obstacles, gen.obstacles, 'obstacles', out);
  for (const k of ['boxes', 'decks'] as const) differences(rust[k], gen[k], k, out);
  differences(rust.roads, gen.roads, 'roads', out);
  differences(rust.ramps, gen.ramps, 'ramps', out);
  differences(rust.placements, gen.placements, 'placements', out);
  differences(rust.falls, gen.falls, 'falls', out);
  // A building's walls are a stretch of the zone's boxes in the engine, the boxes themselves here.
  differences(
    rust.buildings.map((b: { boxes: [number, number] }) => ({ ...b, boxes: rust.boxes.slice(b.boxes[0], b.boxes[1]) })),
    gen.buildings.map(({ plan: _plan, ...b }) => b),
    'buildings',
    out,
  );
  expect(out).toEqual([]);
});

test('the server and the browser agree on the ground', (ctx) => {
  ctx.skip(!existsSync(CHECK), 'build the server first: cargo build --release');
  const gen = generateZone(EMBERHOLM);
  const hf = gen.terrain;
  const rng = makeRng(20261104);
  const points: Array<[number, number]> = [];
  for (let i = 0; i < 2000; i++) points.push([hf.minX - 20 + rng() * (hf.size + 40), hf.minZ - 20 + rng() * (hf.size + 40)]);
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
