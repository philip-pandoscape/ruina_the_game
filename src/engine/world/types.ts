// The shape of a region's recipe (shared/regions/*.json) and of what the generator builds from it.

import type { VillagerLook } from '../../content/looks';

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
      /** false: its ground stays open to trees, rocks and scarecrows (the fields); otherwise it's kept clear of them. */
      keepClear?: boolean;
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
  workbenches: Array<{ id: string; name?: string; place: string; x: number; z: number }>;
  outposts: Array<{ id: string; npc: string; x: number; z: number }>;
  housePlots: Array<{ id: string; x: number; z: number; rot: number }>;
  farmland: { x: number; z: number; w: number; d: number };
  /** Gathering spots, each with an id unique across the world. */
  nodes: Array<{ id: string; kind: string; x: number; z: number; rot: number }>;
  updrafts: Updraft[];
  /** The doors into the dungeons in it, each named for its instance (content/instances/<id>.json): a portal into your party's copy. */
  doors?: DungeonDoor[];
  forests: Array<{ x: number; z: number; r: number; density: number }>;
  scatter: { trees: number; rocks: number; clearOfRoad?: number; clearOfStructure?: number };
  /** Slipways where ships are built. */
  shipyards: Array<{ id: string; name: string; x: number; z: number; rot: number }>;
  /** Day and night: how long a whole day lasts in real seconds, and when the sun is up. */
  sky: { dayLengthSeconds: number; startHour: number; sunrise: number; sunset: number };
  /** The creatures it brings to life where it's played (the server's channels, and offline the page's session). */
  spawns: ZoneSpawn[];
}

/**
 * What a region or an instance brings to life (crates/engine/src/open/spawns.rs): one of a kind on a
 * spot, a group of `count` spread round it out to `r`, or a war-band of `count` in a ring round it.
 */
export interface ZoneSpawn {
  /** A creature's kind (shared/actors.json, or a creature's kinds). */
  kind: string;
  x: number;
  z: number;
  band?: boolean;
  count?: number;
  r?: number;
}

export interface ZonePlace {
  id: string;
  name: string;
  kind: string;
  icon: string;
  x: number;
  z: number;
}

/** One of the island's people (content/npcs/<id>.json): who they are, where they stand, how they look and what they say. */
export interface ZoneNpc {
  id: string;
  name: string;
  title: string;
  /** The place they belong to (a zone place's id). */
  place: string;
  x: number;
  z: number;
  facing: number;
  /** Their actor kind (content/actors/): solid townsfolk, and how the crowd draws them from afar. */
  kind: string;
  /** How they're drawn close up: their colours, build, hair and outfit (src/content/looks.ts); with none, a plain villager dressed from their id. */
  look?: VillagerLook;
  /** Their face as an emoji, until their portrait is taken. */
  portrait: string;
  /** What they say when you talk to them. */
  greeting: string;
  /** The workbench they stand at: talking to them offers it. */
  bench?: string;
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
  /** How far the spring's runnel reaches either side of the bearing, for drawing it. */
  runnel: number;
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
  /** The landing stage (a deck) and the totem (a box), where the fall has them. */
  landing?: { s0: number; s1: number; half: number; top: number };
  totem?: { s: number; t: number; top: number };
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
