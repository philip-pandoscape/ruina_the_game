import * as THREE from 'three';
import type { DetailRig } from './rig';
import { BOX_STRIDE, MADE_STRIDE, type Stride } from './gait';

// Handles on a humanoid rig, and the two ways to pose a limb: by its angles (forward kinematics)
// or by where its end should be (inverse kinematics, analytic two-bone). Everything is measured in
// "model space": the space the body joint lives in, under the squash scale, where the ground is
// y = 0 and the creature faces +Z. Squash and stretch stays a cartoon touch on top, and the feet
// still meet the floor.
//
// Conventions (see the joint notes in src/content/creatures/hero.ts):
//   arms:  yaw about +Y (+ swings toward +X, the left), then pitch about +X (0 hangs down, -pi/2
//          points forward, -pi straight up), then twist about the arm itself. Elbows bend the
//          forearm forward with negative angles.
//   legs:  pitch about +X (negative swings the leg forward), spread about +Z, twist about +Y.
//          Knees bend the shin back with positive angles. Feet: positive pitch points the toes.
//   torso and hips: positive pitch leans forward, positive yaw turns left.

export type Side = 'L' | 'R';
export const SIDES: readonly Side[] = ['L', 'R'];

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _u = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _s = new THREE.Vector3();
const AX = new THREE.Vector3(1, 0, 0);
const AY = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const _e = new THREE.Euler();

export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
export const clamp01 = (t: number): number => clamp(t, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth = (t: number): number => {
  const k = clamp01(t);
  return k * k * (3 - 2 * k);
};
export const easeOut = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3);
export const easeIn = (t: number): number => Math.pow(clamp01(t), 3);
export const easeInOut = (t: number): number => {
  const k = clamp01(t);
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
};
/** 0 -> 1 -> 0 over t in [0, 1], soft at both ends. */
export const bump = (t: number): number => Math.sin(Math.PI * clamp01(t));
/** Fraction of the way through [a, b]. */
export const span = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));

/**
 * Two-bone IK. Points `root`, `target` and the pole direction are in one space; writes the upper
 * bone's orientation in that space to `out` and returns the middle joint's hinge angle. `knee`
 * says which way the hinge folds: a knee pokes toward the pole and bends its lower bone back
 * about +X; an elbow pokes toward the pole and bends its forearm forward about -X.
 */
export function solveTwoBone(
  root: THREE.Vector3,
  target: THREE.Vector3,
  l1: number,
  l2: number,
  pole: THREE.Vector3,
  knee: boolean,
  out: THREE.Quaternion,
): number {
  _d.subVectors(target, root);
  let dist = _d.length();
  if (dist < 1e-6) _d.set(0, -1, 0);
  _d.normalize();
  dist = clamp(dist, Math.abs(l1 - l2) + 1e-4, (l1 + l2) * 0.9999);
  // The plane the limb folds in holds the root-to-target line and the pole.
  _n.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_n.lengthSq() < 1e-8) _n.set(0, 0, 1).addScaledVector(_d, -_d.z);
  if (_n.lengthSq() < 1e-8) _n.set(1, 0, 0);
  _n.normalize();
  const a = Math.acos(clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1));
  const c = Math.acos(clamp((l1 * l1 + l2 * l2 - dist * dist) / (2 * l1 * l2), -1, 1));
  _u.copy(_d).multiplyScalar(Math.cos(a)).addScaledVector(_n, Math.sin(a));
  // The bone runs down its own -Y; +Z faces the way the hinge pokes (knees) or folds (elbows).
  _y.copy(_u).negate();
  _z.copy(_n).addScaledVector(_u, -_n.dot(_u)).normalize();
  if (!knee) _z.negate();
  _x.crossVectors(_y, _z).normalize();
  _m.makeBasis(_x, _y, _z);
  out.setFromRotationMatrix(_m);
  const bend = Math.PI - c;
  return knee ? bend : -bend;
}

interface Limb {
  root: THREE.Group;
  mid: THREE.Group;
  end: THREE.Group;
  /** Upper and lower bone lengths. */
  l1: number;
  l2: number;
}

const cache = new WeakMap<DetailRig, Body>();

export class Body {
  readonly squash: THREE.Group;
  readonly body: THREE.Group;
  readonly hips: THREE.Group;
  readonly torso: THREE.Group;
  readonly neck: THREE.Group;
  readonly head: THREE.Group;
  readonly eyes: THREE.Group;
  readonly cape: THREE.Group;
  readonly capeTail: THREE.Group;
  readonly shoulder: Record<Side, THREE.Group>;
  readonly arm: Record<Side, Limb>;
  readonly leg: Record<Side, Limb>;
  /** Standing height of the body joint, from the rig. */
  readonly standY: number;
  /** Ankle above the sole of the boot. */
  readonly ankleHeight: number;
  /** Heel and ball of the foot, forward of the ankle (the toe-off pivot is the ball). */
  readonly heel: number;
  readonly ball: number;
  /** How this body strides: the box hero's quick short steps, or a made body's human ones. */
  readonly stride: Stride;
  private readonly bind: Array<{ g: THREE.Group; pos: THREE.Vector3 }> = [];
  private readonly chains = new Map<THREE.Object3D, THREE.Object3D[]>();

  static of(rig: DetailRig): Body {
    let b = cache.get(rig);
    if (!b) {
      b = new Body(rig);
      cache.set(rig, b);
    }
    return b;
  }

  private constructor(readonly rig: DetailRig) {
    const j = (n: string) => rig.joint(n);
    this.squash = j('squash');
    this.body = j('body');
    this.hips = j('hips');
    this.torso = j('torso');
    this.neck = j('neck');
    this.head = j('head');
    this.eyes = j('eyes');
    this.cape = j('cape');
    this.capeTail = j('capeTail');
    this.shoulder = { L: j('shoulderL'), R: j('shoulderR') };
    const limb = (a: string, b: string, c: string): Limb => ({
      root: j(a),
      mid: j(b),
      end: j(c),
      l1: Math.abs(j(b).position.y),
      l2: Math.abs(j(c).position.y),
    });
    this.arm = { L: limb('armL', 'elbowL', 'handL'), R: limb('armR', 'elbowR', 'handR') };
    this.leg = { L: limb('legL', 'kneeL', 'footL'), R: limb('legR', 'kneeR', 'footR') };
    for (const d of rig.def.joints) this.bind.push({ g: j(d.name), pos: new THREE.Vector3(...(d.pos ?? [0, 0, 0])) });
    this.standY = this.body.position.y;
    const feet = rig.def.feet ?? { ankle: 0.08, heel: -0.085, ball: 0.17 };
    this.ankleHeight = feet.ankle;
    this.heel = feet.heel;
    this.ball = feet.ball;
    this.stride = rig.def.gait === 'made' ? MADE_STRIDE : BOX_STRIDE;
  }

  /** Back to the bind pose: every joint where the rig put it, unturned, unscaled. */
  reset(): void {
    for (const { g, pos } of this.bind) {
      g.position.copy(pos);
      g.rotation.set(0, 0, 0, 'XYZ');
      g.scale.set(1, 1, 1);
    }
  }

  /** Bind-pose offset of a joint from its parent. */
  rest(g: THREE.Object3D): THREE.Vector3 {
    return this.bind.find((b) => b.g === g)!.pos;
  }

  // ---------- whole poses, for blending one into another ----------

  /** Every joint's position, rotation and scale, 10 floats each. */
  save(out: Float32Array = new Float32Array(this.bind.length * 10)): Float32Array {
    this.bind.forEach(({ g }, i) => {
      const o = i * 10;
      out[o] = g.position.x;
      out[o + 1] = g.position.y;
      out[o + 2] = g.position.z;
      out[o + 3] = g.quaternion.x;
      out[o + 4] = g.quaternion.y;
      out[o + 5] = g.quaternion.z;
      out[o + 6] = g.quaternion.w;
      out[o + 7] = g.scale.x;
      out[o + 8] = g.scale.y;
      out[o + 9] = g.scale.z;
    });
    return out;
  }

  /** Puts the rig `w` of the way from pose `a` to pose `b` (both from save()). */
  mix(a: Float32Array, b: Float32Array, w: number): void {
    const k = clamp01(w);
    this.bind.forEach(({ g }, i) => {
      const o = i * 10;
      g.position.set(lerp(a[o], b[o], k), lerp(a[o + 1], b[o + 1], k), lerp(a[o + 2], b[o + 2], k));
      _q.set(a[o + 3], a[o + 4], a[o + 5], a[o + 6]);
      _q2.set(b[o + 3], b[o + 4], b[o + 5], b[o + 6]);
      g.quaternion.slerpQuaternions(_q, _q2, k);
      g.scale.set(lerp(a[o + 7], b[o + 7], k), lerp(a[o + 8], b[o + 8], k), lerp(a[o + 9], b[o + 9], k));
    });
  }

  get jointCount(): number {
    return this.bind.length;
  }

  private buffers: Float32Array[] = [];
  /** Scratch space for whole poses (save/mix), sized for this rig. */
  buf(i: number): Float32Array {
    return (this.buffers[i] ??= new Float32Array(this.bind.length * 10));
  }

  // ---------- angles ----------

  setArm(s: Side, yaw: number, pitch: number, twist: number, elbow: number): void {
    const a = this.arm[s];
    a.root.quaternion.setFromAxisAngle(AY, yaw);
    a.root.quaternion.multiply(_q.setFromAxisAngle(AX, pitch));
    a.root.quaternion.multiply(_q.setFromAxisAngle(AY, twist));
    a.mid.rotation.set(elbow, 0, 0);
  }

  /** The same arm pose on either side: `out` swings away from the body, twist turns outward. */
  setArmOut(s: Side, out: number, pitch: number, twist: number, elbow: number): void {
    const k = s === 'L' ? 1 : -1;
    this.setArm(s, out * k, pitch, twist * k, elbow);
  }

  setHand(s: Side, x: number, y = 0, z = 0): void {
    this.arm[s].end.rotation.set(x, y, z);
  }

  setLeg(s: Side, pitch: number, spread: number, twist: number, knee: number, ankle: number): void {
    const l = this.leg[s];
    l.root.rotation.set(pitch, twist, spread, 'XZY');
    l.mid.rotation.set(knee, 0, 0);
    l.end.rotation.set(ankle, 0, 0);
  }

  /** The same leg pose on either side: `out` spreads it away from the body. */
  setLegOut(s: Side, pitch: number, out: number, knee: number, ankle: number, twistOut = 0): void {
    const k = s === 'L' ? 1 : -1;
    this.setLeg(s, pitch, -out * k, twistOut * k, knee, ankle);
  }

  // ---------- where things are ----------

  private chain(g: THREE.Object3D): THREE.Object3D[] {
    let c = this.chains.get(g);
    if (!c) {
      c = [];
      for (let n: THREE.Object3D | null = g; n && n !== this.squash; n = n.parent) c.unshift(n);
      this.chains.set(g, c);
    }
    return c;
  }

  /** A joint's transform in model space. */
  matrixOf(g: THREE.Object3D, out = new THREE.Matrix4()): THREE.Matrix4 {
    out.identity();
    for (const n of this.chain(g)) {
      n.updateMatrix();
      out.multiply(n.matrix);
    }
    return out;
  }

  /** A point given in a joint's own space, in model space. */
  toModel(g: THREE.Object3D, local: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(local).applyMatrix4(this.matrixOf(g, _m2));
  }

  positionOf(g: THREE.Object3D, out = new THREE.Vector3()): THREE.Vector3 {
    return out.setFromMatrixPosition(this.matrixOf(g, _m2));
  }

  quaternionOf(g: THREE.Object3D, out = new THREE.Quaternion()): THREE.Quaternion {
    this.matrixOf(g, _m2).decompose(_v3, out, _s);
    return out;
  }

  /** Sets a joint's local rotation so it ends up facing `model` in model space. */
  orient(g: THREE.Object3D, model: THREE.Quaternion): void {
    const parent = g.parent!;
    if (parent === this.squash) g.quaternion.copy(model);
    else g.quaternion.copy(this.quaternionOf(parent, _q3).invert().multiply(model));
  }

  /** How far forward (+) or back (-) a joint is pitched, as model space sees it. */
  pitchOf(g: THREE.Object3D): number {
    const up = _v2.set(0, 1, 0).applyQuaternion(this.quaternionOf(g, _q2));
    return Math.atan2(up.z, up.y);
  }

  // ---------- reaching ----------

  /**
   * Puts an ankle at a point in model space, the foot pitched (toes down +) and turned (toes left
   * +) as asked there. The knee points the way the foot does, `kneeOut` radians further out.
   * Returns how far short the leg fell, metres (0 when it reached).
   */
  footTo(s: Side, ankle: THREE.Vector3, pitch = 0, yaw = 0, kneeOut = 0.12): number {
    const l = this.leg[s];
    const k = s === 'L' ? 1 : -1;
    const hip = this.positionOf(l.root, _v);
    const side = yaw + kneeOut * k;
    const pole = _v2.set(Math.sin(side), 0, Math.cos(side));
    const bend = solveTwoBone(hip, ankle, l.l1, l.l2, pole, true, _q);
    this.orient(l.root, _q);
    l.mid.rotation.set(bend, 0, 0);
    // The foot: turned and pitched in model space, whatever the leg above it did.
    _q2.setFromEuler(_e.set(pitch, yaw, 0, 'YXZ'));
    this.orient(l.end, _q2);
    return Math.max(0, hip.distanceTo(ankle) - (l.l1 + l.l2));
  }

  /** Where an ankle would have to be for the sole to rest flat at a ground point (its middle). */
  ankleOver(x: number, ground: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(x, ground + this.ankleHeight, z);
  }

  /**
   * Puts a hand at a point in model space with the elbow pointing along `pole`. Returns how far
   * short the arm fell.
   */
  handTo(s: Side, target: THREE.Vector3, pole: THREE.Vector3): number {
    const a = this.arm[s];
    const shoulder = this.positionOf(a.root, _v);
    const bend = solveTwoBone(shoulder, target, a.l1, a.l2, pole, false, _q);
    this.orient(a.root, _q);
    a.mid.rotation.set(bend, 0, 0);
    return Math.max(0, shoulder.distanceTo(target) - (a.l1 + a.l2));
  }

  /**
   * Turns a hand fully: what it holds points along `down` (the hand's -Y) and the hand's +Z faces
   * as near to `front` as it can. For things whose roll matters, like a bow held upright.
   */
  frameHand(s: Side, down: THREE.Vector3, front: THREE.Vector3): void {
    _y.copy(down).normalize().negate();
    _z.copy(front).addScaledVector(_y, -front.dot(_y));
    if (_z.lengthSq() < 1e-8) _z.set(0, 0, 1).addScaledVector(_y, -_y.z);
    _z.normalize();
    _x.crossVectors(_y, _z).normalize();
    _m.makeBasis(_x, _y, _z);
    _q.setFromRotationMatrix(_m);
    this.orient(this.arm[s].end, _q);
  }

  /**
   * Turns a hand so what it holds (which points down the hand's -Y) points along `dir` in model
   * space, by the smallest turn of the wrist, then rolls it `roll` about that direction.
   */
  aimHand(s: Side, dir: THREE.Vector3, roll = 0): void {
    const end = this.arm[s].end;
    end.quaternion.identity();
    const now = this.quaternionOf(end, _q);
    const along = _v.copy(DOWN).applyQuaternion(now);
    _q2.setFromUnitVectors(along, _v2.copy(dir).normalize());
    if (roll) _q2.premultiply(_q3.setFromAxisAngle(_v2, roll));
    _q2.multiply(now);
    this.orient(end, _q2);
  }

  /**
   * Moves an ankle to a point in model space without changing how the foot is turned: the leg
   * re-reaches for it with its knee kept pointing the way it was. `yaw` turns the foot about the
   * vertical as well (radians, + to the left), and the knee half as far with it.
   */
  reachFoot(s: Side, ankle: THREE.Vector3, yaw = 0): void {
    const l = this.leg[s];
    const footQ = this.quaternionOf(l.end, new THREE.Quaternion());
    const hip = this.positionOf(l.root, new THREE.Vector3());
    const knee = this.positionOf(l.mid, new THREE.Vector3());
    const pole = knee.sub(_v.copy(hip).add(ankle).multiplyScalar(0.5));
    if (yaw) {
      pole.applyAxisAngle(Y_AXIS, yaw / 2);
      footQ.premultiply(_q2.setFromAxisAngle(Y_AXIS, yaw));
    }
    const bend = solveTwoBone(hip, ankle, l.l1, l.l2, pole, true, _q);
    this.orient(l.root, _q);
    l.mid.rotation.set(bend, 0, 0);
    this.orient(l.end, footQ);
  }

  /** Raises a foot by dy metres, keeping how it's turned. */
  liftLeg(s: Side, dy: number): void {
    const ankle = this.positionOf(this.leg[s].end, new THREE.Vector3());
    ankle.y += dy;
    this.reachFoot(s, ankle);
  }

  /** Height of the hips' joint for a leg above the ground, given the body as posed. */
  hipOf(s: Side, out = new THREE.Vector3()): THREE.Vector3 {
    return this.positionOf(this.leg[s].root, out);
  }

  /**
   * How far the body must come down so that a leg can reach an ankle point: 0 if it already can.
   * Used to keep planted feet on the ground at the ends of a long stride.
   */
  dropToReach(s: Side, ankle: THREE.Vector3, slack = 0.995): number {
    const l = this.leg[s];
    const hip = this.hipOf(s, _v);
    const reach = (l.l1 + l.l2) * slack;
    const dx = hip.x - ankle.x;
    const dz = hip.z - ankle.z;
    const flat = dx * dx + dz * dz;
    if (flat >= reach * reach) return Math.max(0, hip.y - ankle.y);
    const need = hip.y - ankle.y - Math.sqrt(reach * reach - flat);
    return Math.max(0, need);
  }
}

export const V = (x = 0, y = 0, z = 0): THREE.Vector3 => new THREE.Vector3(x, y, z);
