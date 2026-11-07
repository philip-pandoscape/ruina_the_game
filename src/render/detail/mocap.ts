import * as THREE from 'three';
import type { JointDef, RigDef } from '../../content/rig';
import { jointFor } from './fit';
import type { Baked, Strike } from './retarget';

// A captured cycle - Meshy's walk or run, recorded on the made hero's own skeleton - baked for
// our rig: at evenly spaced moments through one stride, the turn of every joint it moves, and how
// high the hips ride. Read by stride phase, so it plays at whatever pace the hero goes; the feet
// are still planted by the gait planner (gait.ts), which knows the ground speed.

export interface Cycle {
  /** Our joints it moves, in rig order (parents first). */
  joints: string[];
  frames: number;
  /** frames x joints x 4: each joint's local turn (its parent's frame), as our rig poses it. */
  turns: Float32Array;
  /** frames: the hips' height over their height standing, metres. */
  lift: Float32Array;
  /** frames: the left and right ankles, height above the sole's floor and forward of the hips, metres. */
  ankles: Float32Array;
  /** Fraction of the clip at which the left foot is furthest forward, about to land: our phase 0. */
  offset: number;
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();

/**
 * Bakes a cycle. `scene` is the clip's armature, the same skeleton as the made body's; `joints`
 * are our rig's; `bind` our joints' local turns in that skeleton's rest pose (Fitted.bind);
 * `scale` takes the clip's metres to ours.
 */
export function bakeCycle(
  scene: THREE.Object3D,
  clip: THREE.AnimationClip,
  joints: readonly JointDef[],
  bind: Map<string, THREE.Quaternion>,
  scale: number,
  frames = 64,
): Cycle {
  // Which bone moves each of our joints: the first (highest) that maps to it, except the torso,
  // which follows the top of the spine (the bone the neck hangs from): our one torso joint turns
  // the chest the way the whole spine does.
  scene.updateMatrixWorld(true);
  const source = new Map<string, THREE.Object3D>();
  scene.traverse((o) => {
    if (!(o as THREE.Bone).isBone) return;
    const j = jointFor(o.name);
    if (j && !source.has(j)) source.set(j, o);
  });
  const neck = source.get('neck');
  if (neck?.parent && jointFor(neck.parent.name) === 'torso') source.set('torso', neck.parent);
  const hips = source.get('hips');
  const footL = source.get('footL');
  const footR = source.get('footR');
  if (!hips || !footL || !footR) throw new Error('mocap: the clip has no hips or feet');

  // Our joints' world turns in the rest pose: their bind turns composed down the tree.
  const bindWorld = new Map<string, THREE.Quaternion>();
  for (const j of joints) {
    const parent = (j.parent && bindWorld.get(j.parent)) || new THREE.Quaternion();
    bindWorld.set(j.name, parent.clone().multiply(bind.get(j.name) ?? new THREE.Quaternion()));
  }
  const driven = joints.filter((j) => source.has(j.name)).map((j) => j.name);
  const restWorld = new Map(driven.map((n) => [n, source.get(n)!.getWorldQuaternion(new THREE.Quaternion())]));
  const restHipsY = hips.getWorldPosition(new THREE.Vector3()).y;
  const floorY = Math.min(footL.getWorldPosition(new THREE.Vector3()).y, footR.getWorldPosition(new THREE.Vector3()).y);

  const mixer = new THREE.AnimationMixer(scene);
  mixer.clipAction(clip).play();
  const turns = new Float32Array(frames * driven.length * 4);
  const lift = new Float32Array(frames);
  const ankles = new Float32Array(frames * 4);
  const parentOf = new Map(joints.map((j) => [j.name, j.parent]));
  const target = new Map<string, THREE.Quaternion>();
  let offset = 0;
  let reach = -Infinity;
  for (let f = 0; f < frames; f++) {
    mixer.setTime((clip.duration * f) / frames);
    scene.updateMatrixWorld(true);
    target.clear();
    driven.forEach((name, i) => {
      // The bone's turn away from its rest, put on our joint's rest.
      const delta = source
        .get(name)!
        .getWorldQuaternion(_q)
        .multiply(_q2.copy(restWorld.get(name)!).invert());
      const world = delta.clone().multiply(bindWorld.get(name)!);
      target.set(name, world);
      // Local to the nearest driven ancestor; joints in between (the body) stay as the pose has them.
      let up = parentOf.get(name);
      while (up && !target.has(up)) up = parentOf.get(up);
      const local = up ? target.get(up)!.clone().invert().multiply(world) : world;
      local.toArray(turns, (f * driven.length + i) * 4);
    });
    const h = hips.getWorldPosition(_v);
    lift[f] = (h.y - restHipsY) * scale;
    const hz = h.z;
    const l = footL.getWorldPosition(new THREE.Vector3());
    const r = footR.getWorldPosition(new THREE.Vector3());
    ankles.set([(l.y - floorY) * scale, (l.z - hz) * scale, (r.y - floorY) * scale, (r.z - hz) * scale], f * 4);
    if (l.z - hz > reach) {
      reach = l.z - hz;
      offset = f / frames;
    }
  }
  mixer.stopAllAction();
  return { joints: driven, frames, turns, lift, ankles, offset };
}

/** A made body's captured motion, which the pose code reads by the rig it poses. */
export interface Motion {
  walk: Cycle;
  run: Cycle;
  /** Combo hits played from animation libraries' clips, by weapon id and hit ("sword:1"): moves.ts. */
  moves?: Map<string, Move>;
}

/** A combo hit played from a clip: the clip, baked for the body (retarget.ts), and its strike. */
export interface Move {
  clip: Baked;
  strike: Strike;
}

const motions = new WeakMap<RigDef, Motion>();

export function setMotion(def: RigDef, m: Motion): void {
  motions.set(def, m);
}

export const motionOf = (def: RigDef): Motion | undefined => motions.get(def);

/** One joint's turn in the cycle at a stride phase (identity for a joint it doesn't move). */
export function cycleTurn(c: Cycle, joint: string, phase: number, out: THREE.Quaternion): THREE.Quaternion {
  const i = c.joints.indexOf(joint);
  if (i < 0) return out.identity();
  const u = ((((phase / (Math.PI * 2) + c.offset) % 1) + 1) % 1) * c.frames;
  const f0 = Math.floor(u) % c.frames;
  const f1 = (f0 + 1) % c.frames;
  const n = c.joints.length;
  out.fromArray(c.turns, (f0 * n + i) * 4);
  return out.slerp(_q2.fromArray(c.turns, (f1 * n + i) * 4), u - Math.floor(u));
}
