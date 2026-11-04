import { RigBuilder, swing } from '../authoring';
import { bakeAuthored } from '../pose';
import { MAT, type Quat, type SpeciesDef } from '../types';

// A four-legged beast: four limb chains instead of two, a spine that runs horizontally and a
// tail. Where the slime proves a species can have no limbs, this one proves the count is not
// baked in anywhere.

const HIDE = 0x6b5847;
const DARK = 0x3a2f26;

interface Leg { hip: number; knee: number; foot: number; front: boolean; phase: number }

function skeleton() {
  const r = new RigBuilder();
  const root = r.joint('root', -1, [0, 0.72, 0]);
  const chest = r.joint('chest', root, [0, 0, 0.3]);
  const neck = r.joint('neck', chest, [0, 0.12, 0.22]);
  const head = r.joint('head', neck, [0, 0.08, 0.24]);
  const hipsB = r.joint('hips', root, [0, 0, -0.34]);
  const tail = r.joint('tail', hipsB, [0, 0.04, -0.18]);

  r.box(root, [0, 0, -0.02], [0.44, 0.42, 0.78], { mat: MAT.team, color: HIDE });
  r.box(chest, [0, 0.02, 0.1], [0.46, 0.44, 0.34], { mat: MAT.team, color: HIDE });
  r.box(neck, [0, 0.04, 0.1], [0.24, 0.26, 0.3], { color: HIDE });
  r.box(head, [0, 0.02, 0.14], [0.26, 0.26, 0.36], { mat: MAT.skin, color: HIDE });
  r.box(head, [0.08, 0.14, 0.04], [0.07, 0.16, 0.06], { color: DARK }); // ears
  r.box(head, [-0.08, 0.14, 0.04], [0.07, 0.16, 0.06], { color: DARK });
  r.box(tail, [0, 0.02, -0.18], [0.1, 0.1, 0.4], { color: DARK });

  const legs: Leg[] = [];
  // Trot: diagonal pairs move together, so the two phases are half a cycle apart.
  const spec: Array<[string, number, number, boolean, number]> = [
    ['FL', 0.19, 0.3, true, 0],
    ['FR', -0.19, 0.3, true, 0.5],
    ['BL', 0.19, -0.34, false, 0.5],
    ['BR', -0.19, -0.34, false, 0],
  ];
  for (const [name, x, z, front, phase] of spec) {
    const hip = r.joint(`hip${name}`, front ? chest : hipsB, [x, -0.06, front ? z - 0.3 : z + 0.34]);
    const knee = r.joint(`knee${name}`, hip, [0, -0.3, 0]);
    const foot = r.joint(`foot${name}`, knee, [0, -0.28, 0]);
    r.box(hip, [0, -0.15, 0], [0.15, 0.34, 0.17], { color: HIDE });
    r.box(knee, [0, -0.14, 0], [0.11, 0.3, 0.12], { color: HIDE });
    r.box(foot, [0, -0.04, 0.03], [0.14, 0.1, 0.2], { color: DARK });
    legs.push({ hip, knee, foot, front, phase });
  }
  return { ...r.build(), legs, root, tail, head };
}

export function quadrupedSpecies(): SpeciesDef {
  const rig = skeleton();
  const { joints, legs } = rig;
  const rest = (j: number): Quat => joints[j].rot;

  const gait = (name: string, frames: number, reach: number, lift: number, bob: number) =>
    bakeAuthored(joints, { name, frames, fps: 30 }, (j, f) => {
      const t = f / frames;
      for (const leg of legs) {
        const p = (t + leg.phase) * Math.PI * 2;
        if (j === leg.hip) return { rot: swing(rest(j), [1, 0, 0], Math.sin(p) * reach) };
        // The knee only folds on the recovery half of the stride.
        if (j === leg.knee) return { rot: swing(rest(j), [1, 0, 0], -Math.max(0, -Math.sin(p)) * lift) };
        if (j === leg.foot) return { rot: swing(rest(j), [1, 0, 0], Math.max(0, -Math.sin(p)) * lift * 0.5) };
      }
      if (j === rig.root) return { pos: [0, 0.72 + Math.abs(Math.cos(t * Math.PI * 2)) * bob, 0] };
      if (j === rig.tail) return { rot: swing(rest(j), [0, 1, 0], Math.sin(t * Math.PI * 2) * 0.22) };
      return undefined;
    });

  const idle = bakeAuthored(joints, { name: 'idle', frames: 60, fps: 30 }, (j, f) => {
    const t = (f / 60) * Math.PI * 2;
    if (j === rig.root) return { pos: [0, 0.72 + Math.sin(t) * 0.012, 0] };
    if (j === rig.head) return { rot: swing(rest(j), [1, 0, 0], Math.sin(t * 0.5) * 0.06) };
    if (j === rig.tail) return { rot: swing(rest(j), [0, 1, 0], Math.sin(t * 0.7) * 0.3) };
    return undefined;
  });

  return {
    id: 'quadruped',
    height: rig.height,
    joints,
    proxy: rig.proxy,
    clips: [idle, gait('walk', 40, 0.42, 0.7, 0.02), gait('run', 24, 0.72, 1.1, 0.05)],
  };
}
