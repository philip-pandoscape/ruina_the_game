import emberholm from '../../../shared/regions/emberholm.json' with { type: 'json' };
import { placedPlan, type BuildingPlan } from '../../content/buildings';
import { type GrownWhole, type GrownZone, growWhole, growZone } from '../wasm';
import { Heightfield } from './terrain';
import type { ActorSpawnPoint, Obstacle, World } from '../shapes';
import { ColliderIndex } from './colliders';
import type { BoxCollider, Deck, WaterfallInfo, ZonePlacement, ZoneRecipe } from './types';

// A region as the page reads it: the World shape (spawn, obstacles, who lives here) plus terrain,
// decks, building colliders and a spatial index, grown by the engine from its recipe
// (crates/engine/src/open/generate.rs), standing where the world places it. The region you start
// in is grown here (growRegionHere); the rest of the world grows in a worker as you travel
// (grower.ts) and arrives in the same shape (regionData).

export const EMBERHOLM = emberholm as unknown as ZoneRecipe;

/** Everything grown from a recipe. */
export interface Generated {
  terrain: Heightfield;
  obstacles: Obstacle[];
  boxes: BoxCollider[];
  decks: Deck[];
  /** Road centre-lines as sampled polylines, for the map and for lamp placement. */
  roads: Array<{ id: string; width: number; points: Array<[number, number]> }>;
  /** The carved mountain paths, for the map. */
  ramps: Array<Array<[number, number]>>;
  /** Cells kept free of trees and rocks (and of scarecrows, unless they are farmland). */
  clear: Uint8Array;
  /** Static decoration placed from the recipe, resolved to heights. */
  placements: ZonePlacement[];
  /** The waterfalls, as cut. */
  falls: WaterfallInfo[];
  /** The buildings you can walk into (src/content/buildings.ts), with their plans and the boxes that are their walls. */
  buildings: PlacedBuilding[];
}

export interface PlacedBuilding {
  id: string;
  plan: BuildingPlan;
  x: number;
  y: number;
  z: number;
  rot: number;
  mirror: boolean;
  /** Its solid parts in the zone's lists (the camera sees through the walls of the one you are in). */
  boxes: BoxCollider[];
}

/** What the engine writes of a grown zone besides the ground's arrays. */
export interface Grown {
  cells: number;
  cell: number;
  water: number;
  /** The grid's corner (vertex 0, 0) in the world. */
  minX: number;
  minZ: number;
  obstacles: Obstacle[];
  boxes: BoxCollider[];
  decks: Deck[];
  roads: Generated['roads'];
  ramps: Generated['ramps'];
  placements: ZonePlacement[];
  falls: WaterfallInfo[];
  buildings: Array<Omit<PlacedBuilding, 'plan' | 'boxes'> & { boxes: [number, number] }>;
}

/** What the engine grew, as the page reads it: the grid where it stands, the buildings with their plans. */
function generated(g: GrownZone<Grown>): Generated {
  const r = g.rest;
  const terrain = new Heightfield(r.cells, r.cell, r.water, r.minX, r.minZ);
  if (terrain.heights.length !== g.heights.length) throw new Error("the engine's grid isn't the heightfield's");
  terrain.heights.set(g.heights);
  terrain.surface.set(g.surface);
  const buildings = r.buildings.map((b): PlacedBuilding => {
    const plan = placedPlan(b.id, b.mirror);
    if (!plan) throw new Error(`no building plan "${b.id}"`);
    return { ...b, plan, boxes: r.boxes.slice(b.boxes[0], b.boxes[1]) };
  });
  return {
    terrain,
    obstacles: r.obstacles,
    boxes: r.boxes,
    decks: r.decks,
    roads: r.roads,
    ramps: r.ramps,
    clear: g.clear,
    placements: r.placements,
    falls: r.falls,
    buildings,
  };
}

/**
 * Grows a zone from its recipe (shared/regions/*.json): coastline, cliffs, hills, mountains with a
 * path carved up their face, flattened town squares, graded roads, then the trees and rocks, the
 * buildings' colliders and the decks you can walk on. The engine grows it (crates/engine/src/open/
 * generate.rs, through its WebAssembly), the same island the server plays: same recipe, same island.
 */
export function generateZone(recipe: ZoneRecipe): Generated {
  return generated(growZone<Grown>(recipe));
}

/** A region of the world as the page holds it: its place in the world's map, its recipe, what grew from it, and its edges as grown. */
export interface RegionData {
  place: number;
  recipe: ZoneRecipe;
  gen: Generated;
  /** Its outer two rows and columns of heights as its recipe grew them, before its borders were blended: what's read of it from across them (worldGround.ts Edges). */
  edges: Float32Array;
}

/** A region grown whole by the engine (here, or in the worker: grower.ts), as the page holds it. */
export function regionData(place: number, g: GrownWhole<Grown>): RegionData {
  return { place, recipe: JSON.parse(g.recipe) as ZoneRecipe, gen: generated(g), edges: g.edges };
}

/** Regions grown on the page's own thread, once a page: growing one takes a few hundred milliseconds. */
const grownHere = new Map<number, RegionData>();

/** The region at `place` grown whole on the page's own thread (the one you start in: the rest grow in a worker as you travel). */
export function growRegionHere(place: number): RegionData {
  let r = grownHere.get(place);
  if (!r) grownHere.set(place, (r = regionData(place, growWhole<Grown>(place))));
  return r;
}

export interface ZoneData {
  recipe: ZoneRecipe;
  gen: Generated;
}

/** Built once per page: generating the island takes a few hundred milliseconds. */
const cache = new Map<string, { world: World; zone: ZoneData }>();

/** A zone alone as a World (the bible's maps and the content library): its grid, colliders and townsfolk. */
export function makeZoneWorld(recipe: ZoneRecipe = EMBERHOLM): World {
  const hit = cache.get(recipe.id);
  if (hit) return hit.world;
  const gen = generateZone(recipe);
  const world = worldOf(recipe, gen);
  cache.set(recipe.id, { world, zone: world.zone! });
  return world;
}

/** A region's World: its grid, its colliders indexed, and its townsfolk (they stand at their posts and are never anyone's target; what the region brings to life besides, its recipe's spawns, is the engine's to place: crates/engine/src/open/spawns.rs). */
export function worldOf(recipe: ZoneRecipe, gen: Generated): World {
  const hf = gen.terrain;
  const spawns: ActorSpawnPoint[] = recipe.npcs.map((n) => ({ kind: n.kind, x: n.x, z: n.z, facing: n.facing }));
  return {
    seed: recipe.seed,
    spawns,
    radius: hf.size / 2 - 8,
    obstacles: gen.obstacles,
    spawn: { ...recipe.spawn },
    teamSpawns: [{ ...recipe.spawn }, { ...recipe.spawn }],
    terrain: hf,
    index: new ColliderIndex(gen.obstacles, gen.boxes, gen.decks),
    zone: { recipe, gen },
  };
}
