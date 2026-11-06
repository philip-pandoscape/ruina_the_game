import * as THREE from 'three';
import type { Bone, JointPose, Posable, Snapshot, Vec3 } from './types';

// Poses as data: reading a body's joints into a snapshot and back, keeping every node of a take
// frame by frame, and saying what changed between two poses in numbers someone can act on.

const DEG = 180 / Math.PI;
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();

export const r4 = (n: number): number => Math.round(n * 1e4) / 1e4;
export const r1 = (n: number): number => Math.round(n * 10) / 10;

export function readJoint(o: THREE.Object3D): JointPose {
  const p = o.position;
  const q = o.quaternion;
  const s = o.scale;
  return [p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z];
}

export function writeJoint(o: THREE.Object3D, j: JointPose): void {
  o.position.set(j[0], j[1], j[2]);
  o.quaternion.set(j[3], j[4], j[5], j[6]);
  o.scale.set(j[7], j[8], j[9]);
}

export function readBones(bones: readonly Bone[]): Record<string, JointPose> {
  const out: Record<string, JointPose> = {};
  for (const b of bones) out[b.name] = readJoint(b.object);
  return out;
}

export function writeBones(bones: readonly Bone[], joints: Record<string, JointPose>): void {
  for (const b of bones) {
    const j = joints[b.name];
    if (j) writeJoint(b.object, j);
  }
}

/** A snapshot rounded for storing (a tenth of a millimetre, quaternions to 1e-5). */
export function compact(s: Snapshot): Snapshot {
  const joints: Record<string, JointPose> = {};
  for (const [k, j] of Object.entries(s.joints)) joints[k] = j.map((v, i) => (i >= 3 && i < 7 ? Math.round(v * 1e6) / 1e6 : r4(v)));
  return { joints, extra: s.extra };
}

export const cloneSnapshot = (s: Snapshot): Snapshot => ({ joints: Object.fromEntries(Object.entries(s.joints).map(([k, j]) => [k, [...j]])), extra: s.extra ? { ...s.extra } : undefined });

/**
 * Every node under a root, kept frame by frame as flat numbers (position, quaternion, scale and
 * whether it's shown), so a take's frames can be shown again in any order. Nodes added later (a
 * weapon's trail, made the first time it swings) aren't kept: the take redraws those itself.
 */
export class NodeTrack {
  static readonly STRIDE = 11;
  readonly nodes: THREE.Object3D[] = [];

  constructor(root: THREE.Object3D) {
    root.traverse((o) => {
      if (o !== root) this.nodes.push(o);
    });
  }

  capture(): Float32Array {
    const out = new Float32Array(this.nodes.length * NodeTrack.STRIDE);
    this.nodes.forEach((o, i) => {
      const k = i * NodeTrack.STRIDE;
      out[k] = o.position.x;
      out[k + 1] = o.position.y;
      out[k + 2] = o.position.z;
      out[k + 3] = o.quaternion.x;
      out[k + 4] = o.quaternion.y;
      out[k + 5] = o.quaternion.z;
      out[k + 6] = o.quaternion.w;
      out[k + 7] = o.scale.x;
      out[k + 8] = o.scale.y;
      out[k + 9] = o.scale.z;
      out[k + 10] = o.visible ? 1 : 0;
    });
    return out;
  }

  apply(buf: Float32Array): void {
    this.nodes.forEach((o, i) => {
      const k = i * NodeTrack.STRIDE;
      o.position.set(buf[k], buf[k + 1], buf[k + 2]);
      o.quaternion.set(buf[k + 3], buf[k + 4], buf[k + 5], buf[k + 6]);
      o.scale.set(buf[k + 7], buf[k + 8], buf[k + 9]);
      o.visible = buf[k + 10] > 0.5;
    });
  }
}

/** Where every bone is in the body's own space (x to its left, y up, z ahead). */
export function modelPositions(body: Posable): Record<string, Vec3> {
  body.root.updateMatrixWorld(true);
  const inv = _m.copy(body.space.matrixWorld).invert();
  const out: Record<string, Vec3> = {};
  for (const b of body.bones) {
    // What isn't shown (the weapons not in hand) isn't anywhere worth saying.
    if (b.name.startsWith('@') && !shownAll(b.object)) continue;
    _v.setFromMatrixPosition(b.object.matrixWorld).applyMatrix4(inv);
    out[b.name] = [_v.x, _v.y, _v.z];
  }
  for (const pt of body.points ?? []) {
    const b = body.bones.find((x) => x.name === pt.bone);
    if (!b || !shownAll(b.object)) continue;
    _v.set(...pt.at).applyMatrix4(b.object.matrixWorld).applyMatrix4(inv);
    out[pt.name] = [_v.x, _v.y, _v.z];
  }
  return out;
}

function shownAll(o: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = o; n; n = n.parent) if (!n.visible) return false;
  return true;
}

/** Each bone's turn in the body's own space. */
export function modelTurns(body: Posable): Record<string, THREE.Quaternion> {
  body.root.updateMatrixWorld(true);
  const rootQ = body.space.getWorldQuaternion(new THREE.Quaternion()).invert();
  const out: Record<string, THREE.Quaternion> = {};
  for (const b of body.bones) out[b.name] = rootQ.clone().multiply(b.object.getWorldQuaternion(new THREE.Quaternion()));
  return out;
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

/** Degrees between two turns (stable for tiny angles, whatever their quaternions' lengths). */
export function angleBetween(a: THREE.Quaternion, b: THREE.Quaternion): number {
  const d = _qa.copy(a).normalize().invert().multiply(_qb.copy(b).normalize());
  return 2 * Math.atan2(Math.hypot(d.x, d.y, d.z), Math.abs(d.w)) * DEG;
}

export const quatOf = (j: JointPose, out = new THREE.Quaternion()): THREE.Quaternion => out.set(j[3], j[4], j[5], j[6]).normalize();

/** Euler angles (degrees, XYZ order as three uses them) of a joint's local turn. */
export function eulerDeg(j: JointPose): Vec3 {
  _e.setFromQuaternion(quatOf(j, _q), 'XYZ');
  return [_e.x * DEG, _e.y * DEG, _e.z * DEG];
}

/** One bone's change between two poses. */
export interface BoneChange {
  bone: string;
  /** Local turn before and after, Euler XYZ degrees, and how far it turned. */
  before: Vec3;
  after: Vec3;
  turned: number;
  /** The extra turn, about an axis in the parent's space (unit), degrees. */
  axis: Vec3;
  /** How far the joint itself was moved (metres, parent's space), if it was. */
  moved: Vec3 | null;
  scaled: Vec3 | null;
}

/** The bones whose local transform differs between two snapshots, biggest change first. */
export function boneChanges(before: Snapshot, after: Snapshot, minDeg = 0.2, minMove = 0.0005): BoneChange[] {
  const out: BoneChange[] = [];
  for (const [name, a] of Object.entries(after.joints)) {
    const b = before.joints[name];
    if (!b) continue;
    const qa = quatOf(b, _q);
    const qb = quatOf(a, _q2);
    const turned = angleBetween(qa, qb);
    const dp: Vec3 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const moved = Math.hypot(...dp) > minMove ? dp : null;
    const ds: Vec3 = [a[7] / (b[7] || 1), a[8] / (b[8] || 1), a[9] / (b[9] || 1)];
    const scaled = ds.some((v) => Math.abs(v - 1) > 0.002) ? ds : null;
    if (turned < minDeg && !moved && !scaled) continue;
    // The extra turn applied on top of the old one, in the parent's space: after = delta * before.
    const delta = qb.clone().multiply(qa.clone().invert());
    if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
    const s = Math.sqrt(Math.max(0, 1 - delta.w * delta.w));
    const axis: Vec3 = s > 1e-6 ? [delta.x / s, delta.y / s, delta.z / s] : [0, 0, 0];
    out.push({ bone: name, before: eulerDeg(b), after: eulerDeg(a), turned, axis, moved, scaled });
  }
  return out.sort((x, y) => y.turned - x.turned);
}

/** Words for a direction in a body's own space: which way +x, +y, +z go. */
export function directionWords(d: Vec3, minimum = 0.004): string {
  const parts: string[] = [];
  const say = (v: number, pos: string, neg: string) => {
    if (Math.abs(v) >= minimum) parts.push(`${(Math.abs(v) * 100).toFixed(1)} cm ${v > 0 ? pos : neg}`);
  };
  say(d[1], 'up', 'down');
  say(d[2], 'forward', 'back');
  say(d[0], "to the body's left", "to the body's right");
  return parts.join(', ') || 'no move';
}

export const fmt3 = (v: Vec3, digits = 1): string => v.map((n) => n.toFixed(digits)).join(', ');

/** A small helper for colouring the skeleton: which side a joint is on, by its name. */
export function sideOf(name: string): 'L' | 'R' | 'C' {
  if (/(^|[a-z])L\d*$/.test(name) || /\.L$|_L$|Left/.test(name)) return 'L';
  if (/(^|[a-z])R\d*$/.test(name) || /\.R$|_R$|Right/.test(name)) return 'R';
  return 'C';
}
