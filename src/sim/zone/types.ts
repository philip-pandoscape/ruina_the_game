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
    /** Waterfalls down a mountain's face (each cut after the trees and rocks are placed, so none of them move). */
    falls?: WaterfallRecipe[];
    sandBelow: number;
    rockSlope: number;
  };
  spawn: { x: number; z: number; facing: number };
  places: ZonePlace[];
  /** mirror: a building drawn and built left for right (src/content/buildings.ts mirrorPlan). */
  structures: Array<{ id: string; x: number; z: number; rot: number; tint?: number; seed?: number; decor?: string[]; mirror?: boolean }>;
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
  /** The doors of the island's dungeons (shared/dungeons/<id>.json): each a portal into your party's copy. */
  dungeons?: DungeonDoor[];
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

/**
 * A waterfall down a mountain's face: a spring pool on the summit spills over the lip, and the face
 * is cut back to a sheer slot so the water falls free into a pool at the foot. Behind the falling
 * water a ledge sticks out of the slot's back wall, under a hood of rock that is solid on top.
 * Distances are out from the mountain's middle along `bearing` (atan2(dz, dx), radians).
 */
export interface WaterfallRecipe {
  id: string;
  mountain: string;
  bearing: number;
  /** Where the water leaves the summit (the slot's back wall), and where the slot opens out at the foot. */
  lip: number;
  foot: number;
  /** The slot's width across the bearing, and how far its walls blend into the face. */
  width: number;
  blend: number;
  /** The slot's floor: its height at the ledge's front and at the foot. */
  floor: [number, number];
  /** The ledge behind the falling water: its height, and how far out from the back wall it reaches. */
  shelf: { top: number; depth: number };
  /** The rock hood over the ledge: how far above it, reaching how far out from the back wall. */
  roof: { above: number; depth: number };
  /** The goblins' landing stage on the ledge, planks jutting out over the drop: from and to (out from the back wall), half its width, how high. */
  landing: { from: number; to: number; half: number; above: number };
  /** Their totem on the ledge: out from the back wall, across, how tall. */
  totem: { at: number; across: number; above: number };
  /** The spring pool on top (its middle out along the bearing, its radius, how deep under its surface). */
  spring: { at: number; r: number; depth: number };
  /** The pool the water falls into (middle along the bearing, half its length along, half its width across, depth). */
  plunge: { at: number; along: number; across: number; depth: number };
  /** How fast the water leaves the lip, outward (m/s): where the curtain falls. */
  speed: number;
}

/** A waterfall as the generator cut it: where everything is, for the renderer and the tests. */
export interface WaterfallInfo {
  id: string;
  /** The mountain's middle, and the unit vectors out along the bearing (u) and across it (v). */
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  vx: number;
  vz: number;
  /** Where the water leaves the lip: out along u, and its height. */
  lip: number;
  lipY: number;
  foot: number;
  width: number;
  speed: number;
  /** The ledge: from the back wall (s0) out to its front (s1), its top. */
  shelf: { s0: number; s1: number; top: number };
  /** The hood over it: from s0 to s1, solid on top at `top`. */
  roof: { s0: number; s1: number; top: number };
  /** The landing stage (a deck) and the totem (a box). */
  landing: { s0: number; s1: number; half: number; top: number };
  totem: { s: number; t: number; top: number };
  /** The slot floor's height at the ledge's front and at the foot. */
  floor: [number, number];
  /** The pools' water surfaces. */
  spring: { x: number; z: number; at: number; r: number; level: number };
  plunge: { x: number; z: number; s: number; along: number; across: number; level: number };
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

/**
 * Where a dungeon's portal stands in the open world (F within `r` of it takes you in), and where you
 * come out of it again, facing away from the portal.
 */
export interface DungeonDoor {
  id: string;
  portal: { x: number; y: number; z: number; r: number };
  outside: { x: number; z: number; facing: number };
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
  mirror?: boolean;
}
