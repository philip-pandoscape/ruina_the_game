import * as THREE from 'three';
import { Hero } from './character';
import { pose } from '../content/pose';
import { onUiScale, uiScale } from '../ui/theme/scale';

// The character select screen's hero: the game's own Hero, standing idle with their weapon, slowly
// turning on a glowing circle in the dusk, lit warm from behind by the setting sun. Its own small
// renderer with a see-through background, so the title screen's sky shows behind; gone (with its
// GPU context) once you enter the world. Drag to turn them yourself.

/** A three-quarter view from the front: where a new character is shown, and where the turn lingers. */
const FRONT = 0.5;
/** Radians a second: slow facing you, quicker round the back. */
const TURN_FRONT = 0.12;
const TURN_BACK = 1.0;

function ringTexture(): THREE.CanvasTexture {
  const n = 256;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  const glow = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  glow.addColorStop(0, 'rgba(255,200,120,0.55)');
  glow.addColorStop(0.45, 'rgba(255,140,60,0.22)');
  glow.addColorStop(1, 'rgba(255,120,40,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, n, n);
  g.translate(n / 2, n / 2);
  g.strokeStyle = 'rgba(255,214,150,0.9)';
  g.lineWidth = 2.5;
  for (const r of [0.8, 0.66]) {
    g.beginPath();
    g.arc(0, 0, (n / 2) * r, 0, Math.PI * 2);
    g.stroke();
  }
  // Rune marks between the rings.
  g.lineWidth = 2;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r0 = (n / 2) * 0.69;
    const r1 = (n / 2) * (i % 3 === 0 ? 0.78 : 0.74);
    g.beginPath();
    g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function shadowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(10,4,12,0.75)');
  r.addColorStop(1, 'rgba(10,4,12,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export class HeroPreview {
  readonly canvas = document.createElement('canvas');
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private hero = new Hero();
  private ring: THREE.Mesh;
  private own: Array<THREE.BufferGeometry | THREE.Material | THREE.Texture> = [];
  private yaw = FRONT;
  /** Turning back round to face you (a new character stepped up), or null. */
  private settle: number | null = null;
  private weapon = 0;
  private time = 0;
  private last = performance.now();
  private raf = 0;
  private flare = 0;
  private drag: { x: number; yaw: number } | null = null;
  private still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private disposed = false;

  constructor(
    private width: number,
    private height: number,
  ) {
    this.canvas.className = 'cs-hero';
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.setClearColor(0x000000, 0);
    this.camera = new THREE.PerspectiveCamera(26, width / height, 0.1, 40);
    this.camera.position.set(0, 1.0, 4.75);
    this.camera.lookAt(0, 0.86, 0);

    // Dusk: a violet sky above, the warm ground below, the setting sun behind and to one side
    // (the rim of light), and a soft key from the front.
    this.scene.add(new THREE.HemisphereLight(0x9a8ad0, 0x4a2224, 1.15));
    const key = new THREE.DirectionalLight(0xffe2c0, 1.5);
    key.position.set(-2.5, 3, 4);
    const rim = new THREE.DirectionalLight(0xff8a3c, 4.2);
    rim.position.set(3, 2.2, -3.5);
    const rim2 = new THREE.DirectionalLight(0xffb070, 2.2);
    rim2.position.set(-3.2, 1.5, -2.5);
    const fill = new THREE.DirectionalLight(0x8090ff, 0.45);
    fill.position.set(3, 1, 3);
    this.scene.add(key, rim, rim2, fill);

    const ringTex = ringTexture();
    const ringGeo = new THREE.PlaneGeometry(2.6, 2.6).rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.ring = new THREE.Mesh(ringGeo, ringMat);
    this.ring.position.y = 0.01;
    const shadowTex = shadowTexture();
    const shadowGeo = new THREE.PlaneGeometry(1.3, 1.3).rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false });
    const shadow = new THREE.Mesh(shadowGeo, shadowMat);
    shadow.position.y = 0.02;
    this.own.push(ringTex, ringGeo, ringMat, shadowTex, shadowGeo, shadowMat);
    this.scene.add(this.ring, shadow, this.hero.root);

    this.resize();
    onUiScale(() => this.resize());
    this.canvas.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, yaw: this.yaw };
      this.settle = null;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.drag) this.yaw = this.drag.yaw + (e.clientX - this.drag.x) * 0.012;
    });
    const release = () => (this.drag = null);
    this.canvas.addEventListener('pointerup', release);
    this.canvas.addEventListener('pointercancel', release);
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Someone steps up: shows the weapon they carry (0 sword, 1 club, 2 staff, 3 bow), facing you. */
  show(weapon: number, flourish = true): void {
    this.weapon = weapon;
    this.settle = FRONT;
    if (flourish && !this.still) this.flare = 1;
  }

  private resize(): void {
    if (this.disposed) return;
    // Drawn at the size it appears on screen: the UI's scale times the screen's pixel density.
    const k = uiScale() * Math.min(2, devicePixelRatio || 1);
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(Math.round(this.width * k), Math.round(this.height * k), false);
  }

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    if (this.settle !== null && !this.drag) {
      // Round the short way to face you, then the slow turn carries on from there.
      const off = Math.atan2(Math.sin(this.settle - this.yaw), Math.cos(this.settle - this.yaw));
      this.yaw += off * (this.still ? 1 : 1 - Math.exp(-dt * 5));
      if (Math.abs(off) < 0.01) this.settle = null;
    } else if (!this.drag && !this.still) {
      const away = (1 - Math.cos(this.yaw - FRONT)) / 2;
      this.yaw += (TURN_FRONT + (TURN_BACK - TURN_FRONT) * away) * dt;
    }
    this.hero.root.rotation.y = this.yaw;
    this.hero.drive(pose({ time: this.time, weapon: this.weapon, stow: 0 }), 0, dt);
    // The circle turns slowly the other way, and flares when someone new steps onto it.
    this.flare = Math.max(0, this.flare - dt * 1.6);
    this.ring.rotation.y -= dt * 0.15;
    this.ring.scale.setScalar(1 + this.flare * 0.25);
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.85 + this.flare * 0.35;
    this.renderer.render(this.scene, this.camera);
  };

  /** Stops drawing and gives the GPU context back (the game is about to make its own). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    // Only what this made: the hero's meshes and materials are shared with the game's.
    for (const o of this.own) o.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
