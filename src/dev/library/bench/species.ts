import * as THREE from 'three';
import { SpeciesCrowd } from '../../../render/creatures/crowd';
import { bindWorlds } from '../../../render/creatures/clips';
import { getSpecies } from '../../../render/creatures/registry';
import { MATRIX_STRIDE, clipByName, type SpeciesDef } from '../../../render/creatures/species';
import { HERO_CLIPS, HERO_RIG } from '../../../render/creatures/heroBody';
import { pose } from '../../../content/pose';
import { poseHumanoid } from '../../../render/detail/humanoid';
import { DetailRig } from '../../../render/detail/rig';

// A species measured from its baked clips (src/species/): what it is made of, where its joints and
// its boxes are on any frame of any clip, and the close-up poses a clip was baked from, to hold the
// two together. Pure data, no drawing: the unit tier checks every species with it
// (tests/unit/species.test.ts), and the library's crowd bench offers the same numbers
// (galleries/crowds.ts).

export interface SpeciesInfo {
  id: string;
  joints: number;
  jointNames: string[];
  boxes: number;
  /** Per body, as the crowd draws it. */
  triangles: number;
  height: number;
  clips: Array<{ name: string; frames: number; fps: number; loop: boolean }>;
}

/** What a species is made of, its triangles counted on the crowd's own geometry. */
export function speciesInfo(id: string, crowd?: SpeciesCrowd): SpeciesInfo {
  const def = getSpecies(id);
  const own = crowd ?? new SpeciesCrowd(def, 1);
  const info = {
    id,
    joints: def.joints.length,
    jointNames: def.joints.map((j) => j.name),
    boxes: def.proxy.length,
    triangles: own.trianglesPerInstance,
    height: +def.height.toFixed(4),
    clips: def.clips.map((c) => ({ name: c.name, frames: c.frames, fps: c.fps, loop: c.loop })),
  };
  if (!crowd) own.dispose();
  return info;
}

function clipOf(def: SpeciesDef, clipName: string) {
  const clip = clipByName(def, clipName);
  if (!clip) throw new Error(`species ${def.id} has no clip "${clipName}"`);
  return clip;
}

/** Model-space translation of every joint on a given frame, straight out of the baked clip. */
export function jointPositions(def: SpeciesDef, clipName: string, frame: number): number[][] {
  const clip = clipOf(def, clipName);
  const f = Math.max(0, Math.min(frame, clip.frames - 1));
  const n = def.joints.length;
  const out: number[][] = [];
  for (let j = 0; j < n; j++) {
    const at = (f * n + j) * MATRIX_STRIDE;
    // The pose matrix maps bind space to posed space; the bind-space joint origin rides with it.
    out.push([clip.matrices[at + 3], clip.matrices[at + 7], clip.matrices[at + 11]].map((x) => +x.toFixed(4)));
  }
  return out;
}

/** Where the proxy's corners end up on a frame: the silhouette a test can assert on. */
export function posedBounds(def: SpeciesDef, clipName: string, frame: number): { min: number[]; max: number[]; size: number[] } {
  const clip = clipOf(def, clipName);
  const f = Math.max(0, Math.min(frame, clip.frames - 1));
  const n = def.joints.length;
  const box = new THREE.Box3();
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  for (const b of def.proxy) {
    const at = (f * n + b.joint) * MATRIX_STRIDE;
    const e = clip.matrices;
    m.set(e[at + 0], e[at + 1], e[at + 2], e[at + 3], e[at + 4], e[at + 5], e[at + 6], e[at + 7], e[at + 8], e[at + 9], e[at + 10], e[at + 11], 0, 0, 0, 1);
    const q = new THREE.Quaternion(...b.rot);
    for (let c = 0; c < 8; c++) {
      v.set((c & 1 ? 0.5 : -0.5) * b.size[0], (c & 2 ? 0.5 : -0.5) * b.size[1], (c & 4 ? 0.5 : -0.5) * b.size[2])
        .applyQuaternion(q)
        .add(new THREE.Vector3(...b.pos))
        .applyMatrix4(m);
      box.expandByPoint(v);
    }
  }
  const size = box.getSize(new THREE.Vector3());
  return {
    min: [box.min.x, box.min.y, box.min.z].map((x) => +x.toFixed(4)),
    max: [box.max.x, box.max.y, box.max.z].map((x) => +x.toFixed(4)),
    size: [size.x, size.y, size.z].map((x) => +x.toFixed(4)),
  };
}

/**
 * Where each joint actually ends up on a frame, in world metres. This is the number a species test
 * asserts on: a foot that should be planted, a slime's crown that should dip when it lands.
 */
export function jointWorld(def: SpeciesDef, clipName: string, frame: number): number[][] {
  const clip = clipOf(def, clipName);
  const f = Math.max(0, Math.min(frame, clip.frames - 1));
  const n = def.joints.length;
  const bind = bindWorlds(def.joints);
  const e = clip.matrices;
  return bind.map((b, j) => {
    const at = (f * n + j) * MATRIX_STRIDE;
    const p = new THREE.Vector3().setFromMatrixPosition(b);
    return [
      e[at + 0] * p.x + e[at + 1] * p.y + e[at + 2] * p.z + e[at + 3],
      e[at + 4] * p.x + e[at + 5] * p.y + e[at + 6] * p.z + e[at + 7],
      e[at + 8] * p.x + e[at + 9] * p.y + e[at + 10] * p.z + e[at + 11],
    ].map((x) => +x.toFixed(4));
  });
}

/**
 * Runs a creature's close-up poses directly, for the same moment a baked clip covers, and reports
 * where the joints land. Held against jointWorld(), it proves the crowd shows the same animation as
 * the close-up renderer rather than a copy of it.
 */
export function poseWorld(creature: string, clipName: string, frame: number): Array<readonly [string, number, number, number]> {
  if (creature !== 'hero') throw new Error(`poseWorld only knows the hero, not "${creature}"`);
  const driver = HERO_CLIPS.find((c) => c.name === clipName);
  if (!driver) throw new Error(`hero has no clip "${clipName}"`);
  const rig = new DetailRig(HERO_RIG);
  rig.showAttachment('sword');
  const t = driver.frames === 1 ? 0 : frame / (driver.loop === false ? driver.frames - 1 : driver.frames);
  poseHumanoid(rig, pose(driver.at(t, frame)));
  rig.root.updateMatrixWorld(true);
  return HERO_RIG.joints.map((j) => {
    const p = new THREE.Vector3();
    rig.joint(j.name).getWorldPosition(p);
    return [j.name, +p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)] as const;
  });
}
