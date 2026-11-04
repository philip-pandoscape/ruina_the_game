import type { SpellView } from '../render/spells';
import type { GameEvent } from '../sim/types';
import { ABILITIES, effectRadius } from '../tuning';
import type { ResolvedSkills } from '../skills';
import type { ArrowRecord, EffectEvent, MeteorRecord, NetCrowd } from './netCrowd';

// Arrows, meteors and spell effects online, timed to match the rest of the screen: other players'
// at the moment other players are drawn (a little in the past), your own in the present. Your own
// arrows, meteors and heals show the instant you release or finish the cast, before the server has
// even heard about them; when the server's copy of an arrow or meteor arrives, it takes over.

const ARROW_RADIUS = 0.55; // server/src/game.rs
const EVENT_HEAL = 1;
const EVENT_EXPLOSION = 2;
const EVENT_ARROW_HIT = 3;
// Sent only to the player they're about, so no local prediction can duplicate them.
const EVENT_YOU_HIT = 4;
const EVENT_YOU_HURT = 5;
const EVENT_YOU_HEAL = 6;

export type MarkerKind = 'hit' | 'hurt' | 'heal';
const MARKERS: Record<number, MarkerKind> = { [EVENT_YOU_HIT]: 'hit', [EVENT_YOU_HURT]: 'hurt', [EVENT_YOU_HEAL]: 'heal' };

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
  fallFrames: number;
  radius: number;
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
  // Damage you dealt, damage you took, healing you gave: position is the one it happened to.
  onMarker: ((kind: MarkerKind, x: number, y: number, z: number, amount: number, cause: number) => void) | null = null;
  private shown: Shown[] = [];
  // Your own resolved build, so a predicted effect is sized the way the server will size it.
  stats: ResolvedSkills;
  private latest = 0;

  constructor(
    private net: NetCrowd,
    stats: ResolvedSkills,
  ) {
    this.stats = stats;
  }

  // Your own shots and finished casts, straight from your predicted moves. Returns effects to show now.
  local(e: GameEvent): GameEvent[] {
    if (e.type === 'shoot') {
      this.localArrows.push({ x: e.x, y: e.y, z: e.z, dirX: e.dirX, dirZ: e.dirZ, speed: e.speed, left: e.range, pierceLeft: e.pierce });
    } else if (e.type === 'cast') {
      // Show each of the ability's effects straight away, before the server has even heard. The
      // server's own copy takes over when it arrives (see receive()).
      const out: GameEvent[] = [];
      for (const fx of ABILITIES[e.ability]?.effects ?? []) {
        const radius = effectRadius(e.ability, fx, this.stats);
        if (fx.kind === 'delayedArea') {
          this.localMeteors.push({ x: e.x, z: e.z, frame: 0, fallFrames: fx.delayFrames ?? 30, radius });
        } else if (fx.kind === 'healArea') {
          this.shown.push({ kind: EVENT_HEAL, x: e.casterX, z: e.casterZ, until: performance.now() + 2000 });
          out.push({ type: 'heal', frame: e.frame, x: e.casterX, y: 0, z: e.casterZ, radius });
        }
      }
      return out;
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
      if (m.frame === m.fallFrames) {
        this.shown.push({ kind: EVENT_EXPLOSION, x: m.x, z: m.z, until: performance.now() + 3000 });
        out.push({ type: 'explosion', frame, x: m.x, y: 0, z: m.z, radius: m.radius });
      }
    }
    this.localMeteors = this.localMeteors.filter((m) => m.frame < m.fallFrames);
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
      // The top 4 bits say what caused it; world effects leave them zero.
      const kind = e.kind & 15;
      const cause = e.kind >> 4;
      // Damage and healing meant for you: a floating number, not a world effect, and never deduped
      // against a local guess because the server is the only thing that knows the amount.
      const marker = MARKERS[kind];
      if (marker) {
        this.onMarker?.(marker, e.x, e.y, e.z, e.size, cause);
        continue;
      }
      const dupe = this.shown.findIndex((s) => s.kind === kind && Math.hypot(s.x - e.x, s.z - e.z) < 1.5);
      if (dupe >= 0) {
        this.shown.splice(dupe, 1);
        continue;
      }
      if (kind === EVENT_HEAL) out.push({ type: 'heal', frame, x: e.x, y: 0, z: e.z, radius: e.size / 10 });
      else if (kind === EVENT_EXPLOSION) out.push({ type: 'explosion', frame, x: e.x, y: 0, z: e.z, radius: e.size / 10 });
      else if (kind === EVENT_ARROW_HIT) out.push({ type: 'arrowHit', frame, x: e.x, y: e.y, z: e.z });
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
      if (fall < 1) view.meteor(m.x, m.z, fall, m.radius, m.team !== myTeam);
    }
    for (const m of this.localMeteors) view.meteor(m.x, m.z, m.frame / m.fallFrames, m.radius, false);
  }

  get counts(): { arrows: number; localArrows: number; meteors: number; localMeteors: number } {
    return { arrows: this.arrows.size, localArrows: this.localArrows.length, meteors: this.meteors.size, localMeteors: this.localMeteors.length };
  }
}
