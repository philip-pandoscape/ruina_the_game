import { type ActorId } from './actor';
import { angleDiff, DEG } from '../math';

// What a melee swing would hit, for the page's guess at a blow online, felt at once before the
// server's word on it (src/net/netMonsters.ts). The rules decide what is hit with the same cone
// (cone_hits in crates/engine/src/training.rs and actors.rs; online crates/server/src/combat.rs).

export interface Target {
  id: ActorId;
  x: number;
  y: number;
  z: number;
  radius: number;
  hitHeight: number;
  hitCeiling: number;
  faction: number;
}

const byDistance = (x: number, z: number) => (a: Target, b: Target) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z);

/**
 * A melee swing: everything inside the arc and within reach, nearest first, capped at `max`.
 * Something standing right on top of you counts even if it is behind the arc, because losing a
 * swing to a target that is already inside your guard reads as a bug.
 */
export function coneHits(targets: readonly Target[], x: number, z: number, facing: number, reach: number, arcDeg: number, max = 1): Target[] {
  const hits: Target[] = [];
  for (const t of targets) {
    const dx = t.x - x;
    const dz = t.z - z;
    const dist = Math.hypot(dx, dz);
    if (dist > reach + t.radius) continue;
    const inCone = Math.abs(angleDiff(facing, Math.atan2(dx, dz))) <= (arcDeg / 2) * DEG;
    if (!inCone && dist > t.radius + 0.3) continue;
    hits.push(t);
  }
  hits.sort(byDistance(x, z));
  return hits.slice(0, Math.max(1, max));
}
