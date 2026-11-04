import shared from '../shared/tuning.json' with { type: 'json' };
import {
  applyChannel,
  applyFrames,
  emptySkills,
  NODES,
  SKILL_POINTS,
  skillIndex,
  statBase,
  statIndex,
  TREES,
  withSkill,
  type ResolvedSkills,
  type SkillSet,
} from './skills';

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
  // Names an animation the renderer should use instead of the default swing.
  pose?: string;
}

export interface Weapon {
  name: string;
  tags: string[];
  combo: AttackStep[];
  // Structural alternatives a skill can unlock, swapping one step of the combo for another.
  // Anything that is only a number belongs in a modifier instead (see src/skills.ts).
  variants?: Array<{ id: string; replace: number; step: AttackStep }>;
}

// What an ability does, as a list of effects rather than a name the code knows. Adding a skill
// built from these is a data change; only a genuinely new kind of thing costs code, and then in
// both languages at once (src/sim, server/src/game.rs).
export type EffectKind = 'healArea' | 'delayedArea';

export interface Effect {
  kind: EffectKind;
  radius: number;
  amount?: number; // healArea: health restored
  damage?: number; // delayedArea
  knock?: number;
  delayFrames?: number; // delayedArea: how long before it lands
}

export interface Ability {
  id: string;
  name: string;
  icon: string;
  desc: string;
  tags: string[];
  // Where it goes off: on you, or on a spot you place. 'ground' is what makes a cast aimable.
  target: 'self' | 'ground';
  castFrames: number;
  cooldownFrames: number;
  range?: number; // ground: default distance in front when you don't aim
  maxRange?: number;
  castPose?: string; // which casting animation to use; the rules never look at it
  effects: Effect[];
}

export const isGroundTargeted = (ability: number): boolean => ABILITIES[ability]?.target === 'ground';

// ---------- Movement skills ----------
//
// A dodge, a backstep, a block: an action state with a startup / active / recovery timeline and
// a few things that can happen during it. New ones are data; only a new field here costs code,
// and then in src/sim/sim.ts and server/src/player.rs together.
export interface ActionDef {
  startup: number;
  active: number;
  recovery: number;
  speed: number; // metres per second while active
  endSpeed?: number; // eases from `speed` to this across the active frames
  direction: 'input' | 'facing' | 'backward';
  steer?: number; // radians per second you can turn it; absent means it's committed
  hold?: boolean; // stays active while the button is held, up to `active` frames
  jumpCarry?: number; // jumping out ends it early and keeps this much of the speed
  bufferFrames?: number; // a press this many frames early still counts
  groundOnly?: boolean; // leaving the ground ends it
  invulnFrom?: number; // frame window, counted from the start of the action
  invulnTo?: number;
  damageTaken?: number; // multiplier on damage that lands during the active frames
  pose?: string;
}

export interface MovementSkill {
  id: string;
  name: string;
  icon: string;
  desc: string;
  tags: string[];
  // Built-in moves everyone has (the slide). No tree node grants them, so they never reach a
  // Q / E slot, but they run through the same action machine as the rest.
  builtin?: boolean;
  cooldownFrames: number;
  action: ActionDef;
}

export const MOVEMENT_SKILLS = shared.movementSkills as unknown as MovementSkill[];
export const MOVEMENT_SLOTS = shared.movementSlots as number;
// Room for this many movement skills, so the wire size doesn't move every time one is added.
// Raise it here and in server/src/tuning.rs together.
export const MOVEMENT_SKILL_CAP = 16;
if (MOVEMENT_SKILLS.length > MOVEMENT_SKILL_CAP) throw new Error('more movement skills than MOVEMENT_SKILL_CAP');
export const NO_MOVEMENT = 255;
export const movementAction = (m: number): ActionDef | null => MOVEMENT_SKILLS[m]?.action ?? null;
// The slide everyone has. Looked up by id so reordering the data can't silently rebind it.
export const SLIDE_SKILL = MOVEMENT_SKILLS.findIndex((m) => m.id === 'slide');
if (SLIDE_SKILL < 0) throw new Error('shared/tuning.json needs a movement skill with id "slide"');
export const actionFrames = (a: ActionDef): number => a.startup + a.active + a.recovery;
export const emptyMovement = (): number[] => new Array<number>(MOVEMENT_SLOTS).fill(NO_MOVEMENT);

// How far a ground-aimed ability reaches, or null if it isn't aimed at the ground at all.
export function groundRange(ability: number): number | null {
  const a = ABILITIES[ability];
  return a && a.target === 'ground' ? (a.maxRange ?? a.range ?? 16) : null;
}

// The biggest radius an ability covers, for drawing its circle.
export const abilityRadius = (ability: number, r: ResolvedSkills): number =>
  Math.max(0, ...(ABILITIES[ability]?.effects ?? []).map((e) => applyChannel(r.ability[ability]?.[STAT_ABILITY_RADIUS], e.radius)));

// Effect numbers, resolved through the build. Modifiers reach abilities the same way they reach
// swings, so a passive that says "area damage" lands here without anything knowing its name.
export const effectRadius = (ability: number, e: Effect, r: ResolvedSkills): number =>
  applyChannel(r.ability[ability]?.[STAT_ABILITY_RADIUS], e.radius);
export const effectDamage = (ability: number, e: Effect, r: ResolvedSkills): number =>
  applyChannel(r.ability[ability]?.[STAT_ABILITY_DAMAGE], e.damage ?? 0);
export const effectAmount = (ability: number, e: Effect, r: ResolvedSkills): number =>
  applyChannel(r.ability[ability]?.[STAT_ABILITY_AMOUNT], e.amount ?? 0);
export const abilityCooldown = (ability: number, r: ResolvedSkills): number =>
  Math.max(0, applyFrames(r.ability[ability]?.[STAT_ABILITY_COOLDOWN], ABILITIES[ability]?.cooldownFrames ?? 0));

export const ATTACK: {
  bufferFrames: number;
  autoAimRange: number;
  autoAimDeg: number;
  airGravityScale: number;
} = shared.attack;

export const WEAPONS = shared.weapons as unknown as Weapon[];
export const ABILITIES = shared.abilities as unknown as Ability[];
export const SKILLS = { points: SKILL_POINTS, trees: TREES, nodes: NODES };
export const NO_ABILITY = 255;

// Combos and cast times, resolved through the skill tree rather than against named perks.
// Adding a skill that changes either is now a data change; see src/skills.ts for the rules.

interface ComboVariant {
  id: string;
  replace: number;
  step: AttackStep;
}

// The combo for a weapon, with any variant the build has unlocked swapped in, and the resolved
// per-step numbers applied. Cached per (weapon, resolved build) because it runs inside the sim.
export function comboFor(weapon: number, r: ResolvedSkills): AttackStep[] {
  const w = WEAPONS[weapon] ?? WEAPONS[0];
  const cached = comboCache.get(r)?.[weapon];
  if (cached) return cached;
  let steps = w.combo;
  for (const v of (w.variants ?? []) as ComboVariant[]) {
    if (!r.combos.has(v.id)) continue;
    steps = steps.map((s, i) => (i === v.replace ? v.step : s));
  }
  const ch = r.weapon[weapon] ?? [];
  const startup = ch[STAT_STARTUP];
  const damage = ch[STAT_ATTACK_DAMAGE];
  const out = steps.map((s) => ({ ...s, startup: applyFrames(startup, s.startup), damage: applyChannel(damage, s.damage) }));
  let byWeapon = comboCache.get(r);
  if (!byWeapon) {
    byWeapon = [];
    comboCache.set(r, byWeapon);
  }
  byWeapon[weapon] = out;
  return out;
}

const comboCache = new WeakMap<ResolvedSkills, AttackStep[][]>();

// Other players are drawn, not simulated, so they are sent which combo variants they have rather
// than their whole skill tree: one bit each, in the order the variants appear in the data.
const VARIANT_IDS: string[] = WEAPONS.flatMap((w) => ((w.variants ?? []) as ComboVariant[]).map((v) => v.id));
if (VARIANT_IDS.length > 8) throw new Error('more than 8 combo variants: widen the field in put_player');
export const COMBO_VARIANTS = VARIANT_IDS;

export function variantBits(r: ResolvedSkills): number {
  let bits = 0;
  VARIANT_IDS.forEach((id, i) => {
    if (r.combos.has(id)) bits |= 1 << i;
  });
  return bits;
}

// The shape of a weapon's combo for a given set of variants: right steps, base numbers. Used for
// drawing someone else, where the exact frame counts of their build don't matter.
export function comboShape(weapon: number, bits: number): AttackStep[] {
  const w = WEAPONS[weapon] ?? WEAPONS[0];
  let steps = w.combo;
  for (const v of (w.variants ?? []) as ComboVariant[]) {
    if ((bits & (1 << VARIANT_IDS.indexOf(v.id))) === 0) continue;
    steps = steps.map((s, i) => (i === v.replace ? v.step : s));
  }
  return steps;
}
const STAT_STARTUP = statIndex('attack.startup');
const STAT_ATTACK_DAMAGE = statIndex('attack.damage');
const STAT_CAST_FRAMES = statIndex('cast.frames');
const STAT_ABILITY_DAMAGE = statIndex('ability.damage');
const STAT_ABILITY_RADIUS = statIndex('ability.radius');
const STAT_ABILITY_AMOUNT = statIndex('ability.amount');
const STAT_ABILITY_COOLDOWN = statIndex('ability.cooldown');
const STAT_MELEE_TARGETS = statIndex('melee.maxTargets');
const STAT_PIERCE = statIndex('projectile.pierce');

export function castFramesFor(ability: number, r: ResolvedSkills): number {
  const a = ABILITIES[ability];
  if (!a) return 1;
  return Math.max(1, applyFrames(r.ability[ability]?.[STAT_CAST_FRAMES], a.castFrames));
}

// How many enemies one swing of this weapon reaches.
export function meleeTargets(weapon: number, r: ResolvedSkills): number {
  return Math.max(1, Math.round(applyChannel(r.weapon[weapon]?.[STAT_MELEE_TARGETS], statBase(STAT_MELEE_TARGETS))));
}

// How many enemies an arrow from this weapon goes through.
export function pierceTargets(weapon: number, r: ResolvedSkills): number {
  return Math.max(1, Math.round(applyChannel(r.weapon[weapon]?.[STAT_PIERCE], statBase(STAT_PIERCE))));
}



// A character's skills and loadout. `perks` has one bit per learned skill.
export const HOTBAR_SLOTS = (shared.hotbar as { slots: number }).slots;

export interface Build {
  skills: SkillSet;
  weapon: number;
  // One entry per movement slot (Q / E, LB / RB), NO_MOVEMENT where empty.
  movement: number[];
  // One entry per hotbar slot, NO_ABILITY where the slot is empty. Always HOTBAR_SLOTS long.
  abilities: number[];
}

export const emptyHotbar = (): number[] => new Array<number>(HOTBAR_SLOTS).fill(NO_ABILITY);

export const DEFAULT_BUILD: Build = {
  skills: withSkill(emptySkills(), skillIndex('sword'), true),
  weapon: 0,
  movement: emptyMovement(),
  abilities: emptyHotbar(),
};

// ---------- Browser-only settings ----------

export const DUMMY = {
  hp: 100,
  radius: 0.4,
  resetFrames: 60,
};

// How anything that rocks when hit settles back upright. Props use it; creatures leave it alone.
export const LEAN = {
  spring: 140,
  damping: 7,
};

// Slimes in the training yard: something that moves and dies, to practise against. They do not
// fight back - a monster with its own intentions belongs on the server, not in the browser's
// local stand-in for one.
export const SLIME = {
  count: 5,
  hp: 40,
  radius: 0.42,
  hitHeight: 0.5, // where a damage number pops
  // A slime is knee-high and an arrow flies at 1.3 m, so a strict height test would make them
  // unshootable. Anything on a flat trajectory counts as a hit.
  hitCeiling: 1.7,
  aggroRange: 9, // hops toward you inside this, wanders outside it
  keepAway: 2.0, // ...but stops closing once it is this near, so they stay out of your view
  hopDistance: 1.15, // metres per hop
  hopFrames: 42,
  hopHeight: 0.5,
  idleMinFrames: 20,
  idleMaxFrames: 70,
  dieFrames: 36,
  respawnFrames: 210,
  wanderRadius: 7, // how far from its post it will drift
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
  // Placing a ground-aimed cast: the view lifts and pulls back, and leans toward the circle, so
  // you can actually see where it's going.
  aimPitch: 0.95,
  aimZoom: 1.7, // multiplies the distance you've chosen
  aimLead: 0.42, // how far the view slides from you toward the circle
  aimEase: 7.0, // how fast it moves in and out, per second
};

// Moving the ground-aim circle: a cursor you push around, not a camera raycast (the camera always
// looks at you, so its centre is never where you want the spell).
export const AIM = {
  stickSpeed: 13.5, // metres per second at full left-stick tilt
  mouseSpeed: 0.022, // metres per pixel of mouse movement
  startRange: 0.6, // fraction of max range the circle starts at, if nothing is marked
};

export const GAMEPAD = {
  deadzone: 0.18,
};

export const WORLD = {
  seed: 1337,
  radius: 32, // invisible wall around the training yard
};
