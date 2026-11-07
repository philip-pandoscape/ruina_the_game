import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { growRegionHere, WorldGround, worldLayout } from '../../src/engine/zone';
import { useContent } from '../../src/engine/wasm';
import { makeRng } from '../../src/util/rng';

// The page's ground across a world of regions (src/engine/world/worldGround.ts) held to the engine's
// world map (crates/engine/src/open/map.rs), on the tests' fixture world (tests/fixtures/world/:
// Emberholm, Saltmere across the open sea to its west, Thornmarch beside Saltmere across a land border):
// inside each region, across the land border, in the open sea sloping up to meet a region within
// the blend of its edge, and out at sea. This file's engine is given the fixture world before it reads
// anything, the regions grown in it as the page's worker grows them; the native engine's answers
// come from `terraincheck --world world`.

const CHECK = `target/release/terraincheck${process.platform === 'win32' ? '.exe' : ''}`;

const dir = 'tests/fixtures/world';
const bundles: Record<string, unknown> = { 'world.json': JSON.parse(readFileSync(`${dir}/world.json`, 'utf8')) };
for (const f of readdirSync(`${dir}/regions`)) bundles[`regions/${f}`] = JSON.parse(readFileSync(`${dir}/regions/${f}`, 'utf8'));
useContent(bundles);

test("the page's ground across the fixture world's regions and the sea between is the engine's, to the bit", (ctx) => {
  ctx.skip(!existsSync(CHECK), 'build the server first: cargo build --release');
  const layout = worldLayout();
  const ground = new WorldGround(layout);
  layout.regions.forEach((_, place) => {
    const r = growRegionHere(place);
    ground.hold(place, r.gen.terrain, r.edges);
  });
  const rng = makeRng(20261106);
  const points: Array<[number, number]> = [];
  const [x0, z0, x1, z1] = layout.bounds;
  // All over the world, then thickly along every border (each region's edges: the land border and
  // the open sea's), where the ground is blended.
  for (let i = 0; i < 3000; i++) points.push([x0 + rng() * (x1 - x0), z0 + rng() * (z1 - z0)]);
  for (const r of layout.regions) {
    const [bx0, bz0, bx1, bz1] = [
      r.chunks.x * layout.chunk,
      r.chunks.z * layout.chunk,
      (r.chunks.x + r.chunks.w) * layout.chunk,
      (r.chunks.z + r.chunks.d) * layout.chunk,
    ];
    for (let i = 0; i < 600; i++) {
      const along = rng();
      const across = (rng() - 0.5) * 2 * (layout.blend + 8);
      points.push([bx0 + across, bz0 + along * (bz1 - bz0)], [bx1 + across, bz0 + along * (bz1 - bz0)]);
      points.push([bx0 + along * (bx1 - bx0), bz0 + across], [bx0 + along * (bx1 - bx0), bz1 + across]);
    }
  }
  // Exactly on vertices and chunk edges too.
  for (const x of [768, 1024, 2048, 3072]) for (const z of [-512, -256, 0, 2, 255, 512]) points.push([x, z]);
  const native = JSON.parse(execFileSync(CHECK, ['--world', 'world'], { input: JSON.stringify(points), maxBuffer: 1 << 26 }).toString()) as Array<
    [number, number, number]
  >;
  let heights = 0;
  let worst = 0;
  points.forEach(([x, z], i) => {
    const [h, slope, surface] = native[i];
    if (h !== ground.height(x, z)) heights++;
    worst = Math.max(worst, Math.abs(slope - ground.slope(x, z)));
    expect(surface, `surface at ${x}, ${z}`).toBe(ground.surfaceAt(x, z));
  });
  expect(heights, 'heights that differ').toBe(0);
  expect(worst).toBeLessThan(1e-9);
});
