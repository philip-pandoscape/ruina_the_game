import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Framing, Backdrop, Vec3 } from './types';

// The library's viewport: a quiet studio (soft key light, a checked floor a metre a tile, fog at the
// edges) so a pose reads clearly. The body stays in view while the floor slides under it by however
// far it has travelled, so a planted foot stays put on the checks. A take can ask for another
// backdrop (BACKDROPS): the hero's films outdoors, a rig on the creature bench, a library clip on the
// retargeting check's grid, each as the page it came from drew it.

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

/** A backdrop: the sky behind, the lights, and the floor (checks a metre a tile, or flat with a metre grid). */
interface Look {
  /** A gradient, top to bottom, or one colour. */
  sky: [string, string] | number;
  fog: [number, number, number] | null;
  hemi: [number, number, number];
  key: { color: number; intensity: number; at: Vec3; shadows: boolean };
  rim: { color: number; intensity: number; at: Vec3 } | null;
  floor: { checks: [string, string]; line: string; inset: number } | { color: number; grid: [number, number] } | null;
  water: number;
}

export const BACKDROPS: Record<Backdrop, Look> = {
  // The library's own.
  studio: {
    sky: ['#262b35', '#14171d'],
    fog: [0x1b1f27, 14, 34],
    hemi: [0xe8f0ff, 0x4a4f5a, 1.55],
    key: { color: 0xfff4e2, intensity: 2.3, at: [-3.5, 8, 5], shadows: true },
    rim: { color: 0xb8d4ff, intensity: 0.9, at: [4, 3, -6] },
    floor: { checks: ['#3d434f', '#373c47'], line: 'rgba(160, 175, 200, 0.18)', inset: 1 },
    water: 0.5,
  },
  // The hero's films as their own page showed them (dev/animations.html, folded in here): sky, and
  // grass checks a metre a tile.
  outdoors: {
    sky: 0x9fc9dc,
    fog: null,
    hemi: [0xe4f2ff, 0x5d6b4a, 1.3],
    key: { color: 0xfff2dc, intensity: 2.4, at: [-4, 9, 5], shadows: true },
    rim: null,
    floor: { checks: ['#8fa36b', '#86995f'], line: 'rgba(40, 50, 30, 0.35)', inset: 0 },
    water: 0.55,
  },
  // The creature bench (dev/creatures.html, folded in here): a dark room, no floor.
  bench: {
    sky: 0x1a1b20,
    fog: null,
    hemi: [0xcfd8ff, 0x2a2f3a, 1.5],
    key: { color: 0xffffff, intensity: 2.2, at: [3, 6, 4], shadows: false },
    rim: null,
    floor: null,
    water: 0.5,
  },
  // The retargeting check (dev/retarget.html, folded in here): a pale sky, a field with a metre grid.
  retarget: {
    sky: 0xd9e2e6,
    fog: null,
    hemi: [0xdff1ff, 0x5d7f3a, 1.5],
    key: { color: 0xfff0d8, intensity: 2.4, at: [2, 5, 4], shadows: false },
    rim: null,
    floor: { color: 0xa9b89a, grid: [0x7d8c70, 0x8d9c80] },
    water: 0.5,
  },
};

function backdrop(top: string, bottom: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, top);
  grad.addColorStop(1, bottom);
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function checker(a: string, b: string, line: string, inset: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = a;
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = b;
  g.fillRect(0, 0, 128, 128);
  g.fillRect(128, 128, 128, 128);
  g.strokeStyle = line;
  g.lineWidth = 2;
  g.strokeRect(inset, inset, 256 - 2 * inset, 256 - 2 * inset);
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
  readonly floor: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>;
  readonly water: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>;
  private key: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private rim: THREE.DirectionalLight;
  private grid: THREE.GridHelper | null = null;
  private textures = new Map<string, THREE.Texture>();
  private framing: Framing = { target: [0, 0.95, 0], distance: 4.6, height: 1.8 };
  view: View = 'three';
  /** The backdrop drawn now. */
  backdrop: Backdrop | null = null;
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

    this.hemi = new THREE.HemisphereLight(0xe8f0ff, 0x4a4f5a, 1.55);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xfff4e2, 2.3);
    this.key.shadow.mapSize.set(2048, 2048);
    const sc = this.key.shadow.camera;
    sc.left = sc.bottom = -6;
    sc.right = sc.top = 6;
    sc.near = 0.5;
    sc.far = 30;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.03;
    this.scene.add(this.key, this.key.target);
    this.rim = new THREE.DirectionalLight(0xb8d4ff, 0.9);
    this.scene.add(this.rim);

    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR, FLOOR).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial());
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
    this.setBackdrop('studio');

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

  /** Draws on another backdrop (BACKDROPS): its sky, lights and floor. */
  setBackdrop(name: Backdrop): void {
    if (this.backdrop === name) return;
    this.backdrop = name;
    const l = BACKDROPS[name];
    const texture = (key: string, make: () => THREE.Texture) => {
      if (!this.textures.has(key)) this.textures.set(key, make());
      return this.textures.get(key)!;
    };
    const sky = l.sky;
    this.scene.background = typeof sky === 'number' ? new THREE.Color(sky) : texture(sky.join(), () => backdrop(...sky));
    this.scene.fog = l.fog ? new THREE.Fog(...l.fog) : null;
    this.hemi.color.set(l.hemi[0]);
    this.hemi.groundColor.set(l.hemi[1]);
    this.hemi.intensity = l.hemi[2];
    this.key.color.set(l.key.color);
    this.key.intensity = l.key.intensity;
    this.key.position.set(...l.key.at);
    this.key.castShadow = l.key.shadows;
    this.rim.visible = !!l.rim;
    if (l.rim) {
      this.rim.color.set(l.rim.color);
      this.rim.intensity = l.rim.intensity;
      this.rim.position.set(...l.rim.at);
    }
    const m = this.floor.material;
    this.grid?.removeFromParent();
    this.grid = null;
    const floor = l.floor;
    if (floor && 'checks' in floor) {
      m.map = texture([...floor.checks, floor.line, floor.inset].join(), () => {
        const t = checker(floor.checks[0], floor.checks[1], floor.line, floor.inset);
        t.repeat.set(FLOOR, FLOOR);
        return t;
      });
      m.color.set(0xffffff);
    } else if (floor) {
      m.map = null;
      m.color.set(floor.color);
      // One line a metre, sliding with the floor.
      this.grid = new THREE.GridHelper(FLOOR, FLOOR, floor.grid[0], floor.grid[1]);
      this.grid.position.y = 0.002;
      this.floor.add(this.grid);
    }
    m.needsUpdate = true;
    this.floor.visible = !!floor;
    this.water.material.opacity = l.water;
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
    this.floor.visible = g.floor && !!BACKDROPS[this.backdrop ?? 'studio'].floor;
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
