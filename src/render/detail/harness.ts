import * as THREE from 'three';
import { DetailRig } from './rig';
import { creatureIds, creatureRig } from '../../content/creatures/index';

// A bench for close-up bodies. Builds a rig straight from its content, poses named joints, and
// reports what it is made of - so adding a race means looking at it here before wiring it into
// the game, and a test can check it did not lose a limb.

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1b20);
scene.add(new THREE.HemisphereLight(0xcfd8ff, 0x2a2f3a, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(3, 6, 4);
scene.add(key);
const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const label = document.getElementById('label')!;
let rig: DetailRig | null = null;

const api = {
  list: () => creatureIds(),

  load(id: string) {
    if (rig) scene.remove(rig.root);
    const def = creatureRig(id);
    rig = new DetailRig(def);
    scene.add(rig.root);
    label.textContent = `${id}  joints=${def.joints.length}  parts=${def.parts.length}`;
    return {
      id,
      joints: def.joints.map((j) => j.name),
      parts: def.parts.length,
      materials: Object.keys(def.materials),
      attachments: Object.entries(def.attachments ?? {}).map(([name, a]) => ({
        name,
        joint: a.joint,
        parts: a.parts.length,
        exclusive: !!a.exclusive,
      })),
      /** Every joint's resting position in the body's own space, for a test to pin down. */
      rest: def.joints.map((j) => {
        const g = rig!.joint(j.name);
        const p = new THREE.Vector3();
        rig!.root.updateMatrixWorld(true);
        g.getWorldPosition(p);
        return [j.name, +p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)] as const;
      }),
    };
  },

  /** Turns one joint, so a test can check the hierarchy hangs together. */
  pose(joint: string, x = 0, y = 0, z = 0) {
    rig!.joint(joint).rotation.set(x, y, z);
  },

  reset() {
    if (!rig) return;
    for (const j of rig.def.joints) rig.joint(j.name).rotation.set(0, 0, 0);
  },

  show(attachment: string | null) {
    rig!.showAttachment(attachment);
  },

  /** Where a joint has ended up after posing. */
  worldOf(joint: string) {
    rig!.root.updateMatrixWorld(true);
    const p = new THREE.Vector3();
    rig!.joint(joint).getWorldPosition(p);
    return [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)];
  },

  frame(height = 1.9) {
    camera.position.set(height * 0.75, height * 0.62, height * 1.75);
    camera.lookAt(0, height * 0.45, 0);
    renderer.render(scene, camera);
    return { draws: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  },
};

(window as unknown as { __creatures: typeof api }).__creatures = api;
renderer.render(scene, camera);
