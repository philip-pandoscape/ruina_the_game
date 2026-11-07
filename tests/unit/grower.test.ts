import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { answer, type GrowerPort, type GrowerReply, type GrownMessage, RegionGrower, regionOf } from '../../src/app/grower';
import { DROP, GROW, Regions, regionFiles } from '../../src/app/regions';
import { ruleFor } from '../../src/assets/catalog';
import { defaultBuild } from '../../src/content/build';
import { Engine } from '../../src/engine/engine';
import { growRegionHere, regionsNear } from '../../src/engine/zone';
import { useContent } from '../../src/engine/wasm';

// The page's region grower (src/app/grower.ts) and the regions it keeps round you (regions.ts), on
// the tests' fixture world (tests/fixtures/world/: Emberholm, Saltmere across the sea to its west,
// Thornmarch beside Saltmere across a land border at x = 2048 m), given to this file's engine before
// it reads anything, as the page gives it to its own and its worker's (?fixture=world). The worker's
// side is answered in-process (`answer`, what grower.worker.ts runs), so its protocol, the page's
// side of it and what the regions do with what it hands over are all checked without a browser.

const dir = 'tests/fixtures/world';
const bundles: Record<string, unknown> = { 'world.json': JSON.parse(readFileSync(`${dir}/world.json`, 'utf8')) };
for (const f of readdirSync(`${dir}/regions`)) bundles[`regions/${f}`] = JSON.parse(readFileSync(`${dir}/regions/${f}`, 'utf8'));
useContent(bundles);

const EMBERHOLM = 0;
const SALTMERE = 1;
const THORNMARCH = 2;

/** A worker answering in-process, a reply at a time as a real one would (after the asking returns). */
function inProcess(): GrowerPort & { asked: string[] } {
  const port: GrowerPort & { asked: string[] } = {
    asked: [],
    onmessage: null,
    postMessage(req) {
      port.asked.push(req.t === 'grow' ? `grow ${req.place}` : req.t);
      setTimeout(() => port.onmessage?.({ data: answer(req).reply as GrowerReply }));
    },
  };
  return port;
}

test('the worker says where the regions stand, and grows one whole: the same as grown on the page', async () => {
  const ready = answer({ t: 'start', content: null }).reply;
  expect(ready.t).toBe('ready');
  if (ready.t !== 'ready') return;
  expect(ready.layout.regions.map((r) => r.id)).toEqual(['emberholm', 'saltmere', 'thornmarch']);
  expect(ready.layout.regions[SALTMERE]).toMatchObject({ chunks: { x: 4, z: -2, w: 4, d: 4 }, minX: 1024, minZ: -512, cells: 512, cell: 2 });

  const { reply, move } = answer({ t: 'grow', place: SALTMERE });
  expect(reply.t).toBe('grown');
  const m = reply as GrownMessage;
  // Everything handed over moves with it rather than being copied.
  expect(move).toEqual([m.heights.buffer, m.surface.buffer, m.clear.buffer, m.edges.buffer, m.depths.buffer, m.picture.buffer]);
  expect(m.heights.length).toBe(513 * 513);
  expect(m.depths.length).toBe(512 * 512);
  expect(m.picture.length).toBe(768 * 768 * 4);
  expect(m.growMs).toBeGreaterThan(0);
  // As the page reads it, the region grown on the page's own thread to the bit.
  const there = regionOf(m);
  const here = growRegionHere(SALTMERE);
  expect(there.recipe.id).toBe('saltmere');
  expect(Buffer.from(there.gen.terrain.heights.buffer).equals(Buffer.from(here.gen.terrain.heights.buffer))).toBe(true);
  expect(Buffer.from(there.gen.terrain.surface).equals(Buffer.from(here.gen.terrain.surface))).toBe(true);
  expect(Buffer.from(there.edges.buffer).equals(Buffer.from(here.edges.buffer))).toBe(true);
  expect(there.gen.obstacles).toEqual(here.gen.obstacles);
  expect([there.gen.terrain.minX, there.gen.terrain.minZ]).toEqual([1024, -512]);
  // No region there: it says so.
  expect(answer({ t: 'grow', place: 9 }).reply).toMatchObject({ t: 'failed', place: 9 });
});

test("the page's side starts the worker, asks for regions and hears each as it's grown", async () => {
  const port = inProcess();
  const grower = new RegionGrower(port, bundles);
  expect(port.asked).toEqual(['start']);
  const layout = await grower.ready;
  expect(layout.regions).toHaveLength(3);
  // Asked for twice before it's grown: asked of the worker once, heard by both.
  const [a, b] = await Promise.all([grower.grow(THORNMARCH), grower.grow(THORNMARCH)]);
  expect(port.asked).toEqual(['start', `grow ${THORNMARCH}`]);
  expect(a).toBe(b);
  expect(a.place).toBe(THORNMARCH);
  expect(grower.pending).toEqual([]);
  await expect(grower.grow(9)).rejects.toThrow('region 9');
});

test('the regions round you: the nearest grown ahead of you one at a time, adopted by the rules, let go behind you', async () => {
  const engine = new Engine({ openWorld: true, online: false, build: defaultBuild() });
  const port = inProcess();
  const grower = new RegionGrower(port, bundles);
  await grower.ready;
  const regions = new Regions({ engine, stage: null, pictures: null, grower, frame: () => engine.frame });
  // The world starts holding the region you start in alone.
  expect(regions.held).toEqual([EMBERHOLM]);
  expect(engine.regionsHeld()).toEqual({ held: [EMBERHOLM], unheld: 0 });
  // Off Emberholm's west coast: Saltmere is within reach, Thornmarch isn't.
  const sea = { x: 900, z: 0 };
  expect(regionsNear(engine.layout!, sea.x, sea.z, GROW)).toEqual([SALTMERE, EMBERHOLM]);
  regions.update(sea.x, sea.z);
  expect(regions.pending).toBe(SALTMERE);
  regions.update(sea.x, sea.z);
  expect(port.asked.filter((q) => q.startsWith('grow'))).toEqual([`grow ${SALTMERE}`]);
  await regions.readyAt(sea.x, sea.z);
  regions.update(sea.x, sea.z);
  expect(regions.held).toEqual([EMBERHOLM, SALTMERE]);
  // The rules hold it as handed over: nothing grown on the page's thread to answer its ground.
  expect(engine.regionsHeld()).toEqual({ held: [EMBERHOLM, SALTMERE], unheld: 0 });
  expect(engine.groundY(1700, 0)).toBeGreaterThan(0);
  expect(engine.regionsHeld().unheld).toBe(0);
  // On into Saltmere: Thornmarch next.
  await regions.readyAt(1990, 0);
  regions.update(1990, 0);
  expect(regions.held).toEqual([EMBERHOLM, SALTMERE, THORNMARCH]);
  // Far east into Thornmarch: Saltmere more than DROP behind is let go, by the rules too; Emberholm,
  // where lives belong, is kept.
  regions.update(2048 + DROP + 10, 0);
  expect(regions.held).toEqual([EMBERHOLM, THORNMARCH]);
  expect(engine.regionsHeld().held).toEqual([EMBERHOLM, THORNMARCH]);
  expect(regions.log.map((e) => `${e.t} ${e.id}`)).toEqual(['arrived saltmere', 'arrived thornmarch', 'dropped saltmere']);
  // What's solid follows: Saltmere's trees are no longer in the page's colliders.
  const tree = growRegionHere(SALTMERE).gen.obstacles.find((o) => o.kind === 'tree')!;
  expect(engine.world.index!.obstacles.some((o) => o.x === tree.x && o.z === tree.z)).toBe(false);
});

test("a region's files are what its looks name, each one the catalogue's", () => {
  // Emberholm's: its made buildings and props, and the village kit its town is built of.
  const ember = regionFiles(growRegionHere(EMBERHOLM).recipe);
  expect(ember).toEqual(expect.arrayContaining(['village/kit', 'village/props', 'models/windmill']));
  for (const id of ember) expect(ruleFor(id)?.zones, id).toContain('emberholm');
  // Saltmere's lamps; Thornmarch has nothing made, only the trees and ground every region shares.
  expect(regionFiles(growRegionHere(SALTMERE).recipe)).toEqual(expect.arrayContaining(['models/lamp']));
  expect(regionFiles(growRegionHere(THORNMARCH).recipe)).toEqual([]);
});
