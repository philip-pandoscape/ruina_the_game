import * as THREE from 'three';
import { loadGltf } from '../assets';
import { DetailRig } from './rig';
import { Body } from './body';
import { madeHero } from './madeHero';
import { dressWeapons } from './madeWeapons';
import { wear } from './fit';
import { bake, JOINT, LIBRARIES, libraryOf, poseFromClip, RATE, type Baked, type Canon } from './retarget';

// The retargeting check, /retarget.html: a library clip on the made hero, baked and posed exactly
// as the game does it (retarget.ts), beside the clip's own skeleton playing it as authored; every
// bone's direction on the hero measured against its source bone's, and the feet against the ground.
//
//   ?file=hero_moves_meshy&clip=Triple_Combo_Attack      a clip file in src/render/assets/models
//   ?url=/scratch/x.glb&clip=Name~Other                   any GLB, clips end to end
//   &mesh=/scratch/with-skin.glb                          show the source skinned (else its bones)
//   &view=three|side|front                                where the camera looks from
//   &draw=0                                               measure without drawing (a test in software)
//
// window.__retarget: { ready, seconds, seek(t) -> { mean, worst, bone, feet } }. tests/retarget.spec.ts
// holds every move's clip (moves.ts) to it. The retarget-animation skill says how to use it.

const q = new URLSearchParams(location.search);
const urls = import.meta.glob('../assets/models/*.glb', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const fileUrl = (name: string) => Object.entries(urls).find(([k]) => k.endsWith(`/${name}.glb`))?.[1];
const clipUrl = q.get('url') ?? fileUrl(q.get('file') ?? 'hero_moves_meshy');
if (!clipUrl) throw new Error('retarget view: no clip file (?file=name in src/render/assets/models, or ?url=)');
const clipNames = (q.get('clip') ?? 'Triple_Combo_Attack').split('~');

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
document.body.style.margin = '0';
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd9e2e6);
scene.add(new THREE.HemisphereLight(0xdff1ff, 0x5d7f3a, 1.5));
const sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
sun.position.set(2, 5, 4);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshLambertMaterial({ color: 0xa9b89a }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const grid = new THREE.GridHelper(40, 40, 0x7d8c70, 0x8d9c80);
grid.position.y = 0.002;
scene.add(grid);

const [source, shown, made] = await Promise.all([loadGltf(clipUrl), q.get('mesh') ? loadGltf(q.get('mesh')!) : null, madeHero()]);
if (!made) throw new Error('retarget view: the made hero did not load (the new look, with hero.glb)');
const clips = clipNames.map((n) => {
  const c = source.animations.find((a) => a.name === n);
  if (!c) throw new Error(`retarget view: no clip ${n} (${source.animations.map((a) => a.name).join(', ')})`);
  return c;
});

// The clip baked for the made hero, as madeHero bakes a move's.
const baked: Baked = bake(source.scene, source.animations, clipNames.map((clip) => ({ clip })), { joints: made.fitted.joints, bind: made.fitted.bind });

// The hero, as the game builds it.
const rig = new DetailRig(made.def);
if (made.weapons) dressWeapons(rig, made.weapons);
wear(rig, made.fitted);
rig.showAttachment('sword');
const body = Body.of(rig);
const hero = new THREE.Group();
hero.add(rig.root);
hero.position.x = -1;
scene.add(hero);

// The source: skinned if a model with the same skeleton was given, else its bones.
const src = shown ? shown.scene : source.scene;
const lib = libraryOf(src);
src.position.x = 1;
scene.add(src);
if (!shown) {
  const helper = new THREE.SkeletonHelper(src);
  (helper.material as THREE.LineBasicMaterial).linewidth = 2;
  scene.add(helper);
}
src.updateMatrixWorld(true);
const named = new Map<string, THREE.Object3D>();
src.traverse((o) => named.set(o.name, o));
const srcBone = (c: Canon) => named.get(lib.bones[c])!;
const root = lib.root ? named.get(lib.root) : undefined;
const restRoot = root ? root.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
const rootStart = root ? root.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
const mixer = new THREE.AnimationMixer(src);
const actions = clips.map((c) => mixer.clipAction(c));
const seconds = clips.reduce((s, c) => s + c.duration, 0);

/** The source at a moment of its clips, laid end to end. */
function poseSource(t: number): void {
  let s = Math.min(t, seconds - 1e-4);
  let i = 0;
  while (i < clips.length - 1 && s >= clips[i].duration) s -= clips[i++].duration;
  actions.forEach((a, j) => {
    a.enabled = j === i;
    if (j === i) a.play();
    else a.stop();
  });
  mixer.setTime(Math.min(s, clips[i].duration - 1e-4));
  src.updateMatrixWorld(true);
}

const DIRECTED: Array<[Canon, Canon]> = [
  ['hips', 'spine1'], ['spine1', 'spine2'], ['spine2', 'spine3'], ['spine3', 'neck'], ['neck', 'head'],
  ['clavicleL', 'armL'], ['armL', 'forearmL'], ['forearmL', 'handL'], ['clavicleR', 'armR'], ['armR', 'forearmR'], ['forearmR', 'handR'],
  ['thighL', 'shinL'], ['shinL', 'footL'], ['footL', 'toeL'], ['thighR', 'shinR'], ['shinR', 'footR'], ['footR', 'toeR'],
];
const at = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

/** Poses both at a moment; how far the hero's bones point from the source's, and its feet off the ground. */
function seek(t: number): { mean: number; worst: number; bone: string; feet: number } {
  poseSource(t);
  body.reset();
  poseFromClip(body, baked, t);
  // Shown travelling as the source does (the game's rules carry the body; here, the clip's root).
  if (root) {
    const travel = at(root).sub(rootStart);
    hero.position.set(-1 + travel.x, 0, travel.z);
  }
  hero.updateMatrixWorld(true);
  const unturn = root ? restRoot.clone().multiply(root.getWorldQuaternion(new THREE.Quaternion()).invert()) : new THREE.Quaternion();
  let sum = 0;
  let worst = 0;
  let bone = '';
  for (const [a, b] of DIRECTED) {
    const ds = at(srcBone(b)).sub(at(srcBone(a))).applyQuaternion(unturn).normalize();
    const dh = at(rig.joint(JOINT[b])).sub(at(rig.joint(JOINT[a]))).normalize();
    const e = THREE.MathUtils.radToDeg(ds.angleTo(dh));
    sum += e;
    if (e > worst) {
      worst = e;
      bone = a;
    }
  }
  // The lower ankle against where it stands at rest: below zero, a foot in the ground.
  const ankle = Math.min(at(rig.joint('footL')).y, at(rig.joint('footR')).y) - made!.fitted.feet.ankle;
  return { mean: sum / DIRECTED.length, worst, bone, feet: ankle };
}

const view = q.get('view') ?? 'three';
const dir = view === 'side' ? new THREE.Vector3(-1, 0.12, 0) : view === 'front' ? new THREE.Vector3(0, 0.15, 1) : new THREE.Vector3(-0.75, 0.42, 0.85);
const half = Number(q.get('half') ?? 1.45);
const cam = new THREE.OrthographicCamera(-half * (innerWidth / innerHeight), half * (innerWidth / innerHeight), half, -half, 0.1, 100);
function draw(): void {
  const mid = at(srcBone('hips')).add(at(rig.joint('hips'))).multiplyScalar(0.5).setY(0.95);
  cam.position.copy(mid).addScaledVector(dir.clone().normalize(), 20);
  cam.lookAt(mid);
  renderer.render(scene, cam);
}

seek(0);
draw();
(window as unknown as { __retarget: unknown }).__retarget = {
  ready: true,
  seconds,
  frames: baked.frames,
  rate: RATE,
  libraries: Object.keys(LIBRARIES),
  seek(t: number) {
    const out = seek(t);
    if (q.get('draw') !== '0') draw();
    return out;
  },
};
