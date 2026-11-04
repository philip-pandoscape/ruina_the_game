import data from '../../shared/actors.json' with { type: 'json' };
import type { ActorKind } from '../sim/actor';

// What kinds of thing can exist in the world. The data is in shared/actors.json so the server
// reads the same numbers; adding a monster starts there, and the rules will spawn it, hit it,
// kill it and respawn it without knowing what it is.

const KINDS = data.kinds as unknown as ActorKind[];
const BY_ID = new Map(KINDS.map((k) => [k.id, k]));

export function actorKind(id: string): ActorKind {
  const k = BY_ID.get(id);
  if (!k) throw new Error(`unknown actor kind "${id}"; known: ${[...BY_ID.keys()].join(', ')}`);
  return k;
}

export const actorKindIds = (): string[] => KINDS.map((k) => k.id);

/** Index of a kind in the shared list, which is how the wire refers to it. */
export const actorKindIndex = (id: string): number => KINDS.findIndex((k) => k.id === id);
export const actorKindAt = (index: number): ActorKind | undefined => KINDS[index];
