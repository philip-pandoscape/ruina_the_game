import { FACTION, isAlive, PLAYER_ID, type Actor, type ActorId } from '../actor';

// One place that answers "what did this hit". Melee cones, projectile points and blast circles
// all come through here, so a new weapon does not have to learn about every kind of target and
// a new monster does not have to be added to every weapon.

const DEG = Math.PI / 180;

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

const angleDiff = (a: number, b: number): number => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

export const targetOf = (a: Actor): Target => ({
  id: a.id,
  x: a.x,
  y: a.y,
  z: a.z,
  radius: a.radius,
  hitHeight: a.hitHeight,
  hitCeiling: a.hitCeiling,
  faction: a.faction,
});

/** Everything currently standing that an attack could land on. */
export function liveTargets(actors: readonly Actor[], extra?: Target): Target[] {
  const out: Target[] = [];
  // Townsfolk (neutral) are never hit.
  for (const a of actors) if (isAlive(a) && a.faction !== FACTION.neutral) out.push(targetOf(a));
  if (extra) out.push(extra);
  return out;
}

const byDistance = (x: number, z: number) => (a: Target, b: Target) =>
  Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z);

/**
 * A melee swing: everything inside the arc and within reach, nearest first, capped at `max`.
 * Something standing right on top of you counts even if it is behind the arc, because losing a
 * swing to a target that is already inside your guard reads as a bug.
 */
export function coneHits(
  targets: readonly Target[],
  x: number,
  z: number,
  facing: number,
  reach: number,
  arcDeg: number,
  max = 1,
): Target[] {
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

/** A blast: everything whose body overlaps the circle. */
export function circleHits(targets: readonly Target[], x: number, z: number, radius: number): Target[] {
  const hits = targets.filter((t) => Math.hypot(t.x - x, t.z - z) <= radius + t.radius);
  hits.sort(byDistance(x, z));
  return hits;
}

/** A projectile at a point in flight: the first thing it touches, or null. */
export function pointHit(targets: readonly Target[], x: number, y: number, z: number, pad = 0): Target | null {
  let best: Target | null = null;
  let bestDist = Infinity;
  for (const t of targets) {
    if (y > t.hitCeiling) continue;
    const dist = Math.hypot(t.x - x, t.z - z);
    if (dist > t.radius + pad || dist >= bestDist) continue;
    best = t;
    bestDist = dist;
  }
  return best;
}

/** The nearest thing worth swinging at, for auto-aim. Ignores the arc. */
export function nearest(targets: readonly Target[], x: number, z: number, within: number): Target | null {
  let best: Target | null = null;
  let bestDist = within;
  for (const t of targets) {
    const dist = Math.hypot(t.x - x, t.z - z);
    if (dist < bestDist) {
      best = t;
      bestDist = dist;
    }
  }
  return best;
}

export const isPlayer = (t: Target): boolean => t.id === PLAYER_ID;
