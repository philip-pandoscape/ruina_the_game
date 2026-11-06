import * as THREE from 'three';
import { RigBuilder } from '../../species/authoring';
import { bakeAuthored, type LocalPose } from '../../species/pose';
import { MAT, type Quat, type SpeciesDef, type Vec3 } from '../../species/types';
import { TAU } from '../../util/math';

// The goblin's body until its model is made (design/goblins.md): boxes on an eight-joint rig,
// drawn by the same instanced crowd as everything else. A metre tall, hunched, with a big head,
// long ears and long arms, a sackcloth tunic, a stone pouch and a rusty dagger held point-down.
// Each brain state in content/creatures/goblin/ names one of these clips. The ones the rules
// time (stab, throw) put their blow where the attack's wind-up ends: the stab at 16 of its 36
// frames, the throw at 24 of 40.

const SKIN = 0x7c8664;
const SKIN_DARK = 0x5f6a4b;
const SACK = 0x8b7556;
const LEATHER = 0x5a3e28;
const STEEL = 0xa9aeb2;
const RUST = 0x8a5a3a;
const EYE = 0xffb23a;
const TOOTH = 0xe8e0c8;

// Where each joint sits in the body when it stands at rest, facing +Z.
const PIVOT = {
  root: [0, 0, 0],
  body: [0, 0.42, 0],
  head: [0, 0.72, 0.07],
  armL: [0.18, 0.66, 0.03],
  armR: [-0.18, 0.66, 0.03],
  legL: [0.09, 0.42, 0],
  legR: [-0.09, 0.42, 0],
} as const;
type JointName = keyof typeof PIVOT;
const PARENT: Record<JointName, JointName | null> = {
  root: null,
  body: 'root',
  head: 'body',
  armL: 'body',
  armR: 'body',
  legL: 'root',
  legR: 'root',
};

/** One moment of the goblin's body, as angles in radians. */
interface Pose {
  /** Torso forward (positive) about the hips. */
  lean: number;
  /** The head about the neck; negative looks up. Added to what keeps it level with the torso. */
  head: number;
  /** Arms and legs forward (negative) or back about the shoulders and hips. */
  armL: number;
  armR: number;
  legL: number;
  legR: number;
  /** Arms and legs out to the side. */
  armOut: number;
  legOut: number;
  /** The whole body off the ground, metres. */
  bob: number;
  /** The whole body tipped back about its feet (a fall), radians. */
  fall: number;
}

const REST: Pose = { lean: 0.42, head: 0, armL: -0.12, armR: -0.35, legL: 0, legR: 0, armOut: 0.12, legOut: 0, bob: 0, fall: 0 };

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const blend = (a: Pose, b: Pose, t: number): Pose => {
  const out = { ...a };
  for (const k of Object.keys(a) as (keyof Pose)[]) out[k] = mix(a[k], b[k], t);
  return out;
};

/** The crouched, dagger-forward stance it fights from. */
const READY: Pose = { ...REST, lean: 0.55, head: -0.1, armL: -0.45, armR: -0.75, legL: -0.18, legR: 0.22, armOut: 0.2 };

const quat = (x: number, z: number): Quat => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, 0, z, 'XZY'));
  return [q.x, q.y, q.z, q.w];
};

function rig() {
  const r = new RigBuilder();
  const ids = {} as Record<JointName, number>;
  for (const name of Object.keys(PIVOT) as JointName[]) {
    const parent = PARENT[name];
    const p = PIVOT[name];
    const q = parent ? PIVOT[parent] : [0, 0, 0];
    ids[name] = r.joint(name, parent ? ids[parent] : -1, [p[0] - q[0], p[1] - q[1], p[2] - q[2]] as Vec3);
  }
  // Boxes are written where they sit in the standing body; each hangs off its joint.
  const put = (joint: JointName, size: Vec3, x: number, y: number, z: number, color: number, tilt?: Vec3) => {
    const p = PIVOT[joint];
    r.box(ids[joint], [x - p[0], y - p[1], z - p[2]], size, { mat: MAT.fixed, color, tilt });
  };

  // Legs: bandy shins, bare clawed feet.
  for (const [joint, x] of [
    ['legL', 0.09],
    ['legR', -0.09],
  ] as const) {
    put(joint, [0.1, 0.24, 0.11], x, 0.3, 0, SKIN);
    put(joint, [0.085, 0.2, 0.09], x, 0.11, 0.01, SKIN);
    put(joint, [0.12, 0.05, 0.19], x, 0.025, 0.05, SKIN_DARK);
    put(joint, [0.13, 0.04, 0.06], x, 0.2, 0.0, SACK); // rag wrapping
  }
  // Torso: a sackcloth tunic over a pot belly, a belt, the stone pouch.
  put('body', [0.3, 0.24, 0.22], 0, 0.56, 0.01, SACK);
  put('body', [0.27, 0.12, 0.2], 0, 0.68, 0.0, SKIN);
  put('body', [0.32, 0.05, 0.24], 0, 0.47, 0.01, LEATHER);
  put('body', [0.34, 0.12, 0.25], 0, 0.42, 0.01, SACK);
  put('body', [0.08, 0.09, 0.06], 0.15, 0.44, 0.06, LEATHER);
  put('body', [0.24, 0.1, 0.1], 0, 0.66, -0.09, SKIN_DARK); // the hunch
  // Head: big, with a heavy brow, long nose, needle teeth, amber eyes and long notched ears.
  put('head', [0.26, 0.23, 0.25], 0, 0.86, 0.1, SKIN);
  put('head', [0.27, 0.05, 0.08], 0, 0.92, 0.2, SKIN_DARK);
  put('head', [0.05, 0.07, 0.1], 0, 0.85, 0.25, SKIN_DARK);
  put('head', [0.15, 0.03, 0.02], 0, 0.78, 0.225, TOOTH);
  put('head', [0.05, 0.035, 0.02], 0.065, 0.885, 0.23, EYE);
  put('head', [0.05, 0.035, 0.02], -0.065, 0.885, 0.23, EYE);
  put('head', [0.24, 0.07, 0.025], 0.22, 0.9, 0.08, SKIN, [0, -0.35, 0.3]);
  put('head', [0.24, 0.07, 0.025], -0.22, 0.9, 0.08, SKIN, [0, 0.35, -0.3]);
  // Long arms; the right hand holds the dagger point-down, so a thrust drives it forward.
  for (const [joint, x] of [
    ['armL', 0.18],
    ['armR', -0.18],
  ] as const) {
    put(joint, [0.075, 0.25, 0.08], x, 0.53, 0.03, SKIN);
    put(joint, [0.065, 0.23, 0.07], x, 0.31, 0.03, SKIN);
    put(joint, [0.085, 0.08, 0.085], x, 0.17, 0.03, SKIN_DARK);
  }
  put('armR', [0.04, 0.05, 0.05], -0.18, 0.11, 0.03, LEATHER);
  put('armR', [0.035, 0.22, 0.02], -0.18, -0.03, 0.03, STEEL);
  put('armR', [0.036, 0.06, 0.022], -0.18, -0.1, 0.03, RUST);

  return { ...r.build(), ids };
}

export function goblinSpecies(): SpeciesDef {
  const { joints, proxy, height, ids } = rig();

  const pose =
    (p: Pose) =>
    (j: number): LocalPose | undefined => {
      if (j === ids.root) {
        // A fall tips it about its feet; the bob lifts it.
        return { pos: [0, p.bob, 0], rot: quat(-p.fall, 0) };
      }
      if (j === ids.body) return { pos: [0, 0.42, 0], rot: quat(p.lean, 0) };
      // The head keeps level as the torso leans, then looks where the pose says.
      if (j === ids.head) return { pos: [0, 0.3, 0.07], rot: quat(-p.lean * 0.8 + p.head, 0) };
      if (j === ids.armL) return { pos: [0.18, 0.24, 0.03], rot: quat(p.armL, p.armOut) };
      if (j === ids.armR) return { pos: [-0.18, 0.24, 0.03], rot: quat(p.armR, -p.armOut) };
      if (j === ids.legL) return { pos: [0.09, 0.42, 0], rot: quat(p.legL, p.legOut) };
      if (j === ids.legR) return { pos: [-0.09, 0.42, 0], rot: quat(p.legR, -p.legOut) };
      return undefined;
    };

  const loop = (name: string, frames: number, at: (phase: number) => Pose) =>
    bakeAuthored(joints, { name, frames, fps: 30 }, (j, f) => pose(at((f / frames) * TAU))(j));
  const once = (name: string, frames: number, at: (t: number) => Pose) =>
    bakeAuthored(joints, { name, frames, fps: 30, loop: false }, (j, f) => pose(at(f / (frames - 1)))(j));

  const idle = loop('idle', 48, (ph) => ({
    ...REST,
    lean: REST.lean + Math.sin(ph) * 0.03,
    head: Math.sin(ph + 1) * 0.08,
    armL: REST.armL + Math.sin(ph) * 0.05,
    bob: (Math.sin(ph) + 1) * 0.004,
  }));

  // Gaits: a scuttling walk and run, a sideways shuffle while it circles, a wary step back.
  const walk = loop('walk', 32, (ph) => {
    const sw = Math.sin(ph);
    return {
      ...REST,
      lean: 0.45,
      head: -0.05,
      legL: sw * 0.55,
      legR: -sw * 0.55,
      armL: -sw * 0.5 - 0.1,
      armR: sw * 0.35 - 0.35,
      bob: Math.abs(Math.cos(ph)) * 0.03,
    };
  });
  const run = loop('run', 24, (ph) => {
    const sw = Math.sin(ph);
    return {
      ...REST,
      lean: 0.7,
      head: -0.2,
      legL: sw * 0.95,
      legR: -sw * 0.95,
      armL: -sw * 0.9 - 0.2,
      armR: sw * 0.7 - 0.5,
      armOut: 0.25,
      bob: Math.abs(Math.cos(ph)) * 0.06,
    };
  });
  const strafe = loop('strafe', 28, (ph) => {
    const sw = Math.sin(ph);
    return { ...READY, legOut: 0.1 + sw * 0.28, legL: -0.1, legR: 0.12, armL: READY.armL + sw * 0.1, bob: Math.abs(Math.cos(ph)) * 0.025 };
  });
  const backoff = loop('backoff', 32, (ph) => {
    const sw = Math.sin(-ph);
    return { ...READY, lean: 0.35, legL: sw * 0.45, legR: -sw * 0.45, armL: -0.9, armR: -0.95, bob: Math.abs(Math.cos(ph)) * 0.025 };
  });

  // It spots you: straightens up with its arms out and shrieks, then drops into a crouch.
  const spot = once('spot', 30, (t) => {
    const shriek: Pose = { ...REST, lean: 0.05, head: -0.55, armL: -1.9, armR: -1.7, armOut: 0.55 };
    return t < 0.35 ? blend(REST, shriek, smooth(0, 0.35, t)) : blend(shriek, READY, smooth(0.6, 1, t));
  });
  const ready = once('ready', 2, () => READY);

  // The stab: the dagger drawn back through the wind-up, a lunging thrust as it ends, then back.
  const stab = once('stab', 36, (t) => {
    const drawn: Pose = { ...READY, lean: 0.35, armR: 0.75, armL: -0.7, legL: -0.25, legR: 0.3 };
    const thrust: Pose = { ...READY, lean: 0.85, head: -0.25, armR: -1.65, armL: 0.35, legL: -0.6, legR: 0.45 };
    if (t < 0.44) return blend(READY, drawn, smooth(0, 0.4, t));
    if (t < 0.6) return blend(drawn, thrust, smooth(0.44, 0.52, t));
    return blend(thrust, READY, smooth(0.62, 1, t));
  });

  // The throw: a stone wound up behind the head, let go as the wind-up ends.
  const throwing = once('throw', 40, (t) => {
    const wound: Pose = { ...REST, lean: 0.1, head: -0.15, armR: -3.5, armL: -1.1, legL: -0.3, legR: 0.25, armOut: 0.2 };
    const loosed: Pose = { ...REST, lean: 0.75, head: -0.1, armR: -0.7, armL: 0.2, legL: -0.45, legR: 0.35, armOut: 0.15 };
    if (t < 0.6) return blend(READY, wound, smooth(0, 0.5, t));
    if (t < 0.75) return blend(wound, loosed, smooth(0.6, 0.68, t));
    return blend(loosed, READY, smooth(0.75, 1, t));
  });

  // Struck: it reels back with its arms up, then steadies.
  const flinch = once('flinch', 16, (t) => {
    const reel: Pose = { ...READY, lean: 0.05, head: 0.35, armL: -1.5, armR: -1.2, armOut: 0.4, bob: 0.02 };
    return t < 0.3 ? blend(READY, reel, smooth(0, 0.25, t)) : blend(reel, READY, smooth(0.45, 1, t));
  });

  // The stolen potion, tipped back and drained.
  const drink = once('drink', 80, (t) => {
    const swig: Pose = { ...REST, lean: 0.15, head: -0.6, armL: -2.55, armOut: 0.05, armR: -0.4 };
    if (t < 0.25) return blend(READY, swig, smooth(0.05, 0.25, t));
    if (t < 0.85) return { ...swig, head: swig.head + Math.sin(t * 40) * 0.03 };
    return blend(swig, READY, smooth(0.85, 1, t));
  });

  const die = once('die', 30, (t) => {
    const down: Pose = { ...REST, fall: 1.45, lean: -0.1, head: 0.3, armL: -2.4, armR: -2.1, armOut: 0.6, legL: -0.3, legR: 0.1 };
    return blend(READY, down, smooth(0, 0.7, t));
  });

  return {
    id: 'goblin',
    height,
    joints,
    proxy,
    clips: [idle, walk, run, strafe, backoff, spot, ready, stab, throwing, flinch, drink, die],
  };
}
