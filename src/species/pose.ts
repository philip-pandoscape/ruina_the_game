import * as THREE from 'three';
import { MATRIX_STRIDE, totalFrames, type Clip, type Joint, type SpeciesDef, type Quat, type Vec3 } from './types';

// Clips are baked down to one model-space matrix per joint per frame, with the inverse bind
// already folded in, and uploaded as a texture. The crowd then poses a vertex with a single
// fetch and a single multiply, whatever the skeleton happens to look like.

const SCRATCH = new THREE.Matrix4();

/** Writes a 3x4 row-major block into a baked clip's buffer. */
export function writeMatrix(out: Float32Array, at: number, m: THREE.Matrix4): void {
  const e = m.elements; // three stores column-major
  out[at + 0] = e[0]; out[at + 1] = e[4]; out[at + 2] = e[8]; out[at + 3] = e[12];
  out[at + 4] = e[1]; out[at + 5] = e[5]; out[at + 6] = e[9]; out[at + 7] = e[13];
  out[at + 8] = e[2]; out[at + 9] = e[6]; out[at + 10] = e[10]; out[at + 11] = e[14];
}

export interface LocalPose {
  pos?: Vec3;
  rot?: Quat;
  scale?: Vec3;
}

/** Bind-pose world transform of every joint, by walking the hierarchy once. */
export function bindWorlds(joints: readonly Joint[]): THREE.Matrix4[] {
  const out: THREE.Matrix4[] = [];
  joints.forEach((j, i) => {
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(...j.pos),
      new THREE.Quaternion(...j.rot),
      new THREE.Vector3(1, 1, 1),
    );
    out[i] = j.parent >= 0 ? new THREE.Matrix4().multiplyMatrices(out[j.parent], local) : local;
  });
  return out;
}

/**
 * Bakes a clip for a species whose animation is authored rather than imported: `pose` returns a
 * joint's local offset from its bind pose for a given frame. This is the path a slime, a
 * tentacle or anything else without a motion library takes.
 */
export function bakeAuthored(
  joints: readonly Joint[],
  meta: { name: string; frames: number; fps?: number; loop?: boolean },
  pose: (joint: number, frame: number, name: string) => LocalPose | undefined,
): Clip {
  const n = joints.length;
  const bind = bindWorlds(joints);
  const inverseBind = bind.map((m) => new THREE.Matrix4().copy(m).invert());
  const matrices = new Float32Array(meta.frames * n * MATRIX_STRIDE);
  const world: THREE.Matrix4[] = [];
  for (let f = 0; f < meta.frames; f++) {
    for (let i = 0; i < n; i++) {
      const j = joints[i];
      const p = pose(i, f, j.name) ?? {};
      const local = new THREE.Matrix4().compose(
        new THREE.Vector3(...(p.pos ?? j.pos)),
        new THREE.Quaternion(...(p.rot ?? j.rot)),
        new THREE.Vector3(...(p.scale ?? [1, 1, 1])),
      );
      world[i] = j.parent >= 0 ? new THREE.Matrix4().multiplyMatrices(world[j.parent], local) : local;
      writeMatrix(matrices, (f * n + i) * MATRIX_STRIDE, SCRATCH.multiplyMatrices(world[i], inverseBind[i]));
    }
  }
  return { name: meta.name, fps: meta.fps ?? 30, loop: meta.loop ?? true, frames: meta.frames, matrices };
}

/**
 * Bakes an imported clip by stepping a mixer and reading the bones, so whatever the source rig
 * does - translation, scale, a hips track - lands in the matrices without being interpreted.
 */
export function bakeImported(
  mesh: THREE.SkinnedMesh,
  rigRoot: THREE.Object3D,
  source: THREE.AnimationClip,
  boneOfJoint: readonly number[],
  opts: { fps?: number; loop?: boolean; scale?: number; name?: string } = {},
): Clip {
  const fps = opts.fps ?? 30;
  const scale = opts.scale ?? 1;
  const frames = Math.max(1, Math.round(source.duration * fps));
  const n = boneOfJoint.length;
  const skel = mesh.skeleton;
  const S = new THREE.Matrix4().makeScale(scale, scale, scale);
  const Sinv = new THREE.Matrix4().makeScale(1 / scale, 1 / scale, 1 / scale);
  const matrices = new Float32Array(frames * n * MATRIX_STRIDE);
  const mixer = new THREE.AnimationMixer(rigRoot);
  const action = mixer.clipAction(source);
  action.play();
  const m = new THREE.Matrix4();
  for (let f = 0; f < frames; f++) {
    mixer.setTime(0);
    mixer.update((f / fps) % Math.max(source.duration, 1e-6));
    rigRoot.updateMatrixWorld(true);
    for (let i = 0; i < n; i++) {
      const b = boneOfJoint[i];
      m.multiplyMatrices(mesh.bindMatrixInverse, skel.bones[b].matrixWorld)
        .multiply(skel.boneInverses[b])
        .multiply(mesh.bindMatrix);
      writeMatrix(matrices, (f * n + i) * MATRIX_STRIDE, SCRATCH.multiplyMatrices(S, m).multiply(Sinv));
    }
  }
  action.stop();
  return { name: opts.name ?? source.name, fps, loop: opts.loop ?? true, frames, matrices };
}

/** A one-frame clip that holds the bind pose: every joint's matrix is the identity. */
export function restClip(jointCount: number, name = 'rest'): Clip {
  const matrices = new Float32Array(jointCount * MATRIX_STRIDE);
  for (let i = 0; i < jointCount; i++) {
    const at = i * MATRIX_STRIDE;
    matrices[at] = 1;
    matrices[at + 5] = 1;
    matrices[at + 10] = 1;
  }
  return { name, fps: 30, loop: true, frames: 1, matrices };
}

export interface PoseTexture {
  texture: THREE.DataTexture;
  /** Row each clip starts on, in clip order. */
  rows: number[];
  width: number;
  height: number;
}

/**
 * Packs every clip into one float texture: three texels per joint across, one row per frame
 * down. Joint count only ever changes the width, which is why a four-joint slime and a
 * fifty-joint rig go through the same renderer.
 */
export function buildPoseTexture(species: SpeciesDef): PoseTexture {
  const n = species.joints.length;
  const width = n * 3;
  const height = Math.max(1, totalFrames(species));
  const data = new Float32Array(width * height * 4);
  const rows: number[] = [];
  let row = 0;
  for (const clip of species.clips) {
    rows.push(row);
    for (let f = 0; f < clip.frames; f++, row++) {
      for (let j = 0; j < n; j++) {
        const from = (f * n + j) * MATRIX_STRIDE;
        const to = (row * width + j * 3) * 4;
        for (let k = 0; k < MATRIX_STRIDE; k++) data[to + k] = clip.matrices[from + k];
      }
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, rows, width, height };
}
