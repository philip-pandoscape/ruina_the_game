import { expect, test } from 'vitest';
import {
  buildingPlan,
  furnitureDef,
  furnitureIds,
  MODULE,
  modules,
  opening,
  sideLength,
  SIDES,
  STOREY,
  stairwell,
  turn,
  WALL,
} from '../../src/content/buildings';
import { structureDef, structureIds } from '../../src/content/structures';
import { generateZone } from '../../src/sim/zone/world';
import { inRect } from '../../src/sim/zone/colliders';
import { EMBERHOLM } from '../../src/sim/zone/world';

// The buildings you can walk into (src/content/buildings.ts): their plans fit their footprints, and
// the rules wall them with their doorways open. Walking in, in the game: tests/integration/village.spec.ts.

test('every building plan fits its structure: walls round the footprint, stairs and furniture inside', () => {
  const buildings = structureIds().filter((id) => structureDef(id).collider === 'building');
  expect(buildings.length, 'the town is built from plans').toBeGreaterThan(8);
  for (const id of [...buildings, 'cottage']) {
    const def = structureDef(id);
    const plan = buildingPlan(id)!;
    expect(plan, `${id} has a plan`).toBeTruthy();
    expect([plan.w, plan.d], `${id}: the plan's footprint is the structure's`).toEqual([def.w, def.d]);
    expect((plan.w % MODULE) + (plan.d % MODULE), `${id}: on the kit's grid`).toBe(0);
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
      for (const [a, b] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
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
        const frame = {
          front: [0, b.plan.d / 2, 0],
          right: [b.plan.w / 2, 0, Math.PI / 2],
          back: [0, -b.plan.d / 2, Math.PI],
          left: [-b.plan.w / 2, 0, -Math.PI / 2],
        }[side] as [number, number, number];
        const [ox, oz] = turn(along, -WALL / 2, frame[2]);
        const [wx, wz] = turn(frame[0] + ox, frame[1] + oz, b.rot);
        const solid = b.boxes.some((box) => inRect(box, b.x + wx, b.z + wz));
        expect(solid, `${b.id} at (${b.x}, ${b.z}): ${side} module ${i} "${ch}"`).toBe(opening(ch) === null);
      });
    }
    if (storeys > 1) {
      // A deck at each upper floor, at the storey's height.
      const tops = new Set(
        gen.decks.filter((d) => Math.hypot(d.x - b.x, d.z - b.z) < Math.hypot(b.plan.w, b.plan.d) / 2).map((d) => +(d.top - b.y).toFixed(3)),
      );
      for (let s = 1; s < storeys; s++) expect(tops.has(s * STOREY), `${b.id}: floor ${s}`).toBe(true);
    }
  }
});
