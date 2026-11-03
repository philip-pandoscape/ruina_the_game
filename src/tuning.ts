import shared from '../shared/tuning.json' with { type: 'json' };

// Gameplay rules live in shared/tuning.json, so the browser and the Rust server read exactly the
// same numbers. Times are in sim frames (60 per second) unless the name says otherwise.
//
// move      walkSpeed / runSpeed (m/s), runThreshold (stick tilt above which you run),
//           groundAccel / groundDecel / airAccel / airDrag (m/s²), turnSpeed (rad/s), playerRadius (m)
// jump      velocity / doubleJumpVelocity (m/s), gravityUp / gravityDown (m/s²; falling faster feels
//           snappier), shortHopCut (upward speed kept when jump is released early), coyoteFrames
//           (grace period after leaving the ground), bufferFrames (how early a jump press still
//           counts), doubleJumpSteer (redirect toward the stick at this × run speed), flipFrames
// slide     speed → endSpeed (m/s) over `frames`, steer (rad/s), jumpCarry (speed a slide jump keeps)
// attack    bufferFrames (how early an attack press counts), auto-aim for the training dummy,
//           airGravityScale (hang time while swinging in the air)
// special   bufferFrames for ability presses; cooldown after cancelling or being interrupted
// weapons   sword, club, staff, bow. Each has a combo; per hit: startup / active / recovery frames,
//           damage, lunge (m/s), reach (m), arcDeg (hit cone), hitstop (training only), knock (dummy
//           wobble), playerKnock (m/s), shake (0..1), cancelAfter (recovery frames before jump or
//           slide can cancel), and for arrows projectileSpeed (m/s) and projectileRange (m).
//           The sword's `whirlwind` hit replaces its third hit with the Whirlwind skill; the bow's
//           rapidFireStartup is its draw time with Rapid Fire.
// abilities Healing Circle and Meteor: castFrames standing still (fastCastFrames with the matching
//           skill), cooldownFrames, and heal amount or meteor range / fall / blast details.
// skills    points to spend, and four trees of three skills each, learned top to bottom.
// combat    maxHp, stunFrames after being hit, knockUp (m/s), downFrames before respawning

export const SIM_HZ = shared.simHz;
export const STEP = 1 / SIM_HZ;
export const MOVE = shared.move;
export const JUMP = shared.jump;
export const SLIDE = shared.slide;
export const COMBAT = shared.combat;
export const SPECIAL = shared.special;

export interface AttackStep {
  startup: number;
  active: number;
  recovery: number;
  damage: number;
  lunge: number;
  reach: number;
  arcDeg: number;
  hitstop: number;
  knock: number;
  playerKnock: number;
  shake: number;
  cancelAfter: number;
  projectileSpeed?: number; // arrows only
  projectileRange?: number;
}

export interface Weapon {
  name: string;
  combo: AttackStep[];
  whirlwind?: AttackStep;
  rapidFireStartup?: number;
}

export interface Ability {
  name: string;
  kind: 'heal' | 'meteor';
  castFrames: number;
  fastCastFrames: number;
  cooldownFrames: number;
  radius: number;
  amount?: number; // heal
  range?: number; // meteor: default distance in front
  maxRange?: number;
  fallFrames?: number;
  damage?: number;
  knock?: number;
}

export interface SkillNode {
  id: string;
  name: string;
  desc: string;
  weapon?: number; // learning this lets you wield that weapon
  ability?: number; // learning this lets you slot that ability
}

export interface SkillTree {
  name: string;
  nodes: SkillNode[];
}

export const ATTACK: {
  bufferFrames: number;
  autoAimRange: number;
  autoAimDeg: number;
  airGravityScale: number;
} = shared.attack;

export const WEAPONS = shared.weapons as unknown as Weapon[];
export const ABILITIES = shared.abilities as unknown as Ability[];
export const SKILLS = shared.skills as unknown as {
  points: number;
  cleaveTargets: number;
  pierceTargets: number;
  trees: SkillTree[];
};
export const NO_ABILITY = 255;
export const CAST = { none: 0, heal: 1, meteor: 2 } as const;

// Every skill is one bit: tree t, skill n → bit t × 3 + n (the order in shared/tuning.json).
// server/src/tuning.rs numbers them the same way.
export function skillBit(id: string): number {
  let bit = 0;
  for (const tree of SKILLS.trees) {
    for (const node of tree.nodes) {
      if (node.id === id) return bit;
      bit++;
    }
  }
  throw new Error(`unknown skill ${id}`);
}

export const PERK = {
  cleave: 1 << skillBit('cleave'),
  whirlwind: 1 << skillBit('whirlwind'),
  piercing: 1 << skillBit('piercing'),
  rapidFire: 1 << skillBit('rapidFire'),
  swiftMending: 1 << skillBit('swiftMending'),
  quickIncantation: 1 << skillBit('quickIncantation'),
};

const swordWhirlwind = [...WEAPONS[0].combo.slice(0, 2), WEAPONS[0].whirlwind!];
const bowRapidFire = WEAPONS[3].combo.map((s) => ({ ...s, startup: WEAPONS[3].rapidFireStartup! }));

// The combo for a weapon, with any skills that change its timing applied.
export function comboFor(weapon: number, perks: number): AttackStep[] {
  if (weapon === 0 && perks & PERK.whirlwind) return swordWhirlwind;
  if (weapon === 3 && perks & PERK.rapidFire) return bowRapidFire;
  return (WEAPONS[weapon] ?? WEAPONS[0]).combo;
}

export function castKindOf(ability: number): number {
  return ABILITIES[ability]?.kind === 'heal' ? CAST.heal : CAST.meteor;
}

export function castFramesFor(ability: number, perks: number): number {
  const a = ABILITIES[ability];
  const fast = a.kind === 'heal' ? perks & PERK.swiftMending : perks & PERK.quickIncantation;
  return fast ? a.fastCastFrames : a.castFrames;
}

// The ability behind a CAST kind (other players only tell us what they're casting, not the slot).
export function abilityOfKind(kind: number): number {
  return ABILITIES.findIndex((a) => a.kind === (kind === CAST.heal ? 'heal' : 'meteor'));
}

// A character's skills and loadout. `perks` has one bit per learned skill.
export interface Build {
  perks: number;
  weapon: number;
  ability1: number;
  ability2: number;
}

export const DEFAULT_BUILD: Build = { perks: 1 << skillBit('sword'), weapon: 0, ability1: NO_ABILITY, ability2: NO_ABILITY };

// ---------- Browser-only settings ----------

export const DUMMY = {
  hp: 100,
  radius: 0.4,
  spring: 140,
  damping: 7,
  resetFrames: 60,
};

export const CAMERA = {
  distance: 6.2,
  targetHeight: 1.35,
  fov: 60,
  mouseSensitivity: 0.0025, // rad per pixel
  stickSpeed: 3.2, // rad/s at full right-stick tilt
  keySpeed: 2.2, // rad/s with arrow keys
  pitchMin: -0.15,
  pitchMax: 1.15,
  startPitch: 0.32,
  followXZ: 14, // higher = tighter follow
  followY: 5, // looser vertically so jumps don't jerk the view
};

export const GAMEPAD = {
  deadzone: 0.18,
};

export const WORLD = {
  seed: 1337,
  radius: 32, // invisible wall around the training yard
};
