import battlefield from '../../../shared/dungeons/battlefield.json' with { type: 'json' };
import goblinsDread from '../../../shared/dungeons/goblinsDread.json' with { type: 'json' };
import yard from '../../../shared/dungeons/yard.json' with { type: 'json' };
import type { ColliderIndex } from './colliders';
import { rect } from './generate';
import type { BoxCollider, Deck, DungeonDoor, ZoneRecipe } from './types';

// The island's dungeons (shared/dungeons/<id>.json). Each party plays its own copy of one, which the
// server keeps apart from the open world (crates/server/src/play/spaces.rs); inside, everything stands round a
// spot high above the sea that nothing else in the world uses, and is solid only in a copy: the
// browser adds a dungeon's boxes and decks to its world while you're inside one and takes them away
// again when you leave (crates/engine/src/open/dungeon.rs does the same for a copy).

/** A box or deck as a dungeon's file gives it: around `origin`, its top above `origin.y`. */
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
  origin: { x: number; y: number; z: number };
  /** Where you come in (around the origin, on its floor). */
  arrive: { x: number; z: number; facing: number };
  /** The portal back out: F within `r` of it. */
  exit: { x: number; z: number; r: number };
  /** Below origin.y + fall you are put back at `arrive`. */
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
}

export const DUNGEONS: Record<string, DungeonDef> = {
  goblinsDread: goblinsDread as unknown as DungeonDef,
  yard: yard as unknown as DungeonDef,
  battlefield: battlefield as unknown as DungeonDef,
};

export function dungeonDef(id: string): DungeonDef | undefined {
  return DUNGEONS[id];
}

/** A dungeon's door in the open world (its portal, and where you come out), from the zone's recipe. */
export function dungeonDoor(recipe: ZoneRecipe, id: string): DungeonDoor | undefined {
  return recipe.dungeons?.find((d) => d.id === id);
}

/** A point given around a dungeon's origin, in the world. */
export function inWorld(def: DungeonDef, x: number, z: number, y = 0): { x: number; y: number; z: number } {
  return { x: def.origin.x + x, y: def.origin.y + y, z: def.origin.z + z };
}

/** A dungeon's boxes and decks, where they stand in the world. */
export function dungeonColliders(def: DungeonDef): { boxes: BoxCollider[]; decks: Deck[] } {
  const place = (p: DungeonPiece) => rect(def.origin.x + p.x, def.origin.z + p.z, p.hw, p.hd, p.rot, def.origin.y + p.top);
  return { boxes: def.boxes.map(place), decks: def.decks.map(place) };
}

/** Where you stand on arriving: on the floor at `arrive`, facing the way it says. */
export function arrivalOf(def: DungeonDef): { x: number; y: number; z: number; facing: number } {
  return { ...inWorld(def, def.arrive.x, def.arrive.z), facing: def.arrive.facing };
}

/** A dungeon's boxes and decks in a world's index (their places in its lists), solid or not. */
export interface DungeonSolids {
  def: DungeonDef;
  boxes: number[];
  decks: number[];
  solid: boolean;
}

/**
 * Makes a dungeon solid in a world (you've come into a copy of it), or not (you've left): added
 * the first time, after that only switched on and off, so coming and going doesn't pile them up.
 */
export function setDungeonSolid(index: ColliderIndex, def: DungeonDef, had: DungeonSolids | null, solid: boolean): DungeonSolids {
  const { boxes, decks } = dungeonColliders(def);
  const s = had ?? { def, boxes: boxes.map((b) => index.addBox(b)), decks: decks.map((d) => index.addDeck(d)), solid: true };
  s.boxes.forEach((i, k) => (solid ? (index.boxes[i].top = boxes[k].top) : index.removeBox(i)));
  s.decks.forEach((i, k) => (solid ? (index.decks[i].top = decks[k].top) : index.removeDeck(i)));
  s.solid = solid;
  return s;
}
