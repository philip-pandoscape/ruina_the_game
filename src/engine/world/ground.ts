import { groundAt } from './colliders';
import type { SimRead } from '../shapes';

// How high you are off the ground, for the page (the engine moves you over it:
// crates/engine/src/open/traverse.rs).

/** Height of your feet above whatever is under you (water counts as a floor). */
export function heightAboveGround(sim: SimRead): number {
  const p = sim.player;
  const hf = sim.world.terrain;
  if (!hf) return p.pos.y;
  const g = Math.max(hf.water, groundAt(hf, sim.world.index, p.pos.x, p.pos.z, p.pos.y, 0));
  return p.pos.y - g;
}
