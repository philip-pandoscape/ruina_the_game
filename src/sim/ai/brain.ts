import data from '../../../shared/behaviours.json' with { type: 'json' };
import { isAlive, kindOf, type Actor, type ActorId } from '../actor';
import { attackDef } from '../../content/attacks';
import { CREATURES } from '../../content/creatures';
import { angleDiff, len } from '../math';

// The behaviour interpreter. Monsters and NPCs do not get their own code: they get an entry in
// shared/behaviours.json (or their own file in shared/creatures/), and this walks it.
// crates/engine/src/ai.rs walks the same files the same way, so the training yard offline and the
// server online agree frame for frame.
//
// A brain only ever changes its own actor. Anything that reaches another (calling the pack,
// pulling them in, a slam landing on you, a stab, a thrown stone) it asks for, and
// src/sim/actors/step.ts does it once every brain has had its turn, so the order actors are
// stepped in can't change the outcome.

export interface Gait {
  /** Metres covered by one cycle of the state. */
  distance: number;
  /** Apex of the hop; zero for something that walks. */
  height: number;
  /** When in the cycle it leaves and regains the ground, as fractions. */
  airStart: number;
  airSpan: number;
}

/**
 * What a transition can wait for: one of these names, `!` in front to turn it round, and for
 * some a number or an attack after a colon (`near:1.7`, `ready:goblin-stone`). Anything else
 * never holds.
 *
 * The slimes': called, angry, threatened, canCall, slam, allies, callOver, broken, fuseLow.
 * A pack's (src/sim/ai/pack.ts): token, opening, afraid. Its foe: near:m, far:m, foeMelee,
 * foeRanged, foeSwinging. Its own: hurt:fraction, ready:attack, canHeal.
 */
export type Condition = string;

/** Go to `to` if `if` holds (all of them, for a list); with no `if`, always. The first that holds wins. */
export interface Guard {
  if?: Condition | Condition[];
  to: string;
}

/**
 * Where an advance heads. wander: toward you if you are in sight, home if it has strayed, anywhere
 * otherwise. player: at you. away: from you. keep: the way it was already set going. caller: to
 * whoever it is rallying to. ally: to its nearest kin. group: to the middle of its burst group.
 *
 * Where a walk heads, worked out again every frame: foe (stopping `stop` short), slot (its place on
 * the pack's ring), rally (its friends, or home), home, away (straight from its foe), wander (a
 * spot near home picked on the way in).
 */
export type Toward = 'wander' | 'player' | 'away' | 'keep' | 'caller' | 'ally' | 'group' | 'foe' | 'slot' | 'rally' | 'home';

export interface BehaviourState {
  name: string;
  /**
   * wait: stand. advance: hop or walk along the gait. windup: stand, having picked where a slam
   * will land. leap: jump there, and slam on landing. channel: stand and gather the pack in.
   * walk: go somewhere at `speed`, steering every frame. strike: wind up `attack` and land it in
   * a cone in front. throw: wind up `attack` and let the missile go. heal: drink, for the whole
   * state; it heals at the end (a blow that makes it flinch spills it).
   */
  act: 'wait' | 'advance' | 'windup' | 'leap' | 'channel' | 'walk' | 'strike' | 'throw' | 'heal';
  /** [min, max] frames, drawn on entry. */
  frames: [number, number];
  gait?: Gait;
  toward?: Toward;
  /** For toward 'player': how far short of you it stops. Defaults to the behaviour's keepAway. A walk's distance short of where it is going. */
  stop?: number;
  /** Entering this state calls the pack. */
  calls?: boolean;
  /** A walk's pace, metres a second. */
  speed?: number;
  /** 'foe': keeps facing its foe (circling, backing off, drinking) rather than the way it moves. */
  face?: 'foe';
  /** A strike's or throw's attack (shared/creatures/). */
  attack?: string;
  /** While here it holds its pack's attack token. */
  token?: boolean;
  /** Checked every frame; the first that holds cuts the state short. */
  interrupt?: Guard[];
  /** Where it goes when the state runs out: a state name, or guards. */
  next: string | Guard[];
}

/** How a war-band fights together (src/sim/ai/pack.ts). */
export interface PackDef {
  /** How many of the band may strike one foe at once, by how many are fighting it (1, 2, 3...); the last holds for more. */
  tokens: number[];
  /** The ring it waits on: this far outside the foe's weapon's reach. */
  ring: number;
  /** Degrees between places on the ring, at most; they bunch up behind the foe. */
  spread: number;
  /** An opening (the foe's back, recovery, cast or stun) lets one more in from this close. */
  openingRange: number;
  /** Degrees off the foe's facing beyond which it counts as behind them. */
  backArc: number;
  /** Friends and foes within this count toward courage. */
  friendRadius: number;
  /** Courage = health (0..1) + friendWorth per friend - foeWorth per foe. */
  friendWorth: number;
  foeWorth: number;
  /** Afraid below braveAt, and not again until calmAt. */
  braveAt: number;
  calmAt: number;
  /** It sticks with its foe unless another is this many metres closer. */
  switchAt: number;
}

export interface Behaviour {
  id: string;
  /** How far away it notices the player. */
  sight: number;
  /** It will not close nearer than this. */
  keepAway: number;
  /** Beyond this from where it spawned, it heads back instead of wandering. */
  leash: number;
  /** Hitting it angers it, and its kin this close, for `frames`; dragged past `calmBeyond` from home it calms down. */
  anger?: { frames: number; radius: number; calmBeyond: number };
  /** [min, max] frames between slams. */
  slamCooldown?: [number, number];
  /** Calling the pack: kin within `radius`, at least `need` of them, only if it was hit in the last `struck` frames; it gives up after `giveUp`. */
  call?: { radius: number; need: number; struckWithin: number; giveUp: number };
  /** Gathering: kin within `radius` slide in at `pull` m/s; losing `breakAt` of its health breaks it; then `cooldown` frames. */
  gather?: { radius: number; pull: number; breakAt: number; cooldown: number };
  /** A burst piece heads back to its group with this many frames left on the fuse. */
  regroupAt?: number;
  /** Angry and you are this close: it feels threatened (and, a burst piece, runs). */
  fleeWithin?: number;
  /** Seeing a foe within sight angers it (and its kin), if the foe is within its leash of home. */
  notices?: boolean;
  /** The attacks its states use, each with its own cooldown, in this order. */
  attacks?: string[];
  /** The state a blow at or above its kind's poise knocks it into. */
  flinch?: string;
  /** It carries `charges` heals of `amount` (a fraction of its health), for when it is below `below`. */
  heal?: { amount: number; charges: number; below: number };
  pack?: PackDef;
  states: BehaviourState[];
}

const loaded = [...(data.behaviours as unknown as Behaviour[]), ...CREATURES.flatMap((c) => (c.behaviours ?? []) as Behaviour[])];

export const BEHAVIOURS: Behaviour[] = loaded.map((b) => ({
  ...b,
  states: b.states.map((s) => ({ ...s, frames: [s.frames[0], s.frames[1]] as [number, number] })),
}));

const BY_ID = new Map(BEHAVIOURS.map((b) => [b.id, b]));
export const behaviour = (id: string): Behaviour | undefined => BY_ID.get(id);

/** The actor's own random stream. Advancing it on the actor keeps draws independent of order. */
export function draw(a: Actor): number {
  a.seed = (a.seed + 0x6d2b79f5) >>> 0;
  let t = a.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * What a brain can see of the foe it is after (src/sim/ai/senses.ts): where they are, and what it
 * can tell about them. `present` is false when there is nobody to notice - the brain then just
 * wanders.
 */
export interface Sighting {
  x: number;
  z: number;
  present: boolean;
  /** The foe's id, 1 and up (0 for nobody). */
  id: number;
  facing: number;
  /** Health left, 0..1. */
  hp: number;
  /** How far its weapon's swings reach; 0 for a bow. */
  reach: number;
  ranged: boolean;
  /** What it is doing (FOE_ACT in senses.ts). */
  act: number;
}

/** Someone standing at a point, as far as a brain can tell: empty-handed and doing nothing. */
export const sightingAt = (x: number, z: number, present: boolean): Sighting => ({
  x,
  z,
  present,
  id: present ? 1 : 0,
  facing: 0,
  hp: 1,
  reach: 0,
  ranged: false,
  act: 0,
});

/** Nobody about. */
export const NOBODY: Sighting = sightingAt(0, 0, false);

/** Another actor as the brains see it: where everyone standing was when the frame began. */
export interface Peer {
  id: ActorId;
  x: number;
  z: number;
  radius: number;
  ladder: number;
  calling: number;
  rallyTo: ActorId;
  group: number;
  band: number;
}

/** Something a brain asks the world to do, because it reaches beyond its own actor. */
export type Request =
  | { t: 'call'; id: ActorId }
  | { t: 'pull'; id: ActorId }
  | { t: 'absorb'; id: ActorId }
  | { t: 'slam'; id: ActorId }
  | { t: 'gatherStart'; id: ActorId }
  | { t: 'broke'; id: ActorId }
  | { t: 'fuseOut'; id: ActorId }
  | { t: 'strike'; id: ActorId; attack: string }
  | { t: 'throw'; id: ActorId; attack: string }
  | { t: 'heal'; id: ActorId };

/** The rest of the world, for a brain that has others to think about. Null for one on its own. */
export interface BrainCtx {
  peers: readonly Peer[];
  out: Request[];
}

const stateIndex = (b: Behaviour, name: string): number => {
  const i = b.states.findIndex((s) => s.name === name);
  return i < 0 ? 0 : i;
};

/** How far through the current state's cycle the actor is, 0..1. */
const progress = (a: Actor, frames: number): number => Math.min(1, a.stateFrame / Math.max(1, frames));

/** Off-the-ground fraction of a gait at a point in the cycle. */
const airAt = (g: Gait, t: number): number => Math.max(0, Math.min(1, (t - g.airStart) / g.airSpan));

const drawFrames = (a: Actor, range: [number, number] | undefined): number =>
  range ? Math.floor(range[0] + draw(a) * Math.max(0, range[1] - range[0])) : 0;

const kin = (a: Actor, p: Peer): boolean => p.id !== a.id && a.ladder >= 0 && p.ladder === a.ladder;

/** Heads at a point, covering at most `most` metres and stopping `stop` short of it. */
function aim(a: Actor, x: number, z: number, most: number, stop: number): void {
  const dx = x - a.x;
  const dz = z - a.z;
  const d = len(dx, dz);
  if (d > 1e-6) {
    a.moveX = dx / d;
    a.moveZ = dz / d;
  }
  a.stride = Math.min(most, Math.max(0, d - stop));
}

function peer(ctx: BrainCtx | null, id: ActorId): Peer | undefined {
  if (!ctx || id === 0) return undefined;
  for (const p of ctx.peers) if (p.id === id) return p;
  return undefined;
}

/** Turns to look at its foe. */
function faceFoe(a: Actor, seen: Sighting): void {
  const dx = seen.x - a.x;
  const dz = seen.z - a.z;
  if (len(dx, dz) > 1e-6) a.facing = Math.atan2(dx, dz);
}

// The original wander: toward you if you're in sight and not too close, home if it has strayed,
// a random way otherwise. Kept exactly, draw for draw, because the conformance tests pin it.
function wander(a: Actor, b: Behaviour, seen: Sighting, most: number): void {
  const dx = seen.x - a.x;
  const dz = seen.z - a.z;
  // len(), not Math.hypot: the Rust mirror has to agree bit for bit and hypot does not.
  const toPlayer = len(dx, dz);
  const hx = a.homeX - a.x;
  const hz = a.homeZ - a.z;
  const toHome = len(hx, hz);
  if (seen.present && toPlayer < b.sight && toPlayer > b.keepAway) {
    a.moveX = dx / toPlayer;
    a.moveZ = dz / toPlayer;
  } else if (toHome > b.leash) {
    a.moveX = hx / toHome;
    a.moveZ = hz / toHome;
  } else {
    const angle = draw(a) * Math.PI * 2;
    a.moveX = Math.sin(angle);
    a.moveZ = Math.cos(angle);
  }
  a.stride = most;
}

function enter(a: Actor, b: Behaviour, index: number, seen: Sighting, ctx: BrainCtx | null): void {
  a.state = index;
  a.stateFrame = 0;
  const s = b.states[index];
  const [lo, hi] = s.frames;
  a.wait = Math.floor(lo + draw(a) * Math.max(0, hi - lo));
  if (s.calls) {
    if (a.calling < 0) a.calling = 0;
    ctx?.out.push({ t: 'call', id: a.id });
  } else if (s.act !== 'channel') {
    a.calling = -1;
  }

  if (s.act === 'windup') {
    // Picks the spot now, so you can see it coming and step out of it.
    a.targetX = seen.present ? seen.x : a.x + a.moveX;
    a.targetZ = seen.present ? seen.z : a.z + a.moveZ;
    const dx = a.targetX - a.x;
    const dz = a.targetZ - a.z;
    if (len(dx, dz) > 1e-6) a.facing = Math.atan2(dx, dz);
    return;
  }
  if (s.act === 'leap') {
    const dx = a.targetX - a.x;
    const dz = a.targetZ - a.z;
    const d = len(dx, dz);
    if (d > 1e-6) {
      a.moveX = dx / d;
      a.moveZ = dz / d;
      a.facing = Math.atan2(a.moveX, a.moveZ);
    }
    a.stride = Math.min(d, kindOf(a)?.slam?.leap ?? 0);
    return;
  }
  if (s.act === 'channel') {
    a.taken = 0;
    ctx?.out.push({ t: 'gatherStart', id: a.id });
    return;
  }
  if (s.act === 'strike' || s.act === 'throw') {
    a.struck = false;
    if (seen.present) faceFoe(a, seen);
    return;
  }
  if (s.act === 'heal') {
    a.taken = 0;
    return;
  }
  if (s.act === 'walk') {
    if (s.toward === 'wander') {
      // A spot somewhere near home, picked once, so it strolls rather than dithers.
      const angle = draw(a) * Math.PI * 2;
      const r = draw(a) * b.leash * 0.5;
      a.destX = a.homeX + Math.sin(angle) * r;
      a.destZ = a.homeZ + Math.cos(angle) * r;
    }
    return;
  }
  if (s.act !== 'advance') return;

  // Choose where to go once, on entry, so the actor commits to a direction for the whole move.
  const most = s.gait?.distance ?? 0;
  switch (s.toward ?? 'wander') {
    case 'keep':
      break;
    case 'player':
      if (seen.present) aim(a, seen.x, seen.z, most, s.stop ?? b.keepAway);
      else a.stride = 0;
      break;
    case 'away': {
      const d = len(a.x - seen.x, a.z - seen.z);
      if (seen.present && d > 1e-6) {
        a.moveX = (a.x - seen.x) / d;
        a.moveZ = (a.z - seen.z) / d;
        a.stride = most;
      } else wander(a, b, seen, most);
      break;
    }
    case 'caller': {
      const c = peer(ctx, a.rallyTo);
      if (c) aim(a, c.x, c.z, most, a.radius + c.radius + 0.2);
      else a.stride = 0;
      break;
    }
    case 'ally': {
      // To the nearest of its kin; with none about, away from you.
      let best: Peer | undefined;
      let bestDist = Infinity;
      for (const p of ctx?.peers ?? []) {
        if (!kin(a, p)) continue;
        const d = len(p.x - a.x, p.z - a.z);
        if (d < bestDist) {
          best = p;
          bestDist = d;
        }
      }
      if (best) aim(a, best.x, best.z, most, a.radius + best.radius + 0.2);
      else {
        const d = len(a.x - seen.x, a.z - seen.z);
        if (seen.present && d > 1e-6) {
          a.moveX = (a.x - seen.x) / d;
          a.moveZ = (a.z - seen.z) / d;
        }
        a.stride = most;
      }
      break;
    }
    case 'group': {
      let sx = a.x;
      let sz = a.z;
      let n = 1;
      for (const p of ctx?.peers ?? []) {
        if (p.id === a.id || a.group === 0 || p.group !== a.group) continue;
        sx += p.x;
        sz += p.z;
        n++;
      }
      aim(a, sx / n, sz / n, most, 0);
      break;
    }
    default:
      wander(a, b, seen, most);
  }
  a.facing = Math.atan2(a.moveX, a.moveZ);
}

// A frame of walking: work out where it is going now (its foe and its ring place move), step
// toward it at the state's pace, keep off the rest of its band, and look where it should.
function walk(a: Actor, s: BehaviourState, seen: Sighting, ctx: BrainCtx | null): void {
  const step = (s.speed ?? 0) / 60;
  let mx = 0;
  let mz = 0;
  if (s.toward === 'away') {
    const dx = a.x - seen.x;
    const dz = a.z - seen.z;
    const d = len(dx, dz);
    if (seen.present && d > 1e-6) {
      mx = (dx / d) * step;
      mz = (dz / d) * step;
    }
  } else {
    let tx = a.x;
    let tz = a.z;
    let stop = 0;
    if (s.toward === 'foe') {
      if (seen.present) {
        tx = seen.x;
        tz = seen.z;
        stop = s.stop ?? 0;
      }
    } else if (s.toward === 'slot') {
      tx = a.slotX;
      tz = a.slotZ;
      stop = 0.1;
    } else if (s.toward === 'rally') {
      tx = a.rallyX;
      tz = a.rallyZ;
      stop = s.stop ?? 0;
    } else if (s.toward === 'home') {
      tx = a.homeX;
      tz = a.homeZ;
      stop = s.stop ?? 0;
    } else if (s.toward === 'wander') {
      tx = a.destX;
      tz = a.destZ;
      stop = 0.2;
    }
    const dx = tx - a.x;
    const dz = tz - a.z;
    const d = len(dx, dz);
    if (d > stop + 1e-6) {
      const m = Math.min(step, d - stop);
      mx = (dx / d) * m;
      mz = (dz / d) * m;
    }
  }
  a.x += mx;
  a.z += mz;

  // Keep a body's width apart from the rest of the band, so a ring of them doesn't stack up.
  if (a.band !== 0) {
    for (const p of ctx?.peers ?? []) {
      if (p.id === a.id || p.band !== a.band) continue;
      const dx = a.x - p.x;
      const dz = a.z - p.z;
      const d = len(dx, dz);
      const apart = a.radius + p.radius + 0.2;
      if (d >= apart || d < 1e-6) continue;
      const push = (apart - d) * 0.5;
      a.x += (dx / d) * push;
      a.z += (dz / d) * push;
    }
  }

  if (s.face === 'foe' && seen.present) faceFoe(a, seen);
  else if (len(mx, mz) > 1e-6) a.facing = Math.atan2(mx, mz);
}

/** Puts an attack's cooldown on, drawn from its range. */
function coolDown(a: Actor, b: Behaviour, attack: string, range: [number, number]): void {
  const i = b.attacks?.indexOf(attack) ?? -1;
  if (i >= 0 && i < a.cds.length) a.cds[i] = drawFrames(a, range);
}

// A frame of a strike: it tracks you early in the wind-up, then commits; the blow goes on the
// frame the wind-up ends, and it lunges after it.
function strike(a: Actor, b: Behaviour, s: BehaviourState, seen: Sighting, ctx: BrainCtx | null): void {
  const atk = s.attack ? attackDef(s.attack) : undefined;
  if (!atk || !s.attack) return;
  if (seen.present && a.stateFrame < atk.track) faceFoe(a, seen);
  if (a.stateFrame === atk.windup && !a.struck) {
    a.struck = true;
    ctx?.out.push({ t: 'strike', id: a.id, attack: s.attack });
    coolDown(a, b, s.attack, atk.cooldown);
  }
  const active = atk.active ?? 0;
  if (active > 0 && a.stateFrame >= atk.windup && a.stateFrame < atk.windup + active) {
    // Not into the foe, though: it stops at arm's length.
    const close = seen.present && len(seen.x - a.x, seen.z - a.z) <= a.radius + 0.45;
    if (!close) {
      const m = (atk.lunge ?? 0) / active;
      a.x += Math.sin(a.facing) * m;
      a.z += Math.cos(a.facing) * m;
    }
  }
}

// A frame of a throw: it aims at you through most of the wind-up and lets go as it ends.
function throwing(a: Actor, b: Behaviour, s: BehaviourState, seen: Sighting, ctx: BrainCtx | null): void {
  const atk = s.attack ? attackDef(s.attack) : undefined;
  if (!atk || !s.attack) return;
  if (seen.present && a.stateFrame < atk.track) faceFoe(a, seen);
  if (a.stateFrame === atk.windup && !a.struck) {
    a.struck = true;
    ctx?.out.push({ t: 'throw', id: a.id, attack: s.attack });
    coolDown(a, b, s.attack, atk.cooldown);
  }
}

function canCall(a: Actor, b: Behaviour, seen: Sighting, ctx: BrainCtx | null): boolean {
  const c = b.call;
  if (!ctx || !c || !b.gather || !kindOf(a)?.gathers) return false;
  if (a.angry <= 0 || !seen.present || a.flashFrame >= c.struckWithin) return false;
  if (a.gatherCd > 0 || a.calling >= 0 || a.rallyTo !== 0) return false;
  let answer = 0;
  for (const p of ctx.peers) {
    if (!kin(a, p)) continue;
    if (len(p.x - a.x, p.z - a.z) > c.radius) continue;
    if (p.calling >= 0) return false; // one call per pack
    if (p.rallyTo === 0 && p.group === 0) answer++;
  }
  return answer >= c.need;
}

function holdsOne(cond: string, a: Actor, b: Behaviour, seen: Sighting, ctx: BrainCtx | null): boolean {
  if (cond.startsWith('!')) return !holdsOne(cond.slice(1), a, b, seen, ctx);
  const colon = cond.indexOf(':');
  const name = colon < 0 ? cond : cond.slice(0, colon);
  const arg = colon < 0 ? '' : cond.slice(colon + 1);
  switch (name) {
    case 'called':
      return a.rallyTo !== 0;
    case 'angry':
      return a.angry > 0 && seen.present;
    case 'threatened':
      return a.angry > 0 && seen.present && len(seen.x - a.x, seen.z - a.z) <= (b.fleeWithin ?? 0);
    case 'canCall':
      return canCall(a, b, seen, ctx);
    case 'slam': {
      const s = kindOf(a)?.slam;
      if (!s || a.angry <= 0 || !seen.present || a.slamCd > 0) return false;
      return len(seen.x - a.x, seen.z - a.z) <= s.range;
    }
    case 'allies': {
      if (!ctx || !b.call || !b.gather) return false;
      let n = 0;
      for (const p of ctx.peers) if (kin(a, p) && len(p.x - a.x, p.z - a.z) <= b.gather.radius) n++;
      return n >= b.call.need;
    }
    case 'callOver':
      return !!b.call && a.calling >= b.call.giveUp;
    case 'broken':
      return !!b.gather && a.taken >= b.gather.breakAt * a.maxHp;
    case 'fuseLow':
      return a.group !== 0 && a.fuse >= 0 && a.fuse <= (b.regroupAt ?? 0);
    case 'token':
      return a.token;
    case 'opening':
      return a.opening;
    case 'afraid':
      return a.afraid;
    case 'near':
      return seen.present && len(seen.x - a.x, seen.z - a.z) <= Number(arg);
    case 'far':
      return seen.present && len(seen.x - a.x, seen.z - a.z) > Number(arg);
    case 'hurt':
      return a.hp <= Number(arg) * a.maxHp;
    case 'foeMelee':
      return seen.present && !seen.ranged && seen.reach > 0;
    case 'foeRanged':
      return seen.present && seen.ranged;
    case 'foeSwinging':
      return seen.present && seen.act === 1;
    case 'ready': {
      const i = b.attacks?.indexOf(arg) ?? -1;
      return i >= 0 && i < a.cds.length && a.cds[i] <= 0;
    }
    case 'canHeal':
      return !!b.heal && a.charges > 0 && a.hp <= b.heal.below * a.maxHp;
  }
  return false;
}

function holds(cond: Condition | Condition[] | undefined, a: Actor, b: Behaviour, seen: Sighting, ctx: BrainCtx | null): boolean {
  if (cond === undefined) return true;
  if (Array.isArray(cond)) {
    for (const c of cond) if (!holdsOne(c, a, b, seen, ctx)) return false;
    return true;
  }
  return holdsOne(cond, a, b, seen, ctx);
}

/**
 * The first guard that holds, as a state index, or -1. `withDefault` lets a guard with no
 * condition count; an interrupt never falls back to one.
 */
function pick(guards: readonly Guard[], withDefault: boolean, a: Actor, b: Behaviour, seen: Sighting, ctx: BrainCtx | null): number {
  for (const g of guards) {
    if (g.if === undefined && !withDefault) continue;
    if (holds(g.if, a, b, seen, ctx)) return stateIndex(b, g.to);
  }
  return -1;
}

/** Runs one frame of an actor's behaviour. Does nothing to an actor with no brain, or a dead one. */
export function stepBrain(a: Actor, seen: Sighting, ctx: BrainCtx | null = null): void {
  if (!a.brain || !isAlive(a)) return;
  const b = BY_ID.get(a.brain);
  if (!b) return;
  if (a.state >= b.states.length) a.state = 0;
  const s = b.states[a.state];

  if (s.interrupt) {
    const to = pick(s.interrupt, false, a, b, seen, ctx);
    if (to >= 0) {
      if (s.act === 'channel') {
        // Cut short: the cast is broken, and it has to wait before trying again.
        a.gatherCd = b.gather?.cooldown ?? 0;
        ctx?.out.push({ t: 'broke', id: a.id });
      }
      if (s.gait) a.y = 0;
      enter(a, b, to, seen, ctx);
      return;
    }
  }

  if ((s.act === 'advance' || s.act === 'leap') && s.gait) {
    // Ground is only covered while the gait says the actor is off it, or it slides as it crouches.
    const now = airAt(s.gait, progress(a, a.wait));
    const before = airAt(s.gait, Math.min(1, Math.max(0, a.stateFrame - 1) / Math.max(1, a.wait)));
    const moved = (now - before) * a.stride;
    a.x += a.moveX * moved;
    a.z += a.moveZ * moved;
    a.y = Math.sin(now * Math.PI) * s.gait.height;
  } else if (s.act === 'channel') {
    ctx?.out.push({ t: 'pull', id: a.id });
  } else if (s.act === 'walk') {
    walk(a, s, seen, ctx);
  } else if (s.act === 'strike') {
    strike(a, b, s, seen, ctx);
  } else if (s.act === 'throw') {
    throwing(a, b, s, seen, ctx);
  } else if (s.face === 'foe' && seen.present) {
    faceFoe(a, seen);
  }

  a.stateFrame++;
  if (a.stateFrame >= a.wait) {
    if (s.gait) a.y = 0;
    if (s.act === 'leap') {
      ctx?.out.push({ t: 'slam', id: a.id });
      a.slamCd = drawFrames(a, b.slamCooldown);
    } else if (s.act === 'channel') {
      ctx?.out.push({ t: 'absorb', id: a.id });
      a.gatherCd = b.gather?.cooldown ?? 0;
    } else if (s.act === 'heal') {
      ctx?.out.push({ t: 'heal', id: a.id });
      a.charges = Math.max(0, a.charges - 1);
    }
    const next = typeof s.next === 'string' ? stateIndex(b, s.next) : pick(s.next, true, a, b, seen, ctx);
    enter(a, b, next < 0 ? 0 : next, seen, ctx);
  }
}

/** What the actor's brain is currently doing, by name. Content maps this onto an animation. */
export function stateName(a: Actor): string {
  const b = a.brain ? BY_ID.get(a.brain) : undefined;
  return b?.states[a.state]?.name ?? 'idle';
}

/** How far through its current state the actor is, 0..1. */
export const stateProgress = (a: Actor): number => Math.min(1, a.stateFrame / Math.max(1, a.wait));

/** Puts a freshly spawned or revived actor into the first state of its brain, with what it carries. */
export function startBrain(a: Actor, seen: Sighting): void {
  if (!a.brain) return;
  const b = BY_ID.get(a.brain);
  if (!b) return;
  a.charges = b.heal?.charges ?? 0;
  enter(a, b, 0, seen, null);
}

/** Puts an actor straight into a named state, for the world's own decisions (taking over a call). */
export function forceState(a: Actor, name: string, seen: Sighting): void {
  if (!a.brain) return;
  const b = BY_ID.get(a.brain);
  if (!b) return;
  a.y = 0;
  enter(a, b, stateIndex(b, name), seen, null);
}

/** The state an actor drops back to when something outside its brain interrupts it. */
export function restState(a: Actor): void {
  const b = a.brain ? BY_ID.get(a.brain) : undefined;
  a.state = b ? stateIndex(b, 'idle') : 0;
  a.stateFrame = 0;
  a.wait = 1;
  a.y = 0;
}

/**
 * A blow landed on it: one at or above its kind's poise knocks it out of whatever it was doing
 * into its brain's flinch, spilling a drink it had at its lips. Mirrors Actors::damage in
 * crates/engine/src/actors.rs.
 */
export function flinch(a: Actor, amount: number): void {
  const k = kindOf(a);
  const b = a.brain ? BY_ID.get(a.brain) : undefined;
  if (!isAlive(a) || !k?.poise || amount < k.poise || !b?.flinch) return;
  if (b.states[a.state]?.act === 'heal') a.charges = Math.max(0, a.charges - 1);
  forceState(a, b.flinch, NOBODY);
}

/** Whether the actor's current state holds its pack's attack token. */
export function holdsToken(a: Actor): boolean {
  const b = a.brain ? BY_ID.get(a.brain) : undefined;
  return !!b?.states[a.state]?.token;
}

/** How far round from `facing` a point is, for the pack's sense of in front and behind. */
export const offFacing = (facing: number, fromX: number, fromZ: number, toX: number, toZ: number): number =>
  Math.abs(angleDiff(facing, Math.atan2(toX - fromX, toZ - fromZ)));
