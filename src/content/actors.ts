import data from '../../shared/actors.json' with { type: 'json' };
import { CREATURES } from './creatures';
import type { CreatureLook } from './looks';

// What kinds of thing can exist in the world. The data is in shared/actors.json so the server
// reads the same numbers; adding a monster starts there, and the rules will spawn it, hit it,
// kill it and respawn it without knowing what it is. A creature with a folder of its own
// (content/creatures/, shared/creatures.json) adds its kinds after these. A kind travels on the wire
// as its place here, which the server takes from the same bundles (the world's connection checks
// that it has the same content: src/net/worldLink.ts).

const KINDS = [...(data.kinds as unknown as ActorKind[]), ...CREATURES.flatMap((c) => (c.kinds ?? []) as ActorKind[])];
const BY_ID = new Map(KINDS.map((k) => [k.id, k]));

export function actorKind(id: string): ActorKind {
  const k = BY_ID.get(id);
  if (!k) throw new Error(`unknown actor kind "${id}"; known: ${[...BY_ID.keys()].join(', ')}`);
  return k;
}

/** As actorKind(), but undefined for a kind that isn't in the file (a test's stand-in, say). */
export const findKind = (id: string): ActorKind | undefined => BY_ID.get(id);

export const actorKindIds = (): string[] => KINDS.map((k) => k.id);

/** What a kind is called on its target plate, if its file names it. */
export const kindName = (id: string): string | undefined => BY_ID.get(id)?.name;

/** Index of a kind in the shared list, which is how the wire refers to it. */
export const actorKindIndex = (id: string): number => KINDS.findIndex((k) => k.id === id);
export const actorKindAt = (index: number): ActorKind | undefined => KINDS[index];

/** The sizes one creature comes in, smallest first, and the limits on how many there can be. */
export interface Ladder {
  id: string;
  kinds: string[];
  /** The most of this creature alive at once; a burst makes fewer pieces rather than pass it. */
  cap: number;
  /** Frames a burst group has before the survivors reform. */
  fuse: number;
  /** Frames a lone survivor lasts before it dissolves. */
  alone: number;
}

export const LADDERS = ((data as { ladders?: Ladder[] }).ladders ?? []) as Ladder[];

/** A slam: where it lands and what it does to whoever is standing there. */
export interface SlamDef {
  /** It winds up when you are this close. */
  range: number;
  /** The furthest it jumps. */
  leap: number;
  radius: number;
  damage: number;
  knock: number;
}

/** What a kind of actor is, before one exists. Content, not state. */
export interface ActorKind {
  id: string;
  faction: number;
  maxHp: number;
  radius: number;
  hitHeight: number;
  hitCeiling: number;
  solid: boolean;
  /** Behaviour id, or null for something that just stands there. */
  brain: string | null;
  /** Frames face-down before it comes back; -1 never respawns. */
  respawnFrames: number;
  /** Which species the renderers draw it as, or null for a bespoke renderer. */
  species: string | null;
  /** Behaviour state name (or 'dead') to clip name, for whichever species it uses. */
  clips: Record<string, string>;
  /** Recolours the species' team slot, so one body can serve several creatures. */
  palette?: { teamA: number; teamB: number };
  /** How big the species is drawn. Drawing only. */
  scale?: number;
  /** For a kind on a ladder: how much of the creature it is. */
  mass?: number;
  /** Dies into this many of another kind. */
  burst?: { into: string; count: number };
  slam?: SlamDef;
  /** Whether it can call the pack and gather them in. */
  gathers?: boolean;
  /** A blow dealing at least this much knocks it out of what it was doing (its brain's flinch). */
  poise?: number;
  /** What its target plate calls it. Drawing only. */
  name?: string;
  /** Clips that play by distance walked, not by state: metres one cycle covers. Drawing only. */
  cycles?: Record<string, number>;
  /** Drawn as jelly, with what is inside it; how it falls apart (src/content/looks.ts). Drawing only. */
  look?: CreatureLook;
}
