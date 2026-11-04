import * as THREE from 'three';
import { clamp01, lerp, smooth } from './body';

// How a humanoid's feet move over the ground at a given speed. A stride cycle is a left step and
// a right step; each foot spends part of it planted (the stance) and the rest swinging forward.
// A planted foot travels back under the body at exactly the ground speed, so it stays put on the
// ground, and rolls heel to toe (walking) or lands on the ball (running). The stride lengthens and
// the feet spend less time down as the speed rises, which is what turns a walk into a run.
//
// The stride clock that drives this lives with whoever owns the body (src/render/character.ts):
// it advances by distance over strideLength(), so the two always agree.

const SPEEDS = [0, 1.0, 1.6, 3.2, 5.0, 7.5, 10.5];
const LENGTHS = [0.6, 0.8, 0.95, 1.5, 2.0, 2.6, 3.3];
const DUTIES = [0.66, 0.63, 0.6, 0.38, 0.28, 0.22, 0.19];

function table(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) return lerp(ys[i - 1], ys[i], (x - xs[i - 1]) / (xs[i] - xs[i - 1]));
  }
  return ys[ys.length - 1] + ((ys[ys.length - 1] - ys[ys.length - 2]) / (xs[xs.length - 1] - xs[xs.length - 2])) * (x - xs[xs.length - 1]);
}

/** Metres one full stride cycle covers at a ground speed (m/s); `back` 0..1 for backing away. */
export function strideLength(speed: number, crouch = 0, carry = false, back = 0): number {
  return table(SPEEDS, LENGTHS, speed) * (1 + 0.18 * crouch) * (carry ? 0.86 : 1) * (1 - 0.22 * back);
}

/** Fraction of the cycle each foot is on the ground. */
export function dutyFactor(speed: number, crouch = 0, back = 0): number {
  return Math.min(0.72, table(SPEEDS, DUTIES, speed) + 0.06 * crouch + 0.08 * back);
}

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * How a direction of travel (radians from straight ahead, + left) becomes a gait. Ahead and to
 * the sides the legs run forward with the pelvis turned partway toward the way you go; past about
 * 105 degrees they run backwards instead, pelvis turned the other way, which is a backpedal.
 * `back` blends the two across that line; `ahead` and `behind` are where the feet travel for each
 * (the direction the stride runs along), `pelvisAhead` / `pelvisBehind` how far the hips turn.
 */
export function directional(heading: number): { back: number; ahead: number; behind: number; pelvisAhead: number; pelvisBehind: number } {
  const h = wrap(heading);
  const back = smooth((Math.abs(h) - 1.75) / 0.4);
  const behind = wrap(h - Math.PI);
  return { back, ahead: h, behind, pelvisAhead: 0.6 * clamp(h, -1.9, 1.9), pelvisBehind: 0.45 * behind };
}

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/** 0 for a walk, 1 for a run: how much flight there is, how the feet land. */
export const runGait = (speed: number): number => smooth((speed - 2.2) / 2.8);
/** 0 at running pace, 1 flat out. */
export const sprintGait = (speed: number): number => smooth((speed - 7.6) / 2.9);

export interface FootPlan {
  ankle: THREE.Vector3;
  /** Toes down (+) or up (-), model space. */
  pitch: number;
  /** 0..1 how firmly planted: 1 through the middle of the stance, 0 in the air. */
  planted: number;
  /** 0..1 through the stance, or -1 while swinging. */
  stance: number;
}

export interface GaitShape {
  speed: number;
  crouch: number;
  carry: boolean;
  /** 1 for the backing-away gait (shorter strides, more time on the ground), else 0. */
  back: number;
  /** Where each foot's stance centres, relative to the hip, metres forward. */
  centre: number;
  /** Half the distance between the feet. */
  width: number;
  ankleHeight: number;
  heel: number;
  ball: number;
}

const _r = new THREE.Vector3();

/** Ankle of a planted foot whose heel contact is at z = heelZ, pitched by `pitch` (rocker). */
function rocker(s: GaitShape, heelZ: number, pitch: number, out: THREE.Vector3): THREE.Vector3 {
  const h = s.ankleHeight;
  if (pitch <= 0) {
    // Rocking on the heel.
    const z = -s.heel;
    _r.set(0, h * Math.cos(pitch) - z * Math.sin(pitch), h * Math.sin(pitch) + z * Math.cos(pitch));
    return out.set(0, _r.y, heelZ + _r.z);
  }
  // Rolling over the ball of the foot.
  const z = -s.ball;
  _r.set(0, h * Math.cos(pitch) - z * Math.sin(pitch), h * Math.sin(pitch) + z * Math.cos(pitch));
  return out.set(0, _r.y, heelZ + (s.ball - s.heel) + _r.z);
}

/** The foot's pitch through the stance: heel strike to toe-off. */
function stancePitch(s: number, run: number): number {
  // Walking: land on the heel, toes up; flat through the middle; peel off over the ball.
  const walk = s < 0.16 ? lerp(-0.32, 0, smooth(s / 0.16)) : s < 0.55 ? 0 : lerp(0, 0.62, smooth((s - 0.55) / 0.45));
  // Running: land on the ball, let the heel kiss the ground, drive off hard.
  const runP = s < 0.18 ? lerp(0.16, 0, smooth(s / 0.18)) : s < 0.38 ? 0 : lerp(0, 1.0, smooth((s - 0.38) / 0.62));
  return lerp(walk, runP, run);
}

function bezier(a: number, b: number, c: number, d: number, t: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

const _a0 = new THREE.Vector3();
const _a1 = new THREE.Vector3();

/**
 * Where one foot is at cycle fraction u (0 = its heel strike), as an offset from straight under
 * its hip on the ground.
 */
export function planFoot(shape: GaitShape, u: number, out: FootPlan): FootPlan {
  const v = shape.speed;
  const L = strideLength(v, shape.crouch, shape.carry, shape.back);
  const d = dutyFactor(v, shape.crouch, shape.back);
  // Backing away is a quicker, lower shuffle than running forward at the same speed.
  const run = runGait(v * (1 - 0.35 * shape.back));
  const sprint = sprintGait(v) * (1 - shape.back);
  const travel = d * L; // ground the body covers while this foot is down
  // Heel contact at touchdown, chosen so the flat part of the stance centres under the hip.
  const heel0 = shape.centre + travel / 2 + shape.heel;
  const k = ((u % 1) + 1) % 1;
  if (k < d) {
    const s = k / d;
    const pitch = stancePitch(s, run);
    rocker(shape, heel0 - s * travel, pitch, out.ankle);
    out.pitch = pitch;
    out.stance = s;
    out.planted = smooth(Math.min(s, 1 - s) * 6);
    return out;
  }
  // Swinging: from toe-off at the back to the next heel strike at the front.
  const q = (k - d) / (1 - d);
  const offPitch = stancePitch(1, run);
  const onPitch = stancePitch(0, run);
  rocker(shape, heel0 - travel, offPitch, _a0);
  rocker(shape, heel0, onPitch, _a1);
  // A swinging foot always clears the ground, even slowing to a stop (standing still is blended in
  // by whoever calls this), so a slow step is a step and not a shuffle.
  const lift = 0.6 + 0.4 * clamp01(v / 1.2);
  const kick = lerp(0.0, 0.11, run) + 0.05 * sprint; // heel flicks up and back first when running
  const reach = lerp(0.05, 0.11, run) + 0.03 * sprint; // and the foot overshoots, then paws back
  const high = (lerp(0.11, 0.44, run) + 0.1 * sprint) * lift * (1 - 0.35 * shape.crouch);
  const late = (lerp(0.07, 0.17, run) + 0.05 * sprint) * lift;
  out.ankle.set(
    0,
    bezier(_a0.y, _a0.y + high, _a1.y + late, _a1.y, q),
    bezier(_a0.z, _a0.z - kick, _a1.z + reach, _a1.z, q),
  );
  // The foot trails behind from toe-off, then reaches toes-up (walk) or flat (run) for the landing.
  const hang = lerp(0.25, 0.75, run) * Math.sin(Math.PI * clamp01(q / 0.75));
  out.pitch = lerp(offPitch, onPitch, smooth(q)) + hang * (1 - q);
  out.stance = -1;
  out.planted = 0;
  return out;
}
