import type { SkillSet } from '../content/skills';
import type { Ground } from './world/terrain';
import type { ColliderIndex } from './world/colliders';
import type { ZoneData } from './world/region';

// The shapes of the rules' state as the page reads it, plain data the engine's session reads back
// after each step (crates/engine/src/session.rs): what you press, you, the world you are in, what
// happened.

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
// 'swim', 'glide' and 'ride' only happen in open worlds (see src/engine/world/ground.ts).
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
  /** Spent by dodges (STAMINA in src/content/tuning.ts); refills a moment after it was last spent. */
  stamina: number;
  /** Frames before stamina starts refilling again, counted down from the last spend. */
  staminaDelay: number;
  /** Spent by casting (MP in src/content/tuning.ts); refills steadily. */
  mp: number;
  stun: number; // frames of no control left after being hit
  downFrame: number; // counts up while knocked down, -1 when standing
  team: number; // 0 or 1
  // Build (skills and loadout), set by the server.
  weapon: number; // its place in WEAPONS (src/content/tuning.ts), the order content/weapons/_order.json gives
  skills: SkillSet; // which skills are learned (src/content/skills.ts)
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
  // ---- Open-world traversal (crates/engine/src/open/traverse.rs plays the same). ----
  /** The trade pack on your back (an id in the life systems), 0 for none. */
  pack: number;
  /** What you are riding (a vehicle id in the life systems), 0 on foot; and which seat. */
  vehicle: number;
  seat: number;
  /**
   * Riding along in someone else's vehicle: whose (their character), 0 in your own or on foot. Their
   * vehicle numbers are their island's, so `vehicle` is one of theirs then.
   */
  host: number;
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
export const ON_FOOT = { pack: 0, vehicle: 0, seat: 0, host: 0, glider: '', airspeed: 0, bank: 0, modeFrame: 0, gustFrames: 0 };

export type GameEvent =
  | { type: 'jump'; frame: number; x: number; y: number; z: number }
  | { type: 'doubleJump'; frame: number; x: number; y: number; z: number }
  | { type: 'land'; frame: number; x: number; y: number; z: number; impact: number }
  // A movement skill started: `id` indexes MOVEMENT_SKILLS.
  | { type: 'action'; frame: number; id: number; x: number; y: number; z: number }
  | { type: 'attack'; frame: number; index: number }
  // A blow landed. `weapon` (an index into WEAPONS) is what dealt it: a swing, or the bow that
  // loosed the arrow. A blast has none.
  | { type: 'hit'; frame: number; index: number; damage: number; x: number; y: number; z: number; dirX: number; dirZ: number; weapon?: number }
  // Anything in the world died. `kind` says what it was, so the effects can differ without the
  // rules needing an event type per creature. `killed`: a blow finished it off (only those count
  // as defeats), rather than a lone piece dissolving on its own.
  | { type: 'actorDie'; frame: number; id: number; kind: string; x: number; y: number; z: number; killed: boolean }
  // A pack at work. A dying one burst into `count` pieces; one called its
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
  // Something a creature threw came down on the ground; a creature drank and got back `amount` health.
  | { type: 'missileLand'; frame: number; x: number; y: number; z: number }
  | { type: 'actorHeal'; frame: number; id: number; x: number; y: number; z: number; amount: number }
  | { type: 'respawn'; frame: number; x: number; y: number; z: number }
  // A movement or hotbar slot was pressed without the stamina or MP its skill costs.
  | { type: 'short'; frame: number; what: 'stamina' | 'mp' }
  // A bow loosed an arrow (the server flies it; the browser draws it straight away). `weapon` is
  // the one that loosed it.
  | {
      type: 'shoot';
      frame: number;
      x: number;
      y: number;
      z: number;
      dirX: number;
      dirZ: number;
      speed: number;
      range: number;
      damage: number;
      pierce: number;
      weapon: number;
    }
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
  /** Spawn points with the same band number fight together as one war-band. */
  band?: number;
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
  spawn: Spawn;
  teamSpawns: [Spawn, Spawn]; // where each team respawns after being knocked down
  // Open worlds only. The training yard and the battlefield are flat at y = 0 and leave these
  // out, which keeps their rules exactly as the server runs them (tests/conformance/player.test.ts).
  /** Ground heights, surfaces and sea level. */
  terrain?: Ground;
  /** Obstacles, building colliders and walkable decks, bucketed for fast queries. */
  index?: ColliderIndex;
  /** The recipe and everything generated from it. */
  zone?: ZoneData;
  /**
   * Where someone knocked down gets up again instead of the island's spawn: in a copy of a dungeon,
   * where it's entered (crates/engine/src/open/dungeon.rs OpenWorld::instance does the same).
   */
  respawnAt?: { x: number; y: number; z: number; facing: number };
  /**
   * Online: everyone else's vehicles in your channel, as circles where they are this step, which you
   * bump into like your own. The server keeps the channel's (crates/server/src/sim/mod.rs); the browser
   * fills in the others as it draws them (src/net/worldPeers.ts).
   */
  movers?: Mover[];
}

/** What the helpers the page calls read of the rules: you and the world (the engine's snapshot, src/engine/views.ts). */
export interface SimRead {
  readonly player: PlayerState;
  readonly world: World;
}

/** One circle of something solid that moves (a vehicle), with the height it stands at and how tall it is. */
export interface Mover {
  x: number;
  z: number;
  r: number;
  y: number;
  height: number;
}
