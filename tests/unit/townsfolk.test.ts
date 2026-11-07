import * as THREE from 'three';
import { expect, test } from 'vitest';
import { fitBody } from '../../src/render/detail/madeBody';
import { type MadeTownsperson, wearTownsperson } from '../../src/render/detail/madeTownsfolk';

// A townsperson in a made body (src/render/detail/madeTownsfolk.ts): a rigged model's skeleton, named
// as Mixamo names it (as Tripo's and Meshy's riggers do), worn on the hero's rig, standing as the
// hero stands at rest, talking with their hands. The model is made here, in an A-pose: a few rings
// of skin round each bone, enough for fit.ts to measure.

/** Where each bone is in the A-pose, metres, facing +Z (the left is +X), and its parent. */
const BONES: Array<[string, string | null, [number, number, number]]> = [
  ['Hips', null, [0, 0.95, 0]],
  ['Spine', 'Hips', [0, 1.05, 0]],
  ['Spine1', 'Spine', [0, 1.18, 0]],
  ['Spine2', 'Spine1', [0, 1.32, 0]],
  ['Neck', 'Spine2', [0, 1.5, 0]],
  ['Head', 'Neck', [0, 1.6, 0.01]],
  ['HeadTop_End', 'Head', [0, 1.78, 0.01]],
  ...(['Left', 'Right'] as const).flatMap((side): Array<[string, string | null, [number, number, number]]> => {
    const x = side === 'Left' ? 1 : -1;
    const down = Math.SQRT1_2;
    return [
      [`${side}Shoulder`, 'Spine2', [x * 0.06, 1.45, 0]],
      [`${side}Arm`, `${side}Shoulder`, [x * 0.19, 1.44, 0]],
      [`${side}ForeArm`, `${side}Arm`, [x * (0.19 + 0.28 * down), 1.44 - 0.28 * down, 0]],
      [`${side}Hand`, `${side}ForeArm`, [x * (0.19 + 0.54 * down), 1.44 - 0.54 * down, 0]],
      [`${side}HandEnd`, `${side}Hand`, [x * (0.19 + 0.72 * down), 1.44 - 0.72 * down, 0]],
      [`${side}UpLeg`, 'Hips', [x * 0.1, 0.92, 0]],
      [`${side}Leg`, `${side}UpLeg`, [x * 0.1, 0.5, 0]],
      [`${side}Foot`, `${side}Leg`, [x * 0.1, 0.08, 0]],
      [`${side}ToeBase`, `${side}Foot`, [x * 0.1, 0.03, 0.12]],
      [`${side}ToeEnd`, `${side}ToeBase`, [x * 0.1, 0.02, 0.2]],
    ];
  }),
];

/** A skinned A-posed body with a ring of skin every few centimetres along each bone, all of it that bone's. */
function aPosedBody(): THREE.Group {
  const bones = new Map<string, THREE.Bone>();
  const at = new Map(BONES.map(([n, , p]) => [n, new THREE.Vector3(...p)]));
  for (const [name, parent, p] of BONES) {
    const b = new THREE.Bone();
    b.name = `mixamorig${name}`; // three's GLTFLoader drops the colon of "mixamorig:Hips"
    const up = parent ? at.get(parent)! : new THREE.Vector3();
    b.position.set(p[0] - up.x, p[1] - up.y, p[2] - up.z);
    if (parent) bones.get(parent)!.add(b);
    bones.set(name, b);
  }
  const list = [...bones.values()];
  const pos: number[] = [];
  const idx: number[] = [];
  const wts: number[] = [];
  for (const [name, parent] of BONES) {
    if (!parent) continue;
    // The skin round the bone from the parent's joint to this one belongs to the parent.
    const a = at.get(parent)!;
    const b = at.get(name)!;
    const along = b.clone().sub(a);
    const side = new THREE.Vector3(0, 0, 1).cross(along).normalize();
    if (side.lengthSq() < 0.5) side.set(1, 0, 0);
    const other = along.clone().cross(side).normalize();
    const owner = list.indexOf(bones.get(parent)!);
    for (let s = 0; s <= 4; s++)
      for (let k = 0; k < 6; k++) {
        const ang = (k / 6) * Math.PI * 2;
        const v = a
          .clone()
          .addScaledVector(along, s / 4)
          .addScaledVector(side, 0.035 * Math.cos(ang))
          .addScaledVector(other, 0.035 * Math.sin(ang));
        pos.push(v.x, Math.max(0, v.y), v.z);
        idx.push(owner, 0, 0, 0);
        wts.push(1, 0, 0, 0);
      }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute(
      pos.map(() => 0).map((_, i) => (i % 3 === 1 ? 1 : 0)),
      3,
    ),
  );
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4));
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
  const root = bones.get('Hips')!;
  mesh.add(root);
  mesh.bind(new THREE.Skeleton(list));
  const scene = new THREE.Group();
  scene.add(mesh);
  return scene;
}

/** Where a joint of the worn rig is, in the townsperson's own space (feet at the origin, facing +Z). */
function where(t: MadeTownsperson, joint: string): THREE.Vector3 {
  t.root.updateMatrixWorld(true);
  return t.rig.joint(joint).getWorldPosition(new THREE.Vector3());
}

test('a body rigged with Mixamo names is worn on the hero rig, standing as tall as asked', () => {
  const body = fitBody(aPosedBody(), 1.7);
  const names = body.def.joints.map((j) => j.name);
  for (const j of ['hips', 'torso', 'neck', 'head', 'armL', 'elbowL', 'handL', 'armR', 'elbowR', 'handR', 'legL', 'kneeL', 'footL', 'legR', 'kneeR', 'footR'])
    expect(names, j).toContain(j);
  const box = body.fitted.geometry.boundingBox!;
  expect(box.min.y).toBeCloseTo(0, 2);
  expect(box.max.y).toBeCloseTo(1.7, 2);
  // Turned a quarter first, a model facing +X comes out facing +Z the same.
  const turned = fitBody(aPosedBody().rotateY(-Math.PI / 2), 1.7, Math.PI / 2);
  expect(turned.fitted.geometry.boundingBox!.max.z).toBeCloseTo(box.max.z, 2);
});

test('standing, their arms hang; talking, their forearms come up in front of them', () => {
  const t = wearTownsperson(fitBody(aPosedBody(), 1.7));
  expect(t.face).toBeGreaterThan(1.45);
  expect(t.face).toBeLessThan(1.7);
  t.animate(1 / 60, { time: 1, talking: false });
  const shoulder = where(t, 'armL');
  const still = where(t, 'handL');
  expect(still.y).toBeLessThan(shoulder.y - 0.4);
  // Easing into talking over a moment, at the top of a gesture.
  for (let f = 0; f < 120; f++) t.animate(1 / 60, { time: 1 + f / 60, talking: true });
  let highest = still.clone();
  for (let f = 0; f < 240; f++) {
    t.animate(1 / 60, { time: 3 + f / 60, talking: true });
    const h = where(t, 'handL');
    if (h.y > highest.y) highest = h;
  }
  expect(highest.y).toBeGreaterThan(still.y + 0.15);
  expect(highest.z).toBeGreaterThan(still.z + 0.1);
});
