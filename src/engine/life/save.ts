import type { Land } from './land';
import type { LifeState } from './state';
import { exitSpot, ridden } from './vehicles';
import { dungeonDef, dungeonDoor } from '../world/dungeons';
import type { LifeRead } from './life';
import type { SimRead } from '../shapes';

// Your life as the rules keep it between visits (money, bag, quests), your land beside it (farms,
// house, vehicles, packs), and where you were standing. The server keeps players' lives and land,
// and takes them up again with the time you were away (load_life, crates/server/src/sim/mod.rs);
// this browser keeps one only for automated tests and bug-report replays (src/app/save.ts), which the
// engine takes up the same way. A save from before land was kept apart (its land inside its state,
// version 3 and before) is read apart by the engine (crates/engine/src/life/land.rs read_saved).

/** The life and its land as the server keeps them. */
export interface LifeSave {
  state: LifeState;
  /** Your land (left out of a save from before it was kept apart: then it's inside the state). */
  land?: Land;
  player: { x: number; y: number; z: number; facing: number };
}

/** An island and when it was saved (ms, on whichever clock `now` is measured on when it loads). */
export interface SavedLife extends LifeSave {
  savedAt: number;
}

/** The island as it would be saved right now: in a copy of an instance, standing outside its door (a save is of the world). */
export function lifeSave(life: LifeRead & { readonly dungeon?: string | null }, sim: SimRead): LifeSave {
  const p = sim.player;
  const door = life.dungeon ? (dungeonDoor(life.zone.recipe, life.dungeon) ?? dungeonDef(life.dungeon)?.door) : undefined;
  if (door) return { state: life.state, land: life.land, player: { x: door.outside.x, y: door.portal.y, z: door.outside.z, facing: door.outside.facing } };
  // Riding is not saved: you will be standing beside it next time.
  const v = p.mode === 'ride' ? ridden(life, sim) : undefined;
  const at = v ? exitSpot(sim, v) : p.pos;
  return { state: life.state, land: life.land, player: { x: at.x, y: at.y, z: at.z, facing: p.facing } };
}
