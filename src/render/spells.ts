import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toon } from './toon';
import type { Vfx } from './vfx';

const MAX_ARROWS = 128;
const MAX_METEORS = 16;
const MAX_CIRCLES = 48;
// Meteors streak in from beyond their target (as the camera saw it when they first appeared), so
// they come down in plain view instead of from straight overhead.
const SKY_AHEAD = 14;
const SKY_SIDE = 4;
const SKY_UP = 13;

export const CIRCLE = {
  enemy: 0xff3b2f,
  ally: 0xffa53a,
  heal: 0x4dff9a,
  gather: 0x9dff5c, // a monster pulling its pack in
  // Placing a cast is a UI state, not an incoming attack, so it gets a colour no spell uses.
  // Cyan also stays legible on both the grass and the dirt; the old gold vanished on sand.
  aim: 0x35e0ff, // where a ground-targeted cast will land while you're still aiming it
  range: 0xbfe9ff, // how far that cast can reach
};

// A part of the arrow model, coloured per vertex so the whole arrow is one instanced mesh.
function colored(geo: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = geo.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

// Arrow pointing along +Z, its tip at z = 0.45.
function arrowGeometry(): THREE.BufferGeometry {
  const shaft = new THREE.CylinderGeometry(0.02, 0.02, 0.9, 5).rotateX(Math.PI / 2).translate(0, 0, -0.1);
  const head = new THREE.ConeGeometry(0.05, 0.16, 5).rotateX(Math.PI / 2).translate(0, 0, 0.42);
  const fin1 = new THREE.PlaneGeometry(0.12, 0.18).rotateX(Math.PI / 2).rotateZ(Math.PI / 2).translate(0, 0, -0.48);
  const fin2 = new THREE.PlaneGeometry(0.12, 0.18).rotateX(Math.PI / 2).translate(0, 0, -0.48);
  const parts = [colored(shaft, 0xd9c39a), colored(head, 0xdfe6ee), colored(fin1, 0xf4f1e8), colored(fin2, 0xf4f1e8)];
  return mergeGeometries(parts.map((g) => g.toNonIndexed()))!;
}

// A fading light streak trailing behind an arrow (two crossed strips along -Z).
function streakGeometry(): THREE.BufferGeometry {
  const strips = [0, Math.PI / 2].map((rot) => {
    const g = new THREE.PlaneGeometry(0.07, 2.4, 1, 6).rotateX(Math.PI / 2).rotateZ(rot).translate(0, 0, -1.3);
    const pos = g.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const k = Math.max(0, Math.min(1, 1 + (pos.getZ(i) + 0.1) / 2.4)); // 1 at the arrow, 0 at the tail
      colors.set([k * 1.0, k * 0.92, k * 0.7], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g.toNonIndexed();
  });
  return mergeGeometries(strips)!;
}

/**
 * What ground circles lie on in an open world: its height anywhere, and the grid the terrain's
 * heights are kept on. A circle's mesh is cut along the same lines and split the same way as the
 * terrain's triangles (src/sim/terrain.ts height()), so on open ground it lies exactly on the drawn
 * surface, however steep the hill.
 */
export interface CircleGround {
  /**
   * Height to lie on at (x, z). `near` is the height of whoever the circle is about (NaN: nobody in
   * particular), so a deck or a roof they stand on counts. `pad` is how far the circle's mesh reaches
   * from this point (metres): ground drawn over the terrain that near (a farm's soil and furrows)
   * counts too, or the circle would be cut where it runs onto it between two of its points.
   */
  height(x: number, z: number, near: number, pad: number): number;
  /** Metres between the terrain's grid lines, and where line 0 is (x and z alike). */
  cell: number;
  origin: number;
}

/** How far a circle floats over what it lies on (metres); the polygon offset does the rest. */
const LIFT = 0.025;

interface Circle {
  mesh: THREE.Mesh;
  uniforms: { uColor: { value: THREE.Color }; uFill: { value: number }; uAlpha: { value: number } };
  /** Its own mesh for lying on uneven ground, rebuilt each frame it's shown. */
  draped: THREE.BufferGeometry;
  /** Vertices that mesh has room for, and the grid size its triangles were last laid out for. */
  room: number;
  cols: number;
  rows: number;
}

const FLAT = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);

/** Grid spacing for a circle: the terrain's own, finer for a small circle so a deck's edge is followed. */
function spacing(cell: number, radius: number): number {
  let s = cell;
  while (s > cell / 4 && s > radius / 2) s /= 2;
  return s;
}

// A warning circle on the ground: a crisp outer ring and a disc that grows to fill it.
function makeCircle(scene: THREE.Scene): Circle {
  const uniforms = { uColor: { value: new THREE.Color() }, uFill: { value: 0 }, uAlpha: { value: 1 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uFill;
      uniform float uAlpha;
      varying vec2 vUv;
      void main() {
        float r = length(vUv * 2.0 - 1.0);
        if (r > 1.0) discard;
        float ring = smoothstep(0.9, 0.95, r) * (1.0 - smoothstep(0.975, 1.0, r));
        float disc = (1.0 - smoothstep(uFill - 0.015, uFill, r)) * (0.16 + 0.22 * uFill);
        float front = smoothstep(uFill - 0.07, uFill, r) * (1.0 - smoothstep(uFill, uFill + 0.012, r)) * step(0.02, uFill);
        float a = max(ring * 0.95, max(disc, front * 0.85)) * uAlpha;
        gl_FragColor = vec4(uColor, a);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(FLAT, mat);
  mesh.visible = false;
  mesh.renderOrder = 4;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { mesh, uniforms, draped: new THREE.BufferGeometry(), room: 0, cols: 0, rows: 0 };
}

/**
 * Lays circle `c` on the ground over (x, z): a grid of vertices on the terrain's lines, each at the
 * ground's height there, with texture coordinates running -1..1 across the circle so the shader
 * draws the same ring and disc it draws on a flat plane.
 */
function drape(c: Circle, g: CircleGround, x: number, z: number, radius: number, near: number): void {
  const s = spacing(g.cell, radius);
  const i0 = Math.floor((x - radius - g.origin) / s);
  const i1 = Math.ceil((x + radius - g.origin) / s);
  const j0 = Math.floor((z - radius - g.origin) / s);
  const j1 = Math.ceil((z + radius - g.origin) / s);
  const cols = Math.max(2, i1 - i0 + 1);
  const rows = Math.max(2, j1 - j0 + 1);
  const n = cols * rows;
  const geo = c.draped;
  if (n > c.room) {
    c.room = Math.ceil(n * 1.5);
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(c.room * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(c.room * 2), 2).setUsage(THREE.DynamicDrawUsage));
    c.cols = c.rows = 0;
  }
  if (cols !== c.cols || rows !== c.rows) {
    // Quad a (i, j), b (i+1, j), c (i, j+1), d (i+1, j+1), split along a-d as the terrain is.
    const idx: number[] = [];
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i;
        const b = a + 1;
        const cc = a + cols;
        const d = cc + 1;
        idx.push(a, d, b, a, cc, d);
      }
    }
    geo.setIndex(idx);
    c.cols = cols;
    c.rows = rows;
  }
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const p = pos.array as Float32Array;
  const t = uv.array as Float32Array;
  // Every triangle touching a point lies within a cell of it, along the grid or across.
  const pad = s * Math.SQRT2;
  let k = 0;
  for (let j = 0; j < rows; j++) {
    const wz = g.origin + (j0 + j) * s;
    for (let i = 0; i < cols; i++, k++) {
      const wx = g.origin + (i0 + i) * s;
      p[k * 3] = wx;
      p[k * 3 + 1] = g.height(wx, wz, near, pad) + LIFT;
      p[k * 3 + 2] = wz;
      t[k * 2] = ((wx - x) / radius + 1) / 2;
      t[k * 2 + 1] = ((wz - z) / radius + 1) / 2;
    }
  }
  pos.needsUpdate = true;
  uv.needsUpdate = true;
  geo.setDrawRange(0, (cols - 1) * (rows - 1) * 6);
}

// Arrows in flight, falling meteors and warning circles on the ground. Pooled: each frame, call
// begin(), add whatever is visible, then end().
export class SpellView {
  private arrows: THREE.InstancedMesh;
  private streaks: THREE.InstancedMesh;
  private arrowCount = 0;
  private meteors: THREE.Group[] = [];
  private meteorCount = 0;
  private circles: Circle[] = [];
  private circleCount = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3(1, 1, 1);
  private v = new THREE.Vector3();
  private e = new THREE.Euler();
  private time = 0;
  private camYaw = 0;
  private skyYaw = new Map<string, number>(); // the direction each meteor is coming from
  private seen = new Set<string>();
  /** The ground in an open world, for circles to lie on and meteors to come down to; null on flat ground at 0. */
  ground: CircleGround | null = null;

  constructor(scene: THREE.Scene, private vfx: Vfx) {
    const arrowMat = toon(0xffffff);
    arrowMat.vertexColors = true;
    this.arrows = new THREE.InstancedMesh(arrowGeometry(), arrowMat, MAX_ARROWS);
    const streakMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.streaks = new THREE.InstancedMesh(streakGeometry(), streakMat, MAX_ARROWS);
    for (const mesh of [this.arrows, this.streaks]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      scene.add(mesh);
    }
    this.streaks.renderOrder = 9;

    const coreGeo = new THREE.IcosahedronGeometry(0.6, 1);
    const glowGeo = new THREE.IcosahedronGeometry(1.15, 2);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffd27a, toneMapped: false });
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xff5a14,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    for (let i = 0; i < MAX_METEORS; i++) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(coreGeo, coreMat), new THREE.Mesh(glowGeo, glowMat));
      g.visible = false;
      scene.add(g);
      this.meteors.push(g);
    }
    for (let i = 0; i < MAX_CIRCLES; i++) this.circles.push(makeCircle(scene));
  }

  get arrowsDrawn(): number {
    return this.arrowCount;
  }

  get meteorsDrawn(): number {
    return this.meteorCount;
  }

  get circlesDrawn(): number {
    return this.circleCount;
  }

  begin(dt: number, camYaw: number): void {
    this.time += dt;
    this.camYaw = camYaw;
    this.seen.clear();
    this.arrowCount = 0;
    this.meteorCount = 0;
    this.circleCount = 0;
  }

  arrow(x: number, y: number, z: number, dirX: number, dirZ: number): void {
    if (this.arrowCount >= MAX_ARROWS) return;
    this.q.setFromEuler(this.e.set(0, Math.atan2(dirX, dirZ), 0));
    this.m.compose(this.v.set(x, y, z), this.q, this.s);
    this.arrows.setMatrixAt(this.arrowCount, this.m);
    this.streaks.setMatrixAt(this.arrowCount, this.m);
    this.arrowCount++;
  }

  // A meteor `fall` of the way (0..1) down onto (x, z), with its warning circle underneath.
  meteor(x: number, z: number, fall: number, radius: number, hostile: boolean): void {
    this.circle(x, z, radius, fall, hostile ? CIRCLE.enemy : CIRCLE.ally, 1);
    if (this.meteorCount >= MAX_METEORS) return;
    const g = this.meteors[this.meteorCount++];
    const key = `${Math.round(x * 10)},${Math.round(z * 10)}`;
    const yaw = this.skyYaw.get(key) ?? this.camYaw;
    this.skyYaw.set(key, yaw);
    this.seen.add(key);
    const k = 1 - Math.min(1, fall);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    // Down to the ground it's aimed at, up on the hills too.
    const floor = this.ground ? this.ground.height(x, z, NaN, 0) : 0;
    g.position.set(x + (fx * SKY_AHEAD - fz * SKY_SIDE) * k, floor + 0.5 + SKY_UP * k, z + (fz * SKY_AHEAD + fx * SKY_SIDE) * k);
    g.rotation.set(this.time * 7, this.time * 5, 0);
    g.scale.setScalar(1 + 0.08 * Math.sin(this.time * 40));
    g.visible = true;
    this.vfx.fireTrail(g.position.x, g.position.y, g.position.z);
  }

  /**
   * A ground circle of `radius` metres, its disc filled `fill` of the way out. In an open world it
   * lies on the ground, over hills and folds; `near` is the height of whoever it's about, so a deck
   * or roof they stand on counts as ground (NaN: the terrain).
   */
  circle(x: number, z: number, radius: number, fill: number, color: number, alpha: number, near = NaN): void {
    if (this.circleCount >= MAX_CIRCLES || !(radius > 0)) return;
    const c = this.circles[this.circleCount++];
    if (this.ground) {
      drape(c, this.ground, x, z, radius, near);
      c.mesh.geometry = c.draped;
      c.mesh.position.set(0, 0, 0);
      c.mesh.scale.setScalar(1);
    } else {
      c.mesh.geometry = FLAT;
      c.mesh.position.set(x, 0.03, z);
      c.mesh.scale.setScalar(radius);
    }
    c.uniforms.uColor.value.set(color);
    c.uniforms.uFill.value = Math.max(0, Math.min(1, fill));
    c.uniforms.uAlpha.value = alpha;
    c.mesh.visible = true;
  }

  /** Testing: the height of the highest circle drawn over (x, z), inside its ring, or null. */
  heightAt(x: number, z: number): number | null {
    const ray = new THREE.Raycaster(new THREE.Vector3(x, 1e4, z), new THREE.Vector3(0, -1, 0), 0, 2e4);
    let best: number | null = null;
    for (let i = 0; i < this.circleCount; i++) {
      const c = this.circles[i];
      c.mesh.updateMatrixWorld();
      // The draped mesh moves every frame; the bounds the raycaster checks first must follow.
      c.mesh.geometry.computeBoundingSphere();
      c.mesh.geometry.computeBoundingBox();
      for (const h of ray.intersectObject(c.mesh, false)) {
        if (h.uv && Math.hypot(h.uv.x * 2 - 1, h.uv.y * 2 - 1) > 1) continue;
        best = Math.max(best ?? -Infinity, h.point.y);
      }
    }
    return best;
  }

  end(): void {
    this.arrows.count = this.arrowCount;
    this.streaks.count = this.arrowCount;
    this.arrows.instanceMatrix.needsUpdate = true;
    this.streaks.instanceMatrix.needsUpdate = true;
    for (let i = this.meteorCount; i < MAX_METEORS; i++) this.meteors[i].visible = false;
    for (const key of this.skyYaw.keys()) if (!this.seen.has(key)) this.skyYaw.delete(key);
    for (let i = this.circleCount; i < MAX_CIRCLES; i++) this.circles[i].mesh.visible = false;
  }
}
