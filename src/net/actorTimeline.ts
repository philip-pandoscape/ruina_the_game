import type { NetActor } from './netCrowd';

// The monsters and props the server describes, kept for a moment by tick so they can be drawn
// between its updates instead of jumping from one to the next. The server answers 20 times a
// second; drawn as they arrive, a hopping slime moves at 20 frames a second (worse when the
// network bunches updates up). Drawn here, they move as smoothly as everything else, at the same
// moment in the past other players are drawn at (NetCrowd.renderTick), and a late update carries
// them on a little rather than stopping them dead.
//
// It also notices health going down, so a blow from anyone flashes whatever it landed on.

/** How many updates are kept: a little over a second at 20 a second. */
const KEEP = 24;
/** Further than this between two updates (metres) is a respawn or a jump across the map: no sliding. */
const SNAP = 3;
/** How far past the newest update things are carried on, in ticks, when the next one is late. */
const AHEAD = 1.5;
/** How long a note of lost health is kept (ms). */
const HURT_KEEP = 3000;

interface Snapshot {
  tick: number;
  byId: Map<number, NetActor>;
  list: NetActor[];
}

/** An actor that lost health: on which tick, and when that tick arrived here (performance.now()). */
export interface HurtNote {
  id: number;
  tick: number;
  at: number;
}

const TAU = Math.PI * 2;

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
  if (respawned || a.kind !== b.kind || Math.hypot(b.x - a.x, b.z - a.z) > SNAP) {
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
  };
}

export class ActorTimeline {
  private snaps: Snapshot[] = [];
  /** Recent losses of health, oldest first. */
  readonly hurts: HurtNote[] = [];
  /** Counts every note ever made, so a reader can tell which ones it has seen. */
  hurtCount = 0;

  /** A new update from the server: what it says is out there as of `tick`, arriving at `now`. */
  push(tick: number, actors: readonly NetActor[], now: number): void {
    let last: Snapshot | undefined = this.snaps[this.snaps.length - 1];
    // A restarted server counts its ticks from scratch again: forget what came before.
    if (last && tick < last.tick - 40) {
      this.snaps = [];
      last = undefined;
    } else if (last && tick <= last.tick) return;
    const byId = new Map<number, NetActor>();
    for (const a of actors) byId.set(a.id, a);
    if (last) {
      for (const b of actors) {
        const a = last.byId.get(b.id);
        if (a && a.kind === b.kind && a.deadFrame < 0 && b.hp < a.hp - 1e-6) {
          this.hurts.push({ id: b.id, tick, at: now });
          this.hurtCount++;
        }
      }
    }
    while (this.hurts.length && now - this.hurts[0].at > HURT_KEEP) this.hurts.shift();
    this.snaps.push({ tick, byId, list: [...actors] });
    if (this.snaps.length > KEEP) this.snaps.shift();
  }

  /** The newest update's actors, as they came. */
  newest(): readonly NetActor[] {
    return this.snaps[this.snaps.length - 1]?.list ?? [];
  }

  /**
   * Every actor as it was at (fractional) server tick `tick`: blended between the two updates
   * either side, or carried on a little past the newest. Health is always the newest word on it,
   * so a blow shows on its bar the moment the server says so.
   */
  at(tick: number): NetActor[] {
    const s = this.snaps;
    if (!s.length) return [];
    const newest = s[s.length - 1];
    if (s.length === 1 || tick <= s[0].tick) return newest === s[0] ? [...newest.list] : this.withHp(s[0].list, newest);
    let a: Snapshot;
    let b: Snapshot;
    let k: number;
    if (tick >= newest.tick) {
      a = s[s.length - 2];
      b = newest;
      k = 1 + Math.min(AHEAD, tick - b.tick) / Math.max(1, b.tick - a.tick);
    } else {
      let i = s.length - 2;
      while (i > 0 && s[i].tick > tick) i--;
      a = s[i];
      b = s[i + 1];
      k = (tick - a.tick) / Math.max(1e-6, b.tick - a.tick);
    }
    const out: NetActor[] = [];
    for (const nb of b.list) {
      const na = a.byId.get(nb.id);
      const shown = na ? blendActor(na, nb, k) : { ...nb };
      const fresh = newest.byId.get(nb.id);
      if (fresh) shown.hp = fresh.hp;
      out.push(shown);
    }
    // Still there at the start of the gap, gone by its end (out of range, absorbed): drawn until then.
    if (k < 1) {
      for (const na of a.list) {
        if (b.byId.has(na.id)) continue;
        const shown = { ...na };
        const fresh = newest.byId.get(na.id);
        if (fresh) shown.hp = fresh.hp;
        out.push(shown);
      }
    }
    return out;
  }

  private withHp(list: readonly NetActor[], newest: Snapshot): NetActor[] {
    return list.map((x) => {
      const fresh = newest.byId.get(x.id);
      return fresh ? { ...x, hp: fresh.hp } : { ...x };
    });
  }
}
