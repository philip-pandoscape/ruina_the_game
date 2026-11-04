import type { SkillSet } from '../skills';
import type { Heightfield } from './terrain';
import type { ColliderIndex } from './zone/colliders';
import type { ZoneData } from './zone/world';
// Game rules use plain data only (no Three.js), so the same code can later run on the server.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// What the player wants to do this frame, already turned into world directions.
export interface Actions {
  moveX: number; // world-space move direction, length 0..1
  moveZ: number;
  jumpPressed: boolean;
  jumpHeld: boolean;
  attackPressed: boolean;
  slidePressed: boolean;
  // Hotbar slot pressed this frame: 0 for none, otherwise 1..HOTBAR_SLOTS. One number rather
  // than a flag per slot, because only one can be used per frame anyway.
  abilitySlot: number;
  // Movement slot pressed this frame: 0 for none, otherwise 1..MOVEMENT_SLOTS (Q / E, LB / RB).
  movementSlot: number;
  movementHeld: number; // the slot still held down, for actions that stay up while you hold them
  sprintHeld: boolean;
  crouchHeld: boolean;
  aimX: number; // optional target offset from the player in metres (0, 0 = aim straight ahead)
  aimZ: number;
  // Combat stance: the world direction to keep facing while moving (unit length), so the stick
  // strafes and backs off instead of turning you. 0, 0 faces the way you move. Sprinting ignores it.
  faceX: number;
  faceZ: number;
  // The raw stick (or WASD), before it is turned into a world direction: x is right, y is forward.
  // Vehicles steer with it (tank controls); everything on foot uses moveX / moveZ.
  stickX: number;
  stickY: number;
}

export const NO_ACTIONS: Actions = {
  moveX: 0,
  moveZ: 0,
  jumpPressed: false,
  jumpHeld: false,
  attackPressed: false,
  slidePressed: false,
  abilitySlot: 0,
  movementSlot: 0,
  movementHeld: 0,
  sprintHeld: false,
  crouchHeld: false,
  aimX: 0,
  aimZ: 0,
  faceX: 0,
  faceZ: 0,
  stickX: 0,
  stickY: 0,
};

// 'action' is a data-driven movement skill: a dodge, a guard, or the slide everyone has.
// 'swim', 'glide' and 'ride' only happen in open worlds (see src/sim/player/traverse.ts).
export type Mode = 'normal' | 'attack' | 'cast' | 'action' | 'swim' | 'glide' | 'ride';

export interface PlayerState {
  pos: Vec3;
  prevPos: Vec3;
  vel: Vec3;
  facing: number; // radians; 0 faces +Z
  prevFacing: number;
  mode: Mode;
  grounded: boolean;
  jumpsUsed: number;
  jumpCutDone: boolean;
  coyote: number;
  jumpBuffer: number;
  attackBuffer: number;
  // A buffered action press, so a slide asked for a few frames early still happens.
  actionBuffer: number;
  actionBufferId: number; // which movement skill, 255 when nothing is buffered
  attackIndex: number;
  attackFrame: number;
  attackQueued: boolean;
  attackHit: boolean;
  flipFrame: number; // counts up during the double-jump flip, -1 when not flipping
  landFrame: number; // frames since landing, for the squash
  landImpact: number; // 0..1 how hard the last landing was
  takeoffFrame: number; // frames since leaving the ground with a jump
  runPhase: number; // distance-driven run cycle
  hp: number;
  stun: number; // frames of no control left after being hit
  downFrame: number; // counts up while knocked down, -1 when standing
  team: number; // 0 or 1
  // Build (skills and loadout), set by the server.
  weapon: number; // 0 sword, 1 club, 2 staff, 3 bow
  skills: SkillSet; // which skills are learned (src/skills.ts)
  // Which combo variants this build unlocked. Derived from `skills` for your own fighter, and the
  // only part of someone else's tree that reaches you, since it changes how they are drawn.
  comboVariants: number;
  abilities: number[]; // one per hotbar slot (index into ABILITIES, 255 = empty)
  cooldowns: number[]; // frames until each slot can be used again
  abilityBuffer: number; // frames left to still act on the slot you pressed
  abilityBufferSlot: number; // which slot that was, 1..HOTBAR_SLOTS (0 = nothing buffered)
  movement: number[]; // one movement skill per slot, 255 where empty
  // Cooldowns are per skill rather than per slot, so moving one between Q and E doesn't reset it
  // and the built-in slide has somewhere to live.
  movementCooldowns: number[];
  actionId: number; // the movement skill running right now, 255 when none
  actionFrame: number;
  actionDirX: number; // the direction it committed to when it started
  actionDirZ: number;
  actionSlot: number; // which slot it came from, 1..MOVEMENT_SLOTS
  sprinting: boolean;
  crouching: boolean;
  crouchFrame: number; // eases the body down and back up, 0..crouchEnterFrames
  castAbility: number; // the ability being cast right now, 255 when not casting
  castSlot: number; // which hotbar slot it came from, 1..HOTBAR_SLOTS
  castFrame: number;
  castTargetX: number; // where a meteor will land
  castTargetZ: number;
  firedAbility: number; // the ability whose cast finished this frame (the server acts on it), else 255
  // ---- Open-world traversal. Offline worlds only for now: the server's mirror has none of it. ----
  /** The trade pack on your back (an id in the life systems), 0 for none. */
  pack: number;
  /** What you are riding (a vehicle id in the life systems), 0 on foot; and which seat. */
  vehicle: number;
  seat: number;
  /** The glider you have equipped ('' for none), and its airspeed while open. */
  glider: string;
  airspeed: number;
  /** Lean into a turn, -1..1, for the glider and the body. */
  bank: number;
  /** Frames since the current traversal mode began (glider opening, swim strokes). */
  modeFrame: number;
  /** Frames until the glider's gust can be used again. */
  gustFrames: number;
}

/** The traversal fields of someone simply on foot, for code that builds a PlayerState by hand. */
export const ON_FOOT = { pack: 0, vehicle: 0, seat: 0, glider: '', airspeed: 0, bank: 0, modeFrame: 0, gustFrames: 0 };

export type GameEvent =
  | { type: 'jump'; frame: number; x: number; y: number; z: number }
  | { type: 'doubleJump'; frame: number; x: number; y: number; z: number }
  | { type: 'land'; frame: number; x: number; y: number; z: number; impact: number }
  // A movement skill started: `id` indexes MOVEMENT_SKILLS.
  | { type: 'action'; frame: number; id: number; x: number; y: number; z: number }
  | { type: 'attack'; frame: number; index: number }
  | { type: 'hit'; frame: number; index: number; damage: number; x: number; y: number; z: number; dirX: number; dirZ: number }
  // Anything in the world died. `kind` says what it was, so the effects can differ without the
  // rules needing an event type per creature.
  | { type: 'actorDie'; frame: number; id: number; kind: string; x: number; y: number; z: number }
  // A pack at work (src/sim/actors/step.ts). A dying one burst into `count` pieces; one called its
  // kin to it; one started gathering them in, or had the cast broken; one was taken in; one grew a
  // size (gathering, or a burst group that reformed).
  | { type: 'actorBurst'; frame: number; kind: string; count: number; x: number; y: number; z: number }
  | { type: 'actorCall'; frame: number; id: number; x: number; y: number; z: number; radius: number }
  | { type: 'gatherStart'; frame: number; id: number; x: number; y: number; z: number; radius: number }
  | { type: 'gatherBroken'; frame: number; id: number; x: number; y: number; z: number }
  | { type: 'actorAbsorbed'; frame: number; x: number; y: number; z: number; toX: number; toZ: number }
  | { type: 'actorGrow'; frame: number; id: number; kind: string; x: number; y: number; z: number }
  // A monster's slam landed, and whether it caught you.
  | { type: 'slam'; frame: number; x: number; y: number; z: number; radius: number }
  | { type: 'hurt'; frame: number; damage: number; x: number; y: number; z: number }
  | { type: 'respawn'; frame: number; x: number; y: number; z: number }
  // A bow loosed an arrow (the server flies it; the browser draws it straight away).
  | { type: 'shoot'; frame: number; x: number; y: number; z: number; dirX: number; dirZ: number; speed: number; range: number; damage: number; pierce: number }
  // A cast finished: `ability` indexes ABILITIES, (x, z) is the target and (casterX, casterZ) the caster.
  | { type: 'cast'; frame: number; ability: number; x: number; z: number; casterX: number; casterZ: number }
  // Spell effects, from the server online or the training range offline.
  | { type: 'heal'; frame: number; x: number; y: number; z: number; radius: number }
  | { type: 'explosion'; frame: number; x: number; y: number; z: number; radius: number }
  | { type: 'arrowHit'; frame: number; x: number; y: number; z: number }
  // Open-world traversal.
  | { type: 'glideOpen'; frame: number; x: number; y: number; z: number }
  | { type: 'glideClose'; frame: number; x: number; y: number; z: number }
  | { type: 'splash'; frame: number; x: number; y: number; z: number; speed: number };

/** Something the world starts with standing in it. */
export interface ActorSpawnPoint {
  kind: string;
  x: number;
  z: number;
  facing?: number;
  seed?: number;
}

export interface Obstacle {
  // 'post' is anything round and solid the world was built with (a well, a lamp, a scarecrow):
  // it blocks like the rest but the stage does not draw it, its own model does.
  kind: 'tree' | 'rock' | 'crate' | 'hay' | 'post';
  x: number;
  z: number;
  r: number; // collision radius
  scale: number;
  rot: number;
}

export interface Spawn {
  x: number;
  z: number;
  facing: number;
}

export interface World {
  seed: number;
  /** What lives here when the world is built. */
  spawns: ActorSpawnPoint[];
  radius: number;
  obstacles: Obstacle[];
  dummy: { x: number; z: number };
  spawn: Spawn;
  teamSpawns: [Spawn, Spawn]; // where each team respawns after being knocked down
  // Open worlds only. The training yard and the battlefield are flat at y = 0 and leave these
  // out, which keeps their rules exactly as the server runs them (tests/conformance.spec.ts).
  /** Ground heights, surfaces and sea level. */
  terrain?: Heightfield;
  /** Obstacles, building colliders and walkable decks, bucketed for fast queries. */
  index?: ColliderIndex;
  /** The recipe and everything generated from it. */
  zone?: ZoneData;
}
