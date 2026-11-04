// One frame for every actor in the world: its brain, its lean, and bringing it back when it
// has been dead long enough.

import type { Sim } from '../sim';
import { LEAN, STEP } from '../../tuning';
import { isAlive } from '../actor';
import { startBrain, stepBrain } from '../ai/brain';
import { actorKind } from '../../content/actors';

export function updateActors(sim: Sim) : void {
  const seen = sim.sighting();
  for (const a of sim.actors.all()) {
    a.flashFrame = Math.min(a.flashFrame + 1, 999);
    if (isAlive(a)) {
      stepBrain(a, seen);
    } else {
      a.deadFrame++;
      const k = actorKind(a.kind);
      if (k.respawnFrames >= 0 && a.deadFrame >= k.respawnFrames) {
        sim.actors.revive(a);
        startBrain(a, seen);
      }
    }
    // Props lean away from a blow and spring back; anything that never leans stays at zero.
    if (a.leanX !== 0 || a.leanZ !== 0 || a.leanVX !== 0 || a.leanVZ !== 0) {
      a.leanVX += (-LEAN.spring * a.leanX - LEAN.damping * a.leanVX) * STEP;
      a.leanVZ += (-LEAN.spring * a.leanZ - LEAN.damping * a.leanVZ) * STEP;
      a.leanX += a.leanVX * STEP;
      a.leanZ += a.leanVZ * STEP;
    }
  }
}
