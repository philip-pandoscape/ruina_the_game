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
  ability1Pressed: boolean; // ability slot 1 (Y / E)
  ability2Pressed: boolean; // ability slot 2 (RB / Q)
  aimX: number; // optional target offset from the player in metres (0, 0 = aim straight ahead)
  aimZ: number;
}

export const NO_ACTIONS: Actions = {
  moveX: 0,
  moveZ: 0,
  jumpPressed: false,
  jumpHeld: false,
  attackPressed: false,
  slidePressed: false,
  ability1Pressed: false,
  ability2Pressed: false,
  aimX: 0,
  aimZ: 0,
};

export type Mode = 'normal' | 'slide' | 'attack' | 'cast';

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
  slideBuffer: number;
  slideFrame: number;
  slideDirX: number;
  slideDirZ: number;
  slideCooldown: number;
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
  perks: number; // one bit per learned skill (skillBit in tuning.ts)
  ability1: number; // ability in each slot (index into ABILITIES, 255 = empty)
  ability2: number;
  abilityBuffer1: number;
  abilityBuffer2: number;
  cooldown1: number; // frames until each slot can be used again
  cooldown2: number;
  castKind: number; // what's being cast right now (CAST in tuning.ts), 0 when not casting
  castSlot: number; // which slot it came from (1 or 2)
  castFrame: number;
  castTargetX: number; // where a meteor will land
  castTargetZ: number;
  firedCast: number; // the cast that finished this frame (the server acts on it), else 0
}

export interface DummyState {
  x: number;
  z: number;
  hp: number;
  tiltX: number; // wobble lean, radians
  tiltZ: number;
  tiltVX: number;
  tiltVZ: number;
  flashFrame: number; // frames since last hit
  brokenFrame: number; // -1 unless the dummy just broke
}

export type GameEvent =
  | { type: 'jump'; frame: number; x: number; y: number; z: number }
  | { type: 'doubleJump'; frame: number; x: number; y: number; z: number }
  | { type: 'land'; frame: number; x: number; y: number; z: number; impact: number }
  | { type: 'slide'; frame: number; x: number; y: number; z: number }
  | { type: 'attack'; frame: number; index: number }
  | { type: 'hit'; frame: number; index: number; damage: number; x: number; y: number; z: number; dirX: number; dirZ: number }
  | { type: 'dummyBreak'; frame: number; x: number; y: number; z: number }
  | { type: 'respawn'; frame: number; x: number; y: number; z: number }
  // A bow loosed an arrow (the server flies it; the browser draws it straight away).
  | { type: 'shoot'; frame: number; x: number; y: number; z: number; dirX: number; dirZ: number; speed: number; range: number; damage: number; pierce: number }
  // A cast finished: kind is CAST.heal or CAST.meteor, (x, z) the target, (casterX, casterZ) the caster.
  | { type: 'cast'; frame: number; kind: number; x: number; z: number; casterX: number; casterZ: number }
  // Spell effects, from the server online or the training range offline.
  | { type: 'heal'; frame: number; x: number; y: number; z: number; radius: number }
  | { type: 'explosion'; frame: number; x: number; y: number; z: number; radius: number }
  | { type: 'arrowHit'; frame: number; x: number; y: number; z: number };

export interface Obstacle {
  kind: 'tree' | 'rock' | 'crate' | 'hay';
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
  radius: number;
  obstacles: Obstacle[];
  dummy: { x: number; z: number };
  spawn: Spawn;
  teamSpawns: [Spawn, Spawn]; // where each team respawns after being knocked down
}
