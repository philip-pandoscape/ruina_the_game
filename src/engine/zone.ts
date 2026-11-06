// The island's ground and what stands on it: terrain, zones and their recipes, buildings, colliders, roads, dungeons.
//
// What outside the rules uses of them, through the bridge (.plans/refactor R6.4): nothing else
// imports src/sim/ (tests/unit/boundaries.test.ts). Phase 8 answers these from the engine.

export { Heightfield, SURFACE, hash2, valueNoise } from '../sim/terrain';
export { ROOF_RISE, buildingColliders, roofSpan } from '../sim/zone/buildings';
export { groundAt, inRect } from '../sim/zone/colliders';
export { DUNGEONS, arrivalOf, dungeonDef, dungeonDoor, inWorld } from '../sim/zone/dungeon';
export type { DungeonDef, DungeonPiece } from '../sim/zone/dungeon';
export { RUNNEL, generateZone, toLocal, toWorld } from '../sim/zone/generate';
export type { PlacedBuilding } from '../sim/zone/generate';
export { ON_ROAD, RoadNetwork, TAIL_MAX, routeFrom, routeNearest, routePoint, routeTight } from '../sim/zone/roads';
export type { Point, Route } from '../sim/zone/roads';
export type { BoxCollider, Deck, DungeonDoor, WaterfallInfo, ZoneNpc, ZonePlace, ZoneRecipe } from '../sim/zone/types';
export { EMBERHOLM, makeZoneWorld } from '../sim/zone/world';
export type { ZoneData } from '../sim/zone/world';
