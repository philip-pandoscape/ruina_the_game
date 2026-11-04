import type { Side } from './body';

// How each weapon swings, as keyframes along the swing's own timeline: 0 is the start, 1 the end
// of the wind-up (startup frames), 2 the end of the strike (active frames), 3 the end of the
// recovery. Angles are radians in the torso's frame: azimuth 0 straight ahead and + to the left,
// elevation + up.
//
// The arm is given as where it points and how straight it is; IK finds the elbow. The weapon is
// given as where it points; the wrist turns it there. The trail is traced from the pose itself
// (src/render/character.ts), so whatever path these describe, the trail follows the blade. Swings
// go diagonally and wide so they read from a camera sitting behind the player.

export type V3 = readonly [number, number, number];

export interface SwingKey {
  at: number;
  /** Right arm: azimuth, elevation, and how straight (0.5 folded .. 1 locked out). */
  arm: V3;
  /** Where the weapon points: azimuth, elevation. */
  aim: readonly [number, number];
  /** Spine: lean forward (+), turn left (+), tip left (+). */
  torso: V3;
  /** Pelvis turn, + left. */
  hips?: number;
  /** How far the body sinks (+) or rises (-), metres. */
  drop?: number;
  /** Left arm, as Body.setArmOut takes it (away from the body, pitch, elbow), when not gripping. */
  off?: V3;
  /** 0..1 how much the left hand is on the weapon (two-handed). */
  grip?: number;
}

export interface FootStep {
  foot: Side;
  /** Timeline places it leaves and meets the ground. */
  lift: number;
  land: number;
  /** Where it comes down, ankle x and z in the body's frame at that moment. */
  to: readonly [number, number];
  /** How high it lifts. */
  height?: number;
}

export interface SwingDef {
  /** Trail colours. */
  color: number;
  core: number;
  keys: SwingKey[];
  steps?: FootStep[];
  /** Turns of the whole body over the strike (Whirlwind), - is clockwise seen from above. */
  spin?: number;
  /** Leaves the ground by this much during the strike. */
  hop?: number;
  /** Where the left hand grips, along the weapon from the right hand (+ toward the pommel). */
  grip?: number;
}

/** Ready stance (ankle x, z): left foot forward, right back, as a swing starts from rest. */
export const READY: Record<Side, readonly [number, number]> = { L: [0.15, 0.09], R: [-0.15, -0.09] };

const REST_SWORD: Omit<SwingKey, 'at'> = { arm: [0.15, -1.0, 0.86], aim: [0.3, -0.5], torso: [0.05, 0, 0], off: [0.15, 0.1, -0.35] };
const REST_CLUB: Omit<SwingKey, 'at'> = { arm: [0.35, -0.25, 0.55], aim: [-2.75, 0.55], torso: [0.04, 0, 0], off: [0.2, 0.05, -0.4] };
const REST_STAFF: Omit<SwingKey, 'at'> = { arm: [-0.35, -1.05, 0.72], aim: [0.05, 1.35], torso: [0.03, 0, 0], off: [0.15, 0.1, -0.35] };

export const SWORD_SWINGS: SwingDef[] = [
  // High right to low left: coil the shoulders right with the blade cocked over the shoulder, then
  // whip it across and down, stepping in with the right foot.
  {
    color: 0x6fd3ff,
    core: 0xffffff,
    keys: [
      { at: 0, ...REST_SWORD },
      { at: 1, arm: [-1.9, 0.75, 0.62], aim: [-2.7, 0.55], torso: [-0.05, -0.5, 0.04], hips: -0.25, drop: 0.03, off: [0.25, -1.35, -0.25] },
      { at: 1.4, arm: [0.35, -0.05, 0.98], aim: [0.55, -0.2], torso: [0.16, 0.25, -0.03], hips: 0.12, drop: 0.07, off: [0.2, 0.55, -1.5] },
      { at: 2, arm: [1.0, -0.6, 0.86], aim: [1.9, -0.55], torso: [0.22, 0.55, -0.06], hips: 0.3, drop: 0.08, off: [0.3, 0.3, -1.1] },
      { at: 2.5, arm: [0.5, -0.8, 0.86], aim: [0.9, -0.5], torso: [0.12, 0.3, -0.02], hips: 0.15, drop: 0.04, off: [0.2, 0.15, -0.6] },
      { at: 3, ...REST_SWORD },
    ],
    steps: [
      { foot: 'R', lift: 0.15, land: 1.35, to: [-0.14, 0.24], height: 0.09 },
      { foot: 'L', lift: 1.55, land: 2.12, to: [0.15, -0.16], height: 0.05 }, // the back foot follows the lunge in
      { foot: 'R', lift: 2.45, land: 2.9, to: READY.R, height: 0.05 },
      { foot: 'L', lift: 2.6, land: 2.95, to: READY.L, height: 0.04 },
    ],
  },
  // Rising backhand: carry the blade on round to the left hip, then rip it up and out to the
  // right, stepping in with the left.
  {
    color: 0x6fd3ff,
    core: 0xffffff,
    keys: [
      { at: 0, arm: [0.85, -0.65, 0.86], aim: [1.6, -0.55], torso: [0.2, 0.45, -0.05], hips: 0.25, drop: 0.07, off: [0.28, 0.25, -1.0] },
      { at: 1, arm: [1.15, -0.72, 0.7], aim: [2.5, -0.35], torso: [0.14, 0.7, -0.06], hips: 0.35, drop: 0.08, off: [0.3, 0.2, -1.2] },
      { at: 1.45, arm: [-0.25, 0.1, 0.98], aim: [-0.4, 0.3], torso: [0.06, -0.15, 0.03], hips: -0.1, drop: 0.05, off: [0.35, -0.6, -0.5] },
      { at: 2, arm: [-1.3, 0.85, 0.8], aim: [-1.75, 0.95], torso: [-0.08, -0.5, 0.06], hips: -0.25, drop: 0.02, off: [0.45, -0.9, -0.3] },
      { at: 2.5, arm: [-0.6, 0.0, 0.86], aim: [-0.5, -0.1], torso: [0.0, -0.2, 0.02], hips: -0.1, drop: 0.02, off: [0.25, -0.3, -0.4] },
      { at: 3, ...REST_SWORD },
    ],
    steps: [
      { foot: 'L', lift: 0.2, land: 1.4, to: [0.15, 0.24], height: 0.09 },
      { foot: 'R', lift: 1.6, land: 2.12, to: [-0.15, -0.16], height: 0.05 },
      { foot: 'R', lift: 2.5, land: 2.95, to: READY.R, height: 0.05 },
      { foot: 'L', lift: 2.55, land: 2.95, to: READY.L, height: 0.04 },
    ],
  },
  // Overhead finisher: both hands raise it high behind the head, the body rises into it, then the
  // whole body comes down behind the chop into a deep lunge.
  {
    color: 0xffb627,
    core: 0xfff4d6,
    grip: 0.13,
    keys: [
      { at: 0, arm: [-1.15, 0.65, 0.8], aim: [-1.5, 0.75], torso: [-0.06, -0.45, 0.05], hips: -0.22, drop: 0.02, off: [0.4, -0.8, -0.3], grip: 0 },
      { at: 0.55, arm: [-0.2, 1.2, 0.72], aim: [-2.8, 0.95], torso: [-0.18, -0.15, 0.0], hips: -0.1, drop: -0.04, grip: 1 },
      { at: 1, arm: [0.25, 1.3, 0.78], aim: [3.0, 0.72], torso: [-0.24, -0.05, 0.0], hips: -0.05, drop: -0.06, grip: 1 },
      { at: 1.45, arm: [0.12, -0.12, 0.98], aim: [0.05, -0.32], torso: [0.36, 0.06, 0.0], hips: 0.05, drop: 0.13, grip: 1 },
      { at: 2, arm: [0.12, -0.55, 0.94], aim: [0.04, -0.64], torso: [0.46, 0.06, 0.0], hips: 0.05, drop: 0.2, grip: 1 },
      { at: 2.55, arm: [0.12, -0.52, 0.92], aim: [0.04, -0.6], torso: [0.42, 0.05, 0.0], hips: 0.04, drop: 0.18, grip: 1 },
      { at: 2.8, arm: [0.12, -0.9, 0.86], aim: [0.2, -0.6], torso: [0.15, 0.02, 0.0], drop: 0.06, grip: 0, off: [0.15, 0.1, -0.35] },
      { at: 3, ...REST_SWORD },
    ],
    steps: [
      { foot: 'R', lift: 0.3, land: 1.5, to: [-0.13, 0.42], height: 0.14 },
      { foot: 'L', lift: 1.6, land: 2.3, to: [0.15, -0.12], height: 0.07 }, // the back foot follows the lunge in
      { foot: 'R', lift: 2.6, land: 2.95, to: READY.R, height: 0.06 },
      { foot: 'L', lift: 2.55, land: 2.95, to: READY.L, height: 0.05 },
    ],
  },
];

/** Whirlwind replaces the finisher: coil low to the left, then hop and spin once, blade out. */
export const WHIRLWIND: SwingDef = {
  color: 0xffb627,
  core: 0xfff4d6,
  spin: -1,
  hop: 0.12,
  keys: [
    { at: 0, arm: [-1.15, 0.65, 0.8], aim: [-1.5, 0.75], torso: [-0.06, -0.45, 0.05], hips: -0.22, drop: 0.02, off: [0.4, -0.8, -0.3] },
    { at: 1, arm: [1.1, -0.75, 0.72], aim: [2.6, -0.15], torso: [0.2, 0.85, -0.05], hips: 0.45, drop: 0.14, off: [0.5, 0.35, -1.3] },
    { at: 1.25, arm: [-0.9, -0.05, 0.98], aim: [-1.25, -0.05], torso: [0.1, 0.0, 0.08], hips: 0.0, drop: 0.06, off: [1.2, -0.4, -0.5] },
    { at: 2, arm: [-1.1, -0.05, 0.98], aim: [-1.4, -0.08], torso: [0.12, -0.2, 0.1], hips: -0.1, drop: 0.1, off: [1.2, -0.3, -0.6] },
    { at: 2.45, arm: [-0.6, -0.5, 0.88], aim: [-0.4, -0.35], torso: [0.1, -0.1, 0.03], drop: 0.08, off: [0.4, -0.1, -0.5] },
    { at: 3, ...REST_SWORD },
  ],
  steps: [{ foot: 'R', lift: 2.15, land: 2.6, to: READY.R, height: 0.05 }],
};

export const CLUB_SWINGS: SwingDef[] = [
  // Off the shoulder in a wide flat arc, right to left.
  {
    color: 0xffa94d,
    core: 0xfff1d6,
    keys: [
      { at: 0, ...REST_CLUB },
      { at: 1, arm: [-1.3, 0.35, 0.7], aim: [-2.6, 0.2], torso: [0.0, -0.55, 0.03], hips: -0.25, drop: 0.05, off: [0.3, -1.2, -0.4] },
      { at: 1.45, arm: [0.3, -0.25, 0.98], aim: [0.5, -0.15], torso: [0.15, 0.35, -0.03], hips: 0.18, drop: 0.08, off: [0.25, 0.5, -1.4] },
      { at: 2, arm: [1.0, -0.35, 0.86], aim: [1.9, -0.05], torso: [0.18, 0.75, -0.05], hips: 0.35, drop: 0.08, off: [0.3, 0.3, -1.1] },
      { at: 2.5, arm: [0.6, -0.5, 0.8], aim: [0.8, -0.4], torso: [0.1, 0.35, 0], hips: 0.15, drop: 0.04, off: [0.2, 0.1, -0.6] },
      { at: 3, ...REST_CLUB },
    ],
    steps: [
      { foot: 'R', lift: 0.2, land: 1.45, to: [-0.15, 0.2], height: 0.08 },
      { foot: 'L', lift: 1.6, land: 2.15, to: [0.15, -0.14], height: 0.05 },
      { foot: 'R', lift: 2.5, land: 2.9, to: READY.R, height: 0.05 },
    ],
  },
  // Two hands, high over the head, and down into the ground.
  {
    color: 0xff8c42,
    core: 0xfff1d6,
    grip: 0.15,
    keys: [
      { at: 0, arm: [0.85, -0.4, 0.84], aim: [1.7, -0.1], torso: [0.17, 0.62, -0.04], hips: 0.3, drop: 0.07, off: [0.28, 0.3, -1.0], grip: 0 },
      { at: 0.6, arm: [0.0, 1.15, 0.72], aim: [3.0, 0.9], torso: [-0.15, 0.0, 0], drop: -0.03, grip: 1 },
      { at: 1, arm: [0.25, 1.3, 0.78], aim: [3.05, 0.68], torso: [-0.26, -0.05, 0], drop: -0.05, grip: 1 },
      { at: 1.5, arm: [0.1, -0.2, 0.98], aim: [0.05, -0.55], torso: [0.4, 0.04, 0], drop: 0.14, grip: 1 },
      { at: 2, arm: [0.1, -0.62, 0.92], aim: [0.05, -0.92], torso: [0.56, 0.04, 0], drop: 0.24, grip: 1 },
      { at: 2.6, arm: [0.1, -0.6, 0.9], aim: [0.05, -0.88], torso: [0.5, 0.03, 0], drop: 0.22, grip: 1 },
      { at: 2.85, arm: [0.25, -0.5, 0.7], aim: [-1.5, 0.3], torso: [0.2, 0, 0], drop: 0.08, grip: 0, off: [0.2, 0.05, -0.4] },
      { at: 3, ...REST_CLUB },
    ],
    steps: [
      { foot: 'R', lift: 0.35, land: 1.55, to: [-0.15, 0.38], height: 0.13 },
      { foot: 'L', lift: 1.65, land: 2.35, to: [0.15, -0.1], height: 0.07 },
      { foot: 'R', lift: 2.65, land: 2.95, to: READY.R, height: 0.06 },
      { foot: 'L', lift: 2.6, land: 2.95, to: READY.L, height: 0.05 },
    ],
  },
];

export const STAFF_SWINGS: SwingDef[] = [
  // Both hands on the shaft, the head of the staff sweeping round at chest height.
  {
    color: 0xb48cff,
    core: 0xffffff,
    grip: 0.38,
    keys: [
      { at: 0, ...REST_STAFF, grip: 0 },
      { at: 1, arm: [-1.2, -0.1, 0.75], aim: [-1.9, 0.2], torso: [0.02, -0.5, 0.03], hips: -0.22, drop: 0.05, grip: 1 },
      { at: 1.45, arm: [0.2, -0.05, 0.95], aim: [0.35, 0.05], torso: [0.12, 0.25, -0.02], hips: 0.12, drop: 0.08, grip: 1 },
      { at: 2, arm: [0.85, -0.2, 0.8], aim: [1.7, 0.15], torso: [0.15, 0.6, -0.04], hips: 0.3, drop: 0.08, grip: 1 },
      { at: 2.6, arm: [0.3, -0.6, 0.78], aim: [0.9, 0.7], torso: [0.08, 0.3, 0], hips: 0.12, drop: 0.04, grip: 0.4 },
      { at: 3, ...REST_STAFF, grip: 0 },
    ],
    steps: [
      { foot: 'R', lift: 0.2, land: 1.4, to: [-0.15, 0.18], height: 0.07 },
      { foot: 'L', lift: 1.6, land: 2.2, to: [0.15, -0.12], height: 0.05 },
      { foot: 'R', lift: 2.5, land: 2.9, to: READY.R, height: 0.05 },
      { foot: 'L', lift: 2.55, land: 2.95, to: READY.L, height: 0.04 },
    ],
  },
];

export const swingsFor = (weapon: number): SwingDef[] => (weapon === 1 ? CLUB_SWINGS : weapon === 2 ? STAFF_SWINGS : SWORD_SWINGS);

/** Which swing a combo step uses: Whirlwind's spin replaces whatever was in its place. */
export function swingFor(weapon: number, index: number, pose: string | undefined): SwingDef {
  if (pose === 'spin') return WHIRLWIND;
  const list = swingsFor(weapon);
  return list[Math.min(index, list.length - 1)];
}
