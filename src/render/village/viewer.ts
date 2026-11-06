import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildingPlan, buildingPlanIds, mirrorPlan, STOREY } from '../../content/buildings';
import { buildingColliders } from '../../sim/zone/buildings';
import type { PlacedBuilding } from '../../sim/zone/generate';
import { assetsReady } from '../assets';
import { windowGlow } from '../models/glb';
import { Village } from './village';

// /buildings.html: the buildings you can walk into, as the game draws them.
//   ?plan=townhouse         one plan (all of them in a row without)
//   ?cut=0                  as seen from inside, on that storey
//   ?colliders=1            the rules' walls (red), decks (blue) and posts (yellow) over it
//   ?mirror=1               mirrored
//   ?night=1                after dark (windows lit, lamps up)
//   ?cam=x,y,z&at=x,y,z     where the camera is and what it looks at

const q = new URLSearchParams(location.search);
const ids = q.get('plan') ? [q.get('plan')!] : buildingPlanIds();
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
document.body.appendChild(renderer.domElement);
const night = q.get('night') === '1';
const scene = new THREE.Scene();
scene.background = new THREE.Color(night ? 0x16233d : 0xbcd8e6);
scene.add(new THREE.HemisphereLight(night ? 0x40528a : 0xc4dbf2, night ? 0x141c22 : 0x6f7a4a, night ? 0.8 : 1.3));
const sun = new THREE.DirectionalLight(night ? 0x8fa6e8 : 0xfff3e0, night ? 0.5 : 3.2);
sun.position.set(14, 24, 9);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 120 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);
windowGlow.value = night ? 1 : 0;
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshLambertMaterial({ color: 0x7d9a55 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// The plans side by side along X, 6 m apart.
const placed: PlacedBuilding[] = [];
let x = 0;
for (const id of ids) {
  const base = buildingPlan(id);
  if (!base) continue;
  const plan = q.get('mirror') === '1' ? mirrorPlan(base) : base;
  const px = x + plan.w / 2;
  const solid = buildingColliders(plan, px, 0, 0, 0);
  placed.push({ id, plan, x: px, y: 0, z: 0, rot: 0, mirror: q.get('mirror') === '1', boxes: solid.boxes });
  x += plan.w + 6;
  if (q.get('colliders') === '1') {
    const line = (color: number) => new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 });
    const show = (b: { x: number; z: number; hw: number; hd: number; rot: number; top: number }, bottom: number, color: number) => {
      const box = new THREE.Box3(new THREE.Vector3(-b.hw, bottom, -b.hd), new THREE.Vector3(b.hw, b.top, b.hd));
      const helper = new THREE.Box3Helper(box, color);
      (helper.material as THREE.Material).depthTest = false;
      const holder = new THREE.Group();
      holder.position.set(b.x, 0, b.z);
      holder.rotation.y = b.rot;
      holder.add(helper);
      scene.add(holder);
    };
    for (const b of solid.boxes) show(b, 0, 0xff3040);
    for (const d of solid.decks) show(d, d.top - 0.05, 0x3080ff);
    for (const o of solid.obstacles) {
      const c = new THREE.LineLoop(new THREE.CircleGeometry(o.r, 20).rotateX(-Math.PI / 2), line(0xffd000));
      c.position.set(o.x, 0.05, o.z);
      scene.add(c);
    }
  }
}
const village = new Village(placed);
scene.add(village.group);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
const cam = q.get('cam')?.split(',').map(Number);
const look = q.get('at')?.split(',').map(Number);
const width = Math.max(10, x - 6);
camera.position.set(...((cam as [number, number, number]) ?? [width / 2 - width * 0.35, 14 + width * 0.3, 18 + width * 0.6]));
controls.target.set(...((look as [number, number, number]) ?? [width / 2, 2, 0]));
controls.update();

const cutAt = q.get('cut');
const label = document.getElementById('label')!;
label.textContent = `${ids.join(', ')}${cutAt !== null ? `\ncut open above storey ${cutAt}` : ''}`;
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (cutAt !== null && placed[0]) {
    const b = placed[0];
    village.locate(b.x, Number(cutAt) * STOREY + 0.1, b.z);
  }
  village.lampLevel = night ? 1 : 0.6;
  village.update(dt, [], { x: controls.target.x, y: controls.target.y, z: controls.target.z });
  controls.update();
  renderer.render(scene, camera);
  (window as unknown as { __ready: boolean }).__ready = village.ready && assetsReady();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
