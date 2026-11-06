import * as THREE from 'three';
import { RigBuilder } from '../authoring';
import { bakeAuthored } from '../pose';
import { MAT, type SpeciesDef, type Vec3 } from '../types';
import { lerp } from '../../util/math';

// The battle crowd's fighter, as species data. The geometry is the same twenty boxes it always
// was; what used to be an if-chain of hardcoded pivots and angles in the vertex shader is now
// four baked clips, which is what lets this share a renderer with a slime.

export const FIGHTER_RUN_FRAMES = 48;
export const FIGHTER_ATTACK_FRAMES = 32;

const PANTS = 0x2f3e46;
const BOOTS = 0x4a3426;
const DARK = 0x1d2733;

// Where each limb hangs off the body. These were GLSL literals; now they are joint offsets.
const PIVOT = {
  body: [0, 0, 0],
  legL: [0.12, 0.62, 0],
  legR: [-0.12, 0.62, 0],
  armL: [0.31, 1.1, 0],
  armR: [-0.31, 1.1, 0],
  cape: [0, 1.12, -0.16],
} as const;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The overhead chop: wind up behind the head, strike forward, settle back. */
export function chopAngle(atk: number): number {
  const wind = smoothstep(0, 0.3, atk);
  const strike = smoothstep(0.3, 0.55, atk);
  const settle = smoothstep(0.65, 1, atk);
  return lerp(lerp(lerp(-0.3, -3.5, wind), -0.5, strike), -0.3, settle);
}

interface Motion {
  phase: number;
  amount: number;
  /** Swing progress 0..1, or -1 when not swinging. */
  atk: number;
  down: boolean;
}

/** Every joint angle for a given motion, matching what the old crowd shader computed. */
function angles(m: Motion) {
  const sw = Math.sin(m.phase) * 0.85 * m.amount;
  const swinging = m.atk >= 0;
  return {
    legL: swinging ? -0.3 : sw,
    legR: swinging ? 0.3 : -sw,
    armL: swinging ? -0.6 : -sw * 1.05 + 0.05,
    armR: swinging ? chopAngle(m.atk) : -0.3 + sw * 0.35,
    cape: 0.15 + 0.8 * m.amount + Math.sin(m.phase * 2) * 0.08 * m.amount,
    lean: m.down ? -1.45 : 0.12 * m.amount,
    bob: Math.abs(Math.cos(m.phase)) * 0.06 * m.amount,
    // A fallen fighter tips about its feet rather than its waist.
    feet: m.down ? 0.15 : 0,
  };
}

function skeleton() {
  const r = new RigBuilder();
  const root = r.joint('root', -1, [0, 0, 0]);
  const ids: Record<string, number> = { root };
  for (const name of ['body', 'legL', 'legR', 'armL', 'armR', 'cape'] as const) {
    ids[name] = r.joint(name, root, PIVOT[name] as unknown as Vec3);
  }
  // Box centres were authored in body space; a joint's boxes sit relative to its own pivot.
  const at = (joint: keyof typeof PIVOT, x: number, y: number, z: number): Vec3 => {
    const p = PIVOT[joint];
    return [x - p[0], y - p[1], z - p[2]];
  };
  const put = (
    joint: keyof typeof PIVOT,
    size: Vec3,
    x: number, y: number, z: number,
    mat: number, color = 0xffffff, tiltX = 0,
  ) => r.box(ids[joint], at(joint, x, y, z), size, { mat, color, tilt: tiltX ? [tiltX, 0, 0] : undefined });

  put('body', [0.4, 0.16, 0.26], 0, 0.64, 0, MAT.fixed, PANTS);
  put('body', [0.46, 0.44, 0.3], 0, 0.93, 0, MAT.team);
  put('body', [0.48, 0.07, 0.32], 0, 0.74, 0, MAT.fixed, 0x6b4226);
  put('body', [0.5, 0.46, 0.46], 0, 1.4, 0, MAT.skin);
  put('body', [0.56, 0.2, 0.52], 0, 1.61, -0.01, MAT.team);
  put('body', [0.08, 0.14, 0.42], 0, 1.76, -0.03, MAT.team);
  put('body', [0.55, 0.3, 0.15], 0, 1.42, -0.19, MAT.hair);
  put('body', [0.07, 0.11, 0.02], 0.11, 1.4, 0.235, MAT.fixed, DARK);
  put('body', [0.07, 0.11, 0.02], -0.11, 1.4, 0.235, MAT.fixed, DARK);
  put('legL', [0.15, 0.5, 0.17], 0.12, 0.37, 0, MAT.fixed, PANTS);
  put('legL', [0.19, 0.13, 0.27], 0.12, 0.065, 0.04, MAT.fixed, BOOTS);
  put('legR', [0.15, 0.5, 0.17], -0.12, 0.37, 0, MAT.fixed, PANTS);
  put('legR', [0.19, 0.13, 0.27], -0.12, 0.065, 0.04, MAT.fixed, BOOTS);
  put('armL', [0.14, 0.42, 0.15], 0.31, 0.89, 0, MAT.team);
  put('armL', [0.12, 0.12, 0.12], 0.31, 0.65, 0, MAT.skin);
  put('armR', [0.14, 0.42, 0.15], -0.31, 0.89, 0, MAT.team);
  put('armR', [0.12, 0.12, 0.12], -0.31, 0.65, 0, MAT.skin);
  // The sword points forward and down at 45 degrees from the hand, so a chop reads well.
  const dir = new THREE.Vector3(0, -Math.SQRT1_2, Math.SQRT1_2);
  const hand = new THREE.Vector3(-0.31, 0.65, 0);
  const guard = hand.clone().addScaledVector(dir, 0.06);
  const blade = hand.clone().addScaledVector(dir, 0.49);
  put('armR', [0.26, 0.05, 0.06], guard.x, guard.y, guard.z, MAT.fixed, 0xe0b84a, Math.PI / 4);
  put('armR', [0.07, 0.025, 0.86], blade.x, blade.y, blade.z, MAT.fixed, 0xdfe6ee, Math.PI / 4);
  put('cape', [0.42, 0.5, 0.04], 0, 0.87, -0.17, MAT.team);
  return { ...r.build(), ids };
}

export function fighterSpecies(): SpeciesDef {
  const rig = skeleton();
  const { joints, ids } = rig;
  const rotX = (a: number) => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), a);
    return [q.x, q.y, q.z, q.w] as [number, number, number, number];
  };

  const pose = (m: Motion) => {
    const a = angles(m);
    // Leaning happens about the feet, which is a rotation about a point rather than an origin:
    // translate the pivot out, turn, translate it back, then add the run's bob.
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), a.lean);
    const f = new THREE.Vector3(0, a.feet, 0);
    const shifted = f.clone().sub(f.clone().applyQuaternion(q));
    const rootPose = { pos: [shifted.x, shifted.y + a.bob, shifted.z] as Vec3, rot: [q.x, q.y, q.z, q.w] as [number, number, number, number] };
    return (j: number): { pos?: Vec3; rot?: [number, number, number, number] } | undefined => {
      if (j === ids.root) return rootPose;
      if (j === ids.legL) return { rot: rotX(a.legL) };
      if (j === ids.legR) return { rot: rotX(a.legR) };
      if (j === ids.armL) return { rot: rotX(a.armL) };
      if (j === ids.armR) return { rot: rotX(a.armR) };
      if (j === ids.cape) return { rot: rotX(a.cape) };
      return undefined;
    };
  };

  const still = pose({ phase: 0, amount: 0, atk: -1, down: false });
  const idle = bakeAuthored(joints, { name: 'idle', frames: 1, fps: 30 }, (j) => still(j));

  // Run is baked at full stride. Anything slower is this clip blended back toward idle, which
  // reproduces the old shader exactly at the level of angles - each one was linear in the run
  // amount - and only differs in that the blend is of matrices, which shortens a limb by a few
  // per cent at half speed. Under a pixel at the range the crowd is seen from.
  const run = bakeAuthored(joints, { name: 'run', frames: FIGHTER_RUN_FRAMES, fps: 30 }, (j, f) =>
    pose({ phase: (f / FIGHTER_RUN_FRAMES) * Math.PI * 2, amount: 1, atk: -1, down: false })(j));

  const attack = bakeAuthored(joints, { name: 'attack', frames: FIGHTER_ATTACK_FRAMES, fps: 58, loop: false }, (j, f) =>
    pose({ phase: 0, amount: 0, atk: f / (FIGHTER_ATTACK_FRAMES - 1), down: false })(j));

  const downPose = pose({ phase: 0, amount: 0, atk: -1, down: true });
  const down = bakeAuthored(joints, { name: 'down', frames: 1, fps: 30, loop: false }, (j) => downPose(j));

  return { id: 'fighter', height: rig.height, joints, proxy: rig.proxy, clips: [idle, run, attack, down] };
}
