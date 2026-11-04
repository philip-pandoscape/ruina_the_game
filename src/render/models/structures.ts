import * as THREE from 'three';
import { structureData, type StructureData } from './data';
import {
  PAL,
  Parts,
  TAU,
  arc,
  beam,
  bev,
  box,
  cone,
  cyl,
  dodec,
  extrude,
  glowMaterial,
  ico,
  jiggle,
  makeRng,
  mesh,
  mix,
  octa,
  ring,
  rod,
  rope,
  span,
  tor,
  vary,
  xf,
  type Rgb,
  type V3,
} from './kit';
import { propParts } from './props';

// Buildings and world dressing, built to the footprints in shared/structures.json: w along X,
// d along Z, facing +Z, origin on the ground at the footprint centre (docks: at sea level).
// Each is one merged vertex-coloured mesh plus at most one unlit mesh for lit windows and lamps
// (and the windmill's sails), with shadows on and no outlines.

export interface StructureOpts {
  /** Colour variant (market stall awning). */
  tint?: number;
  /** Build stage for buildings that have them (cottage: 0 site .. 4 complete). */
  stage?: number;
  seed?: number;
}

export interface StructureModel {
  root: THREE.Object3D;
  animate?(t: number): void;
}

interface Ctx {
  d: StructureData;
  body: Parts;
  glow: Parts;
  root: THREE.Group;
  rng: () => number;
  opts: StructureOpts;
}

type Builder = (c: Ctx) => ((t: number) => void) | void;

// ---------- building blocks ----------

type Hole = readonly [number, number, number, number];

/**
 * A wall along the line a -> b (centre of its thickness), from y0 to y1, with rectangular
 * openings [u0, u1, v0, v1] measured along the wall from a and up from the ground.
 */
function wall(p: Parts, c: Rgb, a: readonly [number, number], b: readonly [number, number], y0: number, y1: number, t: number, holes: Hole[] = []): void {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const L = Math.hypot(dx, dz);
  const yaw = Math.atan2(-dz, dx);
  const rects: Array<[number, number, number, number]> = [];
  const hs = [...holes].sort((h1, h2) => h1[0] - h2[0]);
  let u = 0;
  for (const [u0, u1, v0, v1] of hs) {
    if (u0 > u) rects.push([u, u0, y0, y1]);
    if (v0 > y0) rects.push([u0, u1, y0, v0]);
    if (v1 < y1) rects.push([u0, u1, v1, y1]);
    u = Math.max(u, u1);
  }
  if (u < L) rects.push([u, L, y0, y1]);
  for (const [u0, u1, v0, v1] of rects) {
    if (u1 - u0 < 1e-3 || v1 - v0 < 1e-3) continue;
    const m = (u0 + u1) / 2 / L;
    p.add(box(u1 - u0, v1 - v0, t), c, [a[0] + dx * m, (v0 + v1) / 2, a[1] + dz * m], [0, yaw, 0]);
  }
}

/** A triangle or polygon in the ZY plane given as [z, y] points, made thick along X. */
function prismZY(pts: Array<[number, number]>, x: number, thick: number): THREE.BufferGeometry {
  return xf(extrude(pts, thick), [x, 0, 0], [0, -Math.PI / 2, 0]);
}

interface Roof {
  /** Gable ends: the ridge runs along X between these, plus `over` either side. */
  x0: number;
  x1: number;
  /** Eave edges, front (+Z) and back. */
  zf: number;
  zb: number;
  /** Heights of the roof's top surface at the eave edges and at the ridge. */
  eave: number;
  ridge: number;
  thick: number;
  over: number;
  courses: number;
  colors: Rgb[];
  cap: Rgb;
  thatch?: boolean;
  /** Step each course out by this much over the one below (shingle butts). */
  step?: number;
}

/** A gable roof laid in overlapping courses, with a ridge cap. Ridge along X. */
function gable(p: Parts, r: Roof, rng: () => number): void {
  const zm = (r.zf + r.zb) / 2;
  const L = r.x1 - r.x0 + 2 * r.over;
  const xc = (r.x0 + r.x1) / 2;
  const step = r.step ?? (r.thatch ? 0.035 : 0.02);
  for (const side of [1, -1]) {
    const ze = side > 0 ? r.zf : r.zb;
    const run = Math.abs(ze - zm);
    const rise = r.ridge - r.eave;
    const slope = Math.hypot(run, rise);
    const a = Math.atan2(rise, run);
    const nY = Math.cos(a);
    const nZ = side * Math.sin(a);
    const w = (slope / r.courses) * (r.thatch ? 1.35 : 1.22);
    for (let k = 0; k < r.courses; k++) {
      const f = (k + 0.5) / r.courses;
      const out = -r.thick / 2 + k * step - (r.courses - 1) * step * 0.5;
      const y = r.eave + rise * f + nY * out;
      const z = ze + (zm - ze) * f + nZ * out;
      const c = r.colors[k % r.colors.length];
      const geo = r.thatch ? jiggle(bev(L + (k === 0 ? 0.1 : 0), r.thick, w, 0.07, 1), 0.04, k + side * 7) : box(L, r.thick, w);
      p.add(geo, r.thatch ? vary(c, rng, 0.04) : c, [xc, y, z], [side * a, 0, 0]);
    }
  }
  if (r.thatch) {
    p.add(cyl(0.3, 0.3, L + 0.2, 7), r.cap, [xc, r.ridge - 0.06, zm], [0, 0, Math.PI / 2]);
    for (let k = 0; k < 5; k++) p.add(cyl(0.32, 0.32, 0.12, 7), mix(r.cap, PAL.woodDark, 0.3), [r.x0 - r.over + 0.3 + (k * (L - 0.6)) / 4, r.ridge - 0.06, zm], [0, 0, Math.PI / 2]);
  } else {
    p.add(box(L + 0.06, 0.2, 0.2), r.cap, [xc, r.ridge - 0.03, zm], [Math.PI / 4, 0, 0]);
  }
}

/** Underside height of a gable roof at distance `dz` from the ridge line. */
function roofUnder(r: Roof, dz: number): number {
  const run = Math.abs(r.zf - r.zb) / 2;
  const a = Math.atan2(r.ridge - r.eave, run);
  return r.ridge - (r.ridge - r.eave) * (Math.abs(dz) / run) - r.thick / Math.cos(a) - 0.04;
}

/** A pavilion (hipped) roof in stepped courses over a rectangle centred at (cx, cz). */
function hipRoof(p: Parts, cx: number, cz: number, hw: number, hd: number, y0: number, y1: number, courses: number, colors: Rgb[], cap: Rgb): void {
  const s2 = Math.SQRT2;
  for (let k = 0; k < courses; k++) {
    const t0 = k / courses;
    const t1 = (k + 1) / courses;
    const r0 = 1 - t0 * 0.92 + 0.03;
    const r1 = 1 - t1 * 0.92;
    const h = (y1 - y0) / courses;
    p.add(cyl(r1, r0, h, 4), colors[k % colors.length], [cx, y0 + h * (k + 0.5), cz], [0, Math.PI / 4, 0], [hw * s2, 1, hd * s2]);
  }
  p.add(octa(0.25), cap, [cx, y1 + 0.1, cz], undefined, [1, 1.4, 1]);
}

interface WindowLook {
  frame?: Rgb;
  shutter?: Rgb;
  flowers?: boolean;
  lit?: boolean;
  glass?: Rgb;
  arch?: boolean;
}

/** A window centred on a wall's outer face at `at`, facing along yaw (0 = +Z). */
function windowOn(c: Ctx, at: V3, yaw: number, w: number, h: number, o: WindowLook = {}): void {
  const p = new Parts();
  const g = new Parts();
  const frame = o.frame ?? PAL.woodDark;
  // The glass sits just proud of the wall face, so it shows on solid walls and in openings alike.
  if (o.lit === false) p.add(box(w, h, 0.03), o.glass ?? 0x3d5872, [0, 0, 0.0]);
  else g.add(box(w, h, 0.03), o.glass ?? PAL.glow, [0, 0, 0.0]);
  p.add(box(w + 0.16, 0.09, 0.14), frame, [0, h / 2 + 0.045, -0.02]);
  p.add(box(w + 0.24, 0.07, 0.2), frame, [0, -h / 2 - 0.035, 0.0]);
  for (const sx of [-1, 1]) p.add(box(0.08, h, 0.14), frame, [sx * (w / 2 + 0.04), 0, -0.02]);
  p.add(box(0.05, h, 0.04), frame, [0, 0, 0.03]);
  p.add(box(w, 0.05, 0.04), frame, [0, h * 0.1, 0.03]);
  if (o.arch) p.add(arc(w / 2, w / 2 + 0.09, 0.14, 0, Math.PI, 6), frame, [0, h / 2 + 0.09, -0.02]);
  if (o.shutter !== undefined) {
    for (const sx of [-1, 1]) {
      p.add(box(w / 2, h, 0.04), o.shutter, [sx * (w * 0.75 + 0.12), 0, 0.02]);
      p.add(box(w / 2 - 0.08, 0.05, 0.05), mix(o.shutter, PAL.dark, 0.25), [sx * (w * 0.75 + 0.12), h * 0.28, 0.04]);
      p.add(box(w / 2 - 0.08, 0.05, 0.05), mix(o.shutter, PAL.dark, 0.25), [sx * (w * 0.75 + 0.12), -h * 0.28, 0.04]);
    }
  }
  if (o.flowers) {
    p.add(box(w + 0.15, 0.18, 0.2), PAL.wood, [0, -h / 2 - 0.16, 0.12]);
    const cols = [PAL.red, 0xff8fab, PAL.yellow, 0xb8a1ff, PAL.white];
    for (let k = 0; k < 6; k++) {
      const x = -w / 2 + ((k + 0.5) * w) / 6;
      p.add(ico(0.08, 0), PAL.leafMid, [x, -h / 2 - 0.04, 0.12], undefined, [1, 0.7, 1]);
      p.add(octa(0.045), cols[(k + Math.floor(c.rng() * 5)) % cols.length], [x + 0.02, -h / 2 + 0.03, 0.15]);
    }
  }
  c.body.take(p, at, [0, yaw, 0]);
  if (!g.empty) c.glow.take(g, at, [0, yaw, 0]);
}

/** A plank door (or two leaves) in a frame, hinged at the edges; `open` swings it outward. */
function doorOn(c: Ctx, at: V3, yaw: number, w: number, h: number, colour: Rgb, o: { open?: number; double?: boolean; arch?: boolean; lit?: boolean } = {}): void {
  const p = new Parts();
  const leaves = o.double ? 2 : 1;
  const lw = w / leaves;
  for (const sx of [-1, 1]) p.add(box(0.12, h + 0.12, 0.2), PAL.woodDark, [sx * (w / 2 + 0.06), h / 2 + 0.06, 0]);
  p.add(box(w + 0.36, 0.14, 0.22), PAL.woodDark, [0, h + 0.07, 0]);
  if (o.arch) p.add(arc(w / 2, w / 2 + 0.14, 0.2, 0, Math.PI, 8), PAL.woodDark, [0, h, 0]);
  for (let l = 0; l < leaves; l++) {
    const hinge = leaves === 2 ? (l === 0 ? -w / 2 : w / 2) : -w / 2;
    const dir = hinge < 0 ? 1 : -1;
    const leaf = new Parts();
    const boards = 3;
    for (let k = 0; k < boards; k++) {
      leaf.add(box(lw / boards - 0.012, h - 0.02, 0.06), k % 2 ? colour : mix(colour, PAL.dark, 0.08), [dir * (lw / boards) * (k + 0.5), h / 2, 0]);
    }
    for (const y of [h * 0.22, h * 0.78]) leaf.add(box(lw - 0.08, 0.1, 0.03), mix(colour, PAL.dark, 0.2), [dir * (lw / 2), y, 0.045]);
    leaf.add(tor(0.05, 0.012, 4, 8), PAL.iron, [dir * (lw - 0.15), h * 0.5, 0.07]);
    const open = o.open ?? 0;
    p.take(leaf, [hinge, 0, 0.02], [0, -dir * open, 0]);
  }
  if (o.arch && o.lit) c.glow.take(new Parts().add(cyl(w / 2, w / 2, 0.04, 8, false), PAL.glow, [0, h + 0.01, -0.02], [Math.PI / 2, 0, 0], [1, 1, 1]), at, [0, yaw, 0]);
  c.body.take(p, at, [0, yaw, 0]);
}

/** Scatters proud stones over the faces of a box, skipping any `avoid` rects on the front face. */
function stones(p: Parts, rng: () => number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, n: number, base: Rgb, avoid: Hole[] = []): void {
  const faces = [
    { len: x1 - x0, at: (u: number, v: number): V3 => [x0 + u, v, z1 + 0.025], yaw: 0, front: true },
    { len: x1 - x0, at: (u: number, v: number): V3 => [x0 + u, v, z0 - 0.025], yaw: 0, front: false },
    { len: z1 - z0, at: (u: number, v: number): V3 => [x1 + 0.025, v, z0 + u], yaw: Math.PI / 2, front: false },
    { len: z1 - z0, at: (u: number, v: number): V3 => [x0 - 0.025, v, z0 + u], yaw: Math.PI / 2, front: false },
  ];
  const total = faces.reduce((s, f) => s + f.len, 0);
  for (let i = 0; i < n; i++) {
    let r = rng() * total;
    const f = faces.find((ff) => (r -= ff.len) < 0) ?? faces[0];
    const sw = 0.25 + rng() * 0.3;
    const sh = 0.14 + rng() * 0.14;
    const u = sw / 2 + rng() * Math.max(0.01, f.len - sw);
    const v = y0 + sh / 2 + rng() * Math.max(0.01, y1 - y0 - sh);
    if (f.front && avoid.some(([a0, a1, b0, b1]) => x0 + u > a0 - sw / 2 && x0 + u < a1 + sw / 2 && v > b0 - sh / 2 && v < b1 + sh / 2)) continue;
    p.add(box(sw, sh, 0.06), vary(base, rng, 0.1), f.at(u, v), [0, f.yaw, 0]);
  }
}

/** A brick chimney stack with a cap. */
function chimney(p: Parts, x: number, z: number, y0: number, y1: number, w = 0.7, d = 0.7): void {
  p.add(span(x - w / 2, x + w / 2, y0, y1, z - d / 2, z + d / 2), PAL.brick);
  for (let y = y0 + 0.4; y < y1 - 0.2; y += 0.55) p.add(box(w + 0.02, 0.06, d + 0.02), PAL.brickDark, [x, y, z]);
  p.add(box(w + 0.16, 0.14, d + 0.16), PAL.stoneDark, [x, y1 + 0.07, z]);
  p.add(box(w - 0.24, 0.1, d - 0.24), PAL.dark, [x, y1 + 0.15, z]);
}

/** Timber framing on the outside of a wall line a -> b: plates, posts at `posts`, braces. */
function framing(p: Parts, c: Rgb, a: readonly [number, number], b: readonly [number, number], y0: number, y1: number, posts: number[], braces: Array<[number, number]>, rails: number[] = []): void {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const L = Math.hypot(dx, dz);
  const at = (u: number, y: number): V3 => [a[0] + (dx * u) / L, y, a[1] + (dz * u) / L];
  const yaw = Math.atan2(-dz, dx);
  const T = 0.14;
  p.add(box(L, 0.16, T), c, at(L / 2, y0 + 0.08), [0, yaw, 0]);
  p.add(box(L, 0.16, T), c, at(L / 2, y1 - 0.08), [0, yaw, 0]);
  for (const y of rails) p.add(box(L, 0.12, T), c, at(L / 2, y), [0, yaw, 0]);
  for (const u of posts) p.add(box(0.16, y1 - y0, T), c, at(u, (y0 + y1) / 2), [0, yaw, 0]);
  for (const [u0, u1] of braces) {
    const A = at(u0, y0 + 0.15);
    const B = at(u1, y1 - 0.15);
    const g = beam(A, B, 0.13, T);
    p.add(g, c);
  }
}

/** A plank floor across X between the given extents, top at y. */
function floorboards(p: Parts, x0: number, x1: number, z0: number, z1: number, y: number, n: number, colors: Rgb[]): void {
  const w = (z1 - z0) / n;
  for (let k = 0; k < n; k++) p.add(box(x1 - x0, 0.05, w - 0.01), colors[k % colors.length], [(x0 + x1) / 2, y - 0.025, z0 + w * (k + 0.5)]);
}

function ladder(p: Parts, a: V3, b: V3, rungs: number): void {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const side = new THREE.Vector3(0, 1, 0).cross(d).normalize().multiplyScalar(0.24);
  for (const s of [-1, 1]) p.add(beam([a[0] + side.x * s, a[1], a[2] + side.z * s], [b[0] + side.x * s, b[1], b[2] + side.z * s], 0.06), PAL.wood);
  for (let k = 1; k < rungs; k++) {
    const t = k / rungs;
    const m: V3 = [a[0] + d.x * t, a[1] + d.y * t, a[2] + d.z * t];
    p.add(beam([m[0] - side.x, m[1], m[2] - side.z], [m[0] + side.x, m[1], m[2] + side.z], 0.04), PAL.woodLight);
  }
}

function prop(p: Parts, id: string, at: V3, yaw = 0, seed = 1): void {
  p.take(propParts(id, seed), at, [0, yaw, 0]);
}

function lantern(c: Ctx, at: V3, s = 1): void {
  const [x, y, z] = at;
  c.glow.add(box(0.16 * s, 0.22 * s, 0.16 * s), PAL.glow, [x, y, z]);
  c.body.add(box(0.22 * s, 0.04 * s, 0.22 * s), PAL.iron, [x, y - 0.13 * s, z]);
  c.body.add(cone(0.16 * s, 0.14 * s, 4), PAL.iron, [x, y + 0.18 * s, z], [0, Math.PI / 4, 0]);
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) c.body.add(box(0.025 * s, 0.24 * s, 0.025 * s), PAL.iron, [x + dx * 0.085 * s, y, z + dz * 0.085 * s]);
}

// ---------- the cottage (the player's house), in five stages ----------

const cottage: Builder = (c) => {
  const { d, body: p, rng } = c;
  const stage = Math.max(0, Math.min(4, Math.round(c.opts.stage ?? 4)));
  const W = d.w / 2;
  const D = d.d / 2;
  const t = d.wall ?? 0.3;
  const F = d.floor ?? 0.25;
  const door = d.door ?? 1.6;
  const top = F + 3.0;
  const roof: Roof = {
    x0: -W,
    x1: W,
    zf: D + 0.55,
    zb: -D - 0.55,
    eave: top - 0.2,
    ridge: Math.min(6.2, d.h - 0.4),
    thick: 0.4,
    over: 0.35,
    courses: 6,
    colors: [PAL.thatch, PAL.thatchDark, 0xe2c06a],
    cap: PAL.thatchDark,
    thatch: true,
  };
  const winZ = [-1.6, 1.6];
  const winY = F + 1.55;
  const inner = { x0: -W + t, x1: W - t, z0: -D + t, z1: D - t };

  if (stage === 0) {
    // Site: corner stakes and string lines, a heap of stones and a stack of timber.
    for (const [x, z] of [[-W, -D], [W, -D], [W, D], [-W, D]] as const) {
      p.add(box(0.07, 0.75, 0.07), PAL.woodLight, [x, 0.375, z]);
      p.add(box(0.075, 0.12, 0.075), PAL.red, [x, 0.7, z]);
    }
    const corners: V3[] = [[-W, 0.55, -D], [W, 0.55, -D], [W, 0.55, D], [-W, 0.55, D]];
    for (let k = 0; k < 4; k++) p.addAll(rope(corners[k], corners[(k + 1) % 4], 0.04, 0.012, 3), PAL.white);
    for (let k = 0; k < 9; k++) p.add(jiggle(dodec(0.22 + rng() * 0.1), 0.04, k), vary(PAL.stone, rng, 0.12), [2.2 + rng() * 1.2, 0.15 + (k > 5 ? 0.25 : 0), 1.2 + rng() * 1.2], [rng() * 3, rng() * 3, 0], [1, 0.75, 1]);
  }
  if (stage <= 1) {
    for (let k = 0; k < 7; k++) {
      const layer = Math.floor(k / 3);
      p.add(box(3.2, 0.12, 0.26), vary(PAL.woodLight, rng, 0.08), [-2.0, 0.08 + layer * 0.13, -1.6 + (k % 3) * 0.3 + layer * 0.12], [0, 0.04 * (rng() - 0.5), 0]);
    }
  }
  if (stage >= 1) {
    // Stone foundation ring under the walls, floorboards inside, a doorstep.
    p.add(span(-W, W, 0, F, D - t, D), PAL.stone);
    p.add(span(-W, W, 0, F, -D, -D + t), PAL.stone);
    p.add(span(-W, -W + t, 0, F, -D + t, D - t), PAL.stone);
    p.add(span(W - t, W, 0, F, -D + t, D - t), PAL.stone);
    p.add(span(inner.x0, inner.x1, 0, F - 0.05, inner.z0, inner.z1), PAL.stoneDark);
    floorboards(p, inner.x0, inner.x1, inner.z0, inner.z1, F, 9, [PAL.woodLight, PAL.wood, 0xbd8d55]);
    stones(p, rng, -W, W, 0.03, F - 0.03, -D, D, 26, PAL.stoneDark, [[-door / 2, door / 2, 0, 1]]);
    p.add(bev(door + 0.3, 0.14, 0.45, 0.03), PAL.stoneLight, [0, 0.07, D + 0.2]);
  }
  if (stage >= 2) {
    // Timber frame: posts, plates, braces, the gables' king posts and the roof's rafters.
    const T = PAL.woodDark;
    const e = 0.07;
    framing(p, T, [-W, D - e], [W, D - e], F, top, [0.08, W - door / 2 - 0.08, W + door / 2 + 0.08, 2 * W - 0.08, 1.6, 2 * W - 1.6], [[0.1, 1.5], [2 * W - 0.1, 2 * W - 1.5]], stage >= 3 ? [] : [F + 1.0]);
    framing(p, T, [W, -D + e], [-W, -D + e], F, top, [0.08, 2 * W - 0.08, W, 1.9, 2 * W - 1.9], [[0.1, 1.8], [2 * W - 0.1, 2 * W - 1.8]], [F + 1.0]);
    for (const sx of [-1, 1]) {
      const x = sx * (W - e);
      const posts = [0.08, 2 * D - 0.08, D - 1.6 - 0.55, D - 1.6 + 0.55, D + 1.6 - 0.55, D + 1.6 + 0.55];
      framing(p, T, [x, -D], [x, D], F, top, posts, [[D - 0.3, D - 0.9], [D + 0.3, D + 0.9]], [winY - 0.62, winY + 0.62]);
    }
    const ridgeY = roofUnder(roof, 0);
    for (const sx of [-1, 1]) p.add(box(0.16, ridgeY - top, 0.16), T, [sx * (W - e), (top + ridgeY) / 2, 0]);
    if (stage <= 3) {
      for (let k = 0; k <= 6; k++) {
        const x = -W + 0.1 + (k * (2 * W - 0.2)) / 6;
        for (const side of [1, -1]) p.add(beam([x, top - 0.02, side * (D + 0.25)], [x, ridgeY + 0.05, 0], 0.12, 0.16), T);
        p.add(box(0.1, 0.12, 2.6), T, [x, (top + ridgeY) / 2 + 0.25, 0]);
      }
      p.add(box(2 * W + 0.3, 0.16, 0.16), T, [0, ridgeY + 0.04, 0]);
      ladder(p, [2.7, 0, D + 1.0], [2.7, top + 0.3, D + 0.05], 9);
    }
  }
  if (stage >= 3) {
    // Plaster infill (inset so the timbers stand proud), gables, door and window openings.
    const o = 0.04;
    const tt = t - o;
    const inset = (v: number) => v - Math.sign(v) * (o + tt / 2);
    const winHoles = (zs: number[]): Hole[] => zs.map((z) => [D + z - 0.45, D + z + 0.45, winY - 0.5, winY + 0.5] as const);
    wall(p, PAL.plaster, [-W, inset(D)], [W, inset(D)], F, top, tt, [[W - door / 2, W + door / 2, F, F + 2.15]]);
    wall(p, PAL.plaster, [-W, inset(-D)], [W, inset(-D)], F, top, tt);
    wall(p, PAL.plaster, [inset(W), -D], [inset(W), D], F, top, tt, winHoles(winZ));
    wall(p, PAL.plaster, [inset(-W), -D], [inset(-W), D], F, top, tt, winHoles(winZ));
    for (const sx of [-1, 1]) {
      const peak = roofUnder(roof, 0);
      p.add(prismZY([[-D, top], [D, top], [0, peak]], sx * (W - o - tt / 2), tt), PAL.plaster);
      p.add(prismZY([[-0.4, top], [0.4, top], [0, peak - 0.1]], sx * (W - 0.035), 0.07), PAL.woodDark);
      p.add(box(0.14, 0.14, 2 * D), PAL.woodDark, [sx * (W - 0.07), top + 0.07, 0]);
    }
    if (stage === 3) {
      for (let k = 0; k < 5; k++) {
        const f = (k + 0.5) / 5;
        for (const side of [1, -1]) {
          const z = side * (D + 0.25) * (1 - f);
          p.add(box(2 * W + 0.3, 0.05, 0.08), PAL.woodLight, [0, top - 0.02 + (roofUnder(roof, 0) + 0.05 - top + 0.02) * f + 0.12, z]);
        }
      }
    }
  }
  if (stage >= 4) {
    gable(p, roof, rng);
    // Chimney in the left (+X) gable: a brick column flush with the wall, up through the thatch.
    p.add(span(W - 0.5, W, 0, d.h - 0.15, -0.45, 0.45), PAL.brick);
    for (let y = 0.5; y < d.h - 0.4; y += 0.5) p.add(box(0.52, 0.05, 0.92), PAL.brickDark, [W - 0.25, y, 0]);
    p.add(box(0.66, 0.14, 1.06), PAL.stoneDark, [W - 0.25, d.h - 0.08, 0]);
    p.add(box(0.3, 0.1, 0.6), PAL.dark, [W - 0.25, d.h + 0.0, 0]);
    // Hearth inside.
    p.add(span(W - 1.0, W - 0.3, F, F + 1.2, -0.6, 0.6), PAL.brick);
    p.add(span(W - 1.02, W - 0.5, F, F + 0.7, -0.35, 0.35), PAL.dark);
    c.glow.add(box(0.3, 0.12, 0.4), PAL.glowHot, [W - 0.72, F + 0.08, 0]);
    p.add(box(0.9, 0.1, 1.4), PAL.woodDark, [W - 0.68, F + 1.25, 0]);
    // Door (two green leaves swung open) and shuttered windows with flower boxes.
    doorOn(c, [0, F, D], 0, door - 0.24, 2.05, PAL.doorGreen, { double: true, open: 2.4 });
    for (const sx of [-1, 1]) {
      for (const z of winZ) windowOn(c, [sx * W, winY, z], (sx * Math.PI) / 2, 0.9, 1.0, { shutter: 0x5a8fb0, flowers: true });
    }
    // A lantern by the door.
    lantern(c, [door / 2 + 0.55, F + 2.2, D + 0.15], 0.9);
    // Inside: bed, chest and bench where the data puts them.
    const it = d.interior ?? {};
    if (it.bed) {
      const { x, z } = it.bed;
      p.add(box(2.0, 0.35, 1.0), PAL.wood, [x, F + 0.175, z]);
      p.add(box(1.5, 0.12, 0.96), 0xc94f4f, [x - 0.2, F + 0.41, z]);
      for (let k = 0; k < 3; k++) p.add(box(0.48, 0.125, 0.3), [0x4f7fc4, 0xe0b84a, 0x6fae5f][k], [x - 0.75 + k * 0.5, F + 0.415, z + 0.33]);
      p.add(box(0.36, 0.12, 0.8), PAL.white, [x + 0.75, F + 0.42, z]);
      p.add(box(0.1, 0.8, 1.0), PAL.woodDark, [x + 0.98, F + 0.4, z]);
    }
    if (it.chest) {
      const { x, z } = it.chest;
      p.add(bev(0.9, 0.5, 0.55, 0.03), 0x8a5a33, [x, F + 0.25, z]);
      p.add(box(0.94, 0.06, 0.59), PAL.iron, [x, F + 0.42, z]);
      p.add(box(0.12, 0.14, 0.04), PAL.brass, [x, F + 0.32, z + 0.29]);
    }
    if (it.bench) {
      const { x, z } = it.bench;
      p.add(box(0.42, 0.06, 1.5), PAL.wood, [x, F + 0.45, z]);
      for (const dz of [-0.6, 0.6]) p.add(box(0.36, 0.42, 0.07), PAL.woodDark, [x, F + 0.21, z + dz]);
    }
    p.add(box(2.2, 0.02, 1.5), 0xb35a4a, [-0.6, F + 0.01, -0.4]);
    p.add(box(1.9, 0.021, 1.2), 0xe0b84a, [-0.6, F + 0.011, -0.4]);
  }
};

// ---------- town buildings ----------

const townhouse: Builder = (c) => {
  const { d, body: p, rng } = c;
  const W = d.w / 2;
  const D = d.d / 2;
  const j = 0.4;
  const g1 = 3.2;
  const g2 = 6.0;
  // Stone ground floor, set back under the jettied upper floor.
  const doorX = -2.4;
  const winX = [0.6, 2.6];
  const holes: Hole[] = [[doorX - 0.55, doorX + 0.55, 0, 2.2], ...winX.map((x) => [x - 0.5, x + 0.5, 1.1, 2.2] as const)];
  wall(p, PAL.stone, [-W + j, D - j - 0.2], [W - j, D - j - 0.2], 0, g1, 0.4, holes.map(([a, b, y0, y1]) => [a + W - j, b + W - j, y0, y1] as const));
  p.add(span(-W + j, W - j, 0, g1, -D, D - j - 0.4), PAL.stone);
  stones(p, rng, -W + j, W - j, 0.1, g1 - 0.1, -D, D - j, 40, PAL.stoneDark, holes);
  for (const sx of [-1, 1]) for (let k = 0; k < 5; k++) p.add(box(0.3, 0.3, 0.3), PAL.stoneLight, [sx * (W - j - 0.1), 0.3 + k * 0.62, D - j - 0.1 + (k % 2) * 0.05]);
  doorOn(c, [doorX, 0, D - j], 0, 1.1, 2.1, 0x9c3b31, {});
  p.add(box(1.7, 0.08, 0.6), PAL.woodDark, [doorX, 2.45, D - j + 0.25], [0.25, 0, 0]);
  for (const x of winX) windowOn(c, [x, 1.65, D - j], 0, 1.0, 1.1, {});
  // Jetty joists and the timber-framed upper floor.
  for (let k = 0; k < 10; k++) p.add(box(0.14, 0.18, j + 0.3), PAL.woodDark, [-W + 0.4 + (k * (2 * W - 0.8)) / 9, g1 - 0.1, D - j / 2 - 0.1]);
  p.add(span(-W, W, g1, g2, -D, D - 0.05), PAL.plaster);
  const T = PAL.woodDark;
  framing(p, T, [-W, D - 0.02], [W, D - 0.02], g1, g2, [0.08, 2 * W - 0.08, 1.75, 3.25, 5.75, 7.25], [[0.1, 1.6], [2 * W - 0.1, 2 * W - 1.6], [3.4, 4.4], [5.6, 4.6]], [g1 + 1.0]);
  for (const sx of [-1, 1]) framing(p, T, [sx * (W + 0.02), -D], [sx * (W + 0.02), D], g1, g2, [0.08, 2 * D - 0.08, D], [[0.1, 1.5], [2 * D - 0.1, 2 * D - 1.5]], [g1 + 1.0]);
  for (const x of [-2.6, 0, 2.6]) windowOn(c, [x, g1 + 1.55, D], 0, 0.95, 1.05, { flowers: true, shutter: 0x6a8f5a });
  for (const sx of [-1, 1]) windowOn(c, [sx * W, g1 + 1.55, 0], (sx * Math.PI) / 2, 0.9, 1.0, {});
  const roof: Roof = { x0: -W, x1: W, zf: D + 0.45, zb: -D - 0.35, eave: g2 - 0.1, ridge: d.h - 0.5, thick: 0.22, over: 0.3, courses: 9, colors: [PAL.slate, PAL.slateDark, 0x6c88a8], cap: PAL.slateDark };
  gable(p, roof, rng);
  for (const sx of [-1, 1]) {
    const peak = roofUnder(roof, 0.05);
    p.add(prismZY([[-D, g2], [D, g2], [(roof.zf + roof.zb) / 2, peak]], sx * (W - 0.15), 0.3), PAL.plaster);
    p.add(prismZY([[-0.3, g2], [0.3, g2], [(roof.zf + roof.zb) / 2, peak - 0.05]], sx * (W - 0.0), 0.06), T);
  }
  windowOn(c, [W - 0.01, g2 + 1.0, 0], Math.PI / 2, 0.7, 0.7, { arch: true });
  chimney(p, -W + 1.4, -1.4, g2, d.h - 0.15, 0.8, 0.8);
};

const inn: Builder = (c) => {
  const { d, body: p, rng } = c;
  const W = d.w / 2;
  const D = d.d / 2;
  const zFront = D - 2.6;
  const g1 = 3.4;
  const g2 = 6.6;
  const bx = W - 0.4;
  // Ground floor in stone, upper floor plaster and timber.
  const doorW = 1.8;
  const holes: Hole[] = [[bx - doorW / 2, bx + doorW / 2, 0.3, 2.55 + doorW / 2]];
  for (const x of [-4.6, -2.4, 2.4, 4.6]) holes.push([bx + x - 0.6, bx + x + 0.6, 1.2, 2.5]);
  wall(p, PAL.stone, [-bx, zFront - 0.2], [bx, zFront - 0.2], 0, g1, 0.4, holes);
  p.add(span(-bx, bx, 0, g1, -D, zFront - 0.4), PAL.stone);
  stones(p, rng, -bx, bx, 0.3, g1 - 0.1, -D, zFront, 50, PAL.stoneDark, holes.map(([a, b, y0, y1]) => [a - bx, b - bx, y0, y1] as const));
  doorOn(c, [0, 0.3, zFront], 0, doorW, 2.25, 0x8a4a2a, { double: true, arch: true, lit: true });
  for (const x of [-4.6, -2.4, 2.4, 4.6]) windowOn(c, [x, 1.85, zFront], 0, 1.2, 1.3, {});
  p.add(span(-bx - 0.2, bx + 0.2, g1, g2, -D, zFront + 0.25), PAL.plaster);
  const T = PAL.woodDark;
  const posts = [0.1, 2 * bx + 0.3, 2.2, 4.4, 6.9, 7.9, 10.4, 12.6];
  framing(p, T, [-bx - 0.2, zFront + 0.27], [bx + 0.2, zFront + 0.27], g1, g2, posts, [[0.2, 1.6], [2 * bx + 0.2, 2 * bx - 1.2], [4.5, 6.2], [10.3, 8.6]], [g1 + 1.1]);
  for (const sx of [-1, 1]) framing(p, T, [sx * (bx + 0.22), -D], [sx * (bx + 0.22), zFront + 0.25], g1, g2, [0.1, 2.5, 5, 7.3], [[0.2, 1.8], [7.2, 5.6]], [g1 + 1.1]);
  for (const x of [-5, -2.5, 0, 2.5, 5]) windowOn(c, [x, g1 + 1.7, zFront + 0.25], 0, 1.0, 1.15, { flowers: x !== 0, shutter: 0x4d7a8f });
  for (const sx of [-1, 1]) for (const z of [-3.2, -0.6]) windowOn(c, [sx * (bx + 0.2), g1 + 1.7, z], (sx * Math.PI) / 2, 0.9, 1.0, {});
  // Red tiled roof with two dormers and two chimneys.
  const roof: Roof = { x0: -bx - 0.2, x1: bx + 0.2, zf: zFront + 0.75, zb: -D - 0.0, eave: g2 - 0.1, ridge: d.h - 0.6, thick: 0.22, over: 0.35, courses: 10, colors: [PAL.roofRed, PAL.roofRedDark, 0xd0644c], cap: PAL.roofRedDark };
  gable(p, roof, rng);
  for (const sx of [-1, 1]) {
    p.add(prismZY([[-D + 0.05, g2], [zFront + 0.25, g2], [(roof.zf + roof.zb) / 2, roofUnder(roof, 0.05)]], sx * (bx + 0.05), 0.3), PAL.plaster);
  }
  const slopeZ = (y: number) => roof.zf - ((y - roof.eave) / (roof.ridge - roof.eave)) * (roof.zf - (roof.zf + roof.zb) / 2);
  for (const x of [-3.2, 3.2]) {
    const y0 = g2 + 0.5;
    const zf = slopeZ(y0) - 0.25;
    p.add(span(x - 0.9, x + 0.9, y0 - 0.6, y0 + 1.3, slopeZ(y0 + 1.3) - 0.4, zf), PAL.plaster);
    windowOn(c, [x, y0 + 0.45, zf], 0, 0.75, 0.8, {});
    const dr: Roof = { x0: -0.95, x1: 0.95, zf: 1.05, zb: -1.05, eave: 0, ridge: 0.85, thick: 0.14, over: 0.12, courses: 3, colors: [PAL.roofRed, PAL.roofRedDark], cap: PAL.roofRedDark };
    const g = new Parts();
    gable(g, dr, rng);
    g.add(prismZY([[-0.9, 0], [0.9, 0], [0, 0.68]], 0, 1.9), PAL.plaster);
    p.take(g, [x, y0 + 1.3, zf - 0.85], [0, Math.PI / 2, 0]);
  }
  chimney(p, -W + 2.2, -2.4, g2, d.h - 0.15, 0.9, 0.9);
  chimney(p, W - 2.2, -2.4, g2, d.h - 0.45, 0.9, 0.9);
  // Porch across the front: deck, posts, a lean-to roof, rails and barrels.
  const pz0 = zFront;
  const pz1 = D;
  floorboards(p, -W + 0.2, W - 0.2, pz0, pz1, 0.3, 8, [PAL.wood, PAL.woodLight]);
  p.add(span(-W + 0.2, W - 0.2, 0, 0.25, pz0, pz1), PAL.woodDark);
  const postX = [-W + 0.35, -4.2, -1.3, 1.3, 4.2, W - 0.35];
  for (const x of postX) {
    p.add(box(0.22, 3.0, 0.22), PAL.woodDark, [x, 1.8, pz1 - 0.25]);
    p.add(beam([x, 2.8, pz1 - 0.25], [x, 3.25, pz1 - 0.7], 0.12), PAL.woodDark);
  }
  p.add(box(2 * W - 0.3, 0.22, 0.24), PAL.woodDark, [0, 3.3, pz1 - 0.25]);
  const pr: Roof = { x0: -W + 0.2, x1: W - 0.2, zf: pz1 + 0.15, zb: pz0 - (pz1 - pz0), eave: 3.4, ridge: 4.15, thick: 0.18, over: 0.1, courses: 5, colors: [PAL.roofRed, PAL.roofRedDark], cap: PAL.roofRedDark };
  const porchRoof = new Parts();
  gable(porchRoof, pr, rng);
  // Keep only the front half (the back half would sit inside the building).
  porchRoof.list.splice(pr.courses, porchRoof.list.length - pr.courses);
  p.take(porchRoof);
  for (const sx of [-1, 1]) {
    for (const x0 of [sx > 0 ? 1.3 : -4.2]) {
      const x1 = sx > 0 ? 4.2 : -1.3;
      p.add(box(Math.abs(x1 - x0), 0.08, 0.08), PAL.woodDark, [(x0 + x1) / 2, 1.2, pz1 - 0.25]);
      for (let k = 1; k < 6; k++) p.add(box(0.05, 0.85, 0.05), PAL.wood, [x0 + ((x1 - x0) * k) / 6, 0.75, pz1 - 0.25]);
    }
  }
  prop(p, 'barrel', [-2.2, 0.3, pz0 + 0.6], 0.3, 1);
  prop(p, 'barrel', [-2.95, 0.3, pz0 + 0.75], 1.1, 2);
  prop(p, 'barrel', [-2.55, 1.25, pz0 + 0.68], 0.2, 3);
  prop(p, 'bench', [2.8, 0.3, pz0 + 0.45], 0, 1);
  lantern(c, [-1.25, 2.6, zFront + 0.15], 1);
  lantern(c, [1.25, 2.6, zFront + 0.15], 1);
  // The sign: a lantern and a gull on a board hanging from an iron bracket.
  const sx = W - 0.35;
  const sz = pz1 - 0.25;
  p.add(box(0.06, 0.06, 1.4), PAL.iron, [sx, 3.05, sz + 0.5]);
  p.add(beam([sx, 2.7, sz], [sx, 3.05, sz + 0.7], 0.05), PAL.iron);
  for (const dz of [0.6, 1.1]) p.add(box(0.02, 0.25, 0.02), PAL.iron, [sx, 2.9, sz + dz]);
  const board = new Parts();
  board.add(bev(0.06, 0.75, 0.95, 0.02), 0x2f6f7a, [0, 0, 0]);
  board.add(box(0.08, 0.8, 1.0), PAL.gold, [0, 0, 0], undefined, [0.6, 1, 1]);
  board.add(bev(0.07, 0.75, 0.95, 0.02), 0x2f6f7a, [0, 0, 0]);
  board.add(box(0.09, 0.24, 0.16), PAL.yellow, [0, -0.06, -0.22], undefined, undefined, { glow: 1.4 });
  board.add(box(0.095, 0.05, 0.22), PAL.iron, [0, 0.09, -0.22]);
  board.add(box(0.095, 0.05, 0.2), PAL.iron, [0, -0.2, -0.22]);
  for (const s of [-1, 1]) board.add(box(0.095, 0.05, 0.2), PAL.white, [0, 0.05 + 0.04, 0.2 + s * 0.09], [s * 0.45, 0, 0]);
  p.take(board, [sx, 2.38, sz + 0.85]);
};

const stall: Builder = (c) => {
  const { d, body: p, rng } = c;
  const W = d.w / 2;
  const D = d.d / 2;
  const awning = c.opts.tint ?? PAL.red;
  const cz = d.colliderZ ?? 0.6;
  const cd = d.colliderD ?? 0.8;
  const z0 = cz - cd / 2;
  const z1 = cz + cd / 2;
  // Counter: plank front, a top board, crates of produce.
  for (let k = 0; k < 8; k++) p.add(box((2 * W - 0.3) / 8 - 0.015, 0.95, 0.06), k % 2 ? PAL.woodLight : PAL.wood, [-W + 0.15 + ((k + 0.5) * (2 * W - 0.3)) / 8, 0.475, z1 - 0.03]);
  p.add(span(-W + 0.1, W - 0.1, 0.0, 0.95, z0, z1 - 0.06), PAL.woodDark);
  p.add(bev(2 * W, 0.08, cd + 0.12, 0.02), PAL.woodPale, [0, 0.99, cz + 0.02]);
  const produce: Array<[number, Rgb, Rgb]> = [
    [-0.95, PAL.red, 0xc03a30],
    [0, 0xd8a24a, 0xc08a3a],
    [0.95, 0x6fbf4a, 0x5aa83f],
  ];
  for (const [x, a, b] of produce) {
    p.add(box(0.7, 0.2, 0.45), PAL.crate, [x, 1.13, cz]);
    for (let k = 0; k < 7; k++) p.add(ico(0.075, 0), k % 2 ? a : b, [x - 0.24 + (k % 4) * 0.16, 1.27 + (k > 3 ? 0.05 : 0), cz - 0.1 + (k > 3 ? 0.12 : 0) + (k % 2) * 0.05]);
  }
  p.add(box(0.5, 0.32, 0.03), 0x2d3a3a, [W - 0.5, 0.55, z1 + 0.01]);
  p.add(box(0.3, 0.04, 0.035), PAL.white, [W - 0.5, 0.6, z1 + 0.02]);
  // Posts and the striped awning, high at the back, with a scalloped edge.
  const front = 2.45;
  const back = d.h - 0.05;
  for (const sx of [-1, 1]) {
    p.add(box(0.12, front, 0.12), PAL.woodDark, [sx * (W - 0.08), front / 2, D - 0.1]);
    p.add(box(0.12, back, 0.12), PAL.woodDark, [sx * (W - 0.08), back / 2, -D + 0.1]);
  }
  const n = 8;
  const a = Math.atan2(back - front, 2 * D);
  const len = Math.hypot(2 * D, back - front) + 0.3;
  for (let k = 0; k < n; k++) {
    const x = -W - 0.05 + ((k + 0.5) * (2 * W + 0.1)) / n;
    const col = k % 2 ? PAL.cream : awning;
    p.add(box((2 * W + 0.1) / n, 0.04, len), col, [x, (front + back) / 2 + 0.05, 0.05], [a, 0, 0]);
    p.add(cyl(((2 * W + 0.1) / n) * 0.58, 0.001, 0.32, 3), col, [x, front - 0.12, D + 0.19], [0, Math.PI, 0], [1, 1, 0.25]);
  }
  // A stool and a spare crate behind the counter.
  p.add(cyl(0.2, 0.18, 0.05, 8), PAL.wood, [-0.6, 0.6, -0.5]);
  for (let k = 0; k < 3; k++) {
    const an = (k / 3) * TAU;
    p.add(beam([-0.6 + Math.cos(an) * 0.12, 0.58, -0.5 + Math.sin(an) * 0.12], [-0.6 + Math.cos(an) * 0.2, 0, -0.5 + Math.sin(an) * 0.2], 0.04), PAL.woodDark);
  }
  p.add(box(0.6, 0.45, 0.45), vary(PAL.crate, rng, 0.05), [0.8, 0.225, -0.6], [0, 0.3, 0]);
};

const workbench: Builder = (c) => {
  const { d, body: p, rng } = c;
  const W = d.w / 2;
  const D = d.d / 2;
  const top = 0.92;
  const oak = 0x9a6a3a;
  const zb = -D + 0.12;
  // Thick top in three boards, sturdy legs, a shelf below.
  for (let k = 0; k < 3; k++) p.add(box(2 * W, 0.1, (2 * D - 0.3) / 3 - 0.01), k % 2 ? oak : mix(oak, PAL.woodLight, 0.25), [0, top - 0.05, -D + 0.3 + ((k + 0.5) * (2 * D - 0.3)) / 3]);
  for (const sx of [-1, 1]) {
    for (const z of [zb + 0.25, D - 0.12]) p.add(box(0.13, top - 0.1, 0.13), PAL.woodDark, [sx * (W - 0.15), (top - 0.1) / 2, z]);
    p.add(box(0.1, 0.1, 2 * D - 0.2), PAL.woodDark, [sx * (W - 0.15), 0.3, (zb + 0.25 + D - 0.12) / 2]);
  }
  p.add(box(2 * W - 0.3, 0.05, 2 * D - 0.45), PAL.wood, [0, 0.32, 0.1]);
  p.add(jiggle(ico(0.25, 1), 0.03, 2), PAL.sack, [-0.7, 0.56, 0.1], undefined, [1, 0.9, 0.8]);
  for (let k = 0; k < 4; k++) p.add(box(1.0, 0.07, 0.16), vary(PAL.woodLight, rng, 0.1), [0.5, 0.38 + k * 0.075, 0.05 + (k % 2) * 0.05]);
  // Back rail with a pegboard and hanging tools.
  for (const sx of [-1, 1]) p.add(box(0.1, d.h, 0.1), PAL.woodDark, [sx * (W - 0.15), d.h / 2, zb]);
  p.add(box(2 * W - 0.3, 0.55, 0.04), PAL.woodPale, [0, 1.25, zb + 0.03]);
  p.add(box(2 * W - 0.2, 0.08, 0.08), PAL.woodDark, [0, d.h - 0.06, zb]);
  const tz = zb + 0.08;
  // Saw.
  p.add(extrude([[0, 0], [0.5, 0.06], [0.5, 0.16], [0, 0.14]], 0.012), PAL.steel, [-1.05, 1.08, tz]);
  p.add(box(0.12, 0.16, 0.04), PAL.wood, [-1.12, 1.17, tz]);
  // Hammer, wrench, chisels, a coil of rope.
  p.add(box(0.04, 0.32, 0.04), PAL.wood, [-0.35, 1.2, tz]);
  p.add(box(0.16, 0.06, 0.06), PAL.iron, [-0.35, 1.37, tz]);
  p.add(box(0.035, 0.28, 0.02), PAL.ironLight, [-0.1, 1.2, tz]);
  p.add(tor(0.04, 0.015, 4, 6, 4.5), PAL.ironLight, [-0.1, 1.36, tz], [0, 0, 2.4]);
  for (let k = 0; k < 3; k++) {
    p.add(box(0.025, 0.12, 0.025), PAL.wood, [0.15 + k * 0.08, 1.32, tz]);
    p.add(box(0.02, 0.12, 0.012), PAL.steel, [0.15 + k * 0.08, 1.2, tz]);
  }
  p.add(tor(0.14, 0.04, 4, 10), PAL.rope, [0.8, 1.22, tz + 0.02]);
  p.add(tor(0.09, 0.035, 4, 8), PAL.rope, [0.8, 1.2, tz + 0.05]);
  lantern(c, [1.2, 1.2, tz + 0.08], 0.8);
  // Vice on the front corner.
  const vx = W - 0.35;
  const vz = D - 0.08;
  p.add(box(0.26, 0.14, 0.18), PAL.iron, [vx, top + 0.07, vz - 0.1]);
  p.add(box(0.26, 0.14, 0.05), PAL.ironLight, [vx, top + 0.07, vz + 0.04]);
  p.add(rod([vx, top + 0.03, vz + 0.04], [vx, top + 0.03, vz + 0.22], 0.015, 5), PAL.iron);
  p.add(rod([vx - 0.13, top + 0.03, vz + 0.2], [vx + 0.13, top + 0.03, vz + 0.2], 0.012, 5), PAL.iron);
  // A half-packed harvest crate, a ledger, a pot of nails, a mallet.
  const cx = -0.55;
  const cz = -0.1;
  p.add(box(0.55, 0.42, 0.5), PAL.woodDeep, [cx, top + 0.21, cz]);
  for (let k = 0; k < 3; k++) {
    for (const s of [-1, 1]) {
      p.add(box(0.56, 0.1, 0.02), vary(PAL.crate, rng, 0.08), [cx, top + 0.07 + k * 0.13, cz + s * 0.25]);
      p.add(box(0.02, 0.1, 0.5), vary(PAL.crate, rng, 0.08), [cx + s * 0.27, top + 0.07 + k * 0.13, cz]);
    }
  }
  for (let k = 0; k < 4; k++) p.add(ico(0.08, 0), 0xd4a04a, [cx - 0.12 + (k % 2) * 0.22, top + 0.38, cz - 0.1 + Math.floor(k / 2) * 0.2], undefined, [1, 0.8, 1.1]);
  p.add(box(0.5, 0.03, 0.36), 0x6b3b2a, [0.45, top + 0.015, 0.05], [0, 0.2, 0]);
  for (const s of [-1, 1]) p.add(box(0.23, 0.02, 0.33), 0xf6efdc, [0.45 + s * 0.12 * Math.cos(0.2), top + 0.035 + 0.01, 0.05 - s * 0.12 * Math.sin(0.2)], [0, 0.2, s * 0.06]);
  p.add(cyl(0.08, 0.07, 0.12, 7), PAL.ironLight, [0.95, top + 0.06, -0.15]);
  for (let k = 0; k < 5; k++) p.add(rod([0.92 + k * 0.015, top + 0.11, -0.17], [0.9 + k * 0.02, top + 0.17, -0.12], 0.006, 3), PAL.steel);
  p.add(box(0.07, 0.06, 0.3), PAL.wood, [0.15, top + 0.03, 0.3], [0, 0.6, 0]);
  p.add(cyl(0.06, 0.06, 0.2, 6), PAL.woodDark, [0.24, top + 0.06, 0.18], [0, 0.6, Math.PI / 2]);
};

const tradingPost: Builder = (c) => {
  const { d, body: p, rng } = c;
  const W = d.w / 2;
  const D = d.d / 2;
  const bx = W - 0.45;
  const zb = -D + 0.3;
  const zf = 2.0;
  const wallTop = 3.9;
  const r = 0.17;
  // Log walls: alternating courses with the ends crossing at the corners.
  const counter = { x0: -2.2, x1: 2.2, y0: 1.0, y1: 2.4 };
  const doorX = 3.4;
  for (let k = 0; k * 2 * r < wallTop; k++) {
    const y = r + k * 2 * r;
    const front = k % 2 === 0;
    const cA = vary(0x9a6a3e, rng, 0.08);
    const lenX = 2 * bx + 0.5;
    const lenZ = zf - zb + 0.5;
    // Back wall and the two sides are whole logs.
    p.add(cyl(r, r, lenX, 7), cA, [0, y + (front ? 0 : r), zb], [0, 0, Math.PI / 2]);
    for (const sx of [-1, 1]) p.add(cyl(r, r, lenZ, 7), vary(0x9a6a3e, rng, 0.08), [sx * bx, y + (front ? r : 0), (zf + zb) / 2], [Math.PI / 2, 0, 0]);
    // The front wall is split around the counter opening and the door.
    const yy = y + (front ? 0 : r);
    const segs: Array<[number, number]> = [];
    const blocked = (yy > counter.y0 && yy < counter.y1 ? [[counter.x0, counter.x1]] : []).concat(yy < 2.3 ? [[doorX - 0.6, doorX + 0.6]] : []);
    let x = -bx - 0.25;
    for (const [a0, a1] of blocked.sort((m, n) => m[0] - n[0])) {
      if (a0 > x) segs.push([x, a0]);
      x = a1;
    }
    segs.push([x, bx + 0.25]);
    for (const [a0, a1] of segs) p.add(cyl(r, r, a1 - a0, 7), cA, [(a0 + a1) / 2, yy, zf], [0, 0, Math.PI / 2]);
  }
  p.add(span(-bx, bx, 0, wallTop, zb, zf), 0x5a3c26);
  p.add(span(-bx, bx, 0, 0.1, zb, zf), PAL.woodDark);
  // Counter shelf, the awning above it, a door.
  p.add(bev(counter.x1 - counter.x0 + 0.3, 0.1, 0.8, 0.02), PAL.woodPale, [0, counter.y0 - 0.02, zf + 0.15]);
  for (const x of [counter.x0, counter.x1]) p.add(box(0.14, counter.y1 - counter.y0 + 0.2, 0.4), PAL.woodDark, [x, (counter.y0 + counter.y1) / 2, zf]);
  const aw = 10;
  const ay0 = counter.y1 + 0.3;
  const alen = 1.4;
  for (let k = 0; k < aw; k++) {
    const x = counter.x0 - 0.3 + ((k + 0.5) * (counter.x1 - counter.x0 + 0.6)) / aw;
    const col = k % 2 ? PAL.cream : PAL.green;
    p.add(box((counter.x1 - counter.x0 + 0.6) / aw, 0.04, alen), col, [x, ay0 - 0.25, zf + alen / 2], [-0.36, 0, 0]);
    p.add(cyl(((counter.x1 - counter.x0 + 0.6) / aw) * 0.58, 0.001, 0.3, 3), col, [x, ay0 - 0.65, zf + alen - 0.1], [0, Math.PI, 0], [1, 1, 0.25]);
  }
  for (const x of [counter.x0 - 0.2, counter.x1 + 0.2]) p.add(rod([x, ay0 - 0.05, zf], [x, ay0 - 0.55, zf + 1.25], 0.025, 4), PAL.woodDark);
  doorOn(c, [doorX, 0, zf + r], 0, 1.0, 2.15, 0x6b4426, {});
  windowOn(c, [-3.6, 1.9, zf + r], 0, 0.8, 0.8, { shutter: PAL.green });
  for (const sx of [-1, 1]) windowOn(c, [sx * (bx + r), 1.9, -1.0], (sx * Math.PI) / 2, 0.8, 0.8, { shutter: PAL.green });
  // Shingle roof and log gables.
  const roof: Roof = { x0: -bx - 0.3, x1: bx + 0.3, zf: zf + 0.6, zb: -D, eave: wallTop - 0.05, ridge: d.h - 0.3, thick: 0.18, over: 0.2, courses: 9, colors: [PAL.shingle, PAL.shingleDark, 0x9a7a58], cap: PAL.shingleDark };
  gable(p, roof, rng);
  for (const sx of [-1, 1]) {
    const peak = roofUnder(roof, (zf + zb) / 2 - (roof.zf + roof.zb) / 2);
    p.add(prismZY([[zb - 0.1, wallTop], [zf + 0.1, wallTop], [(roof.zf + roof.zb) / 2, peak]], sx * bx, 0.34), 0x8a5c36);
  }
  // A big sign: a gold coin and brass scales on a board over the counter.
  const sg = new Parts();
  sg.add(bev(2.0, 1.0, 0.1, 0.03), 0x3a5a4a, [0, 0, 0]);
  sg.add(box(2.1, 0.08, 0.12), PAL.woodDark, [0, 0.52, 0]);
  sg.add(cyl(0.34, 0.34, 0.08, 12), PAL.gold, [-0.5, 0, 0.07], [Math.PI / 2, 0, 0]);
  sg.add(cyl(0.24, 0.24, 0.09, 12), mix(PAL.gold, PAL.brass, 0.6), [-0.5, 0, 0.08], [Math.PI / 2, 0, 0]);
  sg.add(box(0.05, 0.6, 0.05), PAL.brass, [0.5, 0.0, 0.08]);
  sg.add(box(0.7, 0.05, 0.05), PAL.brass, [0.5, 0.28, 0.08]);
  for (const s of [-1, 1]) sg.add(cyl(0.13, 0.06, 0.06, 8), PAL.brass, [0.5 + s * 0.32, 0.05, 0.08]);
  for (const s of [-1, 1]) sg.add(rod([0.5 + s * 0.32, 0.27, 0.08], [0.5 + s * 0.32, 0.08, 0.08], 0.01, 3), PAL.iron);
  p.take(sg, [0, wallTop + 0.2, roof.zf - 0.35], [-0.2, 0, 0]);
  // Stacked crates and barrels, a hitching rail.
  prop(p, 'crates', [-W + 1.0, 0, D - 0.85], 0.15, 2);
  prop(p, 'barrel', [W - 0.6, 0, D - 1.35], 0.2, 1);
  prop(p, 'barrel', [W - 0.95, 0, D - 0.6], 1.3, 2);
  for (const x of [1.0, W - 1.6]) p.add(box(0.14, 1.1, 0.14), PAL.woodDark, [x, 0.55, D - 0.3]);
  p.add(rod([1.0, 1.0, D - 0.3], [W - 1.6, 1.0, D - 0.3], 0.06, 6), PAL.wood);
};

// ---------- the waterfront ----------

const dock: Builder = (c) => {
  const { d, body: p, rng } = c;
  const W = d.w / 2;
  const L = d.d / 2;
  const deck = d.deck ?? 1.4;
  const n = Math.round(d.d / 0.32);
  const pw = d.d / n;
  for (let k = 0; k < n; k++) p.add(box(d.w - (k % 3 === 1 ? 0.06 : 0), 0.07, pw - 0.025), vary(k % 2 ? PAL.woodGrey : 0xb09a80, rng, 0.06), [(k % 3 === 1 ? 0.03 : 0), deck - 0.035, -L + pw * (k + 0.5)]);
  for (const x of [-W + 0.35, -0.5, 0.5, W - 0.35]) p.add(box(0.16, 0.22, d.d - 0.1), PAL.woodGreyDark, [x, deck - 0.18, 0]);
  const pileZ: number[] = [];
  for (let z = -L + 0.3; z <= L - 0.25; z += 4) pileZ.push(z);
  if (pileZ[pileZ.length - 1] < L - 0.4) pileZ.push(L - 0.3);
  const piles = (y: number) => (y < 0.25 && y > -0.35 ? 0x5f7f4a : y < -0.35 ? 0x4e5f52 : 0x7b6650);
  for (const z of pileZ) {
    for (const sx of [-1, 1]) p.add(cyl(0.2, 0.22, deck + 3.15, 8), (ce) => piles(ce.y), [sx * (W - 0.2), (deck + 0.15 - 3) / 2, z]);
    p.add(box(d.w + 0.1, 0.2, 0.24), PAL.woodGreyDark, [0, deck - 0.36, z]);
    p.add(beam([-W + 0.2, -0.6, z], [W - 0.2, deck - 0.45, z], 0.1), PAL.woodGreyDark);
  }
  for (const z of [pileZ[1] ?? 0, pileZ[pileZ.length - 2] ?? 0]) {
    p.add(cyl(0.11, 0.13, 0.2, 8), PAL.iron, [W - 0.25, deck + 0.1, z + 1.6]);
    p.add(cyl(0.14, 0.11, 0.06, 8), PAL.iron, [W - 0.25, deck + 0.23, z + 1.6]);
  }
  p.add(tor(0.26, 0.07, 4, 12), PAL.rope, [-W + 0.9, deck + 0.07, L - 3.0], [Math.PI / 2, 0, 0]);
  p.add(tor(0.15, 0.065, 4, 10), PAL.rope, [-W + 0.9, deck + 0.15, L - 3.0], [Math.PI / 2, 0, 0]);
  ladder(p, [W + 0.05, -0.8, L - 1.5], [W + 0.05, deck + 0.1, L - 1.5], 7);
  prop(p, 'lamp', [-W + 0.35, deck, L - 0.6], 0, 1);
};

const lighthouse: Builder = (c) => {
  const { d, body: p, glow, rng } = c;
  const R = d.w / 2;
  const base = 1.2;
  p.add(cyl(R - 0.15, R, base, 10), PAL.stone, [0, base / 2, 0]);
  p.add(cyl(R - 0.05, R - 0.1, 0.12, 10), PAL.stoneLight, [0, base + 0.06, 0]);
  for (let k = 0; k < 22; k++) {
    const a = rng() * TAU;
    p.add(box(0.4 + rng() * 0.3, 0.22 + rng() * 0.15, 0.08), vary(PAL.stoneDark, rng, 0.1), [Math.cos(a) * (R - 0.08), 0.2 + rng() * (base - 0.4), Math.sin(a) * (R - 0.08)], [0, -a + Math.PI / 2, 0]);
  }
  for (let k = 0; k < 3; k++) p.add(box(1.6, 0.2, 0.4), PAL.stoneLight, [0, base - 0.1 - k * 0.2, R - 0.1 + k * 0.32]);
  // Tapered tower in white and red bands.
  const yTop = d.h - 5.2;
  const r0 = R - 0.6;
  const r1 = 1.55;
  const cuts = [base, 4.2, 5.8, 8.8, 10.4, 13.2, yTop - 1.6, yTop];
  const rAt = (y: number) => r0 + ((r1 - r0) * (y - base)) / (yTop - base);
  for (let k = 0; k < cuts.length - 1; k++) {
    const a = cuts[k];
    const b = cuts[k + 1];
    p.add(cyl(rAt(b), rAt(a), b - a, 12, true), k % 2 ? PAL.red : PAL.white, [0, (a + b) / 2, 0]);
  }
  doorOn(c, [0, base, rAt(base + 1) - 0.02], 0, 0.9, 1.9, 0x2f5f4a, { arch: true });
  for (const [y, a] of [[6.8, 0.3], [9.4, 2.4], [11.8, 4.4], [14.2, 1.2]] as const) {
    const rr = rAt(y) - 0.02;
    windowOn(c, [Math.sin(a) * rr, y, Math.cos(a) * rr], a, 0.4, 0.6, { lit: true });
  }
  // Gallery deck on brackets with a railing.
  const gy = yTop;
  p.add(cyl(2.3, 2.15, 0.25, 12), PAL.ironLight, [0, gy + 0.125, 0]);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * TAU;
    p.add(beam([Math.cos(a) * r1, gy - 0.6, Math.sin(a) * r1], [Math.cos(a) * 2.0, gy, Math.sin(a) * 2.0], 0.12), PAL.iron);
    p.add(box(0.05, 0.95, 0.05), PAL.iron, [Math.cos(a) * 2.15, gy + 0.72, Math.sin(a) * 2.15]);
  }
  p.add(ring(2.1, 2.2, 0.06, 12), PAL.iron, [0, gy + 1.2, 0]);
  p.add(ring(2.12, 2.18, 0.04, 12), PAL.iron, [0, gy + 0.7, 0]);
  // Lamp room: lit glass between iron mullions, then the red cone and a finial.
  const ly0 = gy + 0.25;
  const ly1 = ly0 + 2.3;
  p.add(cyl(1.25, 1.25, 0.35, 10), PAL.red, [0, ly0 + 0.175, 0]);
  glow.add(cyl(1.12, 1.12, ly1 - ly0 - 0.35, 10), PAL.glow, [0, (ly0 + 0.35 + ly1) / 2, 0]);
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * TAU + TAU / 20;
    p.add(box(0.08, ly1 - ly0 - 0.35, 0.08), PAL.iron, [Math.cos(a) * 1.14, (ly0 + 0.35 + ly1) / 2, Math.sin(a) * 1.14]);
  }
  p.add(cyl(1.5, 1.5, 0.12, 10), PAL.iron, [0, ly1 + 0.06, 0]);
  p.add(cone(1.5, d.h - 0.5 - ly1 - 0.12, 10), PAL.red, [0, (ly1 + 0.12 + d.h - 0.5) / 2, 0]);
  p.add(ico(0.2, 0), PAL.gold, [0, d.h - 0.45, 0]);
  p.add(rod([0, d.h - 0.3, 0], [0, d.h, 0], 0.03, 4), PAL.iron);
  return undefined;
};

const windmill: Builder = (c) => {
  const { d, body: p, rng, root } = c;
  const R = d.w / 2 - 0.4;
  const hubY = 9;
  const towerTop = hubY + 0.6;
  const rTop = 1.75;
  const rAt = (y: number) => R + ((rTop - R) * y) / towerTop;
  const cuts = [0, 2.4, 4.8, 7.2, towerTop];
  for (let k = 0; k < cuts.length - 1; k++) {
    p.add(cyl(rAt(cuts[k + 1]), rAt(cuts[k]), cuts[k + 1] - cuts[k], 12, true), k % 2 ? PAL.stone : PAL.stoneLight, [0, (cuts[k] + cuts[k + 1]) / 2, 0]);
  }
  for (let k = 0; k < 40; k++) {
    const a = rng() * TAU;
    const y = 0.3 + rng() * (towerTop - 0.8);
    const rr = rAt(y) - 0.02;
    p.add(box(0.45 + rng() * 0.3, 0.22 + rng() * 0.12, 0.08), vary(PAL.stoneDark, rng, 0.1), [Math.cos(a) * rr, y, Math.sin(a) * rr], [0, -a + Math.PI / 2, 0]);
  }
  doorOn(c, [0, 0, rAt(1) - 0.05], 0, 1.0, 2.0, 0x7a4a2a, { arch: true });
  for (const [y, a] of [[4.2, 0], [6.4, 2.2], [6.4, -2.2], [3.6, 3.14]] as const) {
    const rr = rAt(y) - 0.05;
    windowOn(c, [Math.sin(a) * rr, y, Math.cos(a) * rr], a, 0.5, 0.7, { lit: true, shutter: 0x7a4a2a });
  }
  // Wooden cap and windshaft.
  p.add(cyl(rTop + 0.2, rTop + 0.15, 0.35, 12), PAL.woodDark, [0, towerTop + 0.17, 0]);
  const capH = d.h - 0.6 - towerTop - 0.35;
  for (let k = 0; k < 4; k++) {
    const y0 = towerTop + 0.35 + (capH * k) / 4;
    const s0 = 1 - k / 4;
    const s1 = 1 - (k + 1) / 4;
    p.add(cyl((rTop + 0.15) * Math.sqrt(s1) * 0.98, (rTop + 0.15) * Math.sqrt(s0), capH / 4, 12), k % 2 ? PAL.shingle : PAL.shingleDark, [0, y0 + capH / 8, 0]);
  }
  p.add(octa(0.25), PAL.gold, [0, d.h - 0.4, 0], undefined, [1, 1.6, 1]);
  const hubZ = rTop + 0.9;
  p.add(rod([0, hubY, 0.2], [0, hubY, hubZ - 0.2], 0.2, 8), PAL.woodDark);
  // Sails on their own mesh, turning about Z.
  const sails = new THREE.Group();
  sails.name = 'sails';
  sails.position.set(0, hubY, hubZ);
  root.add(sails);
  const s = new Parts();
  s.add(cyl(0.38, 0.42, 0.5, 8), PAL.woodDark, [0, 0, 0], [Math.PI / 2, 0, 0]);
  s.add(cone(0.3, 0.35, 8), PAL.red, [0, 0, 0.42], [Math.PI / 2, 0, 0]);
  const span6 = 6;
  for (let k = 0; k < 4; k++) {
    const g = new Parts();
    g.add(box(0.2, span6, 0.2), PAL.woodDark, [0, span6 / 2, 0.1]);
    const w = 1.45;
    for (const x of [0.12, w]) g.add(box(0.07, span6 - 1.2, 0.07), PAL.wood, [x, 1.2 + (span6 - 1.2) / 2, 0.12]);
    for (let j = 0; j <= 9; j++) g.add(box(w + 0.05, 0.06, 0.06), PAL.wood, [w / 2 + 0.05, 1.25 + (j * (span6 - 1.35)) / 9, 0.13]);
    g.add(box(w - 0.12, (span6 - 1.4) * 0.55, 0.02), k % 2 ? PAL.canvas : PAL.canvasShade, [w / 2 + 0.06, 1.3 + (span6 - 1.4) * 0.275, 0.09]);
    s.take(g, undefined, [0, 0, (k * Math.PI) / 2]);
  }
  mesh(sails, s.build(), { name: 'sails' });
  return (t) => {
    sails.rotation.z = -t * 0.7;
  };
};

const well: Builder = (c) => {
  const { d, body: p, rng } = c;
  const R = d.w / 2 - 0.1;
  const h = 0.85;
  for (let k = 0; k < 3; k++) p.add(ring(R - 0.3, R, h / 3, 10), k % 2 ? PAL.stone : PAL.stoneLight, [0, (h / 3) * (k + 0.5), 0], [0, (k * Math.PI) / 10, 0]);
  p.add(ring(R - 0.34, R + 0.05, 0.1, 10), PAL.stoneLight, [0, h + 0.05, 0]);
  p.add(cyl(R - 0.3, R - 0.3, 0.05, 10), 0x2f6d84, [0, 0.45, 0]);
  for (let k = 0; k < 14; k++) {
    const a = rng() * TAU;
    p.add(box(0.3, 0.16, 0.06), vary(PAL.stoneDark, rng, 0.12), [Math.cos(a) * (R + 0.01), 0.15 + rng() * 0.55, Math.sin(a) * (R + 0.01)], [0, -a + Math.PI / 2, 0]);
  }
  const post = R - 0.12;
  for (const sx of [-1, 1]) p.add(box(0.14, 2.15 - h, 0.14), PAL.woodDark, [sx * post, h + (2.15 - h) / 2, 0]);
  p.add(cyl(0.09, 0.09, 2 * post, 8), PAL.wood, [0, 1.55, 0], [0, 0, Math.PI / 2]);
  p.add(tor(0.11, 0.03, 4, 8), PAL.rope, [0, 1.55, 0], [0, Math.PI / 2, 0]);
  p.add(beam([post + 0.07, 1.55, 0], [post + 0.3, 1.55, 0], 0.05), PAL.iron);
  p.add(beam([post + 0.3, 1.55, 0], [post + 0.3, 1.3, 0.12], 0.04), PAL.iron);
  p.add(rod([post + 0.3, 1.3, 0.12], [post + 0.45, 1.3, 0.12], 0.03, 5), PAL.wood);
  p.add(rod([0, 1.48, 0], [0, 1.18, 0], 0.012, 4), PAL.rope);
  p.add(cyl(0.16, 0.13, 0.22, 8), PAL.wood, [0, 1.06, 0]);
  p.add(ring(0.15, 0.17, 0.03, 8), PAL.iron, [0, 1.12, 0]);
  p.add(tor(0.14, 0.01, 3, 8, Math.PI), PAL.iron, [0, 1.17, 0], [0, Math.PI / 2, 0]);
  const roof: Roof = { x0: -post, x1: post, zf: 0.82, zb: -0.82, eave: 2.08, ridge: d.h - 0.05, thick: 0.1, over: 0.22, courses: 4, colors: [PAL.shingle, PAL.shingleDark], cap: PAL.woodDark };
  gable(p, roof, rng);
  for (const sx of [-1, 1]) p.add(prismZY([[-0.3, 2.12], [0.3, 2.12], [0, d.h - 0.2]], sx * post, 0.08), PAL.woodDark);
};

const stable: Builder = (c) => {
  const { d, body: p, rng } = c;
  const W = d.w / 2;
  const D = d.d / 2;
  const cz = d.colliderZ ?? -1.8;
  const cd = d.colliderD ?? 2.4;
  const solidFront = cz + cd / 2;
  const eave = 3.2;
  const boards = (x0: number, x1: number, z0: number, z1: number, y1: number, alongX: boolean) => {
    const len = alongX ? x1 - x0 : z1 - z0;
    const n = Math.max(2, Math.round(len / 0.3));
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n;
      const col = k % 2 ? PAL.woodLight : PAL.wood;
      if (alongX) p.add(box(len / n - 0.015, y1, 0.08), col, [x0 + len * f, y1 / 2, (z0 + z1) / 2]);
      else p.add(box(0.08, y1, len / n - 0.015), col, [(x0 + x1) / 2, y1 / 2, z0 + len * f]);
    }
  };
  // Floor of straw, the solid back, side walls along the solid part, open front on posts.
  p.add(span(-W + 0.1, W - 0.1, 0, 0.04, -D + 0.1, D - 0.1), 0xd9c27a);
  boards(-W, W, -D, -D + 0.1, eave, true);
  for (const sx of [-1, 1]) boards(sx * (W - 0.05), sx * (W - 0.05), -D, solidFront, eave, false);
  for (const x of [-W + 0.1, -W / 3, W / 3, W - 0.1]) p.add(box(0.22, eave, 0.22), PAL.woodDark, [x, eave / 2, D - 0.25]);
  p.add(box(2 * W, 0.3, 0.22), PAL.woodDark, [0, eave - 0.15, D - 0.25]);
  p.add(box(2 * W, 0.22, 0.22), PAL.woodDark, [0, eave - 0.15, -D + 0.15]);
  for (const sx of [-1, 1]) {
    p.add(box(0.2, 0.22, 2 * D), PAL.woodDark, [sx * (W - 0.1), eave - 0.11, 0]);
    p.add(box(0.2, eave, 0.2), PAL.woodDark, [sx * (W - 0.1), eave / 2, solidFront]);
  }
  // Three stalls: partitions with saddles over them, mangers of hay, hay on the floor.
  for (const x of [-W / 3, W / 3]) {
    boards(x, x, -D + 0.1, solidFront + 0.6, 1.4, false);
    p.add(box(0.16, 1.5, 0.16), PAL.woodDark, [x, 0.75, solidFront + 0.6]);
    p.add(box(0.12, 0.1, solidFront + 0.6 + D), PAL.woodDark, [x, 1.45, (solidFront + 0.6 - D) / 2]);
    const sz = -1.2;
    p.add(bev(0.5, 0.12, 0.55, 0.04), 0x6b3f22, [x, 1.56, sz]);
    for (const s of [-1, 1]) p.add(bev(0.04, 0.45, 0.5, 0.02), x < 0 ? 0xc23b32 : 0x3f6f9a, [x + s * 0.12, 1.3, sz]);
    p.add(bev(0.42, 0.12, 0.08, 0.03), 0x6b3f22, [x, 1.66, sz - 0.24]);
  }
  for (const x of [-2 * W / 3, 0, 2 * W / 3]) {
    p.add(span(x - 1.1, x + 1.1, 0.9, 1.0, -D + 0.12, -D + 0.6), PAL.woodDark);
    p.add(jiggle(box(2.0, 0.35, 0.42), 0.05, Math.round(x * 3 + 9)), PAL.hay, [x, 1.15, -D + 0.38]);
    p.add(jiggle(ico(0.45, 1), 0.06, Math.round(x * 5 + 3)), 0xe0c36a, [x + 0.5, 0.1, -D + 1.0], undefined, [1.5, 0.35, 1.2]);
  }
  p.add(span(-W / 3 - 1.5, -W / 3 - 0.5, 0, 0.45, solidFront - 0.6, solidFront - 0.1), PAL.woodDark);
  p.add(span(-W / 3 - 1.45, -W / 3 - 0.55, 0.3, 0.42, solidFront - 0.55, solidFront - 0.15), 0x3d8fbf);
  // Gable roof over everything, plank gables.
  const roof: Roof = { x0: -W, x1: W, zf: D + 0.25, zb: -D - 0.2, eave, ridge: d.h - 0.3, thick: 0.18, over: 0.25, courses: 7, colors: [PAL.shingle, PAL.shingleDark, 0x9a7a58], cap: PAL.shingleDark };
  gable(p, roof, rng);
  for (const sx of [-1, 1]) p.add(prismZY([[-D, eave], [D, eave], [0, roofUnder(roof, 0)]], sx * (W - 0.06), 0.1), PAL.wood);
  // Horseshoe sign on the front beam.
  for (const sx of [-1, 1]) p.add(box(0.03, 0.3, 0.03), PAL.iron, [sx * 0.4, eave - 0.42, D - 0.25]);
  p.add(box(1.1, 0.6, 0.06), PAL.woodPale, [0, eave - 0.85, D - 0.25]);
  p.add(tor(0.2, 0.05, 4, 10, Math.PI * 1.3), PAL.gold, [0, eave - 0.87, D - 0.2], [0, 0, -Math.PI * 0.15]);
};

const workshop: Builder = (c) => {
  const { d, body: p, rng } = c;
  const W = d.w / 2;
  const D = d.d / 2;
  const bx = W - 0.65;
  const zf = D - 1.0;
  const eave = 3.4;
  // Stone footing, plank walls above, a big double cart door.
  p.add(span(-bx, bx, 0, 1.0, -D, zf), PAL.stone);
  stones(p, rng, -bx, bx, 0.1, 0.9, -D, zf, 30, PAL.stoneDark, [[-1.6, 1.6, 0, 3]]);
  const doorW = 3.0;
  for (const [x0, x1] of [[-bx, -doorW / 2], [doorW / 2, bx]] as const) {
    const n = Math.round((x1 - x0) / 0.35);
    for (let k = 0; k < n; k++) p.add(box((x1 - x0) / n - 0.015, eave - 1.0, 0.1), k % 2 ? PAL.wood : PAL.woodLight, [x0 + ((k + 0.5) * (x1 - x0)) / n, 1.0 + (eave - 1.0) / 2, zf]);
  }
  p.add(span(-doorW / 2, doorW / 2, 2.9, eave, zf - 0.1, zf + 0.05), PAL.wood);
  p.add(span(-bx, bx, 1.0, eave, -D, zf - 0.05), PAL.woodDark);
  for (const leaf of [-1, 1]) {
    const lw = doorW / 2 - 0.05;
    const x0 = leaf < 0 ? -doorW / 2 + 0.03 : 0.02;
    for (let k = 0; k < 4; k++) p.add(box(lw / 4 - 0.015, 2.85, 0.08), k % 2 ? 0x8a4a2a : 0x7a4125, [x0 + ((k + 0.5) * lw) / 4, 1.45, zf + 0.08]);
    for (const y of [0.5, 2.4]) p.add(box(lw - 0.06, 0.16, 0.05), 0x5a2f1a, [x0 + lw / 2, y, zf + 0.14]);
    p.add(beam([x0 + 0.08, 0.6, zf + 0.15], [x0 + lw - 0.08, 2.3, zf + 0.15], 0.14, 0.05), 0x5a2f1a);
  }
  p.add(box(0.08, 2.9, 0.12), PAL.woodDark, [0, 1.45, zf + 0.1]);
  for (const sx of [-1, 1]) windowOn(c, [sx * 2.7, 2.0, zf + 0.05], 0, 0.9, 0.8, { shutter: 0x6a8f5a });
  const roof: Roof = { x0: -bx, x1: bx, zf: zf + 0.6, zb: -D, eave: eave - 0.05, ridge: d.h - 0.25, thick: 0.18, over: 0.3, courses: 8, colors: [PAL.roofRed, PAL.roofRedDark, 0xb9644c], cap: PAL.roofRedDark };
  gable(p, roof, rng);
  for (const sx of [-1, 1]) p.add(prismZY([[-D, eave], [zf, eave], [(roof.zf + roof.zb) / 2, roofUnder(roof, (zf - D) / 2 - (roof.zf + roof.zb) / 2)]], sx * (bx - 0.05), 0.1), PAL.wood);
  chimney(p, -bx + 1.0, -D + 1.0, eave, d.h + 0.2, 0.8, 0.8);
  // A wheel sign over the door.
  p.add(box(1.1, 0.7, 0.06), PAL.woodPale, [0, eave + 0.55, zf + 0.15]);
  wheelOn(p, [0, eave + 0.55, zf + 0.22], 0.28, [0, Math.PI / 2, 0]);
  // Spare wheels leaning on the walls, an anvil on a stump, a stack of lumber.
  for (const [x, z, lean] of [[bx + 0.15, -1.6, 0.2], [bx + 0.18, 0.2, 0.25], [-bx - 0.16, -0.6, -0.22]] as const) wheelOn(p, [x, 0.62, z], 0.6, [0, 0, lean]);
  const ax = -W + 1.6;
  const az = D - 0.55;
  p.add(cyl(0.32, 0.36, 0.5, 8), PAL.woodDark, [ax, 0.25, az]);
  p.add(box(0.26, 0.12, 0.2), PAL.iron, [ax, 0.56, az]);
  p.add(box(0.14, 0.12, 0.14), PAL.iron, [ax, 0.68, az]);
  p.add(box(0.42, 0.12, 0.22), PAL.iron, [ax, 0.8, az]);
  p.add(cone(0.11, 0.3, 4), PAL.iron, [ax + 0.34, 0.8, az], [0, 0, -Math.PI / 2], [1, 1, 0.8]);
  p.add(box(0.06, 0.06, 0.3), PAL.wood, [ax + 0.1, 0.89, az], [0, 0.4, 0]);
  for (let k = 0; k < 5; k++) {
    for (let j = 0; j < 4 - (k > 2 ? 1 : 0); j++) p.add(box(2.2, 0.08, 0.22), vary(PAL.woodLight, rng, 0.1), [W - 1.6, 0.1 + k * 0.13, D - 0.85 + j * 0.24]);
    if (k < 4) for (const x of [W - 2.4, W - 0.8]) p.add(box(0.06, 0.05, 0.9), PAL.woodDark, [x, 0.17 + k * 0.13, D - 0.5]);
  }
};

function wheelOn(p: Parts, at: V3, r: number, rot: V3): void {
  const g = new Parts();
  g.add(ring(r - 0.08, r, 0.1, 12), PAL.woodDark, undefined, [0, 0, Math.PI / 2]);
  g.add(cyl(r * 0.18, r * 0.18, 0.18, 6), PAL.woodDark, undefined, [0, 0, Math.PI / 2]);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    g.add(beam([0, Math.cos(a) * r * 0.15, Math.sin(a) * r * 0.15], [0, Math.cos(a) * (r - 0.06), Math.sin(a) * (r - 0.06)], 0.045), PAL.wood);
  }
  p.take(g, at, rot);
}

const boathouse: Builder = (c) => {
  const { d, body: p, rng } = c;
  const W = d.w / 2;
  const D = d.d / 2;
  const eave = 3.0;
  const grey = [PAL.woodGrey, 0xa89782, PAL.woodGreyDark];
  const boards = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, alongX: boolean) => {
    const len = alongX ? x1 - x0 : z1 - z0;
    const n = Math.max(1, Math.round(len / 0.32));
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n;
      const col = vary(grey[k % 3], rng, 0.05);
      if (alongX) p.add(box(len / n - 0.012, y1 - y0, 0.08), col, [x0 + len * f, (y0 + y1) / 2, (z0 + z1) / 2]);
      else p.add(box(0.08, y1 - y0, len / n - 0.012), col, [(x0 + x1) / 2, (y0 + y1) / 2, z0 + len * f]);
    }
  };
  const ridge = d.h - 0.3;
  const open = 2.6;
  const openTop = 3.7;
  for (const sx of [-1, 1]) boards(sx * (W - 0.1), sx * (W - 0.1), -D, D, 0, eave, false);
  boards(-W, W, -D + 0.05, -D + 0.05, 0, eave, true);
  boards(-W, -open, D - 0.05, D - 0.05, 0, eave, true);
  boards(open, W, D - 0.05, D - 0.05, 0, eave, true);
  p.add(span(-open + 0.1, open - 0.1, 0.0, 0.04, -D + 0.2, D - 0.1), PAL.woodGreyDark);
  for (const sx of [-1, 1]) p.add(box(0.22, openTop, 0.22), PAL.woodDark, [sx * (open + 0.1), openTop / 2, D - 0.08]);
  p.add(box(2 * open + 0.4, 0.25, 0.24), PAL.woodDark, [0, openTop + 0.1, D - 0.08]);
  // Steep roof, ridge along Z, so the gable and its big opening face +Z.
  const roof: Roof = { x0: -D, x1: D, zf: W + 0.35, zb: -W - 0.35, eave: eave - 0.05, ridge, thick: 0.18, over: 0.3, courses: 8, colors: [PAL.shingleDark, PAL.shingle, 0x7f6248], cap: PAL.woodDark };
  const rp = new Parts();
  gable(rp, roof, rng);
  p.take(rp, undefined, [0, Math.PI / 2, 0]);
  const peak = roofUnder(roof, 0);
  for (const [z, holed] of [[D - 0.05, true], [-D + 0.05, false]] as const) {
    const g = new Parts();
    if (holed) {
      g.add(extrude([[-W, eave], [W, eave], [W, eave + 0.01], [0, peak], [-W, eave + 0.01]], 0.1), PAL.woodGrey);
      g.add(extrude([[-open - 0.2, eave], [-W, eave], [-W, eave - 0.01]], 0.1), PAL.woodGrey);
      g.add(span(-open, open, eave, openTop, -0.05, 0.05), PAL.woodGrey);
    } else g.add(extrude([[-W, eave], [W, eave], [0, peak]], 0.1), PAL.woodGrey);
    p.take(g, [0, 0, z]);
  }
  // A half-built hull on blocks inside: keel, stem, ribs and a few strakes.
  const kz0 = -D + 1.4;
  const kz1 = D - 1.5;
  for (const z of [kz0 + 0.5, 0, kz1 - 0.6]) p.add(box(0.8, 0.35, 0.3), PAL.woodDark, [0, 0.175, z]);
  p.add(box(0.18, 0.2, kz1 - kz0), PAL.wood, [0, 0.45, (kz0 + kz1) / 2]);
  p.add(beam([0, 0.45, kz1], [0, 2.0, kz1 + 0.6], 0.16), PAL.wood);
  p.add(beam([0, 0.45, kz0], [0, 1.6, kz0 - 0.25], 0.16), PAL.wood);
  const ribs = 8;
  for (let k = 0; k < ribs; k++) {
    const f = k / (ribs - 1);
    const z = kz0 + 0.3 + f * (kz1 - kz0 - 0.6);
    const rr = 1.25 * Math.sin(Math.PI * (0.18 + 0.7 * f)) + 0.15;
    p.add(arc(rr, rr + 0.1, 0.08, Math.PI * 1.05, Math.PI * 1.95, 7), PAL.woodLight, [0, 0.5 + rr, z], [0, 0, 0], [1, 1.05, 1]);
  }
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 2; k++) p.add(box(0.08, 0.16, (kz1 - kz0) * 0.55), PAL.wood, [sx * (0.35 + k * 0.38), 0.62 + k * 0.22, kz0 + 0.3 + (kz1 - kz0) * 0.3], [0, 0, sx * (0.6 + k * 0.25)]);
  }
  // Oars crossed on the right wall, a net with floats on the left, a lantern at the door.
  for (const s of [-1, 1]) {
    const g = new Parts();
    g.add(rod([0, -1.1, 0], [0, 1.0, 0], 0.035, 5), PAL.woodLight);
    g.add(bev(0.05, 0.5, 0.17, 0.015), PAL.woodLight, [0, 1.2, 0]);
    g.add(box(0.06, 0.15, 0.18), PAL.red, [0, 1.38, 0]);
    p.take(g, [-W - 0.07, 1.6, 0.8], [s * 0.6, 0, 0]);
  }
  for (let k = 0; k <= 5; k++) {
    p.add(box(0.03, 0.025, 2.2), 0x3d3a34, [W + 0.06, 0.8 + k * 0.3, -1.6]);
    p.add(box(0.03, 1.55, 0.025), 0x3d3a34, [W + 0.06, 1.55, -2.7 + k * 0.44]);
  }
  for (let k = 0; k < 5; k++) p.add(cyl(0.07, 0.07, 0.12, 6), PAL.orange, [W + 0.09, 2.35, -2.6 + k * 0.5], [0, 0, Math.PI / 2]);
  lantern(c, [open + 0.35, 2.6, D + 0.12], 1);
};

const registrar: Builder = (c) => {
  const { d, body: p, rng } = c;
  const W = d.w / 2;
  const D = d.d / 2;
  const bx = W - 0.4;
  const zf = D - 1.4;
  const top = 4.6;
  // Ashlar walls in courses of pale stone.
  const course = 0.5;
  for (let k = 0; k * course < top; k++) {
    const y0 = k * course;
    const y1 = Math.min(top, y0 + course);
    const col = k % 2 ? PAL.stoneLight : mix(PAL.stoneLight, PAL.stone, 0.45);
    const holes: Hole[] = [[bx - 0.85, bx + 0.85, 0.4, 3.7], [bx - 2.95, bx - 2.05, 1.0, 3.7], [bx + 2.05, bx + 2.95, 1.0, 3.7]];
    wall(p, col, [-bx, zf - 0.2], [bx, zf - 0.2], y0, y1, 0.4, holes);
    for (const sx of [-1, 1]) wall(p, col, [sx * (bx - 0.2), -D], [sx * (bx - 0.2), zf - 0.4], y0, y1, 0.4, [[1.3, 2.2, 1.0, 3.7], [3.6, 4.5, 1.0, 3.7]]);
    wall(p, col, [-bx, -D + 0.2], [bx, -D + 0.2], y0, y1, 0.4);
  }
  p.add(span(-bx, bx, top, top + 0.3, -D - 0.1, zf + 0.1), PAL.stoneLight);
  p.add(span(-bx + 0.4, bx - 0.4, 0, top, -D + 0.4, zf - 0.4), 0x6e675e);
  for (const x of [-2.5, 2.5]) windowOn(c, [x, 2.1, zf], 0, 0.9, 2.2, { frame: 0xe8e2d4, arch: true });
  for (const sx of [-1, 1]) for (const z of [-D + 1.75, -D + 4.05]) windowOn(c, [sx * bx, 2.1, z], (sx * Math.PI) / 2, 0.9, 2.2, { frame: 0xe8e2d4, arch: true });
  doorOn(c, [0, 0.45, zf], 0, 1.5, 2.45, 0x3f5f8a, { double: true, arch: true, lit: true });
  // Steps, a portico of two columns and a pediment carrying a clock.
  for (let k = 0; k < 3; k++) p.add(box(3.6 - k * 0.3, 0.15, D - zf + 0.1 - k * 0.35), k % 2 ? PAL.stoneLight : PAL.stone, [0, 0.075 + k * 0.15, (zf + D) / 2 + 0.05 - k * 0.17]);
  const colZ = D - 0.45;
  for (const sx of [-1, 1]) {
    const x = sx * 1.35;
    p.add(box(0.6, 0.2, 0.6), PAL.stoneLight, [x, 0.55, colZ]);
    p.add(cyl(0.2, 0.24, 3.2, 10), PAL.white, [x, 0.65 + 1.6, colZ]);
    p.add(box(0.6, 0.2, 0.6), PAL.stoneLight, [x, 3.95, colZ]);
  }
  p.add(span(-1.85, 1.85, 4.05, 4.4, zf - 0.1, D - 0.1), PAL.stoneLight);
  p.add(xf(extrude([[-2.0, 0], [2.0, 0], [0, 1.1]], 0.4), [0, 4.4, D - 0.35]), PAL.stoneLight);
  p.add(xf(extrude([[-1.7, 0.08], [1.7, 0.08], [0, 0.92]], 0.06), [0, 4.4, D - 0.13]), PAL.roofBlue);
  p.add(cyl(0.42, 0.42, 0.1, 14), PAL.gold, [0, 4.85, D - 0.07], [Math.PI / 2, 0, 0]);
  p.add(cyl(0.34, 0.34, 0.12, 14), PAL.cream, [0, 4.85, D - 0.06], [Math.PI / 2, 0, 0]);
  p.add(box(0.04, 0.24, 0.03), PAL.dark, [0, 4.94, D + 0.01]);
  p.add(box(0.18, 0.04, 0.03), PAL.dark, [0.08, 4.85, D + 0.01]);
  // Blue hipped roof, a notice board by the door.
  hipRoof(p, 0, (zf - D) / 2, bx + 0.4, (zf + D) / 2 + 0.35, top + 0.3, d.h - 0.25, 6, [PAL.roofBlue, mix(PAL.roofBlue, PAL.dark, 0.18)], PAL.gold);
  prop(p, 'lamp', [2.4, 0, D - 0.4], 0, 2);
  const nb = new Parts();
  for (const sx of [-1, 1]) nb.add(box(0.08, 1.6, 0.08), PAL.woodDark, [sx * 0.42, 0.8, 0]);
  nb.add(box(0.95, 0.65, 0.05), 0xb98a55, [0, 1.25, 0.02]);
  for (let k = 0; k < 3; k++) nb.add(box(0.22, 0.28, 0.01), PAL.cream, [-0.28 + k * 0.28, 1.27, 0.05], [0, 0, (rng() - 0.5) * 0.2]);
  p.take(nb, [-2.5, 0, D - 0.4], [0, 0.25, 0]);
};

// ---------- outdoor pieces ----------

const launchDeck: Builder = (c) => {
  const { d, body: p, rng, root } = c;
  const W = d.w / 2;
  const D = d.d / 2;
  const deck = d.deck ?? 0.6;
  const n = Math.round(d.d / 0.3);
  const pw = d.d / n;
  for (let k = 0; k < n; k++) p.add(box(d.w, 0.06, pw - 0.02), k === n - 1 ? PAL.yellow : vary(k % 2 ? PAL.woodLight : PAL.wood, rng, 0.05), [0, deck - 0.03, -D + pw * (k + 0.5)]);
  for (const x of [-W + 0.15, 0, W - 0.15]) p.add(box(0.16, 0.2, d.d), PAL.woodDark, [x, deck - 0.16, 0]);
  const legsZ = [-D + 0.2, -D / 3, D / 3, D - 0.2];
  for (const x of [-W + 0.15, W - 0.15]) {
    for (const z of legsZ) p.add(box(0.2, deck - 0.06, 0.2), PAL.woodDark, [x, (deck - 0.06) / 2, z]);
    for (let k = 0; k < legsZ.length - 1; k++) p.add(beam([x, 0.05, legsZ[k]], [x, deck - 0.1, legsZ[k + 1]], 0.07), PAL.woodDark);
  }
  // Rails on the back and sides; the front edge (+Z) is open for jumping off.
  const railH = 1.0;
  const rail = (a: V3, b: V3) => {
    p.add(beam([a[0], deck + railH, a[2]], [b[0], deck + railH, b[2]], 0.08), PAL.wood);
    p.add(beam([a[0], deck + railH * 0.5, a[2]], [b[0], deck + railH * 0.5, b[2]], 0.06), PAL.wood);
  };
  rail([-W + 0.06, 0, -D + 0.06], [W - 0.06, 0, -D + 0.06]);
  for (const sx of [-1, 1]) rail([sx * (W - 0.06), 0, -D + 0.06], [sx * (W - 0.06), 0, D - 0.06]);
  const posts: Array<[number, number]> = [[-W / 2, -D], [W / 2, -D]];
  for (const sx of [-1, 1]) for (const z of [-D, -D / 2, 0, D / 2, D]) posts.push([sx * W, z]);
  for (const [x, z] of posts) {
    const px = Math.sign(x) * Math.min(Math.abs(x), W - 0.06);
    const pz = Math.sign(z) * Math.min(Math.abs(z), D - 0.06);
    p.add(box(0.12, railH + 0.06, 0.12), PAL.woodDark, [px, deck + (railH + 0.06) / 2, pz]);
  }
  // A sign with a wing glyph on the back rail.
  const sg = new Parts();
  sg.add(bev(1.1, 0.6, 0.06, 0.02), 0x3f8fbf, [0, 0, 0]);
  for (let k = 0; k < 4; k++) sg.add(box(0.42 - k * 0.07, 0.07, 0.02), PAL.white, [0.05 - k * 0.04, 0.12 - k * 0.09, 0.04], [0, 0, 0.35 - k * 0.12]);
  sg.add(octa(0.06), PAL.white, [-0.25, 0.1, 0.04]);
  p.take(sg, [0, deck + railH + 0.45, -D + 0.1]);
  for (const sx of [-1, 1]) p.add(box(0.06, 0.4, 0.06), PAL.woodDark, [sx * 0.45, deck + railH + 0.1, -D + 0.08]);
  // Windsock on a pole at the back corner; the sock swings in its own little mesh.
  const px = W - 0.3;
  const pz = -D + 0.3;
  p.add(rod([px, deck, pz], [px, d.h, pz], 0.05, 6, 0.035), PAL.white);
  p.add(octa(0.07), PAL.red, [px, d.h + 0.02, pz]);
  const sock = new THREE.Group();
  sock.position.set(px, d.h - 0.2, pz);
  root.add(sock);
  const s = new Parts();
  s.add(tor(0.2, 0.025, 4, 10), PAL.iron, [0, 0, 0.02], [0, 0, 0]);
  for (let k = 0; k < 5; k++) {
    const r0 = 0.2 - k * 0.025;
    const r1 = 0.2 - (k + 1) * 0.025;
    s.add(cyl(r1, r0, 0.26, 8, true), k % 2 ? PAL.white : PAL.red, [0, 0, 0.13 + k * 0.26], [Math.PI / 2, 0, 0], [1, 1, 1]);
  }
  mesh(sock, s.build(), { name: 'windsock', mat: undefined });
  sock.rotation.y = Math.PI * 0.75;
  return (t) => {
    sock.rotation.y = Math.PI * 0.75 + Math.sin(t * 0.5) * 0.35;
    sock.rotation.x = 0.25 + Math.sin(t * 1.7) * 0.06;
  };
};

const noticeBoard: Builder = (c) => {
  const { d, body: p, rng } = c;
  const W = d.w / 2;
  for (const sx of [-1, 1]) p.add(box(0.12, d.h - 0.15, 0.12), PAL.woodDark, [sx * (W - 0.1), (d.h - 0.15) / 2, 0]);
  p.add(box(2 * W - 0.25, 1.05, 0.08), 0xb98a55, [0, 1.5, 0]);
  p.add(box(2 * W - 0.15, 0.1, 0.12), PAL.woodDark, [0, 2.06, 0]);
  p.add(box(2 * W - 0.15, 0.1, 0.12), PAL.woodDark, [0, 0.94, 0]);
  const papers: Array<[number, number, number, number, Rgb]> = [
    [-0.55, 1.62, 0.36, 0.42, PAL.cream],
    [-0.1, 1.55, 0.3, 0.5, PAL.white],
    [0.35, 1.68, 0.34, 0.3, 0xf3e1a6],
    [0.5, 1.28, 0.28, 0.34, PAL.cream],
    [-0.45, 1.2, 0.3, 0.26, 0xe8f0f6],
  ];
  for (const [x, y, w, h, col] of papers) {
    const tilt = (rng() - 0.5) * 0.18;
    p.add(box(w, h, 0.012), col, [x, y, 0.05], [0, 0, tilt]);
    p.add(octa(0.025), PAL.red, [x, y + h / 2 - 0.05, 0.065]);
    for (let k = 0; k < 3; k++) p.add(box(w * 0.65, 0.022, 0.013), 0x9a9080, [x, y + h / 4 - k * 0.08, 0.052], [0, 0, tilt]);
  }
  const roof: Roof = { x0: -W + 0.05, x1: W - 0.05, zf: 0.38, zb: -0.38, eave: 2.08, ridge: d.h, thick: 0.08, over: 0.12, courses: 3, colors: [PAL.shingle, PAL.shingleDark], cap: PAL.woodDark };
  gable(p, roof, rng);
};

const housePlot: Builder = (c) => {
  const { d, body: p } = c;
  const W = d.w / 2 - 0.1;
  const D = d.d / 2 - 0.1;
  const corners: V3[] = [[-W, 0, -D], [W, 0, -D], [W, 0, D], [-W, 0, D]];
  for (const [x, , z] of corners) {
    p.add(box(0.08, 0.85, 0.08), PAL.woodLight, [x, 0.425, z]);
    p.add(cone(0.06, 0.12, 4), PAL.woodLight, [x, -0.03, z], [Math.PI, Math.PI / 4, 0]);
    p.add(box(0.085, 0.14, 0.085), PAL.red, [x, 0.78, z]);
  }
  for (let k = 0; k < 4; k++) {
    const a = corners[k];
    const b = corners[(k + 1) % 4];
    p.addAll(rope([a[0], 0.7, a[2]], [b[0], 0.7, b[2]], 0.06, 0.02, 4), PAL.white);
  }
  // A little sign at the front: "Plot for claim", drawn as a house with a plus.
  p.add(box(0.09, d.h - 0.05, 0.09), PAL.wood, [0, (d.h - 0.05) / 2, D]);
  p.add(bev(0.75, 0.48, 0.05, 0.02), PAL.cream, [0, d.h - 0.3, D + 0.07]);
  p.add(box(0.22, 0.16, 0.012), 0x3f6f9a, [-0.12, d.h - 0.36, D + 0.1]);
  p.add(xf(extrude([[-0.15, 0], [0.15, 0], [0, 0.12]], 0.012), [-0.12, d.h - 0.28, D + 0.1]), PAL.red);
  p.add(box(0.14, 0.04, 0.012), 0x4f8f4a, [0.17, d.h - 0.3, D + 0.1]);
  p.add(box(0.04, 0.14, 0.012), 0x4f8f4a, [0.17, d.h - 0.3, D + 0.1]);
};

const scarecrow: Builder = (c) => {
  const { d, body: p, rng } = c;
  const W = d.w / 2;
  p.add(box(0.08, 1.95, 0.08), PAL.woodDark, [0, 0.975, 0]);
  p.add(box(2 * W - 0.05, 0.07, 0.07), PAL.woodDark, [0, 1.45, -0.02]);
  // Patched shirt with sleeves along the crossbar.
  p.add(bev(0.5, 0.62, 0.28, 0.06), 0x5a7fa8, [0, 1.3, 0]);
  for (const sx of [-1, 1]) p.add(bev(0.38, 0.2, 0.22, 0.05), 0x5a7fa8, [sx * 0.42, 1.43, 0], [0, 0, sx * -0.12]);
  p.add(box(0.16, 0.16, 0.02), PAL.red, [0.1, 1.42, 0.145], [0, 0, 0.2]);
  p.add(box(0.12, 0.1, 0.02), PAL.yellow, [-0.42, 1.48, 0.115], [0, 0, -0.3]);
  p.add(box(0.5, 0.06, 0.29), PAL.rope, [0, 1.06, 0]);
  // Straw at the cuffs, the collar and the hem.
  const straw = (at: V3, dir: V3, n: number) => {
    for (let k = 0; k < n; k++) p.add(cone(0.035, 0.18, 3), vary(PAL.hay, rng, 0.1), [at[0] + (rng() - 0.5) * 0.12, at[1] + (rng() - 0.5) * 0.1, at[2] + (rng() - 0.5) * 0.12], [dir[0] + (rng() - 0.5) * 0.5, rng() * 3, dir[2] + (rng() - 0.5) * 0.5]);
  };
  straw([W - 0.03, 1.4, 0], [0, 0, -1.6], 5);
  straw([-W + 0.03, 1.4, 0], [0, 0, 1.6], 5);
  straw([0, 0.98, 0], [Math.PI, 0, 0], 8);
  straw([0, 1.63, 0], [0, 0, 0], 5);
  // Sack head with button eyes and a stitched smile, and a straw hat.
  p.add(bev(0.34, 0.34, 0.32, 0.08, 1), PAL.sack, [0, 1.84, 0], undefined, undefined, { smooth: false });
  for (const sx of [-1, 1]) p.add(cyl(0.035, 0.035, 0.02, 6), PAL.dark, [sx * 0.08, 1.88, 0.165], [Math.PI / 2, 0, 0]);
  for (let k = 0; k < 4; k++) p.add(box(0.05, 0.015, 0.012), PAL.dark, [-0.075 + k * 0.05, 1.77 - (k % 2) * 0.012, 0.165], [0, 0, (k % 2 ? 1 : -1) * 0.4]);
  p.add(cyl(0.34, 0.34, 0.04, 10), PAL.hay, [0, 2.03, 0], [0.12, 0, 0.05]);
  p.add(cyl(0.17, 0.19, 0.2, 10), 0xe8cc6a, [0, 2.14, -0.01], [0.12, 0, 0.05]);
  p.add(cyl(0.195, 0.195, 0.05, 10), PAL.red, [0, 2.07, -0.005], [0.12, 0, 0.05]);
};

const farmPlot: Builder = (c) => {
  const { d, body: p, rng } = c;
  const W = d.w / 2;
  const D = d.d / 2;
  p.add(span(-W + 0.15, W - 0.15, 0, 0.035, -D + 0.15, D - 0.15), PAL.soil);
  const n = Math.round((d.w - 0.5) / 0.5);
  const pitch = (d.w - 0.5) / n;
  for (let k = 0; k < n; k++) {
    const x = -W + 0.25 + pitch * (k + 0.5);
    p.add(xf(extrude([[-pitch * 0.42, 0], [pitch * 0.42, 0], [pitch * 0.18, 0.05], [-pitch * 0.18, 0.05]], d.d - 0.5), [x, 0.03, 0]), vary(PAL.soilLight, rng, 0.05));
  }
  // A low rim of heaped earth.
  for (const [x, z, w, dd] of [[0, D - 0.12, d.w, 0.25], [0, -D + 0.12, d.w, 0.25], [W - 0.12, 0, 0.25, d.d - 0.5], [-W + 0.12, 0, 0.25, d.d - 0.5]] as const) {
    p.add(bev(w, d.h - 0.03, dd, 0.06), PAL.soilDark, [x, (d.h - 0.03) / 2 + 0.01, z]);
  }
};

const oreNode: Builder = (c) => {
  const { body: p, rng } = c;
  const vein = (k: number) => (k % 9 === 4 || k % 11 === 7 ? (k % 2 ? 0xb5652d : 0xc97a3a) : undefined);
  const rock = (r: number, at: V3, s: V3, seed: number) => {
    let f = 0;
    p.add(jiggle(dodec(r), r * 0.14, seed), () => vein(f++ + seed) ?? vary(PAL.rock, rng, 0.08), at, [rng(), rng() * 3, rng() * 0.4], s);
  };
  rock(0.95, [-0.25, 0.68, -0.1], [1.25, 0.85, 1.05], 1);
  rock(0.65, [0.8, 0.42, 0.35], [1, 0.8, 1], 2);
  rock(0.45, [0.55, 0.3, -0.7], [1, 0.75, 1.1], 3);
  for (const [at, r] of [[[0.25, 1.15, 0.2], 0.4], [[-0.75, 0.9, 0.55], -0.5], [[0.95, 0.75, 0.15], 0.9], [[-0.1, 1.3, -0.35], -0.2]] as const) {
    p.add(octa(0.16), 0x8fe6f2, at as V3, [0, 0.4, r], [0.5, 1.8, 0.5], { glow: 1.25 });
  }
  for (let k = 0; k < 6; k++) p.add(jiggle(dodec(0.12 + rng() * 0.08), 0.02, k), vary(PAL.rock, rng, 0.1), [(rng() - 0.5) * 2.4, 0.06, 0.8 + rng() * 0.3], undefined, [1, 0.6, 1]);
};

const stoneNode: Builder = (c) => {
  const { body: p, rng } = c;
  const pale = PAL.stoneLight;
  p.add(jiggle(bev(1.9, 1.15, 1.5, 0.12), 0.06, 2), (_c, n) => (n.y > 0.8 ? mix(pale, PAL.white, 0.25) : vary(pale, rng, 0.05)), [-0.25, 0.575, -0.1], [0, 0.15, 0.03]);
  p.add(jiggle(bev(1.1, 0.5, 0.9, 0.08), 0.04, 3), (_c, n) => (n.y > 0.8 ? mix(pale, PAL.white, 0.3) : pale), [-0.45, 1.38, -0.2], [0, -0.2, 0]);
  p.add(jiggle(bev(0.9, 0.75, 0.8, 0.1), 0.05, 4), pale, [0.85, 0.37, -0.3], [0, 0.4, 0]);
  // Chisel marks: rows of short grooves on the faces.
  for (let k = 0; k < 9; k++) p.add(box(0.12, 0.03, 0.02), PAL.stoneDark, [-0.9 + k * 0.17, 0.35 + (k % 3) * 0.25, 0.66], [0, 0.15, 0.6]);
  for (let k = 0; k < 6; k++) p.add(box(0.02, 0.03, 0.12), PAL.stoneDark, [0.71, 0.5 + (k % 2) * 0.2, -0.85 + k * 0.22], [0.5, 0.4, 0]);
  // Loose cut blocks.
  p.add(bev(0.55, 0.32, 0.38, 0.04), pale, [0.85, 0.16, 0.75], [0, 0.5, 0]);
  p.add(bev(0.45, 0.3, 0.3, 0.04), mix(pale, PAL.stone, 0.4), [0.2, 0.15, 0.9], [0, -0.3, 0]);
  p.add(bev(0.4, 0.28, 0.3, 0.04), pale, [0.25, 0.43, 0.88], [0, 0.2, 0]);
};

const timberNode: Builder = (c) => {
  const { body: p, rng } = c;
  const bark = 0x6e4a2e;
  const log = (len: number, r: number, at: V3, yaw: number) => {
    const ax = Math.cos(yaw);
    const az = -Math.sin(yaw);
    p.add(cyl(r, r * 1.05, len, 8), (_c, n) => (Math.abs(n.x * ax + n.z * az) > 0.9 ? 0xdcb98a : vary(bark, rng, 0.12)), at, [0, yaw, Math.PI / 2]);
    for (const s of [-1, 1]) {
      const ex = at[0] + s * Math.cos(yaw) * (len / 2 + 0.005);
      const ez = at[2] - s * Math.sin(yaw) * (len / 2 + 0.005);
      p.add(cyl(r * 0.35, r * 0.35, 0.02, 6), 0xb98a55, [ex, at[1], ez], [0, yaw, Math.PI / 2]);
      p.add(jiggle(ico(r * 0.55, 0), 0.03, s + 3), 0x5f9a45, [ex - s * Math.cos(yaw) * 0.25, at[1] + r * 0.85, ez + s * Math.sin(yaw) * 0.25], undefined, [1.3, 0.45, 1.1]);
    }
  };
  log(3.3, 0.3, [0, 0.3, -0.33], 0.04);
  log(3.0, 0.28, [0.1, 0.28, 0.33], -0.05);
  log(2.9, 0.26, [-0.05, 0.76, 0.0], 0.1);
  // Branch stubs and an axe biting into the top log.
  p.add(cone(0.07, 0.3, 5), bark, [0.7, 0.95, 0.12], [0.6, 0, -0.5]);
  p.add(cone(0.06, 0.25, 5), bark, [-1.0, 0.5, -0.6], [-0.8, 0, 0.2]);
  p.add(rod([0.5, 0.98, 0.02], [0.7, 1.62, 0.25], 0.03, 6), PAL.woodLight);
  p.add(box(0.06, 0.16, 0.24), PAL.iron, [0.48, 0.96, -0.02], [0.35, 0, -0.3]);
};

const herbNode: Builder = (c) => {
  const { body: p, rng } = c;
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * TAU + rng() * 0.4;
    const r = k === 0 ? 0 : 0.18 + rng() * 0.28;
    p.add(jiggle(ico(0.2 + rng() * 0.08, 0), 0.03, k), [PAL.leaf, PAL.leafMid, 0x6abf4b][k % 3], [Math.cos(a) * r, 0.16 + (k === 0 ? 0.12 : rng() * 0.06), Math.sin(a) * r], [rng(), rng() * 3, 0], [1.1, 0.7, 1.1]);
  }
  for (let k = 0; k < 12; k++) {
    const a = rng() * TAU;
    const r = rng() * 0.42;
    const y = 0.38 + rng() * 0.26;
    p.add(rod([Math.cos(a) * r * 0.7, 0.2, Math.sin(a) * r * 0.7], [Math.cos(a) * r, y, Math.sin(a) * r], 0.008, 3), PAL.leafDark);
    p.add(octa(0.045), k % 2 ? PAL.white : 0xb48be0, [Math.cos(a) * r, y + 0.02, Math.sin(a) * r], undefined, [1, 0.6, 1]);
  }
};

const BUILDERS: Record<string, Builder> = {
  cottage,
  townhouse,
  inn,
  stall,
  workbench,
  tradingPost,
  dock,
  lighthouse,
  windmill,
  well,
  stable,
  workshop,
  boathouse,
  registrar,
  launchDeck,
  noticeBoard,
  housePlot,
  scarecrow,
  farmPlot,
  oreNode,
  stoneNode,
  timberNode,
  herbNode,
};

/** A plain block with a roof, for any structure id without its own build. */
const generic: Builder = (c) => {
  const { d, body: p, rng } = c;
  p.add(box(d.w * 0.9, d.h * 0.55, d.d * 0.9), PAL.plaster, [0, d.h * 0.275, 0]);
  gable(p, { x0: -d.w * 0.45, x1: d.w * 0.45, zf: d.d / 2, zb: -d.d / 2, eave: d.h * 0.55, ridge: d.h, thick: 0.2, over: 0.2, courses: 5, colors: [PAL.roofRed, PAL.roofRedDark], cap: PAL.roofRedDark }, rng);
};

/**
 * Builds a structure from its data id. Options: `stage` (cottage 0..4), `tint` (stall awning),
 * `seed` (variation). Windmill sails are a child named 'sails' that animate() turns about Z.
 */
export function buildStructure(id: string, opts: StructureOpts = {}): StructureModel {
  const d = structureData(id) ?? { id, w: 3, d: 3, h: 3, collider: 'box', look: '' };
  const root = new THREE.Group();
  root.name = `structure:${id}`;
  const c: Ctx = { d, body: new Parts(), glow: new Parts(), root, rng: makeRng((opts.seed ?? 1) * 977 + id.length * 13), opts };
  const animate = (BUILDERS[id] ?? generic)(c) ?? undefined;
  if (!c.body.empty) mesh(root, c.body.build(), { name: 'body' });
  let lamp: THREE.MeshBasicMaterial | null = null;
  if (!c.glow.empty) {
    if (id === 'lighthouse') lamp = glowMaterial().clone();
    mesh(root, c.glow.build(), { mat: lamp ?? glowMaterial(), shadow: false, name: 'glow' });
  }
  if (lamp) {
    const m = lamp;
    return {
      root,
      animate(t) {
        m.color.setScalar(0.82 + 0.18 * Math.sin(t * 2.2));
      },
    };
  }
  return { root, animate };
}

