import * as THREE from 'three';
import type { JointDef } from '../../content/rig';
import type { Body } from './body';

// Animation clips from a library (Meshy's, Quaternius', Mixamo's) retargeted onto a made body's rig,
// bone for bone: each of the clip's bones has one of our joints (the spine's three, the collarbones
// and the toes included: fit.ts gives a made body them all). Before anything plays, each joint's
// rest is turned to point the way its source bone points at rest (two T-poses are never quite the
// same); then at every moment the joint takes its source bone's turn away from rest. The body goes
// where the point between the source's hip joints goes, sized by leg length, and the clip's own
// travel across the ground is taken off, so the rules carry the body and the feet a clip plants are
// held where they stand (character.ts). Baked once, played by the pose code by the rules' frames
// (humanoid.ts). The same method shown against each clip's source: /retarget.html.

/** The bones a humanoid clip moves, by what they are. */
const CANON = [
  'hips', 'spine1', 'spine2', 'spine3', 'neck', 'head',
  'clavicleL', 'armL', 'forearmL', 'handL', 'clavicleR', 'armR', 'forearmR', 'handR',
  'thighL', 'shinL', 'footL', 'toeL', 'thighR', 'shinR', 'footR', 'toeR',
] as const;
export type Canon = (typeof CANON)[number];

/** Our rig's joint for each. */
export const JOINT: Record<Canon, string> = {
  hips: 'hips', spine1: 'torso', spine2: 'chest', spine3: 'upperChest', neck: 'neck', head: 'head',
  clavicleL: 'clavicleL', armL: 'armL', forearmL: 'elbowL', handL: 'handL',
  clavicleR: 'clavicleR', armR: 'armR', forearmR: 'elbowR', handR: 'handR',
  thighL: 'legL', shinL: 'kneeL', footL: 'footL', toeL: 'toeL', thighR: 'legR', shinR: 'kneeR', footR: 'footR', toeR: 'toeR',
};

/** The bone each one points at: their directions at rest are lined up, ours onto the source's. */
const NEXT: Partial<Record<Canon, Canon>> = {
  hips: 'spine1', spine1: 'spine2', spine2: 'spine3', spine3: 'neck', neck: 'head',
  clavicleL: 'armL', armL: 'forearmL', forearmL: 'handL', clavicleR: 'armR', armR: 'forearmR', forearmR: 'handR',
  thighL: 'shinL', shinL: 'footL', footL: 'toeL', thighR: 'shinR', shinR: 'footR', footR: 'toeR',
};

export interface Library {
  /** Each bone's name in the library's skeleton (as three loads it: Mixamo's colon dropped). */
  bones: Record<Canon, string>;
  /** A root bone that carries the clips across the ground, if the library has one. */
  root?: string;
  /** The right hand's index and little finger knuckles, where it has fingers: a held blade runs from the one past the other. */
  fist?: readonly [string, string];
}

const side = (l: string, r: string, f: (s: string) => string) => ({ [l]: f('L'), [r]: f('R') });

export const LIBRARIES: Record<'meshy' | 'quaternius' | 'mixamo', Library> = {
  meshy: {
    bones: {
      hips: 'Hips', spine1: 'Spine02', spine2: 'Spine01', spine3: 'Spine', neck: 'neck', head: 'Head',
      ...side('clavicleL', 'clavicleR', (s) => `${s === 'L' ? 'Left' : 'Right'}Shoulder`),
      ...side('armL', 'armR', (s) => `${s === 'L' ? 'Left' : 'Right'}Arm`),
      ...side('forearmL', 'forearmR', (s) => `${s === 'L' ? 'Left' : 'Right'}ForeArm`),
      ...side('handL', 'handR', (s) => `${s === 'L' ? 'Left' : 'Right'}Hand`),
      ...side('thighL', 'thighR', (s) => `${s === 'L' ? 'Left' : 'Right'}UpLeg`),
      ...side('shinL', 'shinR', (s) => `${s === 'L' ? 'Left' : 'Right'}Leg`),
      ...side('footL', 'footR', (s) => `${s === 'L' ? 'Left' : 'Right'}Foot`),
      ...side('toeL', 'toeR', (s) => `${s === 'L' ? 'Left' : 'Right'}ToeBase`),
    } as Record<Canon, string>,
  },
  quaternius: {
    bones: {
      hips: 'pelvis', spine1: 'spine_01', spine2: 'spine_02', spine3: 'spine_03', neck: 'neck_01', head: 'Head',
      ...side('clavicleL', 'clavicleR', (s) => `clavicle_${s.toLowerCase()}`),
      ...side('armL', 'armR', (s) => `upperarm_${s.toLowerCase()}`),
      ...side('forearmL', 'forearmR', (s) => `lowerarm_${s.toLowerCase()}`),
      ...side('handL', 'handR', (s) => `hand_${s.toLowerCase()}`),
      ...side('thighL', 'thighR', (s) => `thigh_${s.toLowerCase()}`),
      ...side('shinL', 'shinR', (s) => `calf_${s.toLowerCase()}`),
      ...side('footL', 'footR', (s) => `foot_${s.toLowerCase()}`),
      ...side('toeL', 'toeR', (s) => `ball_${s.toLowerCase()}`),
    } as Record<Canon, string>,
    root: 'root',
    fist: ['index_01_r', 'pinky_01_r'],
  },
  mixamo: {
    bones: {
      hips: 'mixamorigHips', spine1: 'mixamorigSpine', spine2: 'mixamorigSpine1', spine3: 'mixamorigSpine2', neck: 'mixamorigNeck', head: 'mixamorigHead',
      ...side('clavicleL', 'clavicleR', (s) => `mixamorig${s === 'L' ? 'Left' : 'Right'}Shoulder`),
      ...side('armL', 'armR', (s) => `mixamorig${s === 'L' ? 'Left' : 'Right'}Arm`),
      ...side('forearmL', 'forearmR', (s) => `mixamorig${s === 'L' ? 'Left' : 'Right'}ForeArm`),
      ...side('handL', 'handR', (s) => `mixamorig${s === 'L' ? 'Left' : 'Right'}Hand`),
      ...side('thighL', 'thighR', (s) => `mixamorig${s === 'L' ? 'Left' : 'Right'}UpLeg`),
      ...side('shinL', 'shinR', (s) => `mixamorig${s === 'L' ? 'Left' : 'Right'}Leg`),
      ...side('footL', 'footR', (s) => `mixamorig${s === 'L' ? 'Left' : 'Right'}Foot`),
      ...side('toeL', 'toeR', (s) => `mixamorig${s === 'L' ? 'Left' : 'Right'}ToeBase`),
    } as Record<Canon, string>,
    fist: ['mixamorigRightHandIndex1', 'mixamorigRightHandPinky1'],
  },
};

/** Which library a skeleton comes from, by its hips' name. */
export function libraryOf(scene: THREE.Object3D): Library {
  const names = new Set<string>();
  scene.traverse((o) => names.add(o.name));
  const found = Object.values(LIBRARIES).find((l) => names.has(l.bones.hips));
  if (!found) throw new Error(`retarget: a skeleton no library names (${[...names].slice(0, 12).join(', ')}...)`);
  return found;
}

/** A piece of a clip: all of it, or from and to (seconds). */
export interface ClipPart {
  clip: string;
  from?: number;
  to?: number;
}

/** One strike in a baked clip, seconds: the piece it plays, and where its strike starts and ends. */
export interface Strike {
  from: number;
  to: number;
  start: number;
  end: number;
}

/** A clip baked for one rig. */
export interface Baked {
  /** Our joints it turns, in rig order (parents first); every joint between them is left unturned. */
  joints: string[];
  frames: number;
  seconds: number;
  /** frames x joints x 4: each joint's local turn, its nearest turned ancestor's frame. */
  turns: Float32Array;
  /** frames x 3: where the body joint goes, model space (the clip's travel taken off). */
  body: Float32Array;
  /**
   * frames x 3: where the torso goes on the body joint. A clip's spine grows from its pelvis, so it
   * swings with the pelvis; ours hangs from the body joint (the pose code turns the hips under a
   * torso that stays put), so playing a clip puts it where the pelvis would carry it.
   */
  torso: Float32Array;
  /** frames x 3: which way a weapon in the right fist points, and its edge leads, model space. */
  blade: Float32Array;
  edge: Float32Array;
  /** frames x 2: whether each foot (left, right) is planted, its ball still on the ground. */
  planted: Uint8Array;
  /** The strikes, in order (by the right hand's speed). */
  strikes: Strike[];
}

/** The rig a clip is baked for: its joints and their turns in its T-pose (Fitted.bind). */
export interface Target {
  joints: readonly JointDef[];
  bind: Map<string, THREE.Quaternion>;
}

export const RATE = 60;
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();

/**
 * Bakes clips, end to end, for a rig. `scene` is the library's skeleton at rest (its T-pose) and
 * `clips` its animations; `strikes` how many strikes to look for in the whole.
 */
export function bake(scene: THREE.Object3D, clips: readonly THREE.AnimationClip[], parts: readonly ClipPart[], target: Target, strikes = 1): Baked {
  const lib = libraryOf(scene);
  scene.updateMatrixWorld(true);
  const named = new Map<string, THREE.Object3D>();
  scene.traverse((o) => named.set(o.name, o));
  const bone = {} as Record<Canon, THREE.Object3D>;
  for (const c of CANON) {
    const o = named.get(lib.bones[c]);
    if (!o) throw new Error(`retarget: no ${lib.bones[c]} in the skeleton`);
    bone[c] = o;
  }
  const root = lib.root ? named.get(lib.root) : undefined;
  const at = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

  // Our rig in its T-pose: every joint's turn and place, model space.
  const byName = new Map(target.joints.map((j) => [j.name, j]));
  const ourQ = new Map<string, THREE.Quaternion>();
  const ourP = new Map<string, THREE.Vector3>();
  for (const j of target.joints) {
    const pq = (j.parent && ourQ.get(j.parent)) || new THREE.Quaternion();
    const pp = (j.parent && ourP.get(j.parent)) || new THREE.Vector3();
    ourQ.set(j.name, pq.clone().multiply(target.bind.get(j.name) ?? new THREE.Quaternion()));
    ourP.set(j.name, new THREE.Vector3(...(j.pos ?? [0, 0, 0])).applyQuaternion(pq).add(pp));
  }
  for (const c of CANON) if (!byName.has(JOINT[c])) throw new Error(`retarget: the rig has no ${JOINT[c]}`);

  // The source at rest, and each of our joints' rest turned to point as its bone does.
  const srcQ = {} as Record<Canon, THREE.Quaternion>;
  const srcP = {} as Record<Canon, THREE.Vector3>;
  for (const c of CANON) {
    srcQ[c] = bone[c].getWorldQuaternion(new THREE.Quaternion());
    srcP[c] = at(bone[c]);
  }
  const rest = {} as Record<Canon, THREE.Quaternion>;
  for (const c of CANON) {
    const n = NEXT[c];
    const turn = new THREE.Quaternion();
    if (n) turn.setFromUnitVectors(ourP.get(JOINT[n])!.clone().sub(ourP.get(JOINT[c])!).normalize(), srcP[n].clone().sub(srcP[c]).normalize());
    rest[c] = turn.multiply(ourQ.get(JOINT[c])!);
  }
  const leg = (p: (c: Canon) => THREE.Vector3) => p('thighL').distanceTo(p('shinL')) + p('shinL').distanceTo(p('footL'));
  const k = leg((c) => ourP.get(JOINT[c])!) / leg((c) => srcP[c]);
  const mid = (a: THREE.Vector3, b: THREE.Vector3) => a.clone().add(b).multiplyScalar(0.5);
  const srcMidRest = mid(srcP.thighL, srcP.thighR);
  const ourMidRest = mid(ourP.get('legL')!, ourP.get('legR')!);
  // The point between our hip joints, in the hips' frame, and the hips' place under the body joint.
  const hipsLocal = new THREE.Vector3(...(byName.get('hips')!.pos ?? [0, 0, 0]));
  const midInHips = mid(new THREE.Vector3(...(byName.get('legL')!.pos ?? [0, 0, 0])), new THREE.Vector3(...(byName.get('legR')!.pos ?? [0, 0, 0])));
  // The torso, from the hips, in their T-pose frame.
  const torsoFromHips = ourP.get('torso')!.clone().sub(ourP.get('hips')!).applyQuaternion(ourQ.get('hips')!.clone().invert());
  // A held blade at rest: through the fist from the little finger's knuckle past the index's (or,
  // a hand with no fingers in a T-pose, straight ahead); its edge leads the way the knuckles face.
  const restRoot = root ? root.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
  const fist = lib.fist?.map((n) => named.get(n));
  const bladeRest = fist && fist[0] && fist[1] ? at(fist[0]).sub(at(fist[1])).normalize() : new THREE.Vector3(0, 0, 1);
  const edgeRest = srcP.handR.clone().sub(srcP.forearmR);
  edgeRest.addScaledVector(bladeRest, -edgeRest.dot(bladeRest)).normalize();

  // The pieces, end to end.
  const pieces = parts.map((p) => {
    const clip = clips.find((c) => c.name === p.clip);
    if (!clip) throw new Error(`retarget: no clip ${p.clip} (${clips.map((c) => c.name).join(', ')})`);
    // Never quite the clip's end: a looping action wraps round to its start there.
    return { clip, from: p.from ?? 0, to: Math.min(p.to ?? clip.duration, clip.duration - 1e-4) };
  });
  const seconds = pieces.reduce((s, p) => s + p.to - p.from, 0);
  const frames = Math.max(2, Math.round(seconds * RATE) + 1);
  const dt = seconds / (frames - 1);

  const joints = target.joints.map((j) => j.name).filter((n) => CANON.some((c) => JOINT[c] === n));
  const canonOf = new Map(CANON.map((c) => [JOINT[c], c]));
  const parentOf = new Map(target.joints.map((j) => [j.name, j.parent]));
  const turns = new Float32Array(frames * joints.length * 4);
  const body = new Float32Array(frames * 3);
  const torso = new Float32Array(frames * 3);
  const blade = new Float32Array(frames * 3);
  const edge = new Float32Array(frames * 3);
  const planted = new Uint8Array(frames * 2);
  const speed = new Float32Array(frames);
  const feetMid = new Float32Array(frames * 2);
  const mids = new Float32Array(frames * 3);
  const hipsTurn: THREE.Quaternion[] = [];
  const balls = [bone.toeL, bone.toeR];
  const ballRest = [srcP.toeL.y, srcP.toeR.y];
  const lastBall = [new THREE.Vector3(), new THREE.Vector3()];
  const lastHand = new THREE.Vector3();
  const mixer = new THREE.AnimationMixer(scene);
  let current: THREE.AnimationClip | null = null;
  const world = new Map<string, THREE.Quaternion>();
  const unturn = new THREE.Quaternion();
  const rootAt = new THREE.Vector3();
  for (let f = 0; f < frames; f++) {
    let s = f * dt;
    let i = 0;
    while (i < pieces.length - 1 && s > pieces[i].to - pieces[i].from) {
      s -= pieces[i].to - pieces[i].from;
      i++;
    }
    const piece = pieces[i];
    if (piece.clip !== current) {
      mixer.stopAllAction();
      mixer.clipAction(piece.clip).play();
      current = piece.clip;
    }
    mixer.setTime(Math.min(piece.to, piece.from + s));
    scene.updateMatrixWorld(true);
    // The root's turn away from its rest is taken off everything: the rules turn the body.
    if (root) unturn.copy(restRoot).multiply(root.getWorldQuaternion(_q).invert());
    world.clear();
    joints.forEach((name, n) => {
      const c = canonOf.get(name)!;
      const w = _q.copy(unturn).multiply(bone[c].getWorldQuaternion(_q2)).multiply(_q2.copy(srcQ[c]).invert()).multiply(rest[c]);
      world.set(name, w.clone());
      let up = parentOf.get(name);
      while (up && !world.has(up)) up = parentOf.get(up);
      (up ? world.get(up)!.clone().invert().multiply(w) : w).toArray(turns, (f * joints.length + n) * 4);
    });
    hipsTurn.push(world.get('hips')!);
    // Where the source's hip joints are, and its feet, measured from its root (or, a library with
    // no root bone, from the ground under the middle of its feet, smoothed below).
    if (root) root.getWorldPosition(rootAt).setY(0);
    const inRoot = (v: THREE.Vector3) => (root ? v.sub(rootAt).applyQuaternion(unturn) : v);
    inRoot(mid(at(bone.thighL), at(bone.thighR))).toArray(mids, f * 3);
    const fl = at(bone.footL);
    const fr = at(bone.footR);
    feetMid[f * 2] = (fl.x + fr.x) / 2;
    feetMid[f * 2 + 1] = (fl.z + fr.z) / 2;
    // A weapon in the right fist, as the source holds it.
    const turn = _q.copy(unturn).multiply(bone.handR.getWorldQuaternion(_q2)).multiply(_q2.copy(srcQ.handR).invert());
    _v.copy(bladeRest).applyQuaternion(turn).toArray(blade, f * 3);
    _v.copy(edgeRest).applyQuaternion(turn).toArray(edge, f * 3);
    const hand = inRoot(at(bone.handR));
    speed[f] = f ? lastHand.distanceTo(hand) / dt : 0;
    lastHand.copy(hand);
    // Planted: the ball of the foot on the ground and still in the world, the heel up or not.
    balls.forEach((b, j) => {
      const p = at(b);
      planted[f * 2 + j] = f > 0 && Math.hypot(p.x - lastBall[j].x, p.z - lastBall[j].z) / dt < 0.12 && p.y - ballRest[j] < 0.012 ? 1 : 0;
      lastBall[j].copy(p);
    });
  }
  mixer.stopAllAction();
  planted[0] = planted[2];
  planted[1] = planted[3];

  // A library with no root bone: its travel is the middle of its feet, smoothed over a third of a
  // second, so a lunge's step carries it while the hips still shift over the feet.
  if (!root) {
    const half = Math.round(RATE / 6);
    for (let f = 0; f < frames; f++) {
      let x = 0;
      let z = 0;
      let n = 0;
      for (let g = Math.max(0, f - half); g <= Math.min(frames - 1, f + half); g++, n++) {
        x += feetMid[g * 2];
        z += feetMid[g * 2 + 1];
      }
      mids[f * 3] -= x / n - feetMid[0];
      mids[f * 3 + 2] -= z / n - feetMid[1];
    }
  }
  // The body joint where it puts our hip joints' middle where the source's goes, sized by leg.
  for (let f = 0; f < frames; f++) {
    const want = _v.fromArray(mids, f * 3).sub(srcMidRest).multiplyScalar(k).add(ourMidRest);
    want.sub(hipsLocal).sub(midInHips.clone().applyQuaternion(hipsTurn[f])).toArray(body, f * 3);
    hipsLocal.clone().add(torsoFromHips.clone().applyQuaternion(hipsTurn[f])).toArray(torso, f * 3);
  }
  return { joints, frames, seconds, turns, body, torso, blade, edge, planted, strikes: findStrikes(speed, seconds, strikes) };
}

/**
 * The strikes in a clip: the right hand's fastest moments, `count` of them, apart. Each one plays
 * from where the hand is slowest before it to where it is slowest after it (the clip's ends for the
 * first and last); its strike is where the hand goes better than a third of its fastest.
 */
function findStrikes(speed: Float32Array, seconds: number, count: number): Strike[] {
  const n = speed.length;
  const at = (f: number) => (seconds * f) / (n - 1);
  const smooth = Float32Array.from(speed, (_, f) => (speed[Math.max(0, f - 1)] + speed[f] + speed[Math.min(n - 1, f + 1)]) / 3);
  // The peaks: local highs, the highest first, each at least a fifth of a second from another.
  const peaks: number[] = [];
  const order = Array.from({ length: n }, (_, f) => f).sort((a, b) => smooth[b] - smooth[a]);
  for (const f of order) {
    if (peaks.length === count) break;
    if (peaks.every((p) => Math.abs(p - f) > RATE / 5)) peaks.push(f);
  }
  peaks.sort((a, b) => a - b);
  const cuts = [0];
  for (let i = 1; i < peaks.length; i++) {
    let low = peaks[i - 1];
    for (let f = peaks[i - 1]; f <= peaks[i]; f++) if (smooth[f] < smooth[low]) low = f;
    cuts.push(low);
  }
  cuts.push(n - 1);
  return peaks.map((p, i) => {
    const fast = smooth[p] / 3;
    let a = p;
    while (a > cuts[i] && smooth[a - 1] > fast) a--;
    let b = p;
    while (b < cuts[i + 1] && smooth[b + 1] > fast) b++;
    return { from: at(cuts[i]), to: at(cuts[i + 1]), start: at(a), end: at(b) };
  });
}

// ---------- playing ----------

function moment(c: Baked, s: number): { f0: number; f1: number; k: number } {
  const u = (Math.min(Math.max(s, 0), c.seconds) / c.seconds) * (c.frames - 1);
  const f0 = Math.min(c.frames - 2, Math.floor(u));
  return { f0, f1: f0 + 1, k: u - f0 };
}

/** Turns the rig's joints as the clip has them at a moment (seconds), and every joint between them straight. */
export function playTurns(c: Baked, s: number, joint: (name: string) => THREE.Object3D): void {
  const { f0, f1, k } = moment(c, s);
  const n = c.joints.length;
  c.joints.forEach((name, i) => {
    _q.fromArray(c.turns, (f0 * n + i) * 4);
    joint(name).quaternion.copy(_q.slerp(_q2.fromArray(c.turns, (f1 * n + i) * 4), k));
  });
}

/** A per-moment vector of the clip (body, blade, edge) at a moment. */
export function playVector(c: Baked, channel: Float32Array, s: number, out: THREE.Vector3): THREE.Vector3 {
  const { f0, f1, k } = moment(c, s);
  out.fromArray(channel, f0 * 3);
  return out.lerp(_v.fromArray(channel, f1 * 3), k);
}

const _blade = new THREE.Vector3();
const _edge = new THREE.Vector3();
const _x = new THREE.Vector3();
const _c = new THREE.Vector3();
const _qh = new THREE.Quaternion();

/**
 * Poses a body as a clip has it at a moment: every joint the clip turns, the body where it puts the
 * hips, and the right hand turned so a weapon in its fist points where the clip's fist points one,
 * an edge leading where the knuckles do (either edge: a sword has two). The fingers close round it
 * after (fit.ts gripHands), as they do round any weapon held.
 */
export function poseFromClip(b: Body, c: Baked, s: number): void {
  playTurns(c, s, (name) => b.rig.joint(name));
  playVector(c, c.body, s, b.body.position);
  playVector(c, c.torso, s, b.torso.position);
  b.body.rotation.set(0, 0, 0);
  playVector(c, c.blade, s, _blade).normalize();
  b.aimHand('R', _blade);
  playVector(c, c.edge, s, _edge);
  _edge.addScaledVector(_blade, -_edge.dot(_blade)).normalize();
  _x.set(1, 0, 0).applyQuaternion(b.quaternionOf(b.arm.R.end, _qh));
  let roll = Math.atan2(_c.crossVectors(_x, _edge).dot(_blade), _x.dot(_edge));
  if (roll > Math.PI / 2) roll -= Math.PI;
  else if (roll < -Math.PI / 2) roll += Math.PI;
  b.aimHand('R', _blade, roll);
}

/** Whether a foot (0 left, 1 right) is planted at a moment. */
export function playPlanted(c: Baked, foot: number, s: number): boolean {
  const { f0, f1, k } = moment(c, s);
  return c.planted[(k < 0.5 ? f0 : f1) * 2 + foot] === 1;
}

/**
 * Where in a strike's clip a frame of the rules' swing falls (they time it: startup, active,
 * recovery). The clip's strike starts on the rules' first active frame and plays at its own pace,
 * up to half as fast again to fit their active frames; so most of its wind-up is left out, and its
 * recovery plays for as long as theirs lasts, the next state easing in after.
 */
export function strikeTime(st: Strike, startup: number, active: number, frame: number): number {
  const pace = THREE.MathUtils.clamp((st.end - st.start) / (Math.max(1, active) / RATE), 1, 1.5);
  return THREE.MathUtils.clamp(st.start + ((frame - startup) / RATE) * pace, st.from, st.to);
}
