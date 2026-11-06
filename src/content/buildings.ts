import data from '../../shared/buildings.json' with { type: 'json' };

// Buildings you can walk into, as content: each is laid out on the village kit's 2 m grid, a storey
// at a time (3 m each), with its doors and windows, stairs, roof and furniture. The zone generator
// turns a plan into colliders (walls with their doorways, upper floors and stair treads you walk
// on, furniture you bump into) and src/render/village assembles it from the kit's pieces, so the
// rules and the picture come from the same plan. A structure whose collider is 'building' has one,
// under the same id (shared/structures.json).
//
// A plan's frame: origin at the middle of its footprint on the ground, front to +Z, +X to the right
// as you face the front from outside. Each wall is a string of 2 m modules, read left to right as
// you face it from outside:
//   .  plain wall        W  wide window      R  wide window, arched     w  narrow window
//   D  door              O  door, arched     A  open arch (walk through) G  timber lattice
//   _  nothing at all (an open side)

/** Metres per storey (the kit's walls are 3 m high). */
export const STOREY = 3;
/** Metres per module along a wall. */
export const MODULE = 2;
/** How far the walls reach in from the footprint's edge, as the rules see them. */
export const WALL = 0.3;
/** Half the width of a doorway in a door module, and of the opening in an arch. */
export const DOOR_HALF = 0.65;
export const ARCH_HALF = 0.82;
/** The kit's stair: 14 treads climbing a storey over 4.33 m, 1.64 m wide. */
export const STAIR = { treads: 14, run: 4.33, halfWidth: 0.82, length: 4 };

export type WallKind = 'plaster' | 'stone';
export type Side = 'front' | 'back' | 'left' | 'right';
export const SIDES: Side[] = ['front', 'right', 'back', 'left'];

export interface StoreyPlan {
  walls: WallKind;
  /** The kit's floor piece for this storey (Floor_WoodDark, Floor_Brick, ...). */
  floor: string;
  front: string;
  back: string;
  left: string;
  right: string;
}

/** A flight of stairs up from `storey` to the one above: its foot at (x, z), turned so it climbs toward -Z by `rot`. */
export interface StairPlan {
  storey: number;
  x: number;
  z: number;
  rot: number;
  style?: 'solid' | 'rails' | 'open';
}

export interface RoofPlan {
  /** Which way the ridge runs. */
  ridge: 'x' | 'z';
  chimneys?: Array<{ x: number; z: number }>;
  /** Dormer windows on the slopes: which side of the ridge, and where along it. */
  dormers?: Array<{ side: 1 | -1; at: number }>;
}

/** A piece of furniture (shared/buildings.json furniture) set down in a plan, on a storey, `y` above its floor. */
export interface ItemPlan {
  id: string;
  x: number;
  z: number;
  rot?: number;
  storey?: number;
  y?: number;
}

export interface BuildingPlan {
  id: string;
  w: number;
  d: number;
  storeys: StoreyPlan[];
  roof: RoofPlan;
  stairs?: StairPlan[];
  items?: ItemPlan[];
}

export interface FurnitureDef {
  id: string;
  w: number;
  d: number;
  h: number;
  /** 'box' blocks its footprint, 'post' a circle of radius r, 'none' is walked through (rugs, things on tables). */
  collider: 'box' | 'post' | 'none';
  r?: number;
  /** A warm light it gives off (hearths, lanterns, candles): where in the item's frame, strength and reach. */
  light?: { x?: number; y: number; z?: number; intensity: number; distance: number; color?: number; flicker?: boolean };
  /** What it is drawn with (the renderer's business): a kit prop, several, or something made ('rug', 'hay', 'fire'). */
  model?: string;
  parts?: Array<{ model: string; x?: number; y?: number; z?: number; rot?: number; scale?: number | [number, number, number] }>;
  make?: string;
  variant?: number;
}

const PLANS = new Map((data.plans as unknown as BuildingPlan[]).map((p) => [p.id, p]));
const FURNITURE = new Map(Object.entries(data.furniture as unknown as Record<string, Omit<FurnitureDef, 'id'>>).map(([id, f]) => [id, { id, ...f }]));

export function buildingPlan(id: string): BuildingPlan | undefined {
  return PLANS.get(id);
}

export const buildingPlanIds = (): string[] => [...PLANS.keys()];

export function furnitureDef(id: string): FurnitureDef {
  const f = FURNITURE.get(id);
  if (!f) throw new Error(`unknown furniture "${id}"`);
  return f;
}

export const furnitureIds = (): string[] => [...FURNITURE.keys()];

/** The modules of one wall, spaces dropped. */
export function modules(s: string): string[] {
  return [...s.replace(/\s+/g, '')];
}

/** How many modules a side holds. */
export function sideLength(plan: BuildingPlan, side: Side): number {
  return (side === 'front' || side === 'back' ? plan.w : plan.d) / MODULE;
}

/**
 * Where module `i` of a side sits: the middle of its stretch of the footprint's edge, and the turn
 * that faces a kit piece (outside to +Z) outward.
 */
export function modulePose(plan: BuildingPlan, side: Side, i: number): { x: number; z: number; rot: number } {
  const hw = plan.w / 2;
  const hd = plan.d / 2;
  const off = MODULE / 2 + i * MODULE;
  switch (side) {
    case 'front':
      return { x: -hw + off, z: hd, rot: 0 };
    case 'back':
      return { x: hw - off, z: -hd, rot: Math.PI };
    case 'right':
      return { x: hw, z: hd - off, rot: Math.PI / 2 };
    case 'left':
      return { x: -hw, z: -hd + off, rot: -Math.PI / 2 };
  }
}

/** A point in a plan's frame turned by `rot` (as three.js turns about Y, and as the zone's toWorld does). */
export function turn(x: number, z: number, rot: number): [number, number] {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return [x * c + z * s, -x * s + z * c];
}

/** Which openings let you through: doorways and arches, with how wide; walls and windows don't. */
export function opening(ch: string): number | null {
  if (ch === 'D' || ch === 'O') return DOOR_HALF;
  if (ch === 'A') return ARCH_HALF;
  if (ch === '_') return MODULE / 2;
  return null;
}

/**
 * The treads of a flight, in the plan's frame: each a rectangle (centre, half sizes along the
 * flight's own across and along, its turn) and the height of its top above the storey's floor.
 */
export function stairTreads(st: StairPlan): Array<{ x: number; z: number; hw: number; hd: number; rot: number; top: number }> {
  const out = [];
  const step = STAIR.run / STAIR.treads;
  for (let k = 0; k < STAIR.treads; k++) {
    const [ox, oz] = turn(0, -(k + 0.5) * step, st.rot);
    out.push({ x: st.x + ox, z: st.z + oz, hw: STAIR.halfWidth, hd: step / 2, rot: st.rot, top: ((k + 1) * STOREY) / STAIR.treads });
  }
  return out;
}

/** The stairwell a flight cuts in the floor above: a module wide, STAIR.length long, from its foot. */
export function stairwell(st: StairPlan): { x: number; z: number; hw: number; hd: number; rot: number } {
  const [ox, oz] = turn(0, -STAIR.length / 2, st.rot);
  return { x: st.x + ox, z: st.z + oz, hw: MODULE / 2, hd: STAIR.length / 2, rot: st.rot };
}

/** The floor tiles of a storey (2 m squares at module centres), less those a stairwell from below opens. */
export function floorTiles(plan: BuildingPlan, storey: number): Array<{ x: number; z: number }> {
  const holes = storey === 0 ? [] : (plan.stairs ?? []).filter((s) => s.storey === storey - 1).map(stairwell);
  const tiles = [];
  for (let i = 0; i < plan.w / MODULE; i++)
    for (let j = 0; j < plan.d / MODULE; j++) {
      const x = -plan.w / 2 + MODULE / 2 + i * MODULE;
      const z = -plan.d / 2 + MODULE / 2 + j * MODULE;
      const inHole = holes.some((h) => {
        const [lx, lz] = turn(x - h.x, z - h.z, -h.rot);
        return Math.abs(lx) < h.hw - 0.01 && Math.abs(lz) < h.hd - 0.01;
      });
      if (!inHole) tiles.push({ x, z });
    }
  return tiles;
}

/** The plan seen in a mirror (left and right swapped): for a second house that isn't the first one's twin. */
export function mirrorPlan(plan: BuildingPlan): BuildingPlan {
  const rev = (s: string) => modules(s).reverse().join('');
  return {
    ...plan,
    storeys: plan.storeys.map((s) => ({ ...s, front: rev(s.front), back: rev(s.back), left: rev(s.right), right: rev(s.left) })),
    roof: {
      ...plan.roof,
      chimneys: plan.roof.chimneys?.map((c) => ({ x: -c.x, z: c.z })),
      dormers:
        plan.roof.ridge === 'z'
          ? plan.roof.dormers?.map((d) => ({ side: -d.side as 1 | -1, at: d.at }))
          : plan.roof.dormers?.map((d) => ({ side: d.side, at: -d.at })),
    },
    stairs: plan.stairs?.map((s) => ({ ...s, x: -s.x, rot: -s.rot })),
    items: plan.items?.map((it) => ({ ...it, x: -it.x, rot: -(it.rot ?? 0) })),
  };
}

/** The plan for a structure placed in a zone (mirrored if the placement asks). */
export function placedPlan(id: string, mirror?: boolean): BuildingPlan | undefined {
  const plan = buildingPlan(id);
  return plan && mirror ? mirrorPlan(plan) : plan;
}
