import data from '../../shared/actors.json' with { type: 'json' };
import type { ActorKind } from '../sim/actor';
import { CREATURES } from './creatures';

// What kinds of thing can exist in the world. The data is in shared/actors.json so the server
// reads the same numbers; adding a monster starts there, and the rules will spawn it, hit it,
// kill it and respawn it without knowing what it is. A creature with a file of its own
// (shared/creatures/) adds its kinds after these, so their indexes on the wire never move.

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

/** Which ladder a kind is on, or -1. */
export const ladderOf = (kind: string): number => LADDERS.findIndex((l) => l.kinds.includes(kind));

/** One size up from `kind`; the top size stays itself. */
export function sizeUp(kind: string): string {
  const l = LADDERS[ladderOf(kind)];
  if (!l) return kind;
  const i = l.kinds.indexOf(kind);
  return l.kinds[Math.min(i + 1, l.kinds.length - 1)];
}

/** The biggest size on a ladder that `mass` reaches, or '' if it reaches none. */
export function sizeFor(ladder: number, mass: number): string {
  const l = LADDERS[ladder];
  let best = '';
  if (!l) return best;
  for (const id of l.kinds) if ((BY_ID.get(id)?.mass ?? 0) <= mass) best = id;
  return best;
}

export const kindMass = (id: string): number => BY_ID.get(id)?.mass ?? 0;
