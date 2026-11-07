import { type LifeState } from './state';
import { exitSpot, ridden } from './vehicles';
import { dungeonDef, dungeonDoor } from '../world/dungeons';
import type { IslandRead } from './life';
import type { SimRead } from '../shapes';

// Your island as the rules keep it between visits: money, bag, farms, house, vehicles, quests, and
// where you were standing. The server keeps players' islands, and takes one up again with the time
// you were away (load_island, crates/server/src/sim/mod.rs); this browser keeps one only for automated
// tests and bug-report replays (src/app/save.ts), which the engine takes up the same way.

/** The island as the server keeps it. */
export interface Island {
  state: LifeState;
  player: { x: number; y: number; z: number; facing: number };
}

/** An island and when it was saved (ms, on whichever clock `now` is measured on when it loads). */
export interface Saved extends Island {
  savedAt: number;
}

/** The island as it would be saved right now: in a copy of an instance, standing outside its door (a save is of the world). */
export function islandData(life: IslandRead & { readonly dungeon?: string | null }, sim: SimRead): Island {
  const p = sim.player;
  const door = life.dungeon ? (dungeonDoor(life.zone.recipe, life.dungeon) ?? dungeonDef(life.dungeon)?.door) : undefined;
  if (door) return { state: life.state, player: { x: door.outside.x, y: door.portal.y, z: door.outside.z, facing: door.outside.facing } };
  // Riding is not saved: you will be standing beside it next time.
  const v = p.mode === 'ride' ? ridden(life, sim) : undefined;
  const at = v ? exitSpot(sim, v) : p.pos;
  return { state: life.state, player: { x: at.x, y: at.y, z: at.z, facing: p.facing } };
}
