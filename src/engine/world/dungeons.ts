import data from '../../../shared/instances.json' with { type: 'json' };
import type { CaveDressing } from '../../content/looks';
import { inRect } from './colliders';
import { rect } from './frames';
import type { DungeonDoor, ZoneRecipe, ZoneSpawn } from './types';

// The world's instances: its dungeons and the developer zones (content/instances/<id>.json, built
// into shared/instances.json; docs/world.md). Each party plays its own copy of one, a space of its
// own (crates/server/src/directory/mod.rs; offline the Engine plays it in place of the world while
// you're inside, src/engine/engine.ts): everything in it stands round its own origin, over nothing,
// and its floors and walls are all that's solid there (crates/engine/src/open/dungeon.rs). These
// read a dungeon's file for the page.

/** A box or deck as a dungeon's file gives it: round its origin, its top above it. */
export interface DungeonPiece {
  id: string;
  x: number;
  z: number;
  hw: number;
  hd: number;
  rot: number;
  top: number;
}

export interface DungeonDef {
  id: string;
  name: string;
  /** How many players a copy holds. */
  maxPlayers: number;
  /** Where you come in (round its origin, on its floor). */
  arrive: { x: number; z: number; facing: number };
  /** The portal back out: F within `r` of it. */
  exit: { x: number; z: number; r: number };
  /** Below this you are put back at `arrive`. */
  fall: number;
  boxes: DungeonPiece[];
  decks: DungeonPiece[];
  /** A developer zone: admins go in from the Admin menu, as there's no portal to it on the island. */
  developer?: boolean;
  /** What a developer zone is for, as the Admin menu says it. */
  about?: string;
  /** One copy for everyone allowed in (the battlefield), instead of one a party. */
  shared?: boolean;
  /** Where a developer zone lets you out on the island (a dungeon's door is in the zone's recipe). */
  door?: DungeonDoor;
  /** Bots in it while anyone is (the server's; crates/engine/src/bots.rs). */
  bots?: Array<{ brain: string; count: number; team: number; x: number; z: number }>;
  /** How it's drawn: "cave" (the default) or "arena" (open sky). */
  style?: string;
  /** What a cave looks like inside (src/content/looks.ts): drawing only, the rules never read it. */
  dressing?: CaveDressing;
  /** What a copy of it brings to life (the server's). */
  spawns?: ZoneSpawn[];
  /**
   * The practice rules a copy of it plays offline (crates/engine/src/open/dungeon.rs Practice): a
   * landed blow stops everything a moment (hitPause), a swing turns toward what's nearest (aimAssist).
   */
  practice?: { hitPause?: boolean; aimAssist?: boolean };
}

/** Every dungeon and developer zone, by id, in the order content/instances/_order.json lists them. */
export const DUNGEONS: Record<string, DungeonDef> = Object.fromEntries((data.instances as unknown as DungeonDef[]).map((d) => [d.id, d]));

export function dungeonDef(id: string): DungeonDef | undefined {
  return DUNGEONS[id];
}

/** A dungeon's door in the open world (its portal, and where you come out), from its region's recipe. */
export function dungeonDoor(recipe: ZoneRecipe, id: string): DungeonDoor | undefined {
  return recipe.doors?.find((d) => d.id === id);
}

/**
 * The floor at (x, z) in a copy of the dungeon, if it has one there: the top of the highest of its
 * low pieces (a floor, a deck; walls and rails aren't floor) whose footprint holds the point. What
 * its creatures stand on (crates/engine/src/open/dungeon.rs floor_at).
 */
export function floorAt(def: DungeonDef, x: number, z: number): number | null {
  let best: number | null = null;
  for (const p of [...def.boxes, ...def.decks]) {
    if (p.top > 0.6) continue;
    if (!inRect(rect(p.x, p.z, p.hw, p.hd, p.rot, 0), x, z)) continue;
    if (best === null || p.top > best) best = p.top;
  }
  return best;
}

/** Where you stand on arriving: on the floor at `arrive`, facing the way it says. */
export function arrivalOf(def: DungeonDef): { x: number; y: number; z: number; facing: number } {
  return { x: def.arrive.x, y: 0, z: def.arrive.z, facing: def.arrive.facing };
}
