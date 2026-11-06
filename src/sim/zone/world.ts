import emberholm from '../../../shared/zones/emberholm.json' with { type: 'json' };
import { placedPlan, type BuildingPlan } from '../../content/buildings';
import { growZone } from '../../engine/wasm';
import { Heightfield } from '../terrain';
import type { ActorSpawnPoint, Obstacle, World } from '../types';
import { ColliderIndex } from './colliders';
import type { BoxCollider, Deck, WaterfallInfo, ZonePlacement, ZoneRecipe } from './types';

// An open-world zone as a World the rules can run in: the training yard's shape (spawn, obstacles,
// who lives here) plus terrain, decks, building colliders and a spatial index.

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
interface Grown {
  cells: number;
  cell: number;
  water: number;
  min: number;
  obstacles: Obstacle[];
  boxes: BoxCollider[];
  decks: Deck[];
  roads: Generated['roads'];
  ramps: Generated['ramps'];
  placements: ZonePlacement[];
  falls: WaterfallInfo[];
  buildings: Array<Omit<PlacedBuilding, 'plan' | 'boxes'> & { boxes: [number, number] }>;
}

/**
 * Grows a zone from its recipe (shared/zones/*.json): coastline, cliffs, hills, mountains with a
 * path carved up their face, flattened town squares, graded roads, then the trees and rocks, the
 * buildings' colliders and the decks you can walk on. The engine grows it (crates/engine/src/open/
 * generate.rs, through its WebAssembly), the same island the server plays: same recipe, same island.
 */
export function generateZone(recipe: ZoneRecipe): Generated {
  const g = growZone<Grown>(recipe);
  const r = g.rest;
  const terrain = new Heightfield(r.cells, r.cell, r.water);
  if (terrain.min !== r.min || terrain.heights.length !== g.heights.length) throw new Error("the engine's grid isn't the heightfield's");
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

export interface ZoneData {
  recipe: ZoneRecipe;
  gen: Generated;
}

/** Built once per page: generating the island takes a few hundred milliseconds. */
const cache = new Map<string, { world: World; zone: ZoneData }>();

export function makeZoneWorld(recipe: ZoneRecipe = EMBERHOLM): World {
  const hit = cache.get(recipe.id);
  if (hit) return hit.world;
  const gen = generateZone(recipe);
  const hf = gen.terrain;
  const spawns: ActorSpawnPoint[] = [];
  const s = recipe.slimes;
  for (let i = 0; i < s.count; i++) {
    const a = (i / s.count) * Math.PI * 2 + 0.4;
    const r = s.r * (0.45 + (0.55 * ((i * 7) % 5)) / 4);
    spawns.push({ kind: 'slime', x: s.x + Math.sin(a) * r, z: s.z + Math.cos(a) * r, seed: (recipe.seed ^ 0x51e0) + i * 0x9e3779b1 });
  }
  spawns.push({ kind: 'dummy', x: recipe.dummy.x, z: recipe.dummy.z });
  // The townsfolk: they stand at their posts and are never anyone's target.
  for (const n of recipe.npcs) spawns.push({ kind: n.kind, x: n.x, z: n.z, facing: n.facing });
  const zone: ZoneData = { recipe, gen };
  const world: World = {
    seed: recipe.seed,
    spawns,
    radius: hf.size / 2 - 8,
    obstacles: gen.obstacles,
    dummy: { ...recipe.dummy },
    spawn: { ...recipe.spawn },
    teamSpawns: [{ ...recipe.spawn }, { ...recipe.spawn }],
    terrain: hf,
    index: new ColliderIndex(gen.obstacles, gen.boxes, gen.decks),
    zone,
  };
  cache.set(recipe.id, { world, zone });
  return world;
}
