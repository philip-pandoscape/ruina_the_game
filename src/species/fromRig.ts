import * as THREE from 'three';
import type { RigDef } from '../content/rig';
import { DetailRig } from '../render/detail/rig';
import { pose, type PoseInput } from '../content/pose';
import { writeMatrix } from './pose';
import { MAT, MATRIX_STRIDE, type Clip, type Joint, type ProxyBox, type SpeciesDef, type Quat, type Vec3 } from './types';

// Bakes a close-up creature into the crowd's content format. The poses are not rewritten for
// distance - they are run offscreen, a frame at a time, and the joint matrices they produce are
// what the crowd shader reads. One set of animations drives both renderers, so a creature cannot
// move one way up close and another way in a battle.

export interface ClipDriver {
  name: string;
  frames: number;
  fps?: number;
  loop?: boolean;
  /** What the creature is doing at `t` (0..1 through the clip). The rest stays neutral. */
  at(t: number, frame: number): Partial<PoseInput>;
}

export interface FromRigOptions {
  id: string;
  rig: RigDef;
  pose: (rig: DetailRig, input: PoseInput) => unknown;
  clips: ClipDriver[];
  /** Which carried item to build into the crowd body, if any. */
  weapon?: string;
  /** Rig palette key to crowd material slot, so team colours still read at a distance. */
  slots?: Record<string, number>;
}

/** A box around one part, in the species' bind space. */
function boxOf(mesh: THREE.Mesh, mat: number, color: number, joint: number): ProxyBox | null {
  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox;
  if (!bb) return null;
  const size = bb.getSize(new THREE.Vector3());
  if (size.x <= 0 || size.y <= 0 || size.z <= 0) return null;
  const centre = bb.getCenter(new THREE.Vector3());
  // matrixWorld is model space here, because the rig's root sits at the origin.
  const m = new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, new THREE.Matrix4().makeTranslation(centre.x, centre.y, centre.z));
  const t = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  m.decompose(t, q, s);
  return {
    joint,
    pos: [t.x, t.y, t.z] as Vec3,
    rot: [q.x, q.y, q.z, q.w] as Quat,
    size: [size.x * s.x, size.y * s.y, size.z * s.z] as Vec3,
    mat,
    color,
  };
}

export function speciesFromRig(o: FromRigOptions): SpeciesDef {
  const rig = new DetailRig(o.rig);
  rig.showAttachment(o.weapon ?? null);
  rig.root.updateMatrixWorld(true);

  const names = o.rig.joints.map((j) => j.name);
  const index = new Map(names.map((n, i) => [n, i]));
  const joints: Joint[] = o.rig.joints.map((j) => ({
    name: j.name,
    parent: j.parent !== undefined ? (index.get(j.parent) ?? -1) : -1,
    pos: j.pos ?? ([0, 0, 0] as Vec3),
    rot: [0, 0, 0, 1] as Quat,
  }));
  // The rig as built, before any posing, is the bind pose.
  const inverseBind = names.map((n) => new THREE.Matrix4().copy(rig.joint(n).matrixWorld).invert());

  const proxy: ProxyBox[] = [];
  for (const b of rig.built) {
    // Weapons that are not the one asked for are hidden, and so are not part of the body.
    let node: THREE.Object3D | null = b.mesh;
    let shown = true;
    while (node && node !== rig.root) {
      if (!node.visible) shown = false;
      node = node.parent;
    }
    if (!shown) continue;
    const box = boxOf(b.mesh, o.slots?.[b.mat] ?? MAT.fixed, o.rig.materials[b.mat]?.color ?? 0xffffff, index.get(b.joint) ?? 0);
    if (box) proxy.push(box);
  }

  const reset = () => {
    for (const j of o.rig.joints) {
      const g = rig.joint(j.name);
      g.position.set(...(j.pos ?? [0, 0, 0]));
      g.rotation.set(0, 0, 0);
      g.scale.set(1, 1, 1);
    }
  };

  const clips: Clip[] = o.clips.map((d) => {
    const matrices = new Float32Array(d.frames * joints.length * MATRIX_STRIDE);
    const m = new THREE.Matrix4();
    for (let f = 0; f < d.frames; f++) {
      // A looping clip never samples t = 1, or its last frame would repeat its first.
      const t = d.frames === 1 ? 0 : f / (d.loop === false ? d.frames - 1 : d.frames);
      reset();
      o.pose(rig, pose(d.at(t, f)));
      rig.root.updateMatrixWorld(true);
      for (let k = 0; k < names.length; k++) {
        m.multiplyMatrices(rig.joint(names[k]).matrixWorld, inverseBind[k]);
        writeMatrix(matrices, (f * names.length + k) * MATRIX_STRIDE, m);
      }
    }
    return { name: d.name, fps: d.fps ?? 30, loop: d.loop !== false, frames: d.frames, matrices };
  });

  reset();
  const bounds = new THREE.Box3().setFromObject(rig.root);
  return { id: o.id, height: Math.max(0.1, bounds.max.y), joints, proxy, clips };
}
