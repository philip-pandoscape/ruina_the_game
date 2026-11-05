import * as THREE from 'three';
import type { JointDef } from '../../content/rig';
import { jointFor } from './fit';

// Swings from an animation library (Quaternius' Universal Animation Library, CC0), baked for a made
// body's rig: at evenly spaced moments, the turn of every joint of the upper body, where the hips
// carry the weight, which way the weapon points and its edge leads (read off the sword hand's
// fist), where the feet stand and whether they are planted, and how near the other hand comes to
// the grip. The pose code plays a take by the swing's own timeline (humanoid.ts), so the clip's
// wind-up and strike fall on the rules' frames however quick they are. The clips carry their root
// motion; everything is measured from the root as it goes, so the rules' lunge carries the body
// and a planted foot is held where it stands on the ground (character.ts), not where the clip's
// longer lunge would leave it.

export interface Take {
  /** Our joints it turns, in rig order (parents first). */
  joints: string[];
  frames: number;
  /** How long the take is, clip seconds. */
  seconds: number;
  /** frames x joints x 4: each joint's local turn (its nearest turned ancestor's frame). */
  turns: Float32Array;
  /** frames x 3: how far the hips are from where they stand at rest, metres. */
  hips: Float32Array;
  /** frames x 3: which way the weapon points from the hand, model space. */
  blade: Float32Array;
  /** frames x 3: which way its edge leads (the fist's knuckles), model space. */
  edge: Float32Array;
  /** frames: 0..1 how near the other hand comes to the grip, both hands on the weapon at 1. */
  both: Float32Array;
  /**
   * frames x 2 x FOOT (left, then right): the ankle over the ground (x, z), how far it is lifted
   * above where it stands, the foot's pitch (+ heel up) and yaw (+ to the left), and 1 while the
   * foot is planted: its ball still on the ground.
   */
  feet: Float32Array;
  /** Clip seconds where the wind-up ends and where the strike ends. */
  marks: readonly [number, number];
}

const FOOT = 6;

/** A piece of a clip: all of it, or from and to (seconds). */
export interface TakePart {
  clip: string;
  from?: number;
  to?: number;
}

/**
 * Which clips each swing plays, by weapon and combo hit ("weapon:hit"): the sword's three-hit combo
 * is the library's regular sword combo, each hit with its own recovery; the club's two are the first
 * and the last blows of its heavy combo. The rest (the whirlwind, a jump attack, the staff and the
 * bow) keep their keyframed swings (swings.ts).
 */
export const SWING_TAKES: Record<string, readonly TakePart[]> = {
  '0:0': [{ clip: 'Sword_Regular_A' }, { clip: 'Sword_Regular_A_Rec' }],
  '0:1': [{ clip: 'Sword_Regular_B' }, { clip: 'Sword_Regular_B_Rec' }],
  '0:2': [{ clip: 'Sword_Regular_C' }],
  '1:0': [{ clip: 'Sword_Heavy_Combo', to: 0.92 }],
  '1:1': [{ clip: 'Sword_Heavy_Combo', from: 2.25 }],
};

const RATE = 60;
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/**
 * Bakes a take. `scene` is the library's skeleton, at rest in a T-pose as the made body's model was
 * (Meshy rigs it in one); `joints` and `bind` are the made body's (Fitted.bind: our joints' turns in
 * that T-pose); `leg` our leg's length, hip to ankle, which sizes the library's moves to ours.
 */
export function bakeTake(scene: THREE.Object3D, clips: readonly THREE.AnimationClip[], parts: readonly TakePart[], joints: readonly JointDef[], bind: Map<string, THREE.Quaternion>, leg: number): Take {
  scene.updateMatrixWorld(true);
  const named = new Map<string, THREE.Object3D>();
  scene.traverse((o) => named.set(o.name, o));
  const need = (n: string) => {
    const o = named.get(n);
    if (!o) throw new Error(`take: the library's skeleton has no ${n}`);
    return o;
  };
  const at = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
  // Which bone turns each of our joints: the first (highest) that maps to it, but never the root
  // (it carries the walk across the ground, not the pelvis), and the torso follows the top of the
  // spine, the bone the neck hangs from, as the made body's walk does (mocap.ts). The legs are
  // reached for the feet (humanoid.ts), so they bend as ours must to stand where the take stands.
  const source = new Map<string, THREE.Object3D>();
  scene.traverse((o) => {
    if (o.name === 'root' || !(o as THREE.Bone).isBone) return;
    const j = jointFor(o.name);
    if (j && !source.has(j)) source.set(j, o);
  });
  const neck = source.get('neck');
  if (neck?.parent && jointFor(neck.parent.name) === 'torso') source.set('torso', neck.parent);
  const legJoints = new Set(['legL', 'kneeL', 'footL', 'legR', 'kneeR', 'footR']);
  const driven = joints.filter((j) => source.has(j.name) && !legJoints.has(j.name)).map((j) => j.name);

  const root = need('root');
  const pelvis = need('pelvis');
  const handR = need('hand_r');
  const handL = need('hand_l');
  const feet = [need('foot_l'), need('foot_r')];
  const balls = [need('ball_l'), need('ball_r')];
  // Sized by the legs: hip to knee to ankle, the library's against ours.
  const theirs = at(need('thigh_l')).distanceTo(at(need('calf_l'))) + at(need('calf_l')).distanceTo(at(feet[0]));
  const scale = leg / theirs;

  // Our joints' world turns in the T-pose, and the library's bones' at rest.
  const bindWorld = new Map<string, THREE.Quaternion>();
  for (const j of joints) {
    const parent = (j.parent && bindWorld.get(j.parent)) || new THREE.Quaternion();
    bindWorld.set(j.name, parent.clone().multiply(bind.get(j.name) ?? new THREE.Quaternion()));
  }
  const restWorld = new Map(driven.map((n) => [n, source.get(n)!.getWorldQuaternion(new THREE.Quaternion())]));
  const restRoot = root.getWorldQuaternion(new THREE.Quaternion());
  const restPelvis = at(pelvis);
  const restAnkle = at(feet[0]).y;
  const restBall = at(balls[0]).y;
  // The foot's slope at rest, ankle down to the ball: pitch is measured from it.
  const restSlope = Math.atan2(at(feet[0]).y - at(balls[0]).y, at(balls[0]).setY(0).distanceTo(at(feet[0]).setY(0)));
  // The fist at rest: the weapon runs through it from the little finger's knuckle out past the
  // index finger's, and its edge leads the way the knuckles face (the hand's own length).
  const toHand = handR.getWorldQuaternion(new THREE.Quaternion()).invert();
  const bladeLocal = at(need('index_01_r')).sub(at(need('pinky_01_r'))).applyQuaternion(toHand).normalize();
  const edgeLocal = at(need('middle_01_r')).sub(at(handR)).applyQuaternion(toHand);
  edgeLocal.addScaledVector(bladeLocal, -edgeLocal.dot(bladeLocal)).normalize();

  const pieces = parts.map((p) => {
    const clip = clips.find((c) => c.name === p.clip);
    if (!clip) throw new Error(`take: no clip ${p.clip}`);
    const from = p.from ?? 0;
    // Never quite the clip's end: a looping action wraps round to its start there.
    const to = Math.min(p.to ?? clip.duration, clip.duration - 1e-4);
    return { clip, from, to };
  });
  const seconds = pieces.reduce((s, p) => s + p.to - p.from, 0);
  const frames = Math.max(2, Math.round(seconds * RATE) + 1);
  const dt = seconds / (frames - 1);
  const turns = new Float32Array(frames * driven.length * 4);
  const hips = new Float32Array(frames * 3);
  const blade = new Float32Array(frames * 3);
  const edge = new Float32Array(frames * 3);
  const both = new Float32Array(frames);
  const foot = new Float32Array(frames * 2 * FOOT);
  const speed = new Float32Array(frames);
  const parentOf = new Map(joints.map((j) => [j.name, j.parent]));
  const target = new Map<string, THREE.Quaternion>();
  const mixer = new THREE.AnimationMixer(scene);
  let current: THREE.AnimationClip | null = null;
  const lastHand = new THREE.Vector3();
  const lastBall = [new THREE.Vector3(), new THREE.Vector3()];
  // The root as it goes: where it is, and how far it has turned from its rest (taken off every
  // bone's turn and every direction, so the rules alone turn the body).
  const rootAt = new THREE.Vector3();
  const unturn = new THREE.Quaternion();
  const inRoot = (v: THREE.Vector3) => v.sub(rootAt).applyQuaternion(unturn);
  for (let f = 0; f < frames; f++) {
    // Which piece this moment falls in, and where in its clip.
    let s = f * dt;
    let k = 0;
    while (k < pieces.length - 1 && s > pieces[k].to - pieces[k].from) {
      s -= pieces[k].to - pieces[k].from;
      k++;
    }
    const piece = pieces[k];
    if (piece.clip !== current) {
      mixer.stopAllAction();
      mixer.clipAction(piece.clip).play();
      current = piece.clip;
    }
    mixer.setTime(Math.min(piece.to, piece.from + s));
    scene.updateMatrixWorld(true);
    root.getWorldPosition(rootAt);
    unturn.copy(restRoot).multiply(root.getWorldQuaternion(_q).invert());
    target.clear();
    driven.forEach((name, i) => {
      // The bone's turn away from its rest, put on our joint's rest; then local to the nearest
      // turned ancestor, so joints in between (the body) stay as the pose has them.
      const delta = _q.copy(unturn).multiply(source.get(name)!.getWorldQuaternion(_q2)).multiply(_q2.copy(restWorld.get(name)!).invert());
      const world = delta.clone().multiply(bindWorld.get(name)!);
      target.set(name, world);
      let up = parentOf.get(name);
      while (up && !target.has(up)) up = parentOf.get(up);
      const local = up ? target.get(up)!.clone().invert().multiply(world) : world;
      local.toArray(turns, (f * driven.length + i) * 4);
    });
    inRoot(pelvis.getWorldPosition(_v)).sub(restPelvis).multiplyScalar(scale).toArray(hips, f * 3);
    _q.copy(unturn).multiply(handR.getWorldQuaternion(_q2));
    _v.copy(bladeLocal).applyQuaternion(_q).toArray(blade, f * 3);
    _v.copy(edgeLocal).applyQuaternion(_q).toArray(edge, f * 3);
    const hand = inRoot(handR.getWorldPosition(_v2));
    both[f] = 1 - THREE.MathUtils.smoothstep(inRoot(handL.getWorldPosition(_v)).distanceTo(hand), 0.14, 0.26);
    speed[f] = f ? lastHand.distanceTo(hand) / dt : 0;
    lastHand.copy(hand);
    for (let i = 0; i < 2; i++) {
      const o = (f * 2 + i) * FOOT;
      // Planted: the ball of the foot on the ground and still there (in the world, as the root
      // moves on), whether or not the heel has come up.
      const ball = balls[i].getWorldPosition(_v2);
      const still = f > 0 && Math.hypot(ball.x - lastBall[i].x, ball.z - lastBall[i].z) / dt < 0.35;
      foot[o + 5] = still && ball.y - restBall < 0.03 ? 1 : 0;
      lastBall[i].copy(ball);
      const ankle = inRoot(feet[i].getWorldPosition(_v));
      const toe = inRoot(balls[i].getWorldPosition(_v2)).sub(ankle);
      foot[o] = ankle.x * scale;
      foot[o + 1] = ankle.z * scale;
      foot[o + 2] = (ankle.y - restAnkle) * scale;
      foot[o + 3] = Math.atan2(-toe.y, Math.hypot(toe.x, toe.z)) - restSlope;
      foot[o + 4] = Math.atan2(toe.x, toe.z);
    }
  }
  // The first moment's feet are planted as the next one's are (it has no moment before to compare).
  foot[5] = foot[2 * FOOT + 5];
  foot[FOOT + 5] = foot[3 * FOOT + 5];
  mixer.stopAllAction();
  return { joints: driven, frames, seconds, turns, hips, blade, edge, both, feet: foot, marks: strike(speed, seconds) };
}

/**
 * Where the strike is: the sword hand moving at better than a third of its fastest. Before that is
 * the wind-up, after it the recovery.
 */
function strike(speed: Float32Array, seconds: number): [number, number] {
  let peak = 0;
  for (let f = 1; f < speed.length; f++) if (speed[f] > speed[peak]) peak = f;
  const fast = speed[peak] / 3;
  let a = peak;
  while (a > 1 && speed[a - 1] > fast) a--;
  let b = peak;
  while (b < speed.length - 1 && speed[b + 1] > fast) b++;
  const at = (f: number) => (seconds * f) / (speed.length - 1);
  // The hand is a frame into the strike when it is first that fast.
  return [at(Math.max(0, a - 1)), at(b)];
}

/** A joint's turn in the take at a moment (identity for one it doesn't turn). */
export function takeTurn(t: Take, joint: string, s: number, out: THREE.Quaternion): THREE.Quaternion {
  const i = t.joints.indexOf(joint);
  if (i < 0) return out.identity();
  const { f0, f1, k } = moment(t, s);
  const n = t.joints.length;
  out.fromArray(t.turns, (f0 * n + i) * 4);
  return out.slerp(_q2.fromArray(t.turns, (f1 * n + i) * 4), k);
}

/** A per-frame vector channel of the take (hips, blade, edge) at a moment. */
export function takeVector(t: Take, channel: Float32Array, s: number, out: THREE.Vector3): THREE.Vector3 {
  const { f0, f1, k } = moment(t, s);
  out.fromArray(channel, f0 * 3);
  return out.lerp(_v.fromArray(channel, f1 * 3), k);
}

/** How two-handed the grip is at a moment. */
export function takeBoth(t: Take, s: number): number {
  const { f0, f1, k } = moment(t, s);
  return t.both[f0] * (1 - k) + t.both[f1] * k;
}

/** A foot (0 left, 1 right) at a moment: as Take.feet lays it out. */
export function takeFoot(t: Take, i: number, s: number): { x: number; z: number; lift: number; pitch: number; yaw: number; planted: boolean } {
  const { f0, f1, k } = moment(t, s);
  const a = (f0 * 2 + i) * FOOT;
  const b = (f1 * 2 + i) * FOOT;
  const mix = (j: number) => t.feet[a + j] * (1 - k) + t.feet[b + j] * k;
  return { x: mix(0), z: mix(1), lift: Math.max(0, mix(2)), pitch: mix(3), yaw: mix(4), planted: t.feet[k < 0.5 ? a + 5 : b + 5] > 0.5 };
}

function moment(t: Take, s: number): { f0: number; f1: number; k: number } {
  const u = (Math.min(Math.max(s, 0), t.seconds) / t.seconds) * (t.frames - 1);
  const f0 = Math.min(t.frames - 2, Math.floor(u));
  return { f0, f1: f0 + 1, k: u - f0 };
}
