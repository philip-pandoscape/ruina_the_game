import { actorKindAt } from '../content/actors';
import { behaviour, coneHits, type Target } from '../engine/creatures';
import type { GameEvent } from '../engine/rules';
import { type AttackStep, WEAPONS } from '../content/tuning';
import type { ActorTimeline } from './actorTimeline';
import { CAUSE_WEAPON, causeOf } from './netSpells';
import type { NetActor } from './worldFeed';

// Monsters online, made to feel the way they do offline. The server decides every hit, so on its
// own the browser would only learn of one when its number arrives, a round trip after the swing
// passed through the slime on screen: no sparks, no shake, no flash. Here:
//
// - Your swing is checked against the monsters as the server last placed them, with the server's
//   own rule, the moment it strikes. A hit sparks, shakes and
//   flashes then and there, on the slime as it is drawn; the server's number follows. A hit the
//   server saw and this guess missed gets the same show when its word arrives, late but whole.
// - Health going down on anything, from anyone's blow, flashes it at the moment that blow is drawn.
// - What the server only tells as a change of state (a slam landing, a death, a gather starting or
//   broken, growing a size) gets the effect the offline rules give it, when the drawn monster does it.

/** How long a flash takes to fade (ms): the 7 frames src/render/actors.ts gives one offline. */
const FLASH_MS = (7 / 60) * 1000;
/** How long a guessed hit waits for the server to agree before it's forgotten (ms). */
const CLAIM_MS = 1500;
/** A loss of health this soon after your own blow on the same monster is that blow, confirmed (ms). */
const OWN_MS = 900;
/** How near a hit the server reports must be to a monster to be on it (metres). */
const ON_IT = 1.2;

/** What the drawn monster was doing last frame, to see what it has just done. */
interface Was {
  kind: number;
  state: number;
  progress: number;
  dead: boolean;
  seen: number;
}

export interface SwingInput {
  /** The rules' player after this step. */
  attacking: boolean;
  attackIndex: number;
  attackFrame: number;
  step: AttackStep | null;
  x: number;
  y: number;
  z: number;
  facing: number;
  /** How far above whatever is under you your feet are (a swing from higher than 2 m reaches nothing). */
  above: number;
  /** How many it can catch at once. */
  max: number;
}

export class NetMonsters {
  /** Flash start times by monster id (performance.now() ms). */
  private flashes = new Map<number, number[]>();
  /** When you last struck each monster, guessed or confirmed. */
  private own = new Map<number, number>();
  private guesses: Array<{ id: number; at: number }> = [];
  private hurtsSeen = 0;
  /** The swing a guess was made for, so it lands once, as the rules have it. */
  private swingIndex = -1;
  private swingFrame = -1;
  private landed = false;
  private was = new Map<number, Was>();
  private frame = 0;
  /** For tests and the bug reporter. */
  readonly counts = { guessed: 0, confirmed: 0, claimed: 0, late: 0, flashed: 0, slams: 0, deaths: 0 };

  constructor(private ground: (x: number, z: number) => number) {}

  /**
   * One rules step of your own: on a frame where your swing can strike and hasn't yet, test it
   * against the monsters as the server last had them (`present`). Returns 'hit' events to show
   * now, placed on the monsters as they are drawn (`drawn`).
   */
  swing(p: SwingInput, present: readonly NetActor[], drawn: ReadonlyMap<number, NetActor>, frame: number, now: number): GameEvent[] {
    if (!p.attacking || !p.step) {
      this.swingIndex = -1;
      return [];
    }
    if (p.attackIndex !== this.swingIndex || p.attackFrame < this.swingFrame) {
      this.swingIndex = p.attackIndex;
      this.landed = false;
    }
    this.swingFrame = p.attackFrame;
    const s = p.step;
    if (this.landed || s.projectileSpeed || p.attackFrame <= s.startup || p.attackFrame > s.startup + s.active || p.above > 2) return [];
    const targets: Target[] = [];
    for (const a of present) {
      const k = actorKindAt(a.kind);
      if (!k || a.deadFrame >= 0 || k.faction === 0 || k.faction === 2) continue;
      // On hills only feet within 2 m of yours (combat.rs swing_actors).
      if (Math.abs(a.y + this.ground(a.x, a.z) - p.y) > 2) continue;
      targets.push({ id: a.id, x: a.x, y: a.y, z: a.z, radius: k.radius, hitHeight: k.hitHeight, hitCeiling: k.hitCeiling, faction: k.faction });
    }
    const hits = coneHits(targets, p.x, p.z, p.facing, s.reach, s.arcDeg, p.max);
    if (!hits.length) return [];
    this.landed = true;
    const out: GameEvent[] = [];
    for (const t of hits) {
      const a = drawn.get(t.id) ?? present.find((x) => x.id === t.id)!;
      out.push(this.hitAt(a, p.x, p.z, p.attackIndex, s.damage, frame));
      this.guesses.push({ id: t.id, at: now });
      this.strike(t.id, now);
      this.counts.guessed++;
    }
    return out;
  }

  /**
   * The server's word that one of your blows landed (`cause`: a weapon or an ability, causeOf). Returns
   * where the number goes, on the monster as drawn if it was one, and anything still to show: a
   * melee hit that wasn't guessed gets its sparks and shake now.
   */
  confirm(
    x: number,
    y: number,
    z: number,
    cause: number,
    from: { x: number; z: number; index: number },
    newest: readonly NetActor[],
    drawn: ReadonlyMap<number, NetActor>,
    frame: number,
    now: number,
  ): { x: number; y: number; z: number; show: GameEvent[] } {
    let best: NetActor | null = null;
    let bestD = ON_IT;
    for (const a of newest) {
      const d = Math.hypot(a.x - x, a.z - z);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    // Not a monster (another player, a battlefield bot): those show their own hits.
    if (!best) return { x, y, z, show: [] };
    const id = best.id;
    const a = drawn.get(id) ?? best;
    const k = actorKindAt(a.kind);
    const at = { x: a.x, y: this.ground(a.x, a.z) + a.y + (k?.hitHeight ?? 1), z: a.z };
    this.counts.confirmed++;
    this.guesses = this.guesses.filter((g) => now - g.at < CLAIM_MS);
    const guessed = this.guesses.findIndex((g) => g.id === id);
    if (guessed >= 0) {
      this.guesses.splice(guessed, 1);
      this.own.set(id, now);
      this.counts.claimed++;
      return { ...at, show: [] };
    }
    const show: GameEvent[] = [];
    // A melee weapon's blow, not an arrow's or a spell's.
    const { sort, index } = causeOf(cause);
    if (sort === CAUSE_WEAPON && !WEAPONS[index]?.combo.some((s) => s.projectileSpeed)) {
      show.push(this.hitAt(a, from.x, from.z, from.index, 0, frame));
      this.counts.late++;
    }
    this.strike(id, now);
    return { ...at, show };
  }

  /**
   * Health lost on anything, by anyone (from the timeline): flashes it at the moment the blow is
   * drawn (`drawnAt` turns a tick and its arrival into that time), unless it's your own blow being
   * confirmed, which flashed already.
   */
  hurts(t: ActorTimeline, drawnAt: (tick: number, arrived: number) => number): void {
    const fresh = t.hurtCount - this.hurtsSeen;
    this.hurtsSeen = t.hurtCount;
    const list = t.hurts;
    for (let i = Math.max(0, list.length - fresh); i < list.length; i++) {
      const h = list[i];
      const mine = this.own.get(h.id);
      if (mine !== undefined && h.at - mine < OWN_MS && h.at >= mine - 100) continue;
      this.flashAt(h.id, drawnAt(h.tick, h.at));
    }
  }

  /** 0..1 how white a monster is drawn right now. */
  flash(id: number, now: number): number {
    const list = this.flashes.get(id);
    if (!list) return 0;
    let v = 0;
    for (const s of list) if (s <= now) v = Math.max(v, 1 - (now - s) / FLASH_MS);
    return Math.max(0, v);
  }

  /**
   * The monsters as drawn this frame: what they've just done that the offline rules would have
   * made an effect of. Returns the events to show.
   */
  transitions(drawn: readonly NetActor[], frame: number): GameEvent[] {
    this.frame++;
    const out: GameEvent[] = [];
    for (const a of drawn) {
      const k = actorKindAt(a.kind);
      if (!k) continue;
      const dead = a.deadFrame >= 0;
      const was = this.was.get(a.id);
      this.was.set(a.id, { kind: a.kind, state: a.state, progress: a.progress, dead, seen: this.frame });
      if (!was) continue;
      const g = this.ground(a.x, a.z);
      if (!was.dead && dead) {
        out.push({ type: 'actorDie', frame, id: a.id, kind: k.id, x: a.x, y: g + k.hitHeight, z: a.z, killed: true });
        if (k.burst) out.push({ type: 'actorBurst', frame, kind: k.id, count: k.burst.count, x: a.x, y: g + k.hitHeight, z: a.z });
        this.counts.deaths++;
        continue;
      }
      if (dead || was.dead) continue;
      if (was.kind !== a.kind) {
        out.push({ type: 'actorGrow', frame, id: a.id, kind: k.id, x: a.x, y: g, z: a.z });
        continue;
      }
      const b = k.brain ? behaviour(k.brain) : undefined;
      if (!b) continue;
      const before = b.states[was.state];
      const now = b.states[a.state];
      const changed = was.state !== a.state || a.progress < was.progress;
      if (!changed) continue;
      if (before?.act === 'leap' && k.slam) {
        out.push({ type: 'slam', frame, x: a.x, y: g, z: a.z, radius: k.slam.radius });
        this.counts.slams++;
      }
      if (before?.act === 'channel' && was.progress < 0.97) {
        out.push({ type: 'gatherBroken', frame, id: a.id, x: a.x, y: g + k.hitHeight, z: a.z });
      }
      if (now?.act === 'channel' && before?.act !== 'channel' && b.gather) {
        out.push({ type: 'gatherStart', frame, id: a.id, x: a.x, y: g, z: a.z, radius: b.gather.radius });
      }
    }
    // Forget the ones that have gone, and flashes long over.
    if (this.frame % 120 === 0) {
      for (const [id, w] of this.was) if (this.frame - w.seen > 120) this.was.delete(id);
      const now = performance.now();
      for (const [id, list] of this.flashes) if (now - list[list.length - 1] > 2000) this.flashes.delete(id);
      for (const [id, at] of this.own) if (now - at > 2000) this.own.delete(id);
    }
    return out;
  }

  /** A blow of yours on monster `id` at `now`: it flashes. */
  private strike(id: number, now: number): void {
    this.own.set(id, now);
    this.flashAt(id, now);
  }

  private flashAt(id: number, at: number): void {
    const list = (this.flashes.get(id) ?? []).filter((s) => at - s < 2000);
    list.push(at);
    this.flashes.set(id, list);
    this.counts.flashed++;
  }

  /** A 'hit' on a drawn monster, as the rules make one: on its near side, at its middle. */
  private hitAt(a: NetActor, fromX: number, fromZ: number, index: number, damage: number, frame: number): GameEvent {
    const k = actorKindAt(a.kind);
    const dx = a.x - fromX;
    const dz = a.z - fromZ;
    const d = Math.hypot(dx, dz);
    const nx = d > 0.01 ? dx / d : 0;
    const nz = d > 0.01 ? dz / d : 1;
    const r = k?.radius ?? 0.4;
    return {
      type: 'hit',
      frame,
      index,
      damage,
      x: a.x - nx * r,
      y: this.ground(a.x, a.z) + a.y + (k?.hitHeight ?? 1),
      z: a.z - nz * r,
      dirX: nx,
      dirZ: nz,
    };
  }
}
