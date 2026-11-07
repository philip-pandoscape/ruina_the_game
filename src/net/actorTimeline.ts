import type { NetActor } from './worldFeed';
import { TAU } from '../util/math';

// The monsters and props the server describes, each kept for a moment by tick so they can be drawn
// between its updates instead of jumping from one to the next. The server answers 20 times a
// second; drawn as they arrive, a hopping slime moves at 20 frames a second (worse when the network
// bunches updates up). Drawn here, they move as smoothly as everything else, at the same moment in
// the past other players are drawn at (WorldFeed.renderTick), and a late update carries them on a
// little rather than stopping them dead.
//
// Each one has a timeline of its own: near you one comes every tick, but on the wire for crowds one
// further off comes every fourth or twentieth (its `every`), and between two of its states it is
// blended over however long lay between them.
//
// It also notices health going down, so a blow from anyone flashes whatever it landed on.

/** How long each one's states are kept (ticks): a little over a second, and a far one's last two. */
const KEEP_TICKS = 24;
/** Further than this between two updates (metres) is a respawn or a jump across the map: no sliding. */
const SNAP = 3;
/** How far past its newest state each one is carried on, in its own updates, when the next is late. */
const AHEAD = 1.5;
/** How long a note of lost health is kept (ms). */
const HURT_KEEP = 3000;

/** An actor that lost health: on which tick, and when that tick arrived here (performance.now()). */
export interface HurtNote {
  id: number;
  tick: number;
  at: number;
}

interface Track {
  id: number;
  /** Its states, oldest first. */
  states: Array<{ tick: number; a: NetActor }>;
  /** Ticks between its updates. */
  every: number;
  /** The tick it went out of sight as of (null while in sight). */
  gone: number | null;
}

function turn(a: number, b: number, k: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * k;
}

/** One actor `k` of the way from how it was in update `a` to how it is in update `b` (k > 1 carries it on). */
export function blendActor(a: NetActor, b: NetActor, k: number): NetActor {
  const near = k < 0.5 ? a : b;
  const respawned = a.deadFrame >= 0 && b.deadFrame < 0;
  if (respawned || a.kind !== b.kind || Math.hypot(b.x - a.x, b.z - a.z) > SNAP * Math.max(1, b.every ?? 1)) {
    // Came back somewhere else, grew into something else, or jumped: switch over, don't slide.
    return { ...near, hp: b.hp };
  }
  // Within one state its progress runs on smoothly; across a change of state (or the same state
  // starting over) it switches at the halfway point, which nobody can see in a twentieth of a second.
  const sameState = a.state === b.state && b.progress >= a.progress;
  const bothDead = a.deadFrame >= 0 && b.deadFrame >= 0;
  // Carried on past the newest update, only steady motion is: no hopping into the ground.
  const ahead = k > 1;
  const kk = ahead && (!sameState || b.deadFrame >= 0) ? 1 : k;
  return {
    id: b.id,
    kind: b.kind,
    x: a.x + (b.x - a.x) * kk,
    y: ahead ? b.y : a.y + (b.y - a.y) * k,
    z: a.z + (b.z - a.z) * kk,
    facing: turn(a.facing, b.facing, Math.min(1, k)),
    state: sameState ? b.state : near.state,
    progress: sameState ? Math.min(1, a.progress + (b.progress - a.progress) * k) : near.progress,
    hp: b.hp,
    deadFrame: bothDead ? a.deadFrame + (b.deadFrame - a.deadFrame) * k : near.deadFrame,
    targetX: near.targetX,
    targetZ: near.targetZ,
    every: b.every,
  };
}

export class ActorTimeline {
  private tracks = new Map<number, Track>();
  private last: number | null = null;
  /** Recent losses of health, oldest first. */
  readonly hurts: HurtNote[] = [];
  /** Counts every note ever made, so a reader can tell which ones it has seen. */
  hurtCount = 0;

  /** Forgets everything heard (you've gone somewhere else: a dungeon's copy, or back out of it). */
  reset(): void {
    this.tracks.clear();
    this.last = null;
    this.hurts.length = 0;
  }

  /**
   * A new update from the server as of `tick`, arriving at `now`: the actors with a fresh state in it,
   * and (on the wire for crowds) those still in sight that weren't refreshed. Null for `kept`: every
   * actor in sight is in `fresh`, and one that isn't has gone from sight.
   */
  push(tick: number, fresh: readonly NetActor[], kept: readonly number[] | null, now: number): void {
    // A restarted server counts its ticks from scratch again: forget what came before.
    if (this.last !== null && tick < this.last - 40) this.reset();
    else if (this.last !== null && tick <= this.last) return;
    this.last = tick;
    const inSight = new Set<number>();
    for (const a of fresh) {
      inSight.add(a.id);
      let t = this.tracks.get(a.id);
      if (!t || t.gone !== null) {
        t = { id: a.id, states: [], every: 1, gone: null };
        this.tracks.set(a.id, t);
      }
      const every = Math.max(1, a.every ?? 1);
      const before = t.states[t.states.length - 1];
      if (before) {
        if (a.kind === before.a.kind && before.a.deadFrame < 0 && a.hp < before.a.hp - 1e-6) {
          this.hurts.push({ id: a.id, tick, at: now });
          this.hurtCount++;
        }
        // Quiet for longer than its updates come: it stood as it was until just before this one.
        if (tick - before.tick > every + 1) t.states.push({ tick: tick - every, a: { ...before.a, hp: a.hp } });
      }
      t.states.push({ tick, a });
      t.every = every;
      while (t.states.length > 2 && t.states[0].tick < tick - Math.max(KEEP_TICKS, 2 * every + 2)) t.states.shift();
    }
    for (const id of kept ?? []) inSight.add(id);
    for (const t of this.tracks.values()) {
      if (!inSight.has(t.id) && t.gone === null) t.gone = tick;
      // Long out of sight: forgotten.
      if (t.gone !== null && t.gone < tick - KEEP_TICKS) this.tracks.delete(t.id);
    }
    while (this.hurts.length && now - this.hurts[0].at > HURT_KEEP) this.hurts.shift();
  }

  /** Every actor in sight as the newest update has it. */
  newest(): readonly NetActor[] {
    const out: NetActor[] = [];
    for (const t of this.tracks.values()) if (t.gone === null && t.states.length) out.push(t.states[t.states.length - 1].a);
    return out;
  }

  /**
   * Every actor as it was at (fractional) server tick `tick`: blended between its two states either
   * side, or carried on a little past its newest. Health is always the newest word on it, so a blow
   * shows on its bar the moment the server says so. One that went out of sight is drawn until the
   * moment it went.
   */
  at(tick: number): NetActor[] {
    const out: NetActor[] = [];
    for (const t of this.tracks.values()) {
      if (t.gone !== null && tick >= t.gone) continue;
      const s = t.states;
      if (!s.length) continue;
      const newest = s[s.length - 1];
      let shown: NetActor;
      if (s.length === 1 || tick <= s[0].tick) shown = { ...s[0].a };
      else if (tick >= newest.tick) {
        const a = s[s.length - 2];
        shown = blendActor(a.a, newest.a, 1 + Math.min(AHEAD * t.every, tick - newest.tick) / Math.max(1, newest.tick - a.tick));
      } else {
        let i = s.length - 2;
        while (i > 0 && s[i].tick > tick) i--;
        const a = s[i];
        const b = s[i + 1];
        shown = blendActor(a.a, b.a, (tick - a.tick) / Math.max(1e-6, b.tick - a.tick));
      }
      shown.hp = newest.a.hp;
      out.push(shown);
    }
    return out;
  }
}
