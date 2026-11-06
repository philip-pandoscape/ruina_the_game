import type { Actor, Actors, Missile } from '../actor';
import type { AttackDef } from '../../content/attacks';
import type { Foe } from '../ai/senses';
import { MOVE } from '../../tuning';
import { len } from '../math';

// What creatures throw and shoot, in flight: a stone, later an arrow or a bolt. It is aimed where
// its foe is going (as much as the attack leads), lobbed to come down on them, and it hits the
// first foe whose body it passes through, unless they are in a dodge's untouchable frames, when it
// flies on. It lands where it meets the ground. crates/engine/src/missiles.rs flies the same ones.

/** How tall a foe's body is, from the feet, for what a missile can hit. */
export const FOE_HEIGHT = 1.8;
/** Frames before a missile that never came down is gone. */
const LIFE = 240;

/** Lets one go from a creature at a foe. */
export function launch(actors: Actors, a: Actor, atk: AttackDef, attack: number, foe: Foe, groundY: number): Missile {
  const speed = atk.speed ?? 10;
  const gravity = atk.gravity ?? 0;
  const ox = a.x + Math.sin(a.facing) * 0.25;
  const oz = a.z + Math.cos(a.facing) * 0.25;
  const oy = groundY + a.hitHeight * 0.9;
  // Where the foe will be by the time it gets there, as much as this attack leads.
  const ahead = (len(foe.x - ox, foe.z - oz) / speed) * (atk.lead ?? 0);
  let dx = foe.x + foe.vx * ahead - ox;
  let dz = foe.z + foe.vz * ahead - oz;
  let d = len(dx, dz);
  const range = atk.range ?? d;
  if (d > range) {
    dx = (dx / d) * range;
    dz = (dz / d) * range;
    d = range;
  }
  const dirX = d > 1e-6 ? dx / d : Math.sin(a.facing);
  const dirZ = d > 1e-6 ? dz / d : Math.cos(a.facing);
  // Lobbed to come down at the foe's chest after flying that far at its speed.
  const t = Math.max(d / speed, 0.1);
  const vy = (foe.y + 1 - oy + 0.5 * gravity * t * t) / t;
  const m: Missile = {
    id: actors.missileId(),
    owner: a.id,
    attack,
    x: ox,
    y: oy,
    z: oz,
    vx: dirX * (d / t),
    vy,
    vz: dirZ * (d / t),
    gravity,
    radius: atk.radius ?? 0.1,
    damage: atk.damage,
    knock: atk.knock,
    age: 0,
  };
  actors.missiles.push(m);
  return m;
}

export interface MissileWorld {
  foes: readonly Foe[];
  ground(x: number, z: number): number;
  /** It struck a foe, travelling along (nx, nz). */
  hit(m: Missile, foe: Foe, nx: number, nz: number): void;
  /** It came down on the ground. */
  land(m: Missile): void;
}

/** One frame of everything in flight. */
export function stepMissiles(actors: Actors, w: MissileWorld): void {
  const kept: Missile[] = [];
  for (const m of actors.missiles) {
    m.age++;
    m.vy -= m.gravity / 60;
    m.x += m.vx / 60;
    m.y += m.vy / 60;
    m.z += m.vz / 60;
    let struck: Foe | undefined;
    for (const f of w.foes) {
      if (f.invuln) continue;
      if (len(f.x - m.x, f.z - m.z) > MOVE.playerRadius + m.radius) continue;
      if (m.y < f.y || m.y > f.y + FOE_HEIGHT) continue;
      struck = f;
      break;
    }
    if (struck) {
      const s = len(m.vx, m.vz);
      w.hit(m, struck, s > 1e-6 ? m.vx / s : 0, s > 1e-6 ? m.vz / s : 1);
      continue;
    }
    if (m.y <= w.ground(m.x, m.z)) {
      w.land(m);
      continue;
    }
    if (m.age < LIFE) kept.push(m);
  }
  actors.missiles = kept;
}
