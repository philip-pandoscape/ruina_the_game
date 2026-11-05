import * as THREE from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { pose } from '../content/pose';
import { Hero } from './character';

// Your own portraits (your face beside your health and in the skill tree, all of you in the
// character window), taken in a studio of their own rather than from the world: a second Hero
// dressed as you, standing at ease with the weapon put away, under fixed lights against a plain
// backdrop. So the picture shows how you look, never what you happen to be doing (running,
// swinging, swimming, riding, carrying a pack), which way the camera faces, the hour or the weather.
// It is taken once, and again only when how you look changes.
//
// Drawn offscreen and read back: the scene into a linear buffer, then three's output pass lays the
// renderer's own tone mapping and colour space over it, as a frame drawn straight to the screen
// would get them, so the picture comes out in the colours of whichever look the game is drawn in.

/** Your face (head and shoulders), or all of you from your hair to your boots. */
export type StudioShot = 'face' | 'body';

/** Everything about how you look that a portrait shows: a change to any of it takes a new one. */
export interface Looks {
  weapon: number;
  /** Team colours (the battlefield's two sides); 0 elsewhere. */
  team: number;
  /** Whose looks they are (a character's id). */
  who: string;
}

/** The pictures' sizes in pixels: twice what they're shown at on a plain screen, so they're sharp on a fine one. */
const SIZES: Record<StudioShot, [number, number]> = { face: [256, 256], body: [428, 600] };

/**
 * Where the camera stands, in the hero's own heights (its feet at 0, the top of its head at 1), so a
 * taller or shorter body is framed the same: the height it looks at, the height it looks from, and
 * how far in front it stands. Your face with your shoulders and the top of your chest; all of you
 * with a little room round you. (For the hero as built now, 1.68 m, the framing the live portraits had.)
 */
const FRAMING: Record<StudioShot, { look: number; eye: number; distance: number }> = {
  face: { look: 0.798, eye: 0.846, distance: 1.132 },
  body: { look: 0.506, eye: 0.566, distance: 2.74 },
};
const FOV = 26;

/** A clear day's sky behind you, and the light of one: the sky's and the sun's, high and in front. */
const BACKDROP = 0xcde9f3;
const LIGHT = { sky: 0xe2f2ff, ground: 0x5d7f3a, fill: 1.25, sun: 0xfff0d8, sunIntensity: 2.6, sunFrom: [1.4, 2.6, 2.4] as const };

/** Pictures kept: going back to how you looked a moment ago (the weapon you had) needs no new one. */
const KEEP = 8;

/** The top of what's drawn of a body standing at 0: only what's shown (not the weapons put out of sight). */
function heightOf(root: THREE.Object3D): number {
  const box = new THREE.Box3();
  const part = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    box.union(part.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld));
  });
  return box.isEmpty() ? 0 : box.max.y;
}

export class Studio {
  private scene = new THREE.Scene();
  private hero = new Hero();
  private cam = new THREE.PerspectiveCamera(FOV, 1, 0.05, 50);
  private output = new OutputPass();
  private canvas = document.createElement('canvas');
  private shots = new Map<string, string>();
  /** The hero's height, measured when it first stands for a picture; and what its body is made of then. */
  private height = 0;
  private body = '';
  /** Pictures taken so far. */
  taken = 0;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.scene.background = new THREE.Color(BACKDROP);
    const sun = new THREE.DirectionalLight(LIGHT.sun, LIGHT.sunIntensity);
    sun.position.set(...LIGHT.sunFrom);
    this.scene.add(new THREE.HemisphereLight(LIGHT.sky, LIGHT.ground, LIGHT.fill), sun, sun.target, this.hero.root);
  }

  /**
   * Your picture (a PNG data URL) looking as `looks` says: taken now if it hasn't been taken of you
   * looking like that (or the body it's taken of has changed since: its model arrived, say).
   */
  shot(kind: StudioShot, looks: Looks): string {
    const body = this.bodyKey();
    if (body !== this.body) {
      this.body = body;
      this.shots.clear();
      this.height = 0;
    }
    const key = `${kind}|${looks.weapon}|${looks.team}|${looks.who}`;
    let url = this.shots.get(key);
    if (url === undefined) {
      url = this.take(kind, looks);
      if (this.shots.size >= KEEP) this.shots.delete(this.shots.keys().next().value!);
    }
    // Newest last.
    this.shots.delete(key);
    this.shots.set(key, url);
    return url;
  }

  /** What the hero's body is made of, whatever builds it: its shapes and the pictures painted on them. */
  private bodyKey(): string {
    const parts: string[] = [];
    this.hero.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      parts.push(`${m.geometry?.uuid}:${mats.map((x) => (x as THREE.MeshStandardMaterial).map?.version ?? '').join('.')}`);
    });
    return parts.join('|');
  }

  private take(kind: StudioShot, looks: Looks): string {
    const [w, h] = SIZES[kind];
    // Dressed as you, standing at ease, weapon put away. Posed afresh (a step long enough to forget
    // whatever it last stood for), so the same looks always give the same picture.
    this.hero.setTeam(looks.team);
    this.hero.drive(pose({ weapon: looks.weapon, stow: 1 }), 0, 1);
    this.hero.root.updateMatrixWorld(true);
    if (!this.height) this.height = heightOf(this.hero.root) || 1.75;
    const f = FRAMING[kind];
    this.cam.aspect = w / h;
    this.cam.position.set(0, f.eye * this.height, f.distance * this.height);
    this.cam.lookAt(0, f.look * this.height, 0);
    this.cam.updateProjectionMatrix();

    const r = this.renderer;
    const linear = new THREE.WebGLRenderTarget(w, h, { samples: 4, type: r.extensions.has('EXT_color_buffer_float') ? THREE.HalfFloatType : THREE.UnsignedByteType });
    const out = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
    const was = { target: r.getRenderTarget(), autoClear: r.autoClear, infoReset: r.info.autoReset };
    // The frame's own draw counts are left alone.
    r.info.autoReset = false;
    r.autoClear = true;
    r.setRenderTarget(linear);
    r.render(this.scene, this.cam);
    this.output.render(r, out, linear, 0, false);
    const px = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(out, 0, 0, w, h, px);
    r.setRenderTarget(was.target);
    r.autoClear = was.autoClear;
    r.info.autoReset = was.infoReset;
    linear.dispose();
    out.dispose();

    const c = this.canvas;
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    const img = g.createImageData(w, h);
    // The rows come bottom first.
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    g.putImageData(img, 0, 0);
    this.taken++;
    return c.toDataURL('image/png');
  }
}
