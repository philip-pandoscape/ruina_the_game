import type { RigDef } from '../../content/rig';
import { HERO_RIG } from './heroBody';

// Every close-up body the game can draw. A new playable race or a named NPC is a file next to
// hero.ts and a line here; the renderer and its poses do not change.

const RIGS: RigDef[] = [HERO_RIG];
const BY_ID = new Map(RIGS.map((r) => [r.id, r]));

export function creatureRig(id: string): RigDef {
  const r = BY_ID.get(id);
  if (!r) throw new Error(`unknown creature "${id}"; known: ${[...BY_ID.keys()].join(', ')}`);
  return r;
}

export const creatureIds = (): string[] => RIGS.map((r) => r.id);
