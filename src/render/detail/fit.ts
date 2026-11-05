import * as THREE from 'three';
import type { JointDef, PartDef, RigDef } from '../../content/rig';
import type { DetailRig } from './rig';

// Puts a made, rigged body (Meshy's, or any model with a humanoid skeleton) on a hero rig. Its
// bones are matched to our joints by name, its skin weights moved over to them, and our skeleton
// is bound in the model's own pose (an A or T pose), so what poseHumanoid does to our joints (arms
// hanging at rest, legs straight down) it does to the model. measureRig() reads the model's
// proportions into a rig description, so the joints sit where the model's do: the pose code's
// reach, its feet and its two-bone IK then fit the body they move.

/** Our joint for each of the model's bones, by name; anything unmatched follows its parent. */
const NAMES: Array<[RegExp, string]> = [
  [/^(hips|pelvis|root)$/, 'hips'],
  [/^(spine\d*|chest|upperchest)$/, 'torso'],
  [/^neck\d*$/, 'neck'],
  [/^head(top)?(end)?$/, 'head'],
  [/^(left|l)(shoulder|clavicle)$/, 'shoulderL'],
  [/^(right|r)(shoulder|clavicle)$/, 'shoulderR'],
  [/^(left|l)(arm|upperarm)$/, 'armL'],
  [/^(right|r)(arm|upperarm)$/, 'armR'],
  [/^(left|l)(forearm|lowerarm)$/, 'elbowL'],
  [/^(right|r)(forearm|lowerarm)$/, 'elbowR'],
  [/^(left|l)hand/, 'handL'],
  [/^(right|r)hand/, 'handR'],
  [/^(left|l)(upleg|thigh|upperleg)$/, 'legL'],
  [/^(right|r)(upleg|thigh|upperleg)$/, 'legR'],
  [/^(left|l)(leg|calf|shin|lowerleg)$/, 'kneeL'],
  [/^(right|r)(leg|calf|shin|lowerleg)$/, 'kneeR'],
  [/^(left|l)(foot|toe)/, 'footL'],
  [/^(right|r)(foot|toe)/, 'footR'],
];

/** "mixamorig:LeftUpLeg" (three drops the colon), "Left_UpLeg", "upperleg.L" all come to "leftupleg". */
function plain(name: string): string {
  let n = name.replace(/^.*[:|]/, '').replace(/^mixamorig\d*/i, '').toLowerCase();
  const side = n.match(/[._ ]([lr])$/);
  if (side) n = (side[1] === 'l' ? 'left' : 'right') + n.slice(0, -2);
  return n.replace(/[^a-z0-9]/g, '');
}

export function jointFor(bone: string): string | null {
  const n = plain(bone);
  for (const [re, joint] of NAMES) if (re.test(n)) return joint;
  return null;
}

/** A loaded model, its skinned mesh and bones, measured in our model space. */
export interface MadeBody {
  mesh: THREE.SkinnedMesh;
  /** Each of the model's bones by our joint name: the first (highest) bone that maps to it. */
  bone: Map<string, THREE.Bone>;
  /** Our joint for each of the mesh's skeleton bones, by index. */
  jointOf: string[];
  /** Model space: metres, y up, facing +Z, the soles at y = 0. */
  toModel: THREE.Matrix4;
  /** Every vertex in the bind pose, in the model's world (x, y, z flat). */
  bindPositions: Float32Array;
}

const _v = new THREE.Vector3();

/**
 * Finds the skinned mesh and its bones, and the matrix that takes the model's world into ours:
 * scaled to `height` metres, standing on y = 0, centred over the hips. The model is expected
 * upright and facing +Z (Meshy's front view does).
 */
export function readBody(scene: THREE.Object3D, height: number): MadeBody {
  scene.updateMatrixWorld(true);
  let mesh: THREE.SkinnedMesh | null = null;
  scene.traverse((o) => {
    if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
  });
  if (!mesh) throw new Error('made body: no skinned mesh in the model');
  const m = mesh as THREE.SkinnedMesh;
  const jointOf: string[] = [];
  const bone = new Map<string, THREE.Bone>();
  m.skeleton.bones.forEach((b, i) => {
    let joint = jointFor(b.name);
    let up: THREE.Object3D | null = b.parent;
    while (!joint && up) {
      const at = m.skeleton.bones.indexOf(up as THREE.Bone);
      joint = at >= 0 && at < i ? jointOf[at] : jointFor(up.name);
      up = up.parent;
    }
    jointOf.push(joint ?? 'body');
    if (joint && !bone.has(joint)) bone.set(joint, b);
  });
  for (const need of ['hips', 'torso', 'neck', 'head', 'armL', 'elbowL', 'handL', 'armR', 'elbowR', 'handR', 'legL', 'kneeL', 'footL', 'legR', 'kneeR', 'footR']) {
    if (!bone.has(need)) throw new Error(`made body: no bone for ${need} (bones: ${m.skeleton.bones.map((b) => b.name).join(', ')})`);
  }
  // The pose the model is loaded in (its bind pose, for a model fresh from a rigger), skinned the
  // way three skins it. Not skeleton.pose(): that takes the bones' parent for the world, and a
  // model's armature is often scaled or turned (centimetres, z up).
  m.skeleton.update();
  const box = new THREE.Box3();
  const pos = m.geometry.attributes.position;
  const bindPositions = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    m.applyBoneTransform(i, _v.fromBufferAttribute(pos, i)).applyMatrix4(m.matrixWorld);
    _v.toArray(bindPositions, i * 3);
    box.expandByPoint(_v);
  }
  const s = height / (box.max.y - box.min.y);
  const hips = bone.get('hips')!.getWorldPosition(new THREE.Vector3());
  const toModel = new THREE.Matrix4().makeTranslation(-hips.x * s, -box.min.y * s, -hips.z * s).multiply(new THREE.Matrix4().makeScale(s, s, s));
  return { mesh: m, bone, jointOf, toModel, bindPositions };
}

/** A bone's head in our model space. */
function at(body: MadeBody, joint: string): THREE.Vector3 {
  return body.bone.get(joint)!.getWorldPosition(new THREE.Vector3()).applyMatrix4(body.toModel);
}

/** Where a bone's chain ends (its first child's head), in our model space. */
function tip(body: MadeBody, joint: string): THREE.Vector3 {
  const b = body.bone.get(joint)!;
  const child = b.children.find((c) => (c as THREE.Bone).isBone && jointFor(c.name) !== jointFor(b.name)) ?? b.children.find((c) => (c as THREE.Bone).isBone);
  return child ? child.getWorldPosition(new THREE.Vector3()).applyMatrix4(body.toModel) : at(body, joint);
}

const r3 = (v: THREE.Vector3): [number, number, number] => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];

/**
 * The hero rig's joints, placed where the model's are: the same names and tree as `base`, the
 * limbs as straight bones of the model's lengths hanging down (our rest pose), the rest measured
 * off its skeleton. Parts and attachments are left to the caller.
 */
export function measureRig(body: MadeBody, base: RigDef): JointDef[] {
  const hips = at(body, 'hips');
  const spine = at(body, 'torso');
  const neck = at(body, 'neck');
  const head = at(body, 'head');
  const headTop = tip(body, 'head');
  const leg = { L: at(body, 'legL'), R: at(body, 'legR') };
  const arm = { L: at(body, 'armL'), R: at(body, 'armR') };
  const len = (a: string, b: string) => at(body, a).distanceTo(at(body, b));
  const thigh = (len('legL', 'kneeL') + len('legR', 'kneeR')) / 2;
  const shin = (len('kneeL', 'footL') + len('kneeR', 'footR')) / 2;
  const upper = (len('armL', 'elbowL') + len('armR', 'elbowR')) / 2;
  const fore = (len('elbowL', 'handL') + len('elbowR', 'handR')) / 2;
  // The body joint rides a little above the hips, as the box hero's does.
  const body0 = new THREE.Vector3(0, hips.y + 0.1, 0);
  const torso = new THREE.Vector3(0, spine.y, spine.z).sub(body0);
  const torsoAt = body0.clone().add(torso);
  const shoulderAt = (s: 'L' | 'R') => arm[s].clone().sub(torsoAt);
  const pos: Record<string, THREE.Vector3> = {
    squash: new THREE.Vector3(),
    body: body0,
    hips: hips.clone().setX(0).sub(body0),
    legL: leg.L.clone().sub(hips.clone().setX(0)),
    kneeL: new THREE.Vector3(0, -thigh, 0),
    footL: new THREE.Vector3(0, -shin, 0),
    legR: leg.R.clone().sub(hips.clone().setX(0)),
    kneeR: new THREE.Vector3(0, -thigh, 0),
    footR: new THREE.Vector3(0, -shin, 0),
    torso,
    neck: neck.clone().setX(0).sub(torsoAt),
    head: head.clone().setX(0).sub(neck.clone().setX(0)),
    eyes: new THREE.Vector3(0, (headTop.y - head.y) * 0.42, 0.09),
    cape: new THREE.Vector3(0, (arm.L.y + arm.R.y) / 2 - torsoAt.y, -0.13),
    capeTail: new THREE.Vector3(0, -0.42, 0),
    shoulderL: shoulderAt('L'),
    armL: new THREE.Vector3(),
    elbowL: new THREE.Vector3(0, -upper, 0),
    handL: new THREE.Vector3(0, -fore, 0),
    shoulderR: shoulderAt('R'),
    armR: new THREE.Vector3(),
    elbowR: new THREE.Vector3(0, -upper, 0),
    handR: new THREE.Vector3(0, -fore, 0),
  };
  return base.joints.map((j) => ({ ...j, pos: r3(pos[j.name] ?? new THREE.Vector3(...(j.pos ?? [0, 0, 0]))) }));
}

const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * Our joints' turns in the model's bind pose: each limb bone, which hangs straight down at rest,
 * turned to point the way the model's does; everything else upright, as the model stands. Local
 * turns, by joint name, parents first.
 */
function bindTurns(joints: readonly JointDef[], body: MadeBody): Map<string, THREE.Quaternion> {
  const world = new Map<string, THREE.Quaternion>();
  const aim = (joint: string, from: THREE.Vector3, to: THREE.Vector3) => world.set(joint, new THREE.Quaternion().setFromUnitVectors(DOWN, to.clone().sub(from).normalize()));
  for (const s of ['L', 'R'] as const) {
    aim(`arm${s}`, at(body, `arm${s}`), at(body, `elbow${s}`));
    aim(`elbow${s}`, at(body, `elbow${s}`), at(body, `hand${s}`));
    // A hand bone with nothing after it (Meshy's have no fingers) lies along the forearm.
    const handTip = tip(body, `hand${s}`);
    aim(`hand${s}`, at(body, `hand${s}`), handTip.distanceTo(at(body, `hand${s}`)) > 0.02 ? handTip : at(body, `hand${s}`).multiplyScalar(2).sub(at(body, `elbow${s}`)));
    aim(`leg${s}`, at(body, `leg${s}`), at(body, `knee${s}`));
    aim(`knee${s}`, at(body, `knee${s}`), at(body, `foot${s}`));
  }
  const local = new Map<string, THREE.Quaternion>();
  for (const j of joints) {
    const parentWorld = (j.parent && world.get(j.parent)) || new THREE.Quaternion();
    const want = world.get(j.name);
    if (!want) {
      world.set(j.name, parentWorld.clone());
      continue;
    }
    local.set(j.name, parentWorld.clone().invert().multiply(want));
  }
  return local;
}

/**
 * A made body ready to wear: our rig measured to it, its mesh moved into our model space with its
 * skin weights moved from its bones to our joints (fingers to the hand, the spine's bones to the
 * torso, ...), and the turns that put our joints in its bind pose. Made once per model; every hero
 * wearing it shares the geometry.
 */
export interface Fitted {
  joints: JointDef[];
  /** The ankle above the sole, and the heel and the ball of the foot ahead of it (Body's feet). */
  feet: { ankle: number; heel: number; ball: number };
  /** From the wrist to the middle of a closed fist, where a held grip goes (metres). */
  fist: number;
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  bind: Map<string, THREE.Quaternion>;
}

export function fit(scene: THREE.Object3D, height: number, base: RigDef): Fitted {
  const body = readBody(scene, height);
  const src = body.mesh;
  const geo = src.geometry.clone();
  // The bind pose's vertices, moved into our model space; normals turned the same way. Written
  // as floats: a compressed model keeps them quantized to +-1, which metres would overflow.
  const count = geo.attributes.position.count;
  const pos = new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3);
  for (let i = 0; i < count; i++) {
    _v.fromArray(body.bindPositions, i * 3).applyMatrix4(body.toModel);
    pos.setXYZ(i, _v.x, _v.y, _v.z);
  }
  geo.setAttribute('position', pos);
  const srcNormal = src.geometry.attributes.normal;
  if (srcNormal) {
    const nrm = new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3);
    const nm = new THREE.Matrix3().getNormalMatrix(new THREE.Matrix4().multiplyMatrices(body.toModel, src.matrixWorld));
    for (let i = 0; i < count; i++) {
      _v.fromBufferAttribute(srcNormal, i).applyMatrix3(nm).normalize();
      nrm.setXYZ(i, _v.x, _v.y, _v.z);
    }
    geo.setAttribute('normal', nrm);
  }
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  // Skin weights onto our joints, in the rig's joint order: merged where several bones become one
  // joint, the four strongest kept.
  const hands = measureHands(body, geo);
  const joints = withHands(measureRig(body, base), hands.knuckle, hands.middle);
  const index = new Map(joints.map((j, i) => [j.name, i]));
  const si = geo.attributes.skinIndex;
  const sw = geo.attributes.skinWeight;
  const idx = new Uint16Array(si.count * 4);
  const wts = new Float32Array(si.count * 4);
  const sum = new Map<number, number>();
  for (let v = 0; v < si.count; v++) {
    sum.clear();
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(v, k);
      if (w <= 0) continue;
      const joint = index.get(body.jointOf[si.getComponent(v, k)]) ?? index.get('body')!;
      sum.set(joint, (sum.get(joint) ?? 0) + w);
    }
    const top = [...sum.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const total = top.reduce((t, [, w]) => t + w, 0) || 1;
    top.forEach(([j, w], k) => {
      idx[v * 4 + k] = j;
      wts[v * 4 + k] = w / total;
    });
  }
  splitHands(body, geo, idx, wts, index, hands);
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4));

  const ankle = (at(body, 'footL').y + at(body, 'footR').y) / 2;
  const toe = (tip(body, 'footL').z + tip(body, 'footR').z) / 2 - (at(body, 'footL').z + at(body, 'footR').z) / 2;
  return {
    joints,
    feet: { ankle: +ankle.toFixed(3), heel: +(-0.45 * toe).toFixed(3), ball: +toe.toFixed(3) },
    geometry: geo,
    material: src.material,
    fist: +(hands.knuckle * 0.82).toFixed(3),
    bind: bindTurns(joints, body),
  };
}

// ---------- hands ----------
//
// Meshy's rig gives each hand one bone. The hand's skin is split here into a palm (with the thumb)
// and the four fingers together, bending at the knuckles and again at their middle joints, so a
// hand can close round what it holds. Measured in the bind pose, where the hand lies along the
// forearm with the thumb forward (+Z), as T- and A-posed models stand.

interface HandSize {
  /** Wrist to fingertip, and to the knuckles and the fingers' middle joints, metres. */
  length: number;
  knuckle: number;
  middle: number;
}

/** A hand's frame in the bind pose, in our model space: the wrist, along the hand, toward the thumb. */
function handFrame(body: MadeBody, s: 'L' | 'R'): { wrist: THREE.Vector3; along: THREE.Vector3; thumb: THREE.Vector3 } {
  const wrist = at(body, `hand${s}`);
  const along = wrist.clone().sub(at(body, `elbow${s}`)).normalize();
  const thumb = new THREE.Vector3(0, 0, 1).addScaledVector(along, -along.z).normalize();
  return { wrist, along, thumb };
}

/** How long the hands are: the furthest of the left hand's skin from the wrist, along the hand. */
function measureHands(body: MadeBody, geo: THREE.BufferGeometry): HandSize {
  const { wrist, along } = handFrame(body, 'L');
  const bone = body.mesh.skeleton.bones.indexOf(body.bone.get('handL')!);
  const si = geo.attributes.skinIndex;
  const sw = geo.attributes.skinWeight;
  const pos = geo.attributes.position;
  let length = 0;
  for (let v = 0; v < si.count; v++) {
    let w = 0;
    for (let k = 0; k < 4; k++) if (si.getComponent(v, k) === bone) w += sw.getComponent(v, k);
    if (w > 0.5) length = Math.max(length, _v.fromBufferAttribute(pos, v).sub(wrist).dot(along));
  }
  return { length, knuckle: length * 0.5, middle: length * 0.73 };
}

/** The rig's joints with a palm under each hand and two finger joints under that. */
function withHands(joints: JointDef[], knuckle: number, middle: number): JointDef[] {
  const out: JointDef[] = [];
  for (const j of joints) {
    out.push(j);
    const s = j.name === 'handL' ? 'L' : j.name === 'handR' ? 'R' : null;
    if (!s) continue;
    out.push(
      { name: `palm${s}`, parent: `hand${s}`, pos: [0, 0, 0] },
      { name: `fingers${s}`, parent: `palm${s}`, pos: [0, -+knuckle.toFixed(3), 0] },
      { name: `fingertips${s}`, parent: `fingers${s}`, pos: [0, -+(middle - knuckle).toFixed(3), 0] },
    );
  }
  return out;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Moves each hand's skin from the hand joint to the palm and the finger joints. */
function splitHands(body: MadeBody, geo: THREE.BufferGeometry, idx: Uint16Array, wts: Float32Array, index: Map<string, number>, size: HandSize): void {
  const pos = geo.attributes.position;
  const L = size.length || 1;
  const kn = size.knuckle / L;
  const md = size.middle / L;
  for (const s of ['L', 'R'] as const) {
    const { wrist, along, thumb } = handFrame(body, s);
    const hand = index.get(`hand${s}`)!;
    const parts = [index.get(`palm${s}`)!, index.get(`fingers${s}`)!, index.get(`fingertips${s}`)!];
    const w = new Map<number, number>();
    for (let v = 0; v < pos.count; v++) {
      let k = 0;
      while (k < 4 && !(idx[v * 4 + k] === hand && wts[v * 4 + k] > 0)) k++;
      if (k === 4) continue;
      _v.fromBufferAttribute(pos, v).sub(wrist);
      const u = _v.dot(along) / L;
      const t = _v.dot(thumb) / L;
      // The thumb: well out to the thumb's side, short of the fingertips. It stays with the palm.
      const thumbish = smoothstep(0.2, 0.26, t) * (1 - smoothstep(0.7, 0.8, u));
      const f1 = smoothstep(kn - 0.055, kn + 0.055, u) * (1 - thumbish);
      const f2 = smoothstep(md - 0.05, md + 0.05, u) * (1 - thumbish);
      w.clear();
      for (let j = 0; j < 4; j++) {
        const joint = idx[v * 4 + j];
        const weight = wts[v * 4 + j];
        if (weight <= 0) continue;
        if (joint !== hand) {
          w.set(joint, (w.get(joint) ?? 0) + weight);
          continue;
        }
        const share = [1 - f1, f1 - f2, f2];
        parts.forEach((p, i) => share[i] > 0 && w.set(p, (w.get(p) ?? 0) + weight * share[i]));
      }
      const top = [...w.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const total = top.reduce((sum, [, x]) => sum + x, 0) || 1;
      for (let j = 0; j < 4; j++) {
        idx[v * 4 + j] = top[j]?.[0] ?? 0;
        wts[v * 4 + j] = top[j] ? top[j][1] / total : 0;
      }
    }
  }
}

/** What a hand is doing: 0 open .. 1 closed, and the axis of what it grips (hand space), if anything. */
export interface Grip {
  amount: number;
  /** The held thing's grip axis in the hand joint's space; the palm turns so it runs across it. */
  axis?: THREE.Vector3 | null;
  /** What it holds, moved into the fist. */
  held?: readonly THREE.Object3D[];
}

const MAX_BEND = (65 * Math.PI) / 180;
/** How far in front of the palm's middle a gripped handle's axis runs, metres. */
const PALM_DEPTH = 0.034;
const _f = new THREE.Vector3();
const _d = new THREE.Vector3();
const _a = new THREE.Vector3();
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();
const _bm = new THREE.Matrix4();
const _bq = new THREE.Quaternion();

/**
 * Poses the made body's hands after the rest of it: the pose code turns a hand joint to point
 * what it holds (a ball hand can't show the wrist), and here the palm turns so the grip runs
 * across it and the wrist bends no further than a wrist can, the fingers close round it, and the
 * held thing moves into the fist.
 */
export function gripHands(rig: DetailRig, fist: number, grips: Record<'L' | 'R', Grip>): void {
  for (const s of ['L', 'R'] as const) {
    if (!rig.has(`palm${s}`)) continue;
    const hand = rig.joint(`hand${s}`);
    const palm = rig.joint(`palm${s}`);
    const g = grips[s];
    palm.quaternion.identity();
    if (g.axis && g.amount > 0) {
      // The forearm in the hand's space: it runs down the elbow's -Y.
      _f.set(0, -1, 0).applyQuaternion(_bq.copy(hand.quaternion).invert());
      _a.copy(g.axis).normalize();
      // Fingers across the grip, as near the forearm's line as that allows.
      _d.copy(_f).addScaledVector(_a, -_f.dot(_a));
      if (_d.lengthSq() < 0.04) _d.set(0, 0, -1).addScaledVector(_a, -_a.z);
      _d.normalize();
      const bend = _f.angleTo(_d);
      if (bend > MAX_BEND) _d.lerp(_f, 1 - MAX_BEND / bend).normalize();
      _by.copy(_d).negate();
      _bz.copy(_a).addScaledVector(_by, -_a.dot(_by)).normalize();
      _bx.crossVectors(_by, _bz);
      _bq.setFromRotationMatrix(_bm.makeBasis(_bx, _by, _bz));
      palm.quaternion.slerp(_bq, Math.min(1, g.amount));
      // The grip lies across the palm, in front of it (the right palm faces the palm frame's +X,
      // the left one's -X), where the curled fingers close round it; not through the hand.
      _bx.multiplyScalar(s === 'R' ? PALM_DEPTH : -PALM_DEPTH);
      for (const h of g.held ?? []) h.position.copy(_d).multiplyScalar(fist).add(_bx).multiplyScalar(Math.min(1, g.amount));
    } else {
      for (const h of g.held ?? []) h.position.set(0, 0, 0);
    }
    // Fingers curl toward the palm: about the knuckles' line (the palm's Z), the left hand's palm
    // facing its -X and the right's its +X.
    const curl = (s === 'L' ? -1 : 1) * Math.min(1, Math.max(0, g.amount));
    rig.joint(`fingers${s}`).rotation.set(0, 0, curl * 1.4);
    rig.joint(`fingertips${s}`).rotation.set(0, 0, curl * 1.3);
  }
}

const IDENTITY = new THREE.Quaternion();

/** Dresses a rig built from `fitted.joints` in the made body. Posing the rig poses it. */
export function wear(rig: DetailRig, fitted: Fitted): THREE.SkinnedMesh {
  const mesh = new THREE.SkinnedMesh(fitted.geometry, fitted.material);
  mesh.name = 'madeBody';
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  rig.root.add(mesh);
  // Bound in the model's pose, then the rig goes back to how it was.
  const joints = rig.def.joints.map((j) => rig.joint(j.name));
  const saved = joints.map((g) => g.quaternion.clone());
  rig.def.joints.forEach((j, i) => joints[i].quaternion.copy(fitted.bind.get(j.name) ?? IDENTITY));
  rig.root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(joints as unknown as THREE.Bone[]), mesh.matrixWorld);
  joints.forEach((g, i) => g.quaternion.copy(saved[i]));
  rig.root.updateMatrixWorld(true);
  return mesh;
}

/**
 * Stand-ins for the made body's bulk, hidden: the pose code keeps boots out of the floor and a
 * sprawled body off the ground by its parts (lowestOn, keepOffFloor in humanoid.ts).
 */
export function hull(joints: readonly JointDef[], ankle: number): PartDef[] {
  const y = (name: string) => Math.abs(joints.find((j) => j.name === name)?.pos?.[1] ?? 0);
  const thigh = y('kneeL');
  const shin = y('footL');
  const upper = y('elbowL');
  const fore = y('handL');
  const neck = y('neck');
  const box = (joint: string, w: number, h: number, d: number, pos: [number, number, number]): PartDef => ({
    joint,
    shape: { kind: 'box', w, h, d, r: Math.min(w, h, d) * 0.3 },
    mat: 'skin',
    pos,
    outline: false,
    castShadow: false,
    hidden: true,
  });
  const parts: PartDef[] = [
    box('hips', 0.34, 0.22, 0.22, [0, -0.04, 0]),
    box('torso', 0.36, neck, 0.24, [0, neck / 2, 0]),
    { joint: 'head', shape: { kind: 'sphere', r: 0.11 }, mat: 'skin', pos: [0, 0.1, 0.02], outline: false, castShadow: false, hidden: true },
  ];
  for (const s of ['L', 'R']) {
    parts.push(
      box(`leg${s}`, 0.15, thigh, 0.16, [0, -thigh / 2, 0]),
      box(`knee${s}`, 0.11, shin, 0.12, [0, -shin / 2, 0]),
      box(`foot${s}`, 0.1, ankle + 0.03, 0.26, [0, -ankle + (ankle + 0.03) / 2, 0.04]),
      box(`arm${s}`, 0.1, upper, 0.1, [0, -upper / 2, 0]),
      box(`elbow${s}`, 0.08, fore, 0.08, [0, -fore / 2, 0]),
      { joint: `hand${s}`, shape: { kind: 'sphere', r: 0.05 }, mat: 'skin', pos: [0, -0.08, 0], outline: false, castShadow: false, hidden: true },
    );
  }
  return parts;
}
