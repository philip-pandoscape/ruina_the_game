import type { Obstacle } from '../types';
import type { BoxCollider, Deck } from './types';
import { furnitureDef, MODULE, modules, opening, sideLength, SIDES, STOREY, stairTreads, stairwell, turn, WALL, type BuildingPlan, type Side } from '../../content/buildings';

// The solid parts of a building you can walk into (src/content/buildings.ts), from its plan:
//   - its outer walls, as boxes broken at each doorway and arch;
//   - a wall upstairs over a ground-floor doorway, as a deck you meet upstairs but walk under below;
//   - each upper floor as decks, less the stairwells;
//   - each stair tread as a deck a step higher than the last, with the space under the high end
//     filled (a deck just under head height: solid from the floor, beneath the treads above it);
//   - a rail round a stairwell's open edges;
//   - furniture: boxes and posts on the ground floor, decks upstairs (so you walk under them below);
//   - a roof over it all, halfway up the slope, for anyone coming down from above.
// Boxes are solid from the ground up to their top, so anything that must not block the storeys
// beneath it is a deck: solid from the side only between a step and head height above your feet
// (traversal.json ground.deckStep and deckHeadroom).

/** Head height, less a little: a deck this far over a floor stops you, and you walk under anything higher. */
const HEAD = 1.9;
/** The kit's roofs rise this far over their walls, by span. */
export const ROOF_RISE: Record<number, number> = { 4: 3.73, 6: 4.89, 8: 6.0 };

export interface BuildingColliders {
  boxes: BoxCollider[];
  decks: Deck[];
  obstacles: Obstacle[];
}

function rect(x: number, z: number, hw: number, hd: number, rot: number, top: number): BoxCollider {
  return { x, z, hw, hd, rot, cos: Math.cos(rot), sin: Math.sin(rot), top };
}

/** Where each side's middle is on the footprint's edge, and its turn (along it is +x, outward +z). */
function sideFrame(plan: BuildingPlan, side: Side): { x: number; z: number; rot: number } {
  switch (side) {
    case 'front':
      return { x: 0, z: plan.d / 2, rot: 0 };
    case 'right':
      return { x: plan.w / 2, z: 0, rot: Math.PI / 2 };
    case 'back':
      return { x: 0, z: -plan.d / 2, rot: Math.PI };
    case 'left':
      return { x: -plan.w / 2, z: 0, rot: -Math.PI / 2 };
  }
}

/** The stretches of a side (metres from its left end, seen from outside) that are wall rather than opening. */
function solidSpans(row: string[]): Array<[number, number]> {
  const cuts: Array<[number, number]> = [];
  row.forEach((ch, i) => {
    const h = opening(ch);
    if (h !== null) cuts.push([i * MODULE + MODULE / 2 - h, i * MODULE + MODULE / 2 + h]);
  });
  const spans: Array<[number, number]> = [];
  let at = 0;
  for (const [a, b] of cuts) {
    if (a > at + 1e-6) spans.push([at, a]);
    at = Math.max(at, b);
  }
  const end = row.length * MODULE;
  if (end > at + 1e-6) spans.push([at, end]);
  return spans;
}

/** Spans in `a` not covered by any span in `b`. */
function minus(a: Array<[number, number]>, b: Array<[number, number]>): Array<[number, number]> {
  let out = a;
  for (const [c0, c1] of b) {
    const next: Array<[number, number]> = [];
    for (const [s0, s1] of out) {
      if (c1 <= s0 || c0 >= s1) next.push([s0, s1]);
      else {
        if (c0 > s0 + 1e-6) next.push([s0, c0]);
        if (c1 < s1 - 1e-6) next.push([c1, s1]);
      }
    }
    out = next;
  }
  return out;
}

/** The floor of a storey as few rectangles as its tiles allow (rows merged, then equal rows stacked). */
function floorRects(plan: BuildingPlan, storey: number): Array<{ x: number; z: number; hw: number; hd: number }> {
  const nx = plan.w / MODULE;
  const nz = plan.d / MODULE;
  const holes = (plan.stairs ?? []).filter((s) => s.storey === storey - 1).map(stairwell);
  const solid = (i: number, j: number) => {
    const x = -plan.w / 2 + MODULE / 2 + i * MODULE;
    const z = -plan.d / 2 + MODULE / 2 + j * MODULE;
    return !holes.some((h) => {
      const [lx, lz] = turn(x - h.x, z - h.z, -h.rot);
      return Math.abs(lx) < h.hw - 0.01 && Math.abs(lz) < h.hd - 0.01;
    });
  };
  const rows: Array<Array<[number, number]>> = [];
  for (let j = 0; j < nz; j++) {
    const runs: Array<[number, number]> = [];
    let start = -1;
    for (let i = 0; i <= nx; i++) {
      const on = i < nx && solid(i, j);
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        runs.push([start, i]);
        start = -1;
      }
    }
    rows.push(runs);
  }
  const out: Array<{ x: number; z: number; hw: number; hd: number }> = [];
  const used = rows.map((r) => r.map(() => false));
  for (let j = 0; j < nz; j++)
    rows[j].forEach(([a, b], k) => {
      if (used[j][k]) return;
      let j1 = j;
      while (j1 + 1 < nz) {
        const m = rows[j1 + 1].findIndex(([c, d], kk) => c === a && d === b && !used[j1 + 1][kk]);
        if (m < 0) break;
        used[j1 + 1][m] = true;
        j1++;
      }
      out.push({ x: -plan.w / 2 + ((a + b) / 2) * MODULE, z: -plan.d / 2 + ((j + j1 + 1) / 2) * MODULE, hw: ((b - a) / 2) * MODULE, hd: ((j1 + 1 - j) / 2) * MODULE });
    });
  return out;
}

/** The roof's span (across the ridge) and how high its top deck sits over the walls. */
export function roofSpan(plan: BuildingPlan): number {
  return plan.roof.ridge === 'z' ? plan.w : plan.d;
}

/** Everything solid about a building placed at (x, z), turned `rot`, standing on ground at y. */
export function buildingColliders(plan: BuildingPlan, x: number, z: number, rot: number, y: number): BuildingColliders {
  const out: BuildingColliders = { boxes: [], decks: [], obstacles: [] };
  const storeys = plan.storeys.length;
  const top = y + storeys * STOREY + 0.12;
  /** A rectangle in the plan's frame, out into the world. */
  const place = (lx: number, lz: number, hw: number, hd: number, lrot: number, t: number): BoxCollider => {
    const [ox, oz] = turn(lx, lz, rot);
    return rect(x + ox, z + oz, hw, hd, rot + lrot, t);
  };

  for (const side of SIDES) {
    const f = sideFrame(plan, side);
    const len = sideLength(plan, side) * MODULE;
    /** A span along this side as a slab inside its edge. */
    const slab = ([a, b]: [number, number], t: number): BoxCollider => {
      const [ox, oz] = turn((a + b) / 2 - len / 2, -WALL / 2, f.rot);
      return place(f.x + ox, f.z + oz, (b - a) / 2, WALL / 2, f.rot, t);
    };
    const ground = solidSpans(modules(plan.storeys[0][side]));
    for (const span of ground) out.boxes.push(slab(span, top));
    // Upstairs, wall where the ground floor has a doorway: solid up there, open below.
    for (let s = 1; s < storeys; s++) for (const span of minus(solidSpans(modules(plan.storeys[s][side])), ground)) out.decks.push(slab(span, y + s * STOREY + HEAD));
  }

  for (let s = 1; s < storeys; s++) for (const r of floorRects(plan, s)) out.decks.push(place(r.x, r.z, r.hw, r.hd, 0, y + s * STOREY));

  for (const st of plan.stairs ?? []) {
    const floor = y + st.storey * STOREY;
    const treads = stairTreads(st);
    for (const t of treads) out.decks.push(place(t.x, t.z, t.hw, t.hd, t.rot, floor + t.top));
    // Under the high end, where the treads clear your head, a filler keeps you from walking under them.
    const high = treads.filter((t) => t.top >= HEAD + 0.05);
    if (high.length) {
      const a = high[0];
      const b = high[high.length - 1];
      const hd = (high.length * (a.hd * 2)) / 2;
      out.decks.push(place((a.x + b.x) / 2, (a.z + b.z) / 2, a.hw, hd, st.rot, floor + HEAD));
    }
    // A rail round the stairwell upstairs, on its open edges: not where you step off at the top, nor along an outer wall.
    const well = stairwell(st);
    const railTop = floor + STOREY + 1.1;
    for (const [ex, ez, along] of [
      [-well.hw, 0, false],
      [well.hw, 0, false],
      [0, well.hd, true],
    ] as Array<[number, number, boolean]>) {
      const [ox, oz] = turn(ex, ez, well.rot);
      const px = well.x + ox;
      const pz = well.z + oz;
      if (Math.abs(Math.abs(px) - plan.w / 2) < 0.5 || Math.abs(Math.abs(pz) - plan.d / 2) < 0.5) continue;
      out.decks.push(place(px, pz, along ? well.hw : 0.06, along ? 0.06 : well.hd, well.rot, railTop));
    }
  }

  for (const it of plan.items ?? []) {
    if ((it.y ?? 0) > 0.05) continue; // on a table or a shelf
    const def = furnitureDef(it.id);
    if (def.collider === 'none') continue;
    const storey = it.storey ?? 0;
    const floor = y + storey * STOREY;
    const r = it.rot ?? 0;
    if (storey === 0) {
      if (def.collider === 'post') {
        const [ox, oz] = turn(it.x, it.z, rot);
        out.obstacles.push({ kind: 'post', x: x + ox, z: z + oz, r: def.r ?? Math.min(def.w, def.d) / 2, scale: 1, rot: rot + r });
      } else out.boxes.push(place(it.x, it.z, def.w / 2, def.d / 2, r, floor + def.h));
    } else {
      const half = def.collider === 'post' ? (def.r ?? Math.min(def.w, def.d) / 2) * 0.85 : 0;
      out.decks.push(place(it.x, it.z, half || def.w / 2, half || def.d / 2, r, floor + Math.min(HEAD, Math.max(0.7, def.h))));
    }
  }

  // The roof: something to come down on from the air, well over the top floor.
  out.decks.push(place(0, 0, plan.w / 2, plan.d / 2, 0, top + (ROOF_RISE[roofSpan(plan)] ?? 4) / 2));
  return out;
}
