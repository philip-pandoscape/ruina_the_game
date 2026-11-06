import * as THREE from 'three';
import {
  floorTiles,
  furnitureDef,
  MODULE,
  modulePose,
  modules,
  SIDES,
  STOREY,
  stairwell,
  turn,
  type BuildingPlan,
  type FurnitureDef,
  type WallKind,
} from '../../content/buildings';
import { ROOF_RISE, roofSpan } from '../../content/buildings';
import { ROOF_PART } from './kit';

// A building plan (src/content/buildings.ts) as the kit pieces that make it, each placed in the
// plan's frame and tagged with the part of the building it belongs to (its storey, or the roof).

export interface Placed {
  piece: string;
  matrix: THREE.Matrix4;
  part: number;
}

/** A door leaf: where its hinge is, which way it swings open (+1 inward), and its storey. */
export interface PlacedDoor extends Placed {
  swing: number;
}

export interface PlacedItem {
  def: FurnitureDef;
  matrix: THREE.Matrix4;
  part: number;
}

export interface PlacedLight {
  x: number;
  y: number;
  z: number;
  def: NonNullable<FurnitureDef['light']>;
  part: number;
}

export interface Assembled {
  pieces: Placed[];
  doors: PlacedDoor[];
  items: PlacedItem[];
  lights: PlacedLight[];
}

/** What each module letter is built from, by wall kind: the wall, and what fills its opening. */
const WALLS: Record<WallKind, Record<string, string>> = {
  plaster: {
    '.': 'Wall_Plaster_Straight',
    W: 'Wall_Plaster_Window_Wide_Flat',
    R: 'Wall_Plaster_Window_Wide_Round',
    w: 'Wall_Plaster_Window_Thin_Round',
    D: 'Wall_Plaster_Door_Flat',
    O: 'Wall_Plaster_Door_Round',
    G: 'Wall_Plaster_WoodGrid',
    A: 'Wall_Arch',
  },
  stone: {
    '.': 'Wall_UnevenBrick_Straight',
    W: 'Wall_UnevenBrick_Window_Wide_Flat',
    R: 'Wall_UnevenBrick_Window_Wide_Round',
    w: 'Wall_UnevenBrick_Window_Thin_Round',
    D: 'Wall_UnevenBrick_Door_Flat',
    O: 'Wall_UnevenBrick_Door_Round',
    G: 'Wall_Plaster_WoodGrid',
    A: 'Wall_Arch',
  },
};
const WINDOWS: Record<string, string> = { W: 'Window_Wide_Flat1', R: 'Window_Wide_Round1', w: 'Window_Thin_Round1' };
const SHUTTERS: Record<string, string> = { W: 'WindowShutters_Wide_Flat_Open', R: 'WindowShutters_Wide_Round_Open', w: 'WindowShutters_Thin_Round_Open' };
const FRAMES: Record<WallKind, Record<string, string>> = {
  plaster: { D: 'DoorFrame_Flat_WoodDark', O: 'DoorFrame_Round_WoodDark' },
  stone: { D: 'DoorFrame_Flat_Brick', O: 'DoorFrame_Round_Brick' },
};
const LEAVES: Record<string, string> = { D: 'Door_1_Flat', O: 'Door_1_Round' };
const CORNERS: Record<WallKind, string> = { plaster: 'Corner_Exterior_Wood', stone: 'Corner_Exterior_Brick' };
const STAIRS = { solid: 'Stair_Interior_Solid', rails: 'Stair_Interior_Rails', open: 'Stair_Interior_Simple' };

const Y = new THREE.Vector3(0, 1, 0);
const q = new THREE.Quaternion();
const one = new THREE.Vector3(1, 1, 1);

/** A matrix placing something at (x, y, z) in the plan's frame, turned by rot about Y. */
export function at(x: number, y: number, z: number, rot = 0, scale = one): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q.setFromAxisAngle(Y, rot), scale);
}

/** A small deterministic hash for cosmetic choices (shutters, which window gets flowers). */
function hash(...n: number[]): number {
  let h = 2166136261;
  for (const v of n) h = Math.imul(h ^ Math.round(v * 1000), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * The pieces of a plan. `stage` builds a house only so far (src/sim/life/housing.ts stages:
 * 1 the floor, 2 its timber frame, 3 the walls, 4 the roof and the furnishing).
 */
export function assemble(plan: BuildingPlan, seed = 1, stage = 4): Assembled {
  const out: Assembled = { pieces: [], doors: [], items: [], lights: [] };
  const put = (piece: string, m: THREE.Matrix4, part: number) => out.pieces.push({ piece, matrix: m, part });
  const storeys = plan.storeys.length;
  const top = storeys * STOREY;

  plan.storeys.forEach((st, s) => {
    const y = s * STOREY;
    // Floor: the kit's tiles, a hair over the ground on the ground floor.
    for (const t of floorTiles(plan, s)) put(st.floor, at(t.x, y + (s === 0 ? 0.03 : 0), t.z), s);
    if (stage < 2) return;
    for (const side of SIDES) {
      const row = modules(st[side]);
      row.forEach((ch, i) => {
        if (ch === '_') return;
        const p = modulePose(plan, side, i);
        const m = at(p.x, y, p.z, p.rot);
        if (stage < 3) {
          // The frame: an open timber arch in every module.
          put('Wall_Arch', m, s);
          return;
        }
        put(s > 0 && st.walls === 'plaster' && ch === 'W' ? 'Wall_Plaster_Window_Wide_Flat2' : (WALLS[st.walls][ch] ?? WALLS[st.walls]['.']), m, s);
        if (WINDOWS[ch]) {
          put(WINDOWS[ch], m, s);
          if (s > 0 && hash(seed, s, i, side.length) < 0.55) put(SHUTTERS[ch], m, s);
        }
        if (FRAMES[st.walls][ch]) {
          put(FRAMES[st.walls][ch], m, s);
          // The leaf hangs on the left of the doorway as you face it from outside, and swings in.
          const [hx, hz] = turn(-0.55, -0.12, p.rot);
          out.doors.push({ piece: LEAVES[ch], matrix: at(p.x + hx, y, p.z + hz, p.rot), part: s, swing: 1 });
        }
      });
    }
    // Corner posts (or quoins) where the walls meet.
    for (const [cx, cz, r] of [
      [plan.w / 2, plan.d / 2, 0],
      [plan.w / 2, -plan.d / 2, Math.PI / 2],
      [-plan.w / 2, -plan.d / 2, Math.PI],
      [-plan.w / 2, plan.d / 2, -Math.PI / 2],
    ] as Array<[number, number, number]>)
      put(stage < 3 ? 'Corner_Exterior_Wood' : CORNERS[st.walls], at(cx, y, cz, r), s);
  });

  if (stage >= 4) {
    for (const st of plan.stairs ?? []) {
      put(STAIRS[st.style ?? 'solid'], at(st.x, st.storey * STOREY, st.z, st.rot), st.storey);
      railings(plan, st, put);
    }
    roof(plan, top, put);
    for (const it of plan.items ?? []) {
      const def = furnitureDef(it.id);
      const s = it.storey ?? 0;
      const y = s * STOREY + (it.y ?? 0);
      const m = at(it.x, y, it.z, it.rot ?? 0);
      out.items.push({ def, matrix: m, part: s });
      if (def.light) {
        const p = new THREE.Vector3(def.light.x ?? 0, def.light.y, def.light.z ?? 0).applyMatrix4(m);
        out.lights.push({ x: p.x, y: p.y, z: p.z, def: def.light, part: s });
      }
    }
  }
  return out;
}

/** Rails round a stairwell's open edges, upstairs (as the rules have them: src/sim/zone/buildings.ts). */
function railings(plan: BuildingPlan, st: NonNullable<BuildingPlan['stairs']>[number], put: (piece: string, m: THREE.Matrix4, part: number) => void): void {
  const well = stairwell(st);
  const y = (st.storey + 1) * STOREY;
  // The kit's rail stands a metre in front of its origin.
  for (const [ex, ez, r] of [
    [-well.hw, 0, -Math.PI / 2],
    [well.hw, 0, Math.PI / 2],
    [0, well.hd, 0],
  ] as Array<[number, number, number]>) {
    const [ox, oz] = turn(ex, ez, well.rot);
    const px = well.x + ox;
    const pz = well.z + oz;
    if (Math.abs(Math.abs(px) - plan.w / 2) < 0.5 || Math.abs(Math.abs(pz) - plan.d / 2) < 0.5) continue;
    const along = ez === 0 ? well.hd * 2 : well.hw * 2;
    const n = Math.max(1, Math.round(along / MODULE));
    for (let k = 0; k < n; k++) {
      const u = -along / 2 + MODULE / 2 + k * MODULE;
      // Each rail module: inward of the edge by a metre, so its rail lands on the edge.
      const [lx, lz] = ez === 0 ? [ex - Math.sign(ex) * 1, u] : [u, ez - 1];
      const [wx, wz] = turn(lx, lz, well.rot);
      put('Balcony_Cross_Straight', at(well.x + wx, y, well.z + wz, well.rot + r), st.storey + 1);
    }
  }
}

/** The roof: the kit's whole gable roof for the span, its end walls, chimneys. */
function roof(plan: BuildingPlan, top: number, put: (piece: string, m: THREE.Matrix4, part: number) => void): void {
  const span = roofSpan(plan);
  const len = plan.roof.ridge === 'z' ? plan.d : plan.w;
  const turnRoof = plan.roof.ridge === 'z' ? 0 : Math.PI / 2;
  put(`Roof_RoundTiles_${span}x${len}`, at(0, top, 0, turnRoof), ROOF_PART);
  const end = len / 2;
  for (const sgn of [1, -1]) {
    const [gx, gz] = turn(0, end * sgn, turnRoof);
    put(`Roof_Front_Brick${span}`, at(gx, top, gz, turnRoof + (sgn > 0 ? 0 : Math.PI)), ROOF_PART);
  }
  const rise = ROOF_RISE[span] ?? 4;
  for (const c of plan.roof.chimneys ?? []) put('Prop_Chimney', at(c.x, top + rise + 0.9 - 3.18, c.z), ROOF_PART);
}
