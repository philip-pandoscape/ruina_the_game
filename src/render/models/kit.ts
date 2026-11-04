import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from '../../rng';
import { outlineMaterial, toon } from '../toon';

// The toolkit every procedural model in this folder is built with. Models are assembled from
// simple shapes that are placed, given a flat colour per face and merged, so a whole building is
// one vertex-coloured mesh drawn with the shared toon material (and a thousand crops are one
// InstancedMesh). Things that move (wheels, oars, legs, sails) stay separate pivots.
//
// Conventions: metres; +Y is up; a model faces +Z and its right-hand side is -X.

export const TAU = Math.PI * 2;
export { makeRng };

export type V3 = readonly [number, number, number];
export type Rgb = number | THREE.Color;
/** Colours a face from where it ended up (model space): stripes, bands, speckle. */
export type ColorFn = (centroid: THREE.Vector3, normal: THREE.Vector3, face: number) => Rgb;
export type Col = Rgb | ColorFn;

// ---------- palette ----------

/** One palette for the island, so separately built models still look like they belong together. */
export const PAL = {
  // shared with src/render/scene.ts
  grass: 0x86c55a,
  grassDark: 0x5fa843,
  trunk: 0x8d5a3b,
  leaf: 0x4caf50,
  leafMid: 0x3e9a45,
  leafDark: 0x2e7d32,
  rock: 0x9a9a94,
  crate: 0xb07a45,
  hay: 0xe2c158,
  sky: 0xbfe3f2,
  // timber
  wood: 0xa8743f,
  woodLight: 0xc8995f,
  woodPale: 0xdcbb8c,
  woodDark: 0x734828,
  woodDeep: 0x4f3121,
  woodGrey: 0x9d8d7a,
  woodGreyDark: 0x7b6d5f,
  // building
  plaster: 0xf3e7c9,
  plasterShade: 0xe6d6b3,
  stone: 0xbcb6aa,
  stoneLight: 0xd6d0c3,
  stoneDark: 0x928c82,
  brick: 0xb3573f,
  brickDark: 0x8f4332,
  thatch: 0xd9b45c,
  thatchDark: 0xb48d3f,
  slate: 0x5d7a9c,
  slateDark: 0x4a6385,
  roofRed: 0xc4553f,
  roofRedDark: 0xa04434,
  roofBlue: 0x4f78ab,
  shingle: 0x8b6a4b,
  shingleDark: 0x6f5239,
  // metal
  iron: 0x3d444f,
  ironLight: 0x69727e,
  steel: 0xcfd7df,
  brass: 0xe0b84a,
  gold: 0xf2c94c,
  copper: 0xc7763f,
  // cloth, rope, leather
  canvas: 0xf3e7cb,
  canvasShade: 0xdfcda6,
  sack: 0xc9a878,
  rope: 0xd2b98d,
  leather: 0x7d4b2a,
  leatherDark: 0x5a341d,
  // paint
  red: 0xd9473b,
  redDark: 0xa8342c,
  cream: 0xf6ecd2,
  green: 0x4f8f4a,
  doorGreen: 0x4d8b57,
  blue: 0x3a6ea5,
  skyBlue: 0x5aaee0,
  teal: 0x2fa69d,
  yellow: 0xf2c84b,
  mustard: 0xe0ac3a,
  orange: 0xe8833a,
  white: 0xf7f7f2,
  black: 0x2a2e35,
  // ground & water
  soil: 0x6e4b33,
  soilDark: 0x553a28,
  soilLight: 0x8a6446,
  sand: 0xe0cc98,
  sea: 0x3d9fd1,
  // light
  glow: 0xffd47e,
  glowHot: 0xffad4a,
  dark: 0x1d2733,
} as const;

// ---------- colour helpers ----------

export const color = (c: Rgb): THREE.Color => (c instanceof THREE.Color ? c.clone() : new THREE.Color(c));
/** Scales a colour's brightness (in linear light). */
export const mul = (c: Rgb, f: number): THREE.Color => color(c).multiplyScalar(f);
export const mix = (a: Rgb, b: Rgb, t: number): THREE.Color => color(a).lerp(color(b), t);
/** A colour nudged lighter or darker by a seeded random amount, for natural variation. */
export const vary = (c: Rgb, rng: () => number, amount = 0.08): THREE.Color => mul(c, 1 + (rng() * 2 - 1) * amount);
/** Bands along an axis: alternates the colours every `size` metres. */
export const bands =
  (axis: 'x' | 'y' | 'z', size: number, ...cols: Rgb[]): ColorFn =>
  (c) =>
    cols[((Math.floor(c[axis] / size) % cols.length) + cols.length) % cols.length];

// ---------- geometry primitives ----------

export const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
/** A box with chamfered edges: reads as solid and catches a highlight on every edge. */
export const bev = (w: number, h: number, d: number, r = 0.03, seg = 1) => new RoundedBoxGeometry(w, h, d, seg, r);
export const cyl = (rTop: number, rBottom: number, h: number, sides = 8, open = false) =>
  new THREE.CylinderGeometry(rTop, rBottom, h, sides, 1, open);
export const cone = (r: number, h: number, sides = 8) => new THREE.ConeGeometry(r, h, sides);
export const ico = (r: number, detail = 0) => new THREE.IcosahedronGeometry(r, detail);
export const dodec = (r: number) => new THREE.DodecahedronGeometry(r, 0);
export const octa = (r: number) => new THREE.OctahedronGeometry(r, 0);
export const sph = (r: number, w = 8, h = 6) => new THREE.SphereGeometry(r, w, h);
export const tor = (r: number, tube: number, radial = 4, tubular = 12, arc = TAU) =>
  new THREE.TorusGeometry(r, tube, radial, tubular, arc);

/** A box given by its extents rather than its centre: handy for walls and floors. */
export function span(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

/** Surface of revolution about +Y. Profile points are [radius, y], listed bottom to top. */
export function lathe(profile: ReadonlyArray<readonly [number, number]>, sides = 10, phase = 0): THREE.BufferGeometry {
  return new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-4), y)),
    sides,
    phase,
  );
}

/** A flat ring (washer) about +Y: wheel rims, barrel hoops, railings. */
export function ring(rIn: number, rOut: number, h: number, sides = 12): THREE.BufferGeometry {
  return lathe(
    [
      [rIn, -h / 2],
      [rOut, -h / 2],
      [rOut, h / 2],
      [rIn, h / 2],
      [rIn, -h / 2],
    ],
    sides,
  );
}

/** A polygon in the XY plane pushed out along Z (centred on z = 0). */
export function extrude(points: ReadonlyArray<readonly [number, number]>, depth: number, curveSegments = 8): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments });
  g.translate(0, 0, -depth / 2);
  return g;
}

/** Part of a thick ring in the XY plane between two angles, pushed out along Z: arches, mudguards, ribs. */
export function arc(rIn: number, rOut: number, depth: number, a0: number, a1: number, segs = 8): THREE.BufferGeometry {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + ((a1 - a0) * i) / segs;
    pts.push([Math.cos(a) * rOut, Math.sin(a) * rOut]);
  }
  for (let i = segs; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / segs;
    pts.push([Math.cos(a) * rIn, Math.sin(a) * rIn]);
  }
  return extrude(pts, depth);
}

const UP = new THREE.Vector3(0, 1, 0);

/** A square-section beam from a to b (braces, rafters, rails, rigging). */
export function beam(a: V3, b: V3, w: number, h = w): THREE.BufferGeometry {
  const A = new THREE.Vector3(...a);
  const B = new THREE.Vector3(...b);
  const d = B.clone().sub(A);
  const g = new THREE.BoxGeometry(w, d.length(), h);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()));
  g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
  return g;
}

/** A round rod from a to b, optionally tapering to r2 at b; `open` drops the end caps (stalks). */
export function rod(a: V3, b: V3, r: number, sides = 6, r2 = r, open = false): THREE.BufferGeometry {
  const A = new THREE.Vector3(...a);
  const B = new THREE.Vector3(...b);
  const d = B.clone().sub(A);
  const g = new THREE.CylinderGeometry(r2, r, d.length(), sides, 1, open);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()));
  g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
  return g;
}

/** A sagging rope or string from a to b, as a few straight rod segments. */
export function rope(a: V3, b: V3, sag: number, r = 0.012, segs = 4): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const at = (t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t];
  for (let i = 0; i < segs; i++) out.push(rod(at(i / segs), at((i + 1) / segs), r, 4));
  return out;
}

// ---------- transforms and baking ----------

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Flips every triangle (needed after a mirroring transform). */
function flipWinding(g: THREE.BufferGeometry): void {
  if (g.index) {
    const ix = g.index.array;
    for (let i = 0; i < ix.length; i += 3) {
      const t = ix[i + 1];
      ix[i + 1] = ix[i + 2];
      ix[i + 2] = t;
    }
    g.index.needsUpdate = true;
    return;
  }
  for (const name of Object.keys(g.attributes)) {
    const at = g.getAttribute(name) as THREE.BufferAttribute;
    const n = at.itemSize;
    const arr = at.array;
    for (let v = 0; v < at.count; v += 3) {
      for (let k = 0; k < n; k++) {
        const t = arr[(v + 1) * n + k];
        arr[(v + 1) * n + k] = arr[(v + 2) * n + k];
        arr[(v + 2) * n + k] = t;
      }
    }
    at.needsUpdate = true;
  }
}

/**
 * Places a geometry in place: scale, then rotate (yaw last: Z, then X, then Y), then move.
 * A negative scale mirrors it and the winding is fixed so it still faces outward.
 */
export function xf(geo: THREE.BufferGeometry, p?: V3, r?: V3, s?: number | V3): THREE.BufferGeometry {
  _e.set(r?.[0] ?? 0, r?.[1] ?? 0, r?.[2] ?? 0, 'YXZ');
  _q.setFromEuler(_e);
  _p.set(p?.[0] ?? 0, p?.[1] ?? 0, p?.[2] ?? 0);
  if (typeof s === 'number') _s.setScalar(s);
  else if (s) _s.set(s[0], s[1], s[2]);
  else _s.setScalar(1);
  _m.compose(_p, _q, _s);
  geo.applyMatrix4(_m);
  if (_m.determinant() < 0) flipWinding(geo);
  return geo;
}

/** Low-poly shading: every face gets its own normal. */
export function faceted(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _ctr = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();

/**
 * Bakes a colour into a geometry's 'color' attribute. A function colours each face from its
 * centre and normal (needs non-indexed geometry). `glow` > 1 brightens past white, so a face
 * still reads as lit in the toon material's darkest band: a cheap glow for instanced things.
 */
export function tint(geo: THREE.BufferGeometry, c: Col, glow = 1): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const arr = new Float32Array(pos.count * 3);
  if (typeof c === 'function') {
    if (geo.index) throw new Error('tint: per-face colours need non-indexed geometry (use faceted())');
    for (let f = 0; f < pos.count / 3; f++) {
      _a.fromBufferAttribute(pos, f * 3);
      _b.fromBufferAttribute(pos, f * 3 + 1);
      _c.fromBufferAttribute(pos, f * 3 + 2);
      _ctr.copy(_a).add(_b).add(_c).divideScalar(3);
      _n.subVectors(_c, _b).cross(_t.subVectors(_a, _b)).normalize();
      const k = color(c(_ctr, _n, f)).multiplyScalar(glow);
      for (let v = 0; v < 3; v++) {
        arr[(f * 3 + v) * 3] = k.r;
        arr[(f * 3 + v) * 3 + 1] = k.g;
        arr[(f * 3 + v) * 3 + 2] = k.b;
      }
    }
  } else {
    const k = color(c).multiplyScalar(glow);
    for (let i = 0; i < pos.count; i++) {
      arr[i * 3] = k.r;
      arr[i * 3 + 1] = k.g;
      arr[i * 3 + 2] = k.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/**
 * Merges baked pieces into one non-indexed geometry with just position, normal and colour, so
 * a whole model is one draw call (or one instanced geometry).
 */
export function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (!geos.length) throw new Error('merge: nothing to merge');
  const clean = geos.map((g) => {
    const s = g.index ? g.toNonIndexed() : g;
    if (!s.getAttribute('normal')) s.computeVertexNormals();
    if (!s.getAttribute('color')) tint(s, 0xffffff);
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', s.getAttribute('position'));
    out.setAttribute('normal', s.getAttribute('normal'));
    out.setAttribute('color', s.getAttribute('color'));
    return out;
  });
  const m = mergeGeometries(clean, false);
  if (!m) throw new Error('merge: incompatible geometries');
  m.computeBoundingBox();
  m.computeBoundingSphere();
  return m;
}

export interface AddOpts {
  /** Keep the shape's own smooth normals instead of faceting it. */
  smooth?: boolean;
  /** Brighten past white (see tint). */
  glow?: number;
}

/**
 * Collects coloured, placed pieces and merges them into one geometry:
 *   const p = new Parts(); p.add(box(1, 1, 1), PAL.crate, [0, 0.5, 0]); mesh(p.build())
 */
export class Parts {
  readonly list: THREE.BufferGeometry[] = [];

  add(geo: THREE.BufferGeometry, c: Col, p?: V3, r?: V3, s?: number | V3, opts: AddOpts = {}): this {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    xf(g, p, r, s);
    if (!opts.smooth) g = faceted(g);
    tint(g, c, opts.glow ?? 1);
    this.list.push(g);
    return this;
  }

  /** Adds several already-placed pieces in one colour. */
  addAll(geos: THREE.BufferGeometry[], c: Col, opts: AddOpts = {}): this {
    for (const g of geos) this.add(g, c, undefined, undefined, undefined, opts);
    return this;
  }

  /** Places an already-baked geometry (its colours and normals kept), e.g. a prop inside a building. */
  put(geo: THREE.BufferGeometry, p?: V3, r?: V3, s?: number | V3): this {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    this.list.push(xf(g, p, r, s));
    return this;
  }

  /** Takes another collection's pieces, optionally moved as a block. */
  take(other: Parts, p?: V3, r?: V3, s?: number | V3): this {
    for (const g of other.list) this.list.push(p || r || s ? xf(g.clone(), p, r, s) : g);
    return this;
  }

  get empty(): boolean {
    return this.list.length === 0;
  }

  build(): THREE.BufferGeometry {
    return merge(this.list);
  }
}

/** Randomly but consistently nudges every vertex (shared corners move together, so it stays closed). */
export function jiggle(geo: THREE.BufferGeometry, amount: number, seed = 1, axes: V3 = [1, 1, 1]): THREE.BufferGeometry {
  const p = geo.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const h = (k: number) => {
      const v = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed * 4.7 + k * 19.19) * 43758.5453;
      return (v - Math.floor(v)) * 2 - 1;
    };
    p.setXYZ(i, x + h(0) * amount * axes[0], y + h(1) * amount * axes[1], z + h(2) * amount * axes[2]);
  }
  p.needsUpdate = true;
  return geo;
}

export const triangles = (g: THREE.BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

// ---------- materials and meshes ----------

let vcMat: THREE.MeshToonMaterial | null = null;
let vcClothMat: THREE.MeshToonMaterial | null = null;
let glowMat: THREE.MeshBasicMaterial | null = null;

/** The one material for vertex-coloured models: the shared toon look, colour from the vertices. */
export function vcMaterial(): THREE.MeshToonMaterial {
  return (vcMat ??= toon(0xffffff, { vertexColors: true }));
}

/** Same, drawn from both sides: sails, flags, awnings, glider cloth. */
export function clothMaterial(): THREE.MeshToonMaterial {
  return (vcClothMat ??= toon(0xffffff, { vertexColors: true, side: THREE.DoubleSide }));
}

/** Unlit vertex colours: lit windows, lantern glass, lamp rooms. */
export function glowMaterial(): THREE.MeshBasicMaterial {
  return (glowMat ??= new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
}

const hulls = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();

/**
 * The inverted-hull outline needs normals that agree at shared corners, or a faceted shape's
 * outline splits open at every edge. This welds the corners and smooths the normals, for the
 * hull only - the visible mesh keeps its crisp facets.
 */
export function hullOf(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  let h = hulls.get(geo);
  if (!h) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', geo.getAttribute('position').clone());
    if (geo.index) g.setIndex(geo.index.clone());
    h = mergeVertices(g, 1e-3);
    h.computeVertexNormals();
    hulls.set(geo, h);
  }
  return h;
}

export interface MeshOpts {
  /** Outline thickness in metres, or false for none (the default). */
  outline?: number | false;
  shadow?: boolean;
  receive?: boolean;
  mat?: THREE.Material;
  name?: string;
}

/** Adds a mesh (vertex-coloured toon unless told otherwise), with an optional dark outline. */
export function mesh(parent: THREE.Object3D, geo: THREE.BufferGeometry, opts: MeshOpts = {}): THREE.Mesh {
  const m = new THREE.Mesh(geo, opts.mat ?? vcMaterial());
  m.castShadow = opts.shadow ?? true;
  m.receiveShadow = opts.receive ?? true;
  if (opts.name) m.name = opts.name;
  parent.add(m);
  if (opts.outline) {
    const hull = new THREE.Mesh(hullOf(geo), outlineMaterial(opts.outline));
    hull.castShadow = false;
    hull.receiveShadow = false;
    hull.name = 'outline';
    m.add(hull);
  }
  return m;
}

/** A group placed at a point: the pivots wheels, legs and oars turn about. */
export function pivot(parent: THREE.Object3D, x = 0, y = 0, z = 0, name?: string): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  if (name) g.name = name;
  parent.add(g);
  return g;
}

/** Triangles and draw calls an object costs (outlines included), for budgets and the harness. */
export function cost(obj: THREE.Object3D): { triangles: number; draws: number } {
  let tris = 0;
  let draws = 0;
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    tris += triangles(m.geometry);
    draws++;
  });
  return { triangles: tris, draws };
}

// ---------- cloth ----------

/**
 * A grid of quads whose vertices are recomputed every frame (sails, flags, glider skins). Each
 * quad keeps one flat colour, so stripes and patches stay crisp while the cloth moves.
 */
export class Cloth {
  readonly geometry = new THREE.BufferGeometry();
  private readonly pos: Float32Array;
  private readonly tmp: THREE.Vector3[];

  constructor(
    readonly cols: number,
    readonly rows: number,
    quadColour: (i: number, j: number) => Rgb,
  ) {
    const quads = cols * rows;
    this.pos = new Float32Array(quads * 6 * 3);
    const colours = new Float32Array(quads * 6 * 3);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = color(quadColour(i, j));
        const at = (j * cols + i) * 18;
        for (let v = 0; v < 6; v++) {
          colours[at + v * 3] = k.r;
          colours[at + v * 3 + 1] = k.g;
          colours[at + v * 3 + 2] = k.b;
        }
      }
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(quads * 18), 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    this.tmp = Array.from({ length: (cols + 1) * (rows + 1) }, () => new THREE.Vector3());
  }

  /** Sets every grid point from (u, v) in [0, 1] and refreshes the triangles and normals. */
  shape(at: (u: number, v: number, out: THREE.Vector3) => void): void {
    const { cols, rows, tmp, pos } = this;
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) at(i / cols, j / rows, tmp[j * (cols + 1) + i]);
    }
    const put = (o: number, p: THREE.Vector3) => {
      pos[o] = p.x;
      pos[o + 1] = p.y;
      pos[o + 2] = p.z;
    };
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const a = tmp[j * (cols + 1) + i];
        const b = tmp[j * (cols + 1) + i + 1];
        const c = tmp[(j + 1) * (cols + 1) + i + 1];
        const d = tmp[(j + 1) * (cols + 1) + i];
        const o = (j * cols + i) * 18;
        put(o, a);
        put(o + 3, b);
        put(o + 6, c);
        put(o + 9, a);
        put(o + 12, c);
        put(o + 15, d);
      }
    }
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
  }
}
