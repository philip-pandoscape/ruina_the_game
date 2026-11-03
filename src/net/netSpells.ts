import type { SpellView } from '../render/spells';
import type { GameEvent } from '../sim/types';
import { abilityOfKind, ABILITIES, CAST } from '../tuning';
import type { ArrowRecord, EffectEvent, MeteorRecord, NetCrowd } from './netCrowd';

// Arrows, meteors and spell effects online, timed to match the rest of the screen: other players'
// at the moment other players are drawn (a little in the past), your own in the present. Your own
// arrows, meteors and heals show the instant you release or finish the cast, before the server has
// even heard about them; when the server's copy of an arrow or meteor arrives, it takes over.

const ARROW_RADIUS = 0.55; // server/src/game.rs
const EVENT_HEAL = 1;
const EVENT_EXPLOSION = 2;
const EVENT_ARROW_HIT = 3;
const METEOR = ABILITIES[abilityOfKind(CAST.meteor)];
const HEAL = ABILITIES[abilityOfKind(CAST.heal)];

interface Tracked<T> {
  rec: T;
  first: number; // server tick it was first and last seen
  last: number;
}

interface LocalArrow {
  x: number;
  y: number;
  z: number;
  dirX: number;
  dirZ: number;
  speed: number;
  left: number;
  pierceLeft: number;
}

interface LocalMeteor {
  x: number;
  z: number;
  frame: number;
}

// Effects already shown from your own moves, so the server's copies can be skipped.
interface Shown {
  kind: number;
  x: number;
  z: number;
  until: number; // performance.now() time
}

export class NetSpells {
  private arrows = new Map<number, Tracked<ArrowRecord>>();
  private meteors = new Map<number, Tracked<MeteorRecord>>();
  private localArrows: LocalArrow[] = [];
  private localMeteors: LocalMeteor[] = [];
  private queued: Array<{ tick: number; e: EffectEvent }> = [];
  private shown: Shown[] = [];
  private latest = 0;

  constructor(private net: NetCrowd) {}

  // Your own shots and finished casts, straight from your predicted moves. Returns effects to show now.
  local(e: GameEvent): GameEvent[] {
    if (e.type === 'shoot') {
      this.localArrows.push({ x: e.x, y: e.y, z: e.z, dirX: e.dirX, dirZ: e.dirZ, speed: e.speed, left: e.range, pierceLeft: e.pierce });
    } else if (e.type === 'cast' && e.kind === CAST.meteor) {
      this.localMeteors.push({ x: e.x, z: e.z, frame: 0 });
    } else if (e.type === 'cast' && e.kind === CAST.heal) {
      this.shown.push({ kind: EVENT_HEAL, x: e.casterX, z: e.casterZ, until: performance.now() + 2000 });
      return [{ type: 'heal', frame: e.frame, x: e.casterX, y: 0, z: e.casterZ, radius: HEAL.radius }];
    }
    return [];
  }

  // Moves your own arrows and meteors one sim step. `enemyAt` says whether an enemy is drawn
  // within r metres of (x, z). Returns effects to show (your meteors landing).
  step(dt: number, frame: number, enemyAt: (x: number, z: number, r: number) => boolean): GameEvent[] {
    const out: GameEvent[] = [];
    for (const a of this.localArrows) {
      const travel = Math.min(a.speed * dt, a.left);
      const hops = Math.max(1, Math.ceil(travel / 0.5));
      for (let h = 0; h < hops && a.pierceLeft > 0; h++) {
        a.x += (a.dirX * travel) / hops;
        a.z += (a.dirZ * travel) / hops;
        if (enemyAt(a.x, a.z, ARROW_RADIUS)) a.pierceLeft = 0; // the server decides piercing; stop here
      }
      a.left -= travel;
    }
    this.localArrows = this.localArrows.filter((a) => a.left > 0 && a.pierceLeft > 0);
    for (const m of this.localMeteors) {
      m.frame++;
      if (m.frame === METEOR.fallFrames) {
        this.shown.push({ kind: EVENT_EXPLOSION, x: m.x, z: m.z, until: performance.now() + 3000 });
        out.push({ type: 'explosion', frame, x: m.x, y: 0, z: m.z, radius: METEOR.radius });
      }
    }
    this.localMeteors = this.localMeteors.filter((m) => m.frame < (METEOR.fallFrames ?? 30));
    return out;
  }

  // A new update from the server: keep track of arrows and meteors, let the server's copies of your
  // own arrows take over from the ones you're already drawing, and queue up effects.
  receive(myId: number | null): void {
    const tick = this.net.lastTick;
    this.latest = tick;
    for (const a of this.net.arrows) {
      const t = this.arrows.get(a.id);
      if (t) {
        t.rec = a;
        t.last = tick;
        continue;
      }
      this.arrows.set(a.id, { rec: a, first: tick, last: tick });
      if (a.owner === myId) this.claimLocalArrow(a);
    }
    for (const m of this.net.meteors) {
      const t = this.meteors.get(m.id);
      if (t) {
        t.rec = m;
        t.last = tick;
      } else {
        this.meteors.set(m.id, { rec: m, first: tick, last: tick });
      }
    }
    for (const e of this.net.events.splice(0)) this.queued.push({ tick, e });
  }

  // The local arrow that matches a server arrow: same direction, on the same line.
  private claimLocalArrow(a: ArrowRecord): void {
    const speed = Math.hypot(a.vx, a.vz) || 1;
    const dx = a.vx / speed;
    const dz = a.vz / speed;
    let best = -1;
    let bestOff = 1.0;
    this.localArrows.forEach((l, i) => {
      if (l.dirX * dx + l.dirZ * dz < 0.995) return;
      const off = Math.abs((a.x - l.x) * dz - (a.z - l.z) * dx); // distance from the local arrow's line
      if (off < bestOff) {
        bestOff = off;
        best = i;
      }
    });
    if (best >= 0) this.localArrows.splice(best, 1);
  }

  // Effects from the server that are due on screen by `renderTick`, minus the ones you've already
  // seen from your own moves.
  due(renderTick: number, frame: number): GameEvent[] {
    const now = performance.now();
    this.shown = this.shown.filter((s) => s.until > now);
    const out: GameEvent[] = [];
    while (this.queued.length && this.queued[0].tick - 0.5 <= renderTick) {
      const { e } = this.queued.shift()!;
      const dupe = this.shown.findIndex((s) => s.kind === e.kind && Math.hypot(s.x - e.x, s.z - e.z) < 1.5);
      if (dupe >= 0) {
        this.shown.splice(dupe, 1);
        continue;
      }
      if (e.kind === EVENT_HEAL) out.push({ type: 'heal', frame, x: e.x, y: 0, z: e.z, radius: e.size / 10 });
      else if (e.kind === EVENT_EXPLOSION) out.push({ type: 'explosion', frame, x: e.x, y: 0, z: e.z, radius: e.size / 10 });
      else if (e.kind === EVENT_ARROW_HIT) out.push({ type: 'arrowHit', frame, x: e.x, y: e.y, z: e.z });
    }
    return out;
  }

  // Draws every arrow and meteor. Other players' at renderTick, your own at presentTick (both in
  // server ticks, fractional).
  draw(view: SpellView, renderTick: number, presentTick: number, myId: number | null, myTeam: number): void {
    const tickSec = 1 / this.net.ticksPerSecond;
    for (const [id, t] of this.arrows) {
      const a = t.rec;
      const mine = a.owner === myId;
      const at = mine ? presentTick : renderTick;
      const inLatest = t.last === this.latest;
      // Gone from the server's list: it hit something or ran out of range.
      if (!inLatest && (mine || at > t.last + 0.5)) {
        this.arrows.delete(id);
        continue;
      }
      if (at < t.first - 1) continue; // not loosed yet, as far as this screen is concerned
      const dt = (at - t.last) * tickSec;
      const speed = Math.hypot(a.vx, a.vz) || 1;
      view.arrow(a.x + a.vx * dt, a.y, a.z + a.vz * dt, a.vx / speed, a.vz / speed);
    }
    for (const a of this.localArrows) view.arrow(a.x, a.y, a.z, a.dirX, a.dirZ);

    const fallFrames = METEOR.fallFrames ?? 30;
    for (const [id, t] of this.meteors) {
      const m = t.rec;
      if (t.last !== this.latest && renderTick > t.last + 1) {
        this.meteors.delete(id);
        continue;
      }
      // Your own meteor is already drawn from your cast.
      if (this.localMeteors.some((l) => Math.abs(l.x - m.x) < 0.1 && Math.abs(l.z - m.z) < 0.1)) continue;
      if (renderTick < t.first - 1) continue;
      const fall = (m.fallTicks - m.ticksLeft + (renderTick - t.last)) / m.fallTicks;
      if (fall < 1) view.meteor(m.x, m.z, fall, METEOR.radius, m.team !== myTeam);
    }
    for (const m of this.localMeteors) view.meteor(m.x, m.z, m.frame / fallFrames, METEOR.radius, false);
  }

  get counts(): { arrows: number; localArrows: number; meteors: number; localMeteors: number } {
    return { arrows: this.arrows.size, localArrows: this.localArrows.length, meteors: this.meteors.size, localMeteors: this.localMeteors.length };
  }
}
