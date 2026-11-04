import data from '../../../shared/behaviours.json' with { type: 'json' };
import { isAlive, type Actor } from '../actor';
import { len } from '../math';

// The behaviour interpreter. Monsters and NPCs do not get their own code: they get an entry in
// shared/behaviours.json, and this walks it. server/src/ai.rs walks the same file the same way,
// so the training yard offline and the server online agree frame for frame.

export interface Gait {
  /** Metres covered by one cycle of the state. */
  distance: number;
  /** Apex of the hop; zero for something that walks. */
  height: number;
  /** When in the cycle it leaves and regains the ground, as fractions. */
  airStart: number;
  airSpan: number;
}

export interface BehaviourState {
  name: string;
  act: 'wait' | 'advance';
  /** [min, max] frames, drawn on entry. */
  frames: [number, number];
  gait?: Gait;
  next: string;
}

export interface Behaviour {
  id: string;
  /** How far away it notices the player. */
  sight: number;
  /** It will not close nearer than this. */
  keepAway: number;
  /** Beyond this from where it spawned, it heads back instead of wandering. */
  leash: number;
  states: BehaviourState[];
}

export const BEHAVIOURS: Behaviour[] = (data.behaviours as Behaviour[]).map((b) => ({
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

export interface Sighting {
  x: number;
  z: number;
  /** False when there is nobody to notice - the brain then just wanders. */
  present: boolean;
}

const stateIndex = (b: Behaviour, name: string): number => {
  const i = b.states.findIndex((s) => s.name === name);
  return i < 0 ? 0 : i;
};

/** How far through the current state's cycle the actor is, 0..1. */
const progress = (a: Actor, frames: number): number => Math.min(1, a.stateFrame / Math.max(1, frames));

/** Off-the-ground fraction of a gait at a point in the cycle. */
const airAt = (g: Gait, t: number): number => Math.max(0, Math.min(1, (t - g.airStart) / g.airSpan));

function enter(a: Actor, b: Behaviour, index: number, seen: Sighting): void {
  a.state = index;
  a.stateFrame = 0;
  const s = b.states[index];
  const [lo, hi] = s.frames;
  a.wait = Math.floor(lo + draw(a) * Math.max(0, hi - lo));
  if (s.act !== 'advance') return;

  // Choose where to go once, on entry, so the actor commits to a direction for the whole move.
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
  a.facing = Math.atan2(a.moveX, a.moveZ);
}

/** Runs one frame of an actor's behaviour. Does nothing to an actor with no brain, or a dead one. */
export function stepBrain(a: Actor, seen: Sighting): void {
  if (!a.brain || !isAlive(a)) return;
  const b = BY_ID.get(a.brain);
  if (!b) return;
  if (a.state >= b.states.length) a.state = 0;
  const s = b.states[a.state];

  if (s.act === 'advance' && s.gait) {
    // Ground is only covered while the gait says the actor is off it, or it slides as it crouches.
    const now = airAt(s.gait, progress(a, a.wait));
    const before = airAt(s.gait, Math.min(1, Math.max(0, a.stateFrame - 1) / Math.max(1, a.wait)));
    const moved = (now - before) * s.gait.distance;
    a.x += a.moveX * moved;
    a.z += a.moveZ * moved;
    a.y = Math.sin(now * Math.PI) * s.gait.height;
  }

  a.stateFrame++;
  if (a.stateFrame >= a.wait) {
    if (s.gait) a.y = 0;
    enter(a, b, stateIndex(b, s.next), seen);
  }
}

/** What the actor's brain is currently doing, by name. Content maps this onto an animation. */
export function stateName(a: Actor): string {
  const b = a.brain ? BY_ID.get(a.brain) : undefined;
  return b?.states[a.state]?.name ?? 'idle';
}

/** How far through its current state the actor is, 0..1. */
export const stateProgress = (a: Actor): number => Math.min(1, a.stateFrame / Math.max(1, a.wait));

/** Puts a freshly spawned or revived actor into the first state of its brain. */
export function startBrain(a: Actor, seen: Sighting): void {
  if (!a.brain) return;
  const b = BY_ID.get(a.brain);
  if (!b) return;
  enter(a, b, 0, seen);
}
