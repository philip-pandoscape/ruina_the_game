import { ABILITIES, effectDamage, effectRadius, STEP } from '../tuning';
import { pointHit } from './combat/hit';
import type { Sim } from './sim';
import type { GameEvent } from './types';

// The training yard has no server, so this stands in for it: arrows fly, meteors fall and Healing
// Circle goes off, with the same numbers the server uses (crates/server/src/game.rs), against the dummy.

const ARROW_PAD = 0.25; // how close an arrow has to pass to count
const ARROW_KNOCK = 3; // how hard it rocks whatever it hits
const METEOR_KNOCK = 9;

export interface ArrowFlight {
  x: number;
  y: number;
  z: number;
  dirX: number;
  dirZ: number;
  speed: number;
  left: number; // metres of range left
  damage: number;
  weapon: number; // which weapon loosed it (what it hits trains that one)
  spent: boolean; // it hit something and is done
}

export interface MeteorFall {
  x: number;
  z: number;
  frame: number; // frames since the cast finished
  fallFrames: number;
  radius: number;
  damage: number;
}

export class TrainingRange {
  arrows: ArrowFlight[] = [];
  meteors: MeteorFall[] = [];

  constructor(private sim: Sim) {}

  reset(): void {
    this.arrows = [];
    this.meteors = [];
  }

  // Picks up shots and finished casts from this step's events, then moves everything one step.
  // New effects (hits, heals, explosions) go into the sim's event list.
  step(events: GameEvent[]): void {
    for (const e of events) {
      if (e.type === 'shoot') {
        this.arrows.push({
          x: e.x,
          y: e.y,
          z: e.z,
          dirX: e.dirX,
          dirZ: e.dirZ,
          speed: e.speed,
          left: e.range,
          damage: e.damage,
          weapon: e.weapon,
          spent: false,
        });
      } else if (e.type === 'cast') {
        // Whatever the ability is made of, run each of its effects. The dummy is the only thing
        // out here to hit, so this is the server's rules narrowed to one target.
        const r = this.sim.stats;
        for (const fx of ABILITIES[e.ability]?.effects ?? []) {
          if (fx.kind === 'healArea') {
            this.sim.addEvent({ type: 'heal', frame: e.frame, x: e.casterX, y: 0, z: e.casterZ, radius: effectRadius(e.ability, fx, r) });
          } else if (fx.kind === 'delayedArea') {
            this.meteors.push({
              x: e.x,
              z: e.z,
              frame: 0,
              fallFrames: fx.delayFrames ?? 30,
              radius: effectRadius(e.ability, fx, r),
              damage: effectDamage(e.ability, fx, r),
            });
          }
        }
      }
    }

    for (const a of this.arrows) {
      // Short hops, like the server, so fast arrows can't skip past something thin.
      const travel = Math.min(a.speed * STEP, a.left);
      const hops = Math.max(1, Math.ceil(travel / 0.5));
      for (let h = 0; h < hops && !a.spent; h++) {
        a.x += (a.dirX * travel) / hops;
        a.z += (a.dirZ * travel) / hops;
        const hit = pointHit(this.sim.targets(), a.x, a.y, a.z, ARROW_PAD);
        if (hit) {
          a.spent = true;
          this.sim.damageFrom(hit, a.damage, a.dirX, a.dirZ, ARROW_KNOCK, 0, a.weapon);
        }
      }
      a.left -= travel;
    }
    this.arrows = this.arrows.filter((a) => a.left > 0 && !a.spent);

    for (const m of this.meteors) {
      m.frame++;
      if (m.frame < m.fallFrames) continue;
      this.sim.damageCircle(m.x, m.z, m.radius, m.damage, METEOR_KNOCK, 2);
      this.sim.addEvent({ type: 'explosion', frame: this.sim.frame, x: m.x, y: 0, z: m.z, radius: m.radius });
    }
    this.meteors = this.meteors.filter((m) => m.frame < m.fallFrames);
  }
}
