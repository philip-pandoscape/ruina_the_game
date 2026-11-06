import data from '../../../shared/behaviours.json' with { type: 'json' };
import { type Actor } from './actor';
import { CREATURES } from '../../content/creatures';

// The creatures' behaviours as the page reads them. Monsters and NPCs do not get their own code:
// they get an entry in shared/behaviours.json (or their own in shared/creatures.json), which the
// engine walks (crates/engine/src/ai.rs), the same offline in the training yard and on the server
// online. The page reads a behaviour for the names of its states and how far through one a
// creature is (stateName, stateProgress), and the shapes of the entries.
//
// A brain only ever changes its own actor. Anything that reaches another (calling the pack,
// pulling them in, a slam landing on you, a stab, a thrown stone) it asks for, and the engine does
// it once every brain has had its turn (crates/engine/src/actors.rs), so the order actors are
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
 * A pack's: token, opening, afraid. Its foe: near:m, far:m, foeMelee,
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
  /** A strike's or throw's attack (shared/creatures.json). */
  attack?: string;
  /** While here it holds its pack's attack token. */
  token?: boolean;
  /** Checked every frame; the first that holds cuts the state short. */
  interrupt?: Guard[];
  /** Where it goes when the state runs out: a state name, or guards. */
  next: string | Guard[];
}

/** How a war-band fights together. */
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

/** What the actor's brain is currently doing, by name. Content maps this onto an animation. */
export function stateName(a: Actor): string {
  const b = a.brain ? BY_ID.get(a.brain) : undefined;
  return b?.states[a.state]?.name ?? 'idle';
}

/** How far through its current state the actor is, 0..1. */
export const stateProgress = (a: Actor): number => Math.min(1, a.stateFrame / Math.max(1, a.wait));
