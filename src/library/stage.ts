import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Framing, Vec3 } from './types';

// The library's viewport: a quiet studio (soft key light, a checked floor a metre a tile, fog at the
// edges) so a pose reads clearly. The body stays in view while the floor slides under it by however
// far it has travelled, so a planted foot stays put on the checks.

export type View = 'three' | 'front' | 'side' | 'left' | 'back' | 'top';

export const VIEWS: Array<{ id: View; label: string; key: string }> = [
  { id: 'three', label: 'Three-Quarter', key: '1' },
  { id: 'front', label: 'Front', key: '2' },
  { id: 'side', label: 'Right Side', key: '3' },
  { id: 'left', label: 'Left Side', key: '4' },
  { id: 'back', label: 'Behind', key: '5' },
  { id: 'top', label: 'Above', key: '6' },
];

/** Where the camera sits for each view, looking at the body (which faces +Z, its left toward +X). */
const VIEW_DIR: Record<View, Vec3> = {
  three: [-0.72, 0.32, 0.78],
  front: [0, 0.08, 1],
  side: [-1, 0.1, 0],
  left: [1, 0.1, 0],
  back: [0, 0.35, -1],
  top: [0, 1, 0.02],
};

const BG_TOP = '#262b35';
const BG_BOTTOM = '#14171d';

function backdrop(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, BG_TOP);
  grad.addColorStop(1, BG_BOTTOM);
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function checker(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#3d434f';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#373c47';
  g.fillRect(0, 0, 128, 128);
  g.fillRect(128, 128, 128, 128);
  g.strokeStyle = 'rgba(160, 175, 200, 0.18)';
  g.lineWidth = 2;
  g.strokeRect(1, 1, 254, 254);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

const FLOOR = 60;
const mod1 = (v: number): number => v - Math.floor(v);

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.05, 400);
  readonly controls: OrbitControls;
  /** Where the take's body goes. */
  readonly bodies = new THREE.Group();
  /** Ghosts, onion skins and corrections. */
  readonly ghosts = new THREE.Group();
  /** Drawn over everything: the skeleton, trails. */
  readonly overlay = new THREE.Group();
  readonly floor: THREE.Mesh;
  readonly water: THREE.Mesh;
  private key: THREE.DirectionalLight;
  private framing: Framing = { target: [0, 0.95, 0], distance: 4.6, height: 1.8 };
  view: View = 'three';
  /** Called after each render, for the HTML drawn over the picture (labels on joints). */
  onRender: (() => void) | null = null;

  constructor(readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add('stage-canvas');

    this.scene.background = backdrop();
    this.scene.fog = new THREE.Fog(0x1b1f27, 14, 34);
    this.scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x4a4f5a, 1.55));
    this.key = new THREE.DirectionalLight(0xfff4e2, 2.3);
    this.key.position.set(-3.5, 8, 5);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    const sc = this.key.shadow.camera;
    sc.left = sc.bottom = -6;
    sc.right = sc.top = 6;
    sc.near = 0.5;
    sc.far = 30;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.03;
    this.scene.add(this.key, this.key.target);
    const rim = new THREE.DirectionalLight(0xb8d4ff, 0.9);
    rim.position.set(4, 3, -6);
    this.scene.add(rim);

    const tex = checker();
    tex.repeat.set(FLOOR, FLOOR);
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR, FLOOR).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: tex }));
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(FLOOR, FLOOR).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0x3f8fb5, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    this.water.renderOrder = 5;
    this.water.visible = false;
    this.scene.add(this.water);
    this.scene.add(this.bodies, this.ghosts, this.overlay);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.16;
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 40;
    this.controls.target.set(0, 0.95, 0);

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Frames a body: where to look and how far back. */
  frame(f: Framing, view: View = this.view): void {
    this.framing = f;
    this.setView(view);
  }

  setView(view: View): void {
    this.view = view;
    const target = new THREE.Vector3(...this.framing.target);
    const d = new THREE.Vector3(...VIEW_DIR[view]).normalize();
    this.camera.position.copy(target).addScaledVector(d, this.framing.distance);
    this.controls.target.copy(target);
    this.controls.update();
  }

  /** The camera as it is, to keep with a note and to come back to after a reload. */
  cameraState(): { position: Vec3; target: Vec3 } {
    const p = this.camera.position;
    const t = this.controls.target;
    return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
  }

  setCamera(s: { position: Vec3; target: Vec3 }): void {
    this.camera.position.set(...s.position);
    this.controls.target.set(...s.target);
    this.controls.update();
  }

  /** The ground under the body on this frame: the floor slides by however far it has gone. */
  setGround(g: { x: number; z: number; y: number; water: number | null; floor: boolean }): void {
    this.floor.visible = g.floor;
    this.floor.position.set(-mod1(g.x), g.y, -mod1(g.z));
    this.water.visible = g.water !== null;
    if (g.water !== null) this.water.position.set(0, g.water, 0);
  }

  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.onRender?.();
  }

  /** Screen position (CSS pixels in the viewport) of a point in the world; z > 1 is behind the camera. */
  toScreen(p: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    out.copy(p).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    out.x = ((out.x + 1) / 2) * r.width;
    out.y = ((1 - out.y) / 2) * r.height;
    return out;
  }

  /** The picture as it is now, drawn again first so it is current. */
  snapshot(): HTMLCanvasElement {
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    c.getContext('2d')!.drawImage(src, 0, 0);
    return c;
  }

  /** Draws from another camera for a moment (a side view for a correction), then puts it back. */
  snapshotFrom(view: View, distance?: number): HTMLCanvasElement {
    const saved = this.cameraState();
    const savedView = this.view;
    const f = this.framing;
    const target = new THREE.Vector3(...f.target);
    const d = new THREE.Vector3(...VIEW_DIR[view]).normalize();
    this.camera.position.copy(target).addScaledVector(d, distance ?? f.distance);
    this.camera.lookAt(target);
    const shot = this.snapshot();
    this.setCamera(saved);
    this.view = savedView;
    return shot;
  }
}
