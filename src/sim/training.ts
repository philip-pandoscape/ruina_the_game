import { abilityOfKind, ABILITIES, CAST, DUMMY, STEP } from '../tuning';
import type { Sim } from './sim';
import type { GameEvent } from './types';

// The training yard has no server, so this stands in for it: arrows fly, meteors fall and Healing
// Circle goes off, with the same numbers the server uses (server/src/game.rs), against the dummy.

const DUMMY_HIT_RADIUS = DUMMY.radius + 0.25; // how close an arrow has to pass
const ARROW_KNOCK = 3; // dummy wobble
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
  hitDummy: boolean;
}

export interface MeteorFall {
  x: number;
  z: number;
  frame: number; // frames since the cast finished
  fallFrames: number;
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
        this.arrows.push({ x: e.x, y: e.y, z: e.z, dirX: e.dirX, dirZ: e.dirZ, speed: e.speed, left: e.range, damage: e.damage, hitDummy: false });
      } else if (e.type === 'cast' && e.kind === CAST.heal) {
        const heal = ABILITIES[abilityOfKind(CAST.heal)];
        this.sim.addEvent({ type: 'heal', frame: e.frame, x: e.casterX, y: 0, z: e.casterZ, radius: heal.radius });
      } else if (e.type === 'cast' && e.kind === CAST.meteor) {
        const meteor = ABILITIES[abilityOfKind(CAST.meteor)];
        this.meteors.push({ x: e.x, z: e.z, frame: 0, fallFrames: meteor.fallFrames ?? 30 });
      }
    }

    const d = this.sim.dummy;
    for (const a of this.arrows) {
      // Short hops, like the server, so fast arrows can't skip past the dummy.
      const travel = Math.min(a.speed * STEP, a.left);
      const hops = Math.max(1, Math.ceil(travel / 0.5));
      for (let h = 0; h < hops && !a.hitDummy; h++) {
        a.x += (a.dirX * travel) / hops;
        a.z += (a.dirZ * travel) / hops;
        if (d.brokenFrame < 0 && Math.hypot(d.x - a.x, d.z - a.z) < DUMMY_HIT_RADIUS && a.y < 2.2) {
          a.hitDummy = true;
          this.sim.hitDummy(a.damage, a.dirX, a.dirZ, ARROW_KNOCK, 0, a.y);
        }
      }
      a.left -= travel;
    }
    this.arrows = this.arrows.filter((a) => a.left > 0 && !a.hitDummy);

    for (const m of this.meteors) {
      m.frame++;
      if (m.frame < m.fallFrames) continue;
      const meteor = ABILITIES[abilityOfKind(CAST.meteor)];
      const dx = d.x - m.x;
      const dz = d.z - m.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= meteor.radius + DUMMY.radius) {
        this.sim.hitDummy(meteor.damage ?? 0, dist > 0.01 ? dx / dist : 1, dist > 0.01 ? dz / dist : 0, METEOR_KNOCK, 2, 1.0);
      }
      this.sim.addEvent({ type: 'explosion', frame: this.sim.frame, x: m.x, y: 0, z: m.z, radius: meteor.radius });
    }
    this.meteors = this.meteors.filter((m) => m.frame < m.fallFrames);
  }
}
