import * as THREE from 'three';
import { comboShape } from '../../tuning';
import { MAT } from '../../species/types';
import type { ClipDriver } from '../pose';
import type { PartDef, RigDef } from '../rig';

// The player character's build: what it is made of and how it hangs together. The motion that
// drives it lives in src/render/character.ts, because every humanoid race shares it - a second
// race is another file like this one, not another renderer.

const TAU = Math.PI * 2;

const box = (w: number, h: number, d: number, r = 0.05) => ({ kind: 'box', w, h, d, r }) as const;

/** Weapons point down the arm: "forward" along them is -Y. */
function sword(): PartDef[] {
  const tip = (g: THREE.BufferGeometry) => {
    g.rotateZ(Math.PI);
    g.rotateY(Math.PI / 4);
    g.scale(1, 1, 0.33);
  };
  return [
    { joint: 'wrist', shape: { kind: 'cylinder', top: 0.028, bottom: 0.028, h: 0.18 }, mat: 'leather', outline: 0.012 },
    { joint: 'wrist', shape: { kind: 'sphere', r: 0.04, widthSeg: 8, heightSeg: 6 }, mat: 'gold', pos: [0, 0.1, 0], outline: 0.012 },
    { joint: 'wrist', shape: box(0.26, 0.05, 0.07, 0.02), mat: 'gold', pos: [0, -0.1, 0], outline: 0.012 },
    { joint: 'wrist', shape: box(0.075, 0.86, 0.025, 0.012), mat: 'steel', pos: [0, -0.55, 0], outline: 0.012 },
    { joint: 'wrist', shape: { kind: 'cone', r: 0.053, h: 0.12 }, mat: 'steel', pos: [0, -1.04, 0], outline: 0.012, tweak: tip },
  ];
}

function club(): PartDef[] {
  const studs: PartDef[] = ([[0.09, -0.5, 0.03], [-0.07, -0.42, 0.07], [0.02, -0.58, -0.09], [-0.05, -0.33, -0.08]] as const).map(
    (pos) => ({ joint: 'wrist', shape: { kind: 'ico', r: 0.035 }, mat: 'gold', pos, outline: false }),
  );
  return [
    { joint: 'wrist', shape: { kind: 'cylinder', top: 0.03, bottom: 0.035, h: 0.34 }, mat: 'darkWood', pos: [0, -0.06, 0], outline: 0.012 },
    { joint: 'wrist', shape: { kind: 'cylinder', top: 0.1, bottom: 0.065, h: 0.42, sides: 9 }, mat: 'wood', pos: [0, -0.42, 0], outline: 0.015 },
    ...studs,
  ];
}

function staff(): PartDef[] {
  return [
    { joint: 'wrist', shape: { kind: 'cylinder', top: 0.026, bottom: 0.03, h: 1.6, sides: 7 }, mat: 'darkWood', pos: [0, -0.3, 0], outline: 0.012 },
    { joint: 'wrist', shape: { kind: 'torus', r: 0.09, tube: 0.02 }, mat: 'gold', pos: [0, -1.12, 0], outline: false },
    { joint: 'wrist', shape: { kind: 'ico', r: 0.085, detail: 1 }, mat: 'orb', pos: [0, -1.2, 0], outline: 0.012, castShadow: false },
  ];
}

/** Held in the left hand: upright, grip at the hand, bulging forward with the string behind. */
function bow(): PartDef[] {
  return [
    {
      joint: 'leftHand',
      shape: { kind: 'torus', r: 0.55, tube: 0.026, tubularSeg: 18, arc: (TAU / 360) * 120 },
      mat: 'wood',
      outline: 0.012,
      tweak: (g) => {
        g.rotateZ(-(5 * Math.PI) / 6);
        g.rotateY(Math.PI / 2);
        g.translate(0, 0.55, 0);
      },
    },
    {
      joint: 'leftHand',
      shape: { kind: 'cylinder', top: 0.006, bottom: 0.006, h: 0.95, sides: 4 },
      mat: 'string',
      pos: [0, 0.275, 0],
      outline: false,
      castShadow: false,
      tweak: (g) => g.rotateX(Math.PI / 2),
    },
  ];
}

function arrow(): PartDef[] {
  return [
    { joint: 'leftHand', shape: { kind: 'cylinder', top: 0.012, bottom: 0.012, h: 0.8, sides: 5 }, mat: 'shaft', pos: [0, -0.1, 0], outline: false, castShadow: false },
    { joint: 'leftHand', shape: { kind: 'cone', r: 0.03, h: 0.08 }, mat: 'steel', pos: [0, -0.52, 0], outline: false, tweak: (g) => g.rotateZ(Math.PI) },
  ];
}

export const HERO_RIG: RigDef = {
  id: 'hero',
  materials: {
    skin: { color: 0xf1c27d },
    tunic: { color: 0x3a6ea5 },
    leather: { color: 0x6b4226 },
    pants: { color: 0x2f3e46 },
    boots: { color: 0x4a3426 },
    hair: { color: 0x5b3a29 },
    dark: { color: 0x1d2733 },
    gold: { color: 0xe0b84a },
    steel: { color: 0xdfe6ee, emissive: 0x334455 },
    cape: { color: 0xc0392b },
    wood: { color: 0x8a5a33 },
    darkWood: { color: 0x5c3a1e },
    orb: { color: 0xffa040, basic: true },
    string: { color: 0xeeeeee },
    shaft: { color: 0xd9c39a },
  },
  // Parents come before children; the rig checks.
  joints: [
    { name: 'squash' },
    { name: 'body', parent: 'squash', pos: [0, 0.78, 0] },
    { name: 'hips', parent: 'body', pos: [0, -0.14, 0] },
    { name: 'legL', parent: 'hips', pos: [0.12, -0.02, 0] },
    { name: 'legR', parent: 'hips', pos: [-0.12, -0.02, 0] },
    { name: 'torso', parent: 'body', pos: [0, -0.08, 0] },
    { name: 'head', parent: 'torso', pos: [0, 0.7, 0] },
    { name: 'cape', parent: 'torso', pos: [0, 0.42, -0.16] },
    // Arms go shoulder -> yaw -> pitch, so a swing is two angles rather than a quaternion.
    { name: 'shoulderL', parent: 'torso', pos: [0.31, 0.4, 0] },
    { name: 'armLyaw', parent: 'shoulderL' },
    { name: 'armLpitch', parent: 'armLyaw' },
    { name: 'leftHand', parent: 'armLpitch', pos: [0, -0.45, 0] },
    { name: 'shoulderR', parent: 'torso', pos: [-0.31, 0.4, 0] },
    { name: 'armRyaw', parent: 'shoulderR' },
    { name: 'armRpitch', parent: 'armRyaw' },
    { name: 'wrist', parent: 'armRpitch', pos: [0, -0.45, 0] },
  ],
  parts: [
    { joint: 'hips', shape: box(0.4, 0.16, 0.26), mat: 'pants' },
    { joint: 'legL', shape: box(0.15, 0.5, 0.17), mat: 'pants', pos: [0, -0.25, 0] },
    { joint: 'legL', shape: box(0.19, 0.13, 0.27, 0.04), mat: 'boots', pos: [0, -0.555, 0.04] },
    { joint: 'legR', shape: box(0.15, 0.5, 0.17), mat: 'pants', pos: [0, -0.25, 0] },
    { joint: 'legR', shape: box(0.19, 0.13, 0.27, 0.04), mat: 'boots', pos: [0, -0.555, 0.04] },
    { joint: 'torso', shape: box(0.46, 0.44, 0.3, 0.08), mat: 'tunic', pos: [0, 0.23, 0] },
    { joint: 'torso', shape: box(0.48, 0.07, 0.32, 0.03), mat: 'leather', pos: [0, 0.04, 0], outline: 0.015 },
    { joint: 'torso', shape: box(0.09, 0.08, 0.04, 0.02), mat: 'gold', pos: [0, 0.04, 0.165], outline: false },
    { joint: 'head', shape: box(0.5, 0.46, 0.46, 0.12), mat: 'skin' },
    { joint: 'head', shape: box(0.55, 0.17, 0.5, 0.07), mat: 'hair', pos: [0, 0.2, -0.01] },
    { joint: 'head', shape: box(0.55, 0.36, 0.15, 0.06), mat: 'hair', pos: [0, 0.05, -0.19] },
    { joint: 'head', shape: box(0.07, 0.11, 0.02, 0.01), mat: 'dark', pos: [0.11, 0, 0.235], outline: false, castShadow: false },
    { joint: 'head', shape: box(0.07, 0.11, 0.02, 0.01), mat: 'dark', pos: [-0.11, 0, 0.235], outline: false, castShadow: false },
    { joint: 'cape', shape: box(0.42, 0.5, 0.04, 0.02), mat: 'cape', pos: [0, -0.25, 0], outline: 0.015 },
    { joint: 'armLpitch', shape: box(0.14, 0.42, 0.15), mat: 'tunic', pos: [0, -0.21, 0] },
    { joint: 'armLpitch', shape: { kind: 'sphere', r: 0.075 }, mat: 'skin', pos: [0, -0.45, 0], outline: 0.015 },
    { joint: 'armRpitch', shape: box(0.14, 0.42, 0.15), mat: 'tunic', pos: [0, -0.21, 0] },
    { joint: 'armRpitch', shape: { kind: 'sphere', r: 0.075 }, mat: 'skin', pos: [0, -0.45, 0], outline: 0.015 },
  ],
  attachments: {
    sword: { joint: 'wrist', exclusive: true, parts: sword() },
    club: { joint: 'wrist', exclusive: true, parts: club() },
    staff: { joint: 'wrist', exclusive: true, parts: staff() },
    bow: { joint: 'leftHand', exclusive: true, parts: bow() },
    arrow: { joint: 'leftHand', parts: arrow() },
  },
};

/** Weapon index (as the rules number them) to the attachment that draws it. */
export const HERO_WEAPONS = ['sword', 'club', 'staff', 'bow'] as const;

/** Team colours: blue tunic with a red cape, or red tunic with a dark one. */
export const HERO_TEAM_COLOURS = [
  { tunic: 0x3a6ea5, cape: 0xc0392b },
  { tunic: 0xb33a3a, cape: 0x3a3f4f },
];

/** Which crowd palette slot each worn material uses, so armies still read as two sides. */
export const HERO_SLOTS: Record<string, number> = {
  tunic: MAT.team,
  cape: MAT.team,
  skin: MAT.skin,
  hair: MAT.hair,
};

// The crowd's animations, as points along the same poses the close-up renderer uses. These are
// drivers, not a second set of animations: each one says what the hero is doing at a moment, and
// the baker runs the real pose code to find out what that looks like.
const SWORD_COMBO = comboShape(0, 0);

export const HERO_CLIPS: ClipDriver[] = [
  { name: 'idle', frames: 72, at: (t) => ({ time: t * 2.4 }) },
  { name: 'walk', frames: 40, at: (t) => ({ run: 0.45, phase: t * TAU }) },
  { name: 'run', frames: 26, at: (t) => ({ run: 1, phase: t * TAU }) },
  ...SWORD_COMBO.map((step, i) => ({
    name: `attack${i + 1}`,
    frames: Math.max(2, step.startup + step.active + step.recovery),
    loop: false,
    at: (_t: number, frame: number) => ({ attackIndex: i, attackFrame: frame, step, comboLength: SWORD_COMBO.length }),
  })),
  { name: 'cast', frames: 48, at: (t) => ({ castAbility: 0, time: t * 1.6 }) },
  { name: 'air', frames: 2, loop: false, at: () => ({ grounded: false, rise: 0.4 }) },
  { name: 'down', frames: 1, loop: false, at: () => ({ down: true }) },
];
