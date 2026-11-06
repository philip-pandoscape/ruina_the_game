import { expect, test, type Page } from '@playwright/test';
import { buildingPlan, furnitureDef, furnitureIds, MODULE, modules, opening, sideLength, SIDES, STOREY, stairwell, turn, WALL } from '../src/content/buildings';
import { structureDef, structureIds } from '../src/content/structures';
import { generateZone } from '../src/sim/zone/generate';
import { inRect } from '../src/sim/zone/colliders';
import { EMBERHOLM } from '../src/sim/zone/world';

// The buildings you can walk into (src/content/buildings.ts, src/render/village): their plans fit
// their footprints and the kit, the rules wall them with their doorways open, and in the game you
// walk in through a door, are drawn the room cut open, and climb the stairs. The server plays the
// same walls and stairs from the baked island: tests/world-conformance.spec.ts walks into the inn
// and up its stairs on both sides.

const SHOTS = 'screenshots';

test('every building plan fits its structure: walls round the footprint, stairs and furniture inside', () => {
  const buildings = structureIds().filter((id) => structureDef(id).collider === 'building');
  expect(buildings.length, 'the town is built from plans').toBeGreaterThan(8);
  for (const id of [...buildings, 'cottage']) {
    const def = structureDef(id);
    const plan = buildingPlan(id)!;
    expect(plan, `${id} has a plan`).toBeTruthy();
    expect([plan.w, plan.d], `${id}: the plan's footprint is the structure's`).toEqual([def.w, def.d]);
    expect(plan.w % MODULE + (plan.d % MODULE), `${id}: on the kit's grid`).toBe(0);
    expect([4, 6, 8], `${id}: the kit has a roof that spans it`).toContain(plan.roof.ridge === 'z' ? plan.w : plan.d);
    plan.storeys.forEach((st, s) => {
      for (const side of SIDES) {
        const row = modules(st[side]);
        expect(row.length, `${id} storey ${s} ${side}: a module every 2 m`).toBe(sideLength(plan, side));
        for (const ch of row) expect('.WRwDOAG_', `${id} storey ${s} ${side}: "${ch}"`).toContain(ch);
      }
    });
    const doors = SIDES.flatMap((side) => modules(plan.storeys[0][side])).filter((ch) => opening(ch) !== null);
    expect(doors.length, `${id}: a way in on the ground floor`).toBeGreaterThan(0);
    for (const st of plan.stairs ?? []) {
      expect(st.storey, `${id}: stairs lead to a storey`).toBeLessThan(plan.storeys.length - 1);
      const well = stairwell(st);
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const [x, z] = turn(a * well.hw, b * well.hd, well.rot);
        expect(Math.abs(well.x + x), `${id}: stairwell inside`).toBeLessThanOrEqual(plan.w / 2 + 1e-6);
        expect(Math.abs(well.z + z), `${id}: stairwell inside`).toBeLessThanOrEqual(plan.d / 2 + 1e-6);
      }
    }
    for (const it of plan.items ?? []) {
      const f = furnitureDef(it.id);
      expect(it.storey ?? 0, `${id}: ${it.id} on a storey there is`).toBeLessThan(plan.storeys.length);
      expect(Math.abs(it.x), `${id}: ${it.id} inside`).toBeLessThanOrEqual(plan.w / 2 - WALL + 0.35);
      expect(Math.abs(it.z), `${id}: ${it.id} inside`).toBeLessThanOrEqual(plan.d / 2 - WALL + 0.35);
      expect(f.model || f.parts?.length || f.make, `${it.id} is drawn with something`).toBeTruthy();
    }
  }
  for (const id of furnitureIds()) {
    const f = furnitureDef(id);
    expect(f.w > 0 && f.d > 0 && f.h > 0, `${id}: a size`).toBe(true);
    if (f.collider === 'post') expect(f.r, `${id}: a radius`).toBeGreaterThan(0);
  }
});

test('the rules wall each building with its doorways open, floor its upper storeys and step its stairs', () => {
  const gen = generateZone(EMBERHOLM);
  expect(gen.buildings.length).toBeGreaterThan(15);
  for (const b of gen.buildings) {
    const storeys = b.plan.storeys.length;
    // Every door module's middle, just inside the wall, is clear of the walls; a plain module's isn't.
    for (const side of SIDES) {
      modules(b.plan.storeys[0][side]).forEach((ch, i) => {
        const len = sideLength(b.plan, side) * MODULE;
        const along = -len / 2 + MODULE / 2 + i * MODULE;
        const frame = { front: [0, b.plan.d / 2, 0], right: [b.plan.w / 2, 0, Math.PI / 2], back: [0, -b.plan.d / 2, Math.PI], left: [-b.plan.w / 2, 0, -Math.PI / 2] }[side] as [number, number, number];
        const [ox, oz] = turn(along, -WALL / 2, frame[2]);
        const [wx, wz] = turn(frame[0] + ox, frame[1] + oz, b.rot);
        const solid = b.boxes.some((box) => inRect(box, b.x + wx, b.z + wz));
        expect(solid, `${b.id} at (${b.x}, ${b.z}): ${side} module ${i} "${ch}"`).toBe(opening(ch) === null);
      });
    }
    if (storeys > 1) {
      // A deck at each upper floor, at the storey's height.
      const tops = new Set(gen.decks.filter((d) => Math.hypot(d.x - b.x, d.z - b.z) < Math.hypot(b.plan.w, b.plan.d) / 2).map((d) => +(d.top - b.y).toFixed(3)));
      for (let s = 1; s < storeys; s++) expect(tops.has(s * STOREY), `${b.id}: floor ${s}`).toBe(true);
    }
  }
});

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?world&test');
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 60_000 });
  await page.evaluate(() => (window as any).__game.reset());
  await page.waitForFunction(() => (window as any).__game.assetsReady === true, null, { timeout: 90_000 });
  return errors;
}

test('every piece and prop the buildings are made of is in the kit', async ({ page }) => {
  await open(page);
  const missing = await page.evaluate(async () => {
    const kitPath = '/src/render/village/kit.ts';
    const asmPath = '/src/render/village/assemble.ts';
    const contentPath = '/src/content/buildings.ts';
    const kit = await (await import(/* @vite-ignore */ kitPath)).loadKit();
    const { assemble } = await import(/* @vite-ignore */ asmPath);
    const c = await import(/* @vite-ignore */ contentPath);
    const out: string[] = [];
    const ids = c.buildingPlanIds();
    for (const id of ids)
      for (const stage of [1, 2, 3, 4]) {
        const a = assemble(c.buildingPlan(id), 1, stage);
        for (const p of [...a.pieces, ...a.doors]) if (!kit.pieces.has(p.piece)) out.push(`${id}: ${p.piece}`);
      }
    for (const id of c.furnitureIds()) {
      const f = c.furnitureDef(id);
      for (const m of [f.model, ...(f.parts ?? []).map((p: { model: string }) => p.model)]) if (m && !m.startsWith('@') && !kit.pieces.has(m)) out.push(`${id}: ${m}`);
    }
    return [...new Set(out)];
  });
  expect(missing).toEqual([]);
});

test('into the inn through its door and up its stairs: cut open above you, the door open, the lamps lit', async ({ page }) => {
  const errors = await open(page);
  const w = {
    advance: (n: number, a: Record<string, number> = {}) => page.evaluate(([f, x]) => (window as any).__game.advance(f, x), [n, a] as const),
    indoors: () => page.evaluate(() => (window as any).__game.indoors()),
    stats: () => page.evaluate(() => (window as any).__game.villageStats()),
  };
  const stats = await w.stats();
  expect(stats.drawn, 'the village is drawn').toBeGreaterThan(10);
  expect(stats.list.some((m: { name: string }) => m.name.startsWith('doors:')), 'with doors').toBe(true);
  expect(stats.list.some((m: { name: string }) => m.name === 'fires'), 'and fires in the hearths').toBe(true);
  // The inn faces south: its plan's +X is the world's -X, its +Z the world's -Z.
  await page.evaluate(() => (window as any).__game.teleport(-24, -226.5, 0));
  await w.advance(50, { moveZ: 1 });
  expect(await w.indoors(), 'in through the door').toMatchObject({ id: 'inn', storey: 0 });
  await page.evaluate(() => (window as any).__game.setCamera({ yaw: 0.6, pitch: 0.5, distance: 8 }));
  await w.advance(2);
  await page.screenshot({ path: `${SHOTS}/village-inn.png` });
  await w.advance(50, { moveX: -0.952, moveZ: 0.307 });
  await w.advance(12, { moveZ: 1 });
  await w.advance(70, { moveX: 1 });
  expect(await w.indoors(), 'up the stairs').toMatchObject({ id: 'inn', storey: 1 });
  await page.screenshot({ path: `${SHOTS}/village-inn-upstairs.png` });
  // Back out through the door the way you came in: down the stairs and out.
  await w.advance(80, { moveX: -1 });
  expect(await w.indoors(), 'back down').toMatchObject({ id: 'inn', storey: 0 });
  expect(errors).toEqual([]);
});
