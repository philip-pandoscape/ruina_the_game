// The shape of a zone recipe (shared/zones/*.json) and of what the generator builds from it.

export interface ZoneRecipe {
  id: string;
  name: string;
  subtitle: string;
  seed: number;
  climate: string;
  terrain: {
    cells: number;
    cell: number;
    water: number;
    island: { x: number; z: number; radius: number; lobes: Array<[number, number, number]>; warp: number; warpScale: number };
    bays: Array<{ x: number; z: number; r: number }>;
    headlands: Array<{ x: number; z: number; r: number; push: number }>;
    islets: Array<{ x: number; z: number; r: number; h: number }>;
    cliffs: Array<{ x: number; z: number; r: number; h: number }>;
    shore: { beach: number; beachHeight: number; inlandRise: number; seabedSlope: number; seabedCurve: number; maxDepth: number };
    hills: { scale: number; height: number; detailScale: number; detail: number; inlandFrom: number; inlandTo: number };
    mountains: Array<{
      id: string;
      x: number;
      z: number;
      top: number;
      plateau: number;
      cliff: number;
      skirt: number;
      cliffDrop: number;
      rugged: number;
      crag: number;
    }>;
    ramps: Array<{ mountain: string; startAngle: number; turns: number; direction: number; from: number; to: number; width: number }>;
    pits: Array<{ x: number; z: number; r: number; depth: number; floor: number }>;
    flatten: Array<{
      id: string;
      x: number;
      z: number;
      r?: number;
      w?: number;
      d?: number;
      fall: number;
      h: number | 'auto';
      surface?: string;
      surfaceR?: number;
      seaFall?: number;
    }>;
    roads: Array<{ id: string; width: number; points: Array<[number, number]> }>;
    sandBelow: number;
    rockSlope: number;
  };
  spawn: { x: number; z: number; facing: number };
  places: ZonePlace[];
  structures: Array<{ id: string; x: number; z: number; rot: number; tint?: number; seed?: number; decor?: string[] }>;
  props: Array<{
    id: string;
    x?: number;
    z?: number;
    rot?: number;
    ring?: { x: number; z: number; r: number; count: number; phase: number };
    along?: string;
    every?: number;
    line?: [[number, number], [number, number]];
  }>;
  npcs: ZoneNpc[];
  workbenches: Array<{ id: string; place: string; x: number; z: number }>;
  outposts: Array<{ id: string; npc: string; x: number; z: number }>;
  housePlots: Array<{ id: string; x: number; z: number; rot: number }>;
  farmland: { x: number; z: number; w: number; d: number };
  nodes: Array<{ kind: string; x: number; z: number; rot: number }>;
  updrafts: Updraft[];
  forests: Array<{ x: number; z: number; r: number; density: number }>;
  scatter: { trees: number; rocks: number; clearOfRoad?: number; clearOfStructure?: number };
  slimes: { x: number; z: number; count: number; r: number };
  /** Slipways where ships are built. */
  shipyards: Array<{ id: string; name: string; x: number; z: number; rot: number }>;
  /** Day and night: how long a whole day lasts in real seconds, and when the sun is up. */
  sky: { dayLengthSeconds: number; startHour: number; sunrise: number; sunset: number };
  dummy: { x: number; z: number };
}

export interface ZonePlace {
  id: string;
  name: string;
  kind: string;
  icon: string;
  x: number;
  z: number;
}

export interface ZoneNpc {
  id: string;
  name: string;
  title: string;
  x: number;
  z: number;
  facing: number;
  kind: string;
}

/** A column of rising air: gliders inside it climb. */
export interface Updraft {
  x: number;
  z: number;
  r: number;
  /** It stops lifting above this height. */
  top: number;
  /** Climb rate at its core, m/s. */
  strength: number;
}

/** A solid oriented rectangle (a building, a wall, a counter). Infinitely tall below `top`. */
export interface BoxCollider {
  x: number;
  z: number;
  hw: number;
  hd: number;
  rot: number;
  cos: number;
  sin: number;
  top: number;
}

/** A walkable platform: the ground is at `top` anywhere over its rectangle. */
export type Deck = BoxCollider;

/** Something the renderer should draw, with its height already resolved from the terrain. */
export interface ZonePlacement {
  kind: 'structure' | 'prop' | 'node';
  id: string;
  x: number;
  y: number;
  z: number;
  rot: number;
  tint?: number;
  seed?: number;
  decor?: string[];
}
