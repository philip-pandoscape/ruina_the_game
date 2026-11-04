// Dealing damage to the world. Every weapon ends up here, so none of them has to know what
// kinds of thing exist.

import type { Sim } from '../sim';
import { len } from '../math';
import { circleHits } from './hit';
import type { Target } from './hit';
import { isAlive } from '../actor';

export function damage(sim: Sim, t: Target, amount: number, knock = 0, index = 0) : void {
  const a = sim.actors.get(t.id);
  if (!a || !isAlive(a)) return;
  const dx = a.x - sim.player.pos.x;
  const dz = a.z - sim.player.pos.z;
  const dist = len(dx, dz);
  const nx = dist > 0.01 ? dx / dist : Math.sin(sim.player.facing);
  const nz = dist > 0.01 ? dz / dist : Math.cos(sim.player.facing);
  damageFrom(sim, t, amount, nx, nz, knock, index);
}

/** As damage(), but the blow travels along a direction you already know. */

export function damageFrom(sim: Sim, t: Target, amount: number, nx: number, nz: number, knock = 0, index = 0) : void {
  const a = sim.actors.get(t.id);
  if (!a || !isAlive(a)) return;
  a.hp = Math.max(0, a.hp - amount);
  a.flashFrame = 0;
  a.leanVX += nx * knock;
  a.leanVZ += nz * knock;
  // Open worlds stand actors on terrain; their own heights are off that patch of ground.
  const ground = sim.world.terrain ? sim.world.terrain.height(a.x, a.z) : 0;
  sim.emit({
    type: 'hit',
    frame: sim.frame,
    index,
    damage: amount,
    x: a.x - nx * a.radius,
    y: a.y + a.hitHeight + ground,
    z: a.z - nz * a.radius,
    dirX: nx,
    dirZ: nz,
  });
  if (a.hp <= 0) {
    a.deadFrame = 0;
    sim.emit({ type: 'actorDie', frame: sim.frame, id: a.id, kind: a.kind, x: a.x, y: a.hitHeight + ground, z: a.z });
  }
}

/** A blast: everything standing inside the circle takes it. */

export function damageCircle(sim: Sim, x: number, z: number, radius: number, amount: number, knock = 0, index = 0) : void {
  for (const t of circleHits(sim.targets(), x, z, radius)) {
    const dx = t.x - x;
    const dz = t.z - z;
    const dist = len(dx, dz);
    damageFrom(sim, t, amount, dist > 0.01 ? dx / dist : 1, dist > 0.01 ? dz / dist : 0, knock, index);
  }
}
