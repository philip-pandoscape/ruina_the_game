import emberholm from '../../../shared/zones/emberholm.json' with { type: 'json' };
import type { ActorSpawnPoint, World } from '../types';
import { generateZone, type Generated } from './generate';
import { ColliderIndex } from './colliders';
import type { ZoneRecipe } from './types';

// An open-world zone as a World the rules can run in: the training yard's shape (spawn, obstacles,
// who lives here) plus terrain, decks, building colliders and a spatial index.

export const EMBERHOLM = emberholm as unknown as ZoneRecipe;

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
