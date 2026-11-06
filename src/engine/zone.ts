// The island's ground and what stands on it: terrain, zones and their recipes, buildings, colliders, roads, dungeons.
//
// What outside the rules uses of them, through the bridge (.plans/refactor R6.4): nothing else
// imports src/sim/ (tests/unit/boundaries.test.ts). Phase 8 answers these from the engine.

export { Heightfield, SURFACE, hash2, valueNoise } from '../sim/terrain';
export { groundAt, inRect } from '../sim/zone/colliders';
export { DUNGEONS, arrivalOf, dungeonDef, dungeonDoor, inWorld } from '../sim/zone/dungeon';
export type { DungeonDef, DungeonPiece } from '../sim/zone/dungeon';
export { toLocal, toWorld } from '../sim/zone/frames';
export { ON_ROAD, RoadNetwork, TAIL_MAX, routeFrom, routeNearest, routePoint, routeTight } from '../sim/zone/roads';
export type { Point, Route } from '../sim/zone/roads';
export type { BoxCollider, Deck, DungeonDoor, WaterfallInfo, ZoneNpc, ZonePlace, ZoneRecipe } from '../sim/zone/types';
export { EMBERHOLM, generateZone, makeZoneWorld } from '../sim/zone/world';
export type { PlacedBuilding, ZoneData } from '../sim/zone/world';

import type { Obstacle } from '../sim/types';
import type { BoxCollider as Box, Deck as Platform } from '../sim/zone/types';
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
