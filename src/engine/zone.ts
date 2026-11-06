// The island's ground and what stands on it: terrain, zones and their recipes, buildings, colliders, roads, dungeons.
//
// What outside the rules uses of them: the bridge's front door for them, naming exactly what is used
// (tests/unit/boundaries.test.ts). The rules are the engine's; what's read here is the shapes of what
// it hands back and the helpers that read them.

export { Heightfield, SURFACE, hash2, valueNoise } from './world/terrain';
export { groundAt, inRect } from './world/colliders';
export { DUNGEONS, arrivalOf, dungeonDef, dungeonDoor } from './world/dungeons';
export type { DungeonDef, DungeonPiece } from './world/dungeons';
export { toLocal, toWorld } from './world/frames';
export { ON_ROAD, RoadNetwork, TAIL_MAX, routeFrom, routeNearest, routePoint, routeTight } from './world/roads';
export type { Point, Route } from './world/roads';
export type { BoxCollider, Deck, DungeonDoor, WaterfallInfo, ZoneNpc, ZonePlace, ZoneRecipe } from './world/types';
export { EMBERHOLM, generateZone, makeZoneWorld } from './world/region';
export type { PlacedBuilding, ZoneData } from './world/region';

import type { Obstacle } from './shapes';
import type { BoxCollider as Box, Deck as Platform } from './world/types';
import { buildingSolids } from './wasm';

/** Everything solid about a building plan placed at (x, z), turned `rot`, on ground at `y`: the engine's colliders for it (null for no such plan). */
export const buildingColliders = (
  id: string,
  mirror: boolean,
  x: number,
  z: number,
  rot: number,
  y: number,
): { boxes: Box[]; decks: Platform[]; obstacles: Obstacle[] } | null => buildingSolids(id, mirror, x, z, rot, y);
