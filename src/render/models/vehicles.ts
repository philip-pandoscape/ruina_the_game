import * as THREE from 'three';
import type { BoatDef, VehicleDef, Wheel, WheeledDef } from '../../content/vehicles';
import {
  Cloth,
  PAL,
  Parts,
  TAU,
  arc,
  beam,
  bev,
  box,
  clothMaterial,
  color,
  cone,
  cyl,
  extrude,
  glowMaterial,
  ico,
  lathe,
  mesh,
  octa,
  pivot,
  ring,
  rod,
  span,
  tor,
  type Rgb,
  type V3,
} from './kit';
import { toon } from '../toon';

// Vehicles: wheeled carts and cars, and boats. Built around the anchors in shared/vehicles.json
// (seats, cargo slots, wheels, oars, masts), so the rules and the art agree on where things are.
// Frame: faces +Z, +Y up, right-hand side at -X. Wheeled: origin on the ground at the footprint
// centre, wheel centres at y = r. Boats: origin at the waterline, hull down to -draft.

export interface VehicleAnim {
  /** m/s along +Z, signed. */
  speed: number;
  /** -1..1, + = turn left. */
  steer: number;
  /** -1..1. */
  throttle: number;
  /** 0 furled .. 1 full. */
  sail: number;
  /** Radians the boom / yard swings off centre; + swings it out over the right (-X) side. */
  boom: number;
  /** Seconds. */
  time: number;
}

export interface VehicleModel {
  root: THREE.Group;
  animate(dt: number, s: VehicleAnim): void;
}

type Animator = (dt: number, s: VehicleAnim) => void;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => {
  const k = clamp(t, 0, 1);
  return k * k * (3 - 2 * k);
};

/** What a vehicle is assembled into: outlined body, thin un-outlined trim, lit glass. */
interface Build {
  root: THREE.Group;
  body: Parts;
  trim: Parts;
  glow: Parts;
  anims: Animator[];
  outline: number;
}

function start(def: VehicleDef, outline: number): Build {
  const root = new THREE.Group();
  root.name = `vehicle:${def.id}`;
  return { root, body: new Parts(), trim: new Parts(), glow: new Parts(), anims: [], outline };
}

function finish(b: Build): VehicleModel {
  if (!b.body.empty) mesh(b.root, b.body.build(), { outline: b.outline, name: 'body' });
  if (!b.trim.empty) mesh(b.root, b.trim.build(), { name: 'trim' });
  if (!b.glow.empty) mesh(b.root, b.glow.build(), { mat: glowMaterial(), shadow: false, name: 'glow' });
  return {
    root: b.root,
    animate(dt, s) {
      for (const a of b.anims) a(dt, s);
    },
  };
}

// ---------- shared parts ----------

interface WheelLook {
  tyre: Rgb;
  rim: Rgb;
  hub: Rgb;
  cap: Rgb;
  /** Spoke count; 0 for a disc wheel. */
  spokes: number;
  spoke?: Rgb;
  disc?: Rgb;
  width: number;
  /** Radial thickness of the tyre and of the rim inside it. */
  tyreDepth: number;
  rimDepth: number;
}

const wheelCache = new Map<string, { solid: THREE.BufferGeometry; thin: THREE.BufferGeometry | null }>();

/** One wheel, axle along X, hub sticking out on the `side` (+1 = +X). */
function wheelGeometry(r: number, w: WheelLook, side: number) {
  const key = `${r}:${side}:${JSON.stringify(w)}`;
  let g = wheelCache.get(key);
  if (g) return g;
  const solid = new Parts();
  const thin = new Parts();
  const axle: V3 = [0, 0, -Math.PI / 2];
  const rIn = r - w.tyreDepth;
  solid.add(ring(rIn, r, w.width, 12), w.tyre, undefined, axle);
  if (w.spokes > 0) solid.add(ring(rIn - w.rimDepth, rIn + 0.004, w.width * 0.86, 12), w.rim, undefined, axle);
  const hubR = Math.max(0.05, r * 0.2);
  solid.add(cyl(hubR, hubR, w.width + 0.04, 7), w.hub, [side * 0.02, 0, 0], axle);
  solid.add(cyl(hubR * 0.55, hubR * 0.8, 0.04, 7), w.cap, [side * (w.width / 2 + 0.055), 0, 0], axle);
  if (w.spokes > 0) {
    const r0 = hubR * 0.7;
    const r1 = rIn - w.rimDepth * 0.5;
    const t = Math.max(0.025, r * 0.075);
    for (let k = 0; k < w.spokes; k++) {
      const a = (k / w.spokes) * TAU;
      thin.add(beam([0, Math.cos(a) * r0, Math.sin(a) * r0], [0, Math.cos(a) * r1, Math.sin(a) * r1], t, t * 0.8), w.spoke ?? w.rim);
    }
  } else {
    solid.add(cyl(rIn + 0.004, rIn + 0.004, w.width * 0.6, 12), w.disc ?? w.rim, undefined, axle);
  }
  g = { solid: solid.build(), thin: thin.empty ? null : thin.build() };
  wheelCache.set(key, g);
  return g;
}

/** Wheels as steer (yaw) and spin (roll) pivots, driven by speed and steer. */
function wheels(b: Build, list: Wheel[], look: WheelLook): void {
  const spin: THREE.Group[] = [];
  const steer: THREE.Group[] = [];
  for (const w of list) {
    const yaw = pivot(b.root, w.x, w.r, w.z, 'wheel');
    const roll = pivot(yaw, 0, 0, 0, 'spin');
    const g = wheelGeometry(w.r, look, w.x >= 0 ? 1 : -1);
    mesh(roll, g.solid, { outline: b.outline });
    if (g.thin) mesh(roll, g.thin);
    spin.push(roll);
    if (w.steer) steer.push(yaw);
  }
  let dist = 0;
  b.anims.push((dt, s) => {
    dist = (dist + s.speed * dt) % 10000;
    list.forEach((w, i) => (spin[i].rotation.x = (dist / w.r) % TAU));
    for (const g of steer) g.rotation.y = clamp(s.steer, -1, 1) * 0.5;
  });
}

/** A small iron lantern with lit glass, its base at `at`. */
function lantern(b: Build, at: V3, s = 1): void {
  const [x, y, z] = at;
  b.glow.add(box(0.11 * s, 0.14 * s, 0.11 * s), PAL.glow, [x, y + 0.1 * s, z]);
  b.body.add(box(0.16 * s, 0.03 * s, 0.16 * s), PAL.iron, [x, y + 0.015 * s, z]);
  b.body.add(box(0.15 * s, 0.025 * s, 0.15 * s), PAL.iron, [x, y + 0.185 * s, z]);
  b.body.add(cone(0.1 * s, 0.08 * s, 4), PAL.iron, [x, y + 0.235 * s, z], [0, Math.PI / 4, 0]);
  b.trim.add(tor(0.03 * s, 0.008 * s, 4, 8), PAL.iron, [x, y + 0.29 * s, z]);
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    b.trim.add(box(0.018 * s, 0.15 * s, 0.018 * s), PAL.iron, [x + dx * 0.062 * s, y + 0.1 * s, z + dz * 0.062 * s]);
  }
}

/**
 * A flag or pennant flying from a pole top at `at`, streaming toward -Z (aft) and rippling
 * faster as the vehicle speeds up.
 */
function flag(b: Build, at: V3, len: number, h: number, colours: (i: number, j: number) => Rgb, pennant = false): void {
  const cloth = new Cloth(6, pennant ? 1 : 2, colours);
  const m = mesh(b.root, cloth.geometry, { mat: clothMaterial(), receive: false, name: 'flag' });
  m.position.set(...at);
  let phase = 0;
  const shape = (wave: number) =>
    cloth.shape((u, v, out) => {
      const taper = pennant ? 1 - u * 0.92 : 1;
      out.set(Math.sin(phase - u * 5) * 0.12 * len * u * wave, -h / 2 + (v - 0.5) * h * taper, -u * len);
    });
  shape(0.4);
  b.anims.push((dt, s) => {
    const sp = Math.abs(s.speed);
    phase += dt * (3 + Math.min(sp, 15) * 0.6);
    shape(0.35 + Math.min(1, sp / 10) * 0.4);
  });
}

// ---------- hulls ----------

interface HullSpec {
  /** Stern and bow ends of the sheer line. */
  z0: number;
  z1: number;
  /** Max half-beam at the gunwale. */
  half: number;
  /** Shape along the length, t = 0 at the stern .. 1 at the bow. */
  halfAt: (t: number) => number;
  sheerAt: (t: number) => number;
  /** Depth of the hull bottom below the waterline (positive). */
  keelAt: (t: number) => number;
  /** Inner floor / deck height. */
  floorAt: (t: number) => number;
  thick: number;
  /** Section exponent: 2 is round, higher is boxier. */
  fullness: number;
  stations: number;
  rows: number;
  outside: (row: number, y: number) => Rgb;
  inside: Rgb;
  rim: Rgb;
  deck: (strip: number) => Rgb;
  /** Square stern (transom) colour, if the stern is cut off flat. */
  transom?: Rgb;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Collects triangles with flat colours, flipping any whose normal disagrees with a hint. */
class Tris {
  private pos: number[] = [];
  private col: number[] = [];
  private n = new THREE.Vector3();
  private e1 = new THREE.Vector3();
  private e2 = new THREE.Vector3();

  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, k: Rgb, hint: THREE.Vector3): void {
    this.n.crossVectors(this.e1.subVectors(c, b), this.e2.subVectors(a, b));
    if (this.n.lengthSq() < 1e-12) return;
    const [p, q] = this.n.dot(hint) < 0 ? [c, b] : [b, c];
    const kc = color(k);
    for (const v of [a, p, q]) {
      this.pos.push(v.x, v.y, v.z);
      this.col.push(kc.r, kc.g, kc.b);
    }
  }

  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, k: Rgb, hint: THREE.Vector3): void {
    this.tri(a, b, c, k, hint);
    this.tri(a, c, d, k, hint);
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
}

/**
 * A lofted open hull: planked outside, an inner skin down to the floor or deck, a gunwale cap,
 * the deck itself, and a flat transom if the stern is square.
 */
function hull(s: HullSpec): THREE.BufferGeometry {
  const T = new Tris();
  const e = 2 / s.fullness;
  const N = s.stations;
  const zAt = (t: number) => s.z0 + (s.z1 - s.z0) * t;
  const section = (t: number, u: number) => {
    const th = (u * Math.PI) / 2;
    const hb = s.half * s.halfAt(t);
    const sh = s.sheerAt(t);
    const kd = s.keelAt(t);
    return { x: hb * Math.pow(Math.sin(th), e), y: sh - (sh + kd) * Math.pow(Math.cos(th), e) };
  };
  /** Outer half-width at height y (inverting the section). */
  const widthAt = (t: number, y: number) => {
    const hb = s.half * s.halfAt(t);
    const sh = s.sheerAt(t);
    const kd = s.keelAt(t);
    const c = clamp((sh - y) / (sh + kd), 0, 1);
    const th = Math.acos(Math.pow(c, 1 / e));
    return hb * Math.pow(Math.sin(th), e);
  };
  const outer: THREE.Vector3[][] = [];
  const inner: THREE.Vector3[][] = [];
  const K = 3;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const z = zAt(t);
    const row: THREE.Vector3[] = [];
    for (let j = 0; j <= s.rows; j++) {
      const p = section(t, j / s.rows);
      row.push(V(p.x, p.y, z));
    }
    outer.push(row);
    const fl = s.floorAt(t);
    const sh = s.sheerAt(t);
    const zi = i === 0 && s.transom !== undefined ? z + s.thick : z;
    const inRow: THREE.Vector3[] = [];
    for (let k = 0; k <= K; k++) {
      const y = lerp(fl, sh, k / K);
      inRow.push(V(Math.max(0, widthAt(t, y) - s.thick), y, zi));
    }
    inner.push(inRow);
  }
  const mirror = (v: THREE.Vector3, side: number) => (side > 0 ? v : V(-v.x, v.y, v.z));
  for (const side of [1, -1]) {
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < s.rows; j++) {
        const a = mirror(outer[i][j], side);
        const b = mirror(outer[i + 1][j], side);
        const c = mirror(outer[i + 1][j + 1], side);
        const d = mirror(outer[i][j + 1], side);
        const cy = (a.y + b.y + c.y + d.y) / 4;
        const cx = (a.x + b.x + c.x + d.x) / 4;
        const sh = s.sheerAt((i + 0.5) / N);
        T.quad(a, b, c, d, s.outside(j, cy), V(cx, cy - sh, (i / N - 0.5) * 0.2 * Math.abs(cx)));
      }
      for (let k = 0; k < K; k++) {
        const a = mirror(inner[i][k], side);
        const b = mirror(inner[i + 1][k], side);
        const c = mirror(inner[i + 1][k + 1], side);
        const d = mirror(inner[i][k + 1], side);
        T.quad(a, b, c, d, s.inside, V(-side, 0, 0));
      }
      // Gunwale cap.
      T.quad(mirror(outer[i][s.rows], side), mirror(outer[i + 1][s.rows], side), mirror(inner[i + 1][K], side), mirror(inner[i][K], side), s.rim, V(0, 1, 0));
    }
  }
  // Deck / floorboards in strips that follow the hull.
  const strips = 6;
  for (let i = 0; i < N; i++) {
    for (let m = 0; m < strips; m++) {
      const at = (ii: number, f: number) => {
        const p = inner[ii][0];
        return V(lerp(-p.x, p.x, f), p.y, p.z);
      };
      T.quad(at(i, m / strips), at(i + 1, m / strips), at(i + 1, (m + 1) / strips), at(i, (m + 1) / strips), s.deck(m), V(0, 1, 0));
    }
  }
  if (s.transom !== undefined) {
    const o = outer[0];
    const top = V(0, o[s.rows].y, o[0].z);
    for (const side of [1, -1]) {
      for (let j = 0; j < s.rows; j++) T.tri(top, mirror(o[j], side), mirror(o[j + 1], side), s.transom, V(0, 0, -1));
      // Inside face of the transom, from the floor up.
      const ii = inner[0];
      const base = V(0, ii[0].y, ii[0].z);
      for (let k = 0; k < K; k++) T.tri(base, mirror(ii[k], side), mirror(ii[k + 1], side), s.inside, V(0, 0, 1));
      T.tri(base, mirror(ii[K], side), V(0, ii[K].y, ii[K].z), s.inside, V(0, 0, 1));
      // Top of the transom.
      T.quad(mirror(o[s.rows], side), V(0, o[s.rows].y, o[s.rows].z), V(0, ii[K].y, ii[K].z), mirror(ii[K], side), s.rim, V(0, 1, 0));
    }
  }
  return T.geometry();
}

/** Half-width of a hull spec's inside at a given z and height, for placing seats and hatches. */
function innerHalf(s: HullSpec, z: number, y: number): number {
  const t = clamp((z - s.z0) / (s.z1 - s.z0), 0, 1);
  const e = 2 / s.fullness;
  const hb = s.half * s.halfAt(t);
  const sh = s.sheerAt(t);
  const kd = s.keelAt(t);
  const c = clamp((sh - y) / (sh + kd), 0, 1);
  return Math.max(0, hb * Math.pow(Math.sin(Math.acos(Math.pow(c, 1 / e))), e) - s.thick);
}

/** Strakes: alternating plank shades, a wale along the top, bottom paint below the water. */
function strakes(top: Rgb, a: Rgb, b: Rgb, bottom: Rgb, rows: number, bootTop?: Rgb) {
  return (row: number, y: number): Rgb => {
    if (row === rows - 1) return top;
    if (y < -0.04) return bottom;
    if (bootTop !== undefined && y < 0.16) return bootTop;
    return row % 2 ? a : b;
  };
}

/** A ship's wheel facing +Z (the helmsman sits behind it), turning with steer. */
function helm(b: Build, at: V3, r: number, pedestal: number): void {
  b.body.add(bev(0.16, pedestal, 0.16, 0.03), PAL.woodDark, [at[0], at[1] - pedestal / 2 - r * 0.15, at[2] + 0.12]);
  const g = pivot(b.root, at[0], at[1], at[2], 'helm');
  const p = new Parts();
  p.add(ring(r * 0.86, r, 0.05, 12), PAL.woodDark, undefined, [Math.PI / 2, 0, 0]);
  p.add(cyl(0.06, 0.06, 0.1, 8), PAL.brass, undefined, [Math.PI / 2, 0, 0]);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    p.add(beam([0, 0, 0], [Math.cos(a) * r * 1.22, Math.sin(a) * r * 1.22, 0], 0.03), PAL.wood);
  }
  mesh(g, p.build(), { outline: b.outline * 0.7 });
  b.anims.push((_dt, s) => (g.rotation.z = clamp(s.steer, -1, 1) * 2.4));
}

/** A rudder blade hung on the stern post, deflecting against the turn. */
function rudder(b: Build, at: V3, top: number, bottom: number, chord: number, colour: Rgb): void {
  const g = pivot(b.root, at[0], at[1], at[2], 'rudder');
  const p = new Parts();
  p.add(extrude([[0, bottom], [-chord, bottom + 0.15], [-chord, top - 0.25], [-chord * 0.35, top], [0, top]], 0.1), colour, undefined, [0, Math.PI / 2, 0]);
  p.add(cyl(0.05, 0.05, top - bottom + 0.2, 6), PAL.woodDark, [0, (top + bottom) / 2, 0]);
  mesh(g, p.build(), { outline: b.outline });
  b.anims.push((_dt, s) => (g.rotation.y = -clamp(s.steer, -1, 1) * 0.5));
}

// ---------- the farm cart ----------

function farmCart(def: WheeledDef): VehicleModel {
  const b = start(def, 0.022);
  const { body, trim } = b;
  const paint = 0x4f9a55;
  const paintDark = 0x3f8046;
  const cream = 0xf2e2b0;
  const bedY = Math.min(...def.cargo.map((c) => c.y));
  const seat = def.seats[0];
  const zBack = -def.length / 2 + 0.07;
  const zBed = Math.max(...def.cargo.map((c) => c.z)) + 0.5;
  const hw = Math.max(...def.cargo.map((c) => Math.abs(c.x))) + 0.36;
  const wr = def.wheels[0].r;
  const zFront = def.length / 2 - 0.12;

  // Chassis: rails, bolsters over the axles, iron axles.
  for (const x of [-0.5, 0.5]) body.add(box(0.1, 0.12, zFront - zBack), PAL.woodDark, [x, bedY - 0.17, (zFront + zBack) / 2]);
  for (const w of def.wheels.filter((w) => w.x > 0)) {
    body.add(box(1.25, 0.12, 0.16), PAL.woodDark, [0, wr + 0.1, w.z]);
    trim.add(rod([-w.x + 0.05, wr, w.z], [w.x - 0.05, wr, w.z], 0.035, 6), PAL.iron);
  }
  // Bed: planks, painted boards, stakes with iron caps.
  for (let i = 0; i < 6; i++) {
    const x = -hw + (i + 0.5) * ((hw * 2) / 6);
    body.add(box((hw * 2) / 6 - 0.012, 0.07, zBed - zBack), i % 2 ? PAL.woodLight : PAL.wood, [x, bedY - 0.035, (zBed + zBack) / 2]);
  }
  body.add(box(hw * 2 + 0.02, 0.05, zBed - zBack + 0.02), PAL.woodDark, [0, bedY - 0.095, (zBed + zBack) / 2]);
  const boardH = 0.15;
  for (const [y0, c] of [[bedY, paint], [bedY + boardH + 0.04, paintDark]] as const) {
    for (const sx of [-1, 1]) body.add(box(0.06, boardH, zBed - zBack), c, [sx * (hw + 0.03), y0 + boardH / 2, (zBed + zBack) / 2]);
    for (const z of [zBack + 0.03, zBed - 0.03]) body.add(box(hw * 2, boardH, 0.06), c, [0, y0 + boardH / 2, z]);
  }
  for (const sx of [-1, 1]) {
    for (const z of [zBack + 0.04, (zBack + zBed) / 2, zBed - 0.04]) {
      body.add(box(0.07, 0.5, 0.07), PAL.woodDark, [sx * (hw + 0.07), bedY + 0.17, z]);
      body.add(box(0.09, 0.04, 0.09), PAL.iron, [sx * (hw + 0.07), bedY + 0.43, z]);
    }
    trim.add(box(0.012, 0.03, zBed - zBack - 0.1), cream, [sx * (hw + 0.066), bedY + boardH + 0.02, (zBed + zBack) / 2]);
  }
  // Seat box with the bench, two cushions and a backrest.
  const sz = seat.z;
  body.add(bev(1.3, seat.y - 0.12 - (bedY - 0.23), 0.6, 0.03), paint, [0, (seat.y - 0.12 + bedY - 0.23) / 2, sz + 0.02]);
  trim.add(box(1.31, 0.03, 0.61), cream, [0, seat.y - 0.2, sz + 0.02]);
  body.add(bev(1.42, 0.05, 0.5, 0.015), PAL.woodLight, [0, seat.y - 0.095, sz]);
  for (const s of def.seats) body.add(bev(0.56, 0.075, 0.44, 0.03), PAL.mustard, [s.x, seat.y - 0.0375, s.z]);
  const back = [0, seat.y + 0.2, sz - 0.27] as const;
  body.add(bev(1.42, 0.36, 0.06, 0.02), paint, back, [-0.18, 0, 0]);
  body.add(bev(1.2, 0.2, 0.05, 0.02), PAL.mustard, [0, seat.y + 0.2, sz - 0.235], [-0.18, 0, 0]);
  for (const sx of [-1, 1]) body.add(box(0.07, 0.6, 0.07), PAL.woodDark, [sx * 0.7, seat.y + 0.12, sz - 0.3], [-0.18, 0, 0]);
  // Footboard and dashboard.
  body.add(box(1.2, 0.05, 0.42), PAL.wood, [0, seat.y - 0.45, sz + 0.5], [0.25, 0, 0]);
  body.add(bev(1.3, 0.34, 0.06, 0.02), paint, [0, seat.y - 0.28, zFront - 0.02], [0.12, 0, 0]);
  trim.add(box(1.31, 0.03, 0.065), cream, [0, seat.y - 0.13, zFront - 0.002], [0.12, 0, 0]);
  // Steering wheel for the driver.
  const drv = def.seats.find((s) => s.pose === 'drive') ?? seat;
  const top: V3 = [drv.x, seat.y + 0.25, sz + 0.38];
  trim.add(rod([drv.x, seat.y - 0.4, zFront - 0.05], top, 0.025, 6), PAL.iron);
  body.add(tor(0.16, 0.022, 5, 12), PAL.woodDark, top, [-0.95, 0, 0]);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU;
    trim.add(beam([0, 0, 0], [Math.cos(a) * 0.16, Math.sin(a) * 0.16, 0], 0.018), PAL.woodDark, top, [-0.95, 0, 0]);
  }
  // Lantern on a crooked post at the front corner.
  const lx = hw - 0.05;
  body.add(box(0.06, 0.7, 0.06), PAL.woodDark, [lx, seat.y + 0.12, zFront - 0.08]);
  body.add(box(0.05, 0.05, 0.22), PAL.woodDark, [lx, seat.y + 0.45, zFront + 0.02]);
  lantern(b, [lx, seat.y + 0.19, zFront + 0.12], 0.9);
  trim.add(rod([lx, seat.y + 0.45, zFront + 0.12], [lx, seat.y + 0.45, zFront + 0.12], 0.01), PAL.iron);
  // A bucket under the tail.
  body.add(cyl(0.12, 0.09, 0.2, 8), PAL.ironLight, [-0.3, bedY - 0.32, zBack + 0.15]);
  trim.add(tor(0.11, 0.008, 3, 8, Math.PI), PAL.iron, [-0.3, bedY - 0.22, zBack + 0.15]);
  // Pennant on a pole at the back-left corner, topping out at the cart's height.
  const px = hw + 0.07;
  trim.add(rod([px, bedY + 0.45, zBack + 0.04], [px, def.height, zBack + 0.04], 0.022, 6), PAL.woodDark);
  flag(b, [px, def.height - 0.02, zBack + 0.03], 0.55, 0.3, () => PAL.red, true);
  wheels(b, def.wheels, {
    tyre: PAL.iron,
    rim: 0xc9553c,
    hub: 0xc9553c,
    cap: PAL.iron,
    spokes: 8,
    spoke: 0xb94a33,
    width: 0.11,
    tyreDepth: 0.035,
    rimDepth: 0.075,
  });
  return finish(b);
}

// ---------- the roadster ----------

function roadster(def: WheeledDef): VehicleModel {
  const b = start(def, 0.02);
  const { body, trim, glow } = b;
  const red = 0xd8473c;
  const redDark = 0xb33a31;
  const chrome = PAL.steel;
  const seat = def.seats[0];
  const L = def.length / 2;
  const cargo = def.cargo[0];
  const front = def.wheels.find((w) => w.steer)!;
  const rear = def.wheels.find((w) => !w.steer)!;

  // Floor pan and running boards.
  body.add(span(-0.6, 0.6, 0.2, 0.3, -L + 0.3, L - 0.35), PAL.black);
  for (const sx of [-1, 1]) {
    body.add(span(sx * 0.62, sx * 0.88, 0.26, 0.31, rear.z + rear.r + 0.12, front.z - front.r - 0.1), PAL.black);
    trim.add(span(sx * 0.875, sx * 0.885, 0.255, 0.315, rear.z + rear.r + 0.12, front.z - front.r - 0.1), chrome);
  }
  // Cockpit tub: sides, rear bulkhead and scuttle.
  const zSeat = seat.z;
  for (const sx of [-1, 1]) body.add(bev(0.08, 0.5, 1.3, 0.035), red, [sx * 0.64, 0.53, zSeat + 0.05]);
  body.add(bev(1.36, 0.5, 0.1, 0.035), red, [0, 0.53, zSeat - 0.6]);
  body.add(bev(1.36, 0.58, 0.22, 0.05), red, [0, 0.57, zSeat + 0.66]);
  for (const sx of [-1, 1]) trim.add(beam([sx * 0.685, 0.79, zSeat - 0.6], [sx * 0.685, 0.79, zSeat + 0.7], 0.03, 0.03), PAL.leatherDark);
  // Bonnet with a cream stripe and louvres.
  const zb0 = zSeat + 0.75;
  const zb1 = L - 0.2;
  body.add(bev(1.0, 0.46, zb1 - zb0, 0.08), red, [0, 0.63, (zb0 + zb1) / 2]);
  trim.add(box(0.16, 0.02, zb1 - zb0 - 0.04), PAL.cream, [0, 0.865, (zb0 + zb1) / 2]);
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 5; k++) trim.add(box(0.012, 0.16, 0.035), redDark, [sx * 0.503, 0.66, zb0 + 0.25 + k * 0.1]);
  }
  // Grille, radiator cap and a gold mascot.
  body.add(bev(0.86, 0.56, 0.1, 0.06), chrome, [0, 0.6, zb1 + 0.04]);
  body.add(box(0.66, 0.42, 0.02), PAL.black, [0, 0.6, zb1 + 0.095]);
  for (let k = -3; k <= 3; k++) trim.add(box(0.025, 0.4, 0.02), chrome, [k * 0.09, 0.6, zb1 + 0.105]);
  body.add(cyl(0.035, 0.045, 0.06, 8), chrome, [0, 0.91, zb1 - 0.02]);
  body.add(octa(0.04), PAL.gold, [0, 0.97, zb1 - 0.02], undefined, [0.8, 1.2, 1.4]);
  for (const sx of [-1, 1]) body.add(box(0.1, 0.02, 0.05), PAL.gold, [sx * 0.06, 0.975, zb1 - 0.03], [0, 0, sx * 0.4]);
  // Headlamps on a bar, with lit lenses.
  trim.add(rod([-0.5, 0.62, zb1 - 0.05], [0.5, 0.62, zb1 - 0.05], 0.02, 6), chrome);
  for (const sx of [-1, 1]) {
    body.add(cyl(0.11, 0.08, 0.16, 10), chrome, [sx * 0.5, 0.74, zb1 - 0.02], [Math.PI / 2, 0, 0]);
    glow.add(cyl(0.085, 0.085, 0.02, 10), 0xfff2c4, [sx * 0.5, 0.74, zb1 + 0.065], [Math.PI / 2, 0, 0]);
    trim.add(rod([sx * 0.5, 0.62, zb1 - 0.05], [sx * 0.5, 0.68, zb1 - 0.03], 0.02, 5), chrome);
  }
  // Boat-tail and the pack rack.
  const zt0 = zSeat - 0.65;
  const tail: Array<[number, number]> = [
    [-0.66, -zt0],
    [0.66, -zt0],
    [0.6, -(-L + 0.45)],
    [0.34, -(-L + 0.06)],
    [-0.34, -(-L + 0.06)],
    [-0.6, -(-L + 0.45)],
  ];
  body.add(extrude(tail, 0.42), red, [0, 0.5, 0], [-Math.PI / 2, 0, 0]);
  body.add(extrude(tail.map(([x, y]) => [x * 0.92, y] as [number, number]), 0.08), redDark, [0, 0.74, 0], [-Math.PI / 2, 0, 0]);
  const rackY = cargo.y - 0.02;
  const rz0 = cargo.z + 0.32;
  const rz1 = cargo.z - 0.33;
  for (const x of [-0.3, 0.3]) {
    trim.add(rod([x, rackY, rz0], [x, rackY, rz1], 0.018, 5), chrome);
    for (const z of [rz0 - 0.02, rz1 + 0.02]) trim.add(rod([x, 0.78, z], [x, rackY, z], 0.016, 5), chrome);
  }
  for (let k = 0; k < 4; k++) body.add(box(0.64, 0.025, 0.05), PAL.woodLight, [0, cargo.y - 0.0125, lerp(rz0, rz1, k / 3)]);
  // Tail lights.
  for (const sx of [-1, 1]) glow.add(box(0.08, 0.06, 0.03), 0xff4a3a, [sx * 0.3, 0.62, -L + 0.07]);
  // Striped bench seat and backrest.
  const stripes = 8;
  for (let k = 0; k < stripes; k++) {
    const x = -0.6 + (k + 0.5) * (1.2 / stripes);
    const c = k % 2 ? PAL.cream : PAL.red;
    body.add(box(1.2 / stripes, 0.13, 0.5), c, [x, seat.y - 0.065, zSeat - 0.02]);
    body.add(box(1.2 / stripes, 0.44, 0.1), c, [x, seat.y + 0.2, zSeat - 0.33], [-0.22, 0, 0]);
  }
  body.add(box(1.24, 0.1, 0.54), PAL.black, [0, seat.y - 0.18, zSeat - 0.02]);
  // Windscreen.
  const zw = zSeat + 0.58;
  for (const sx of [-1, 1]) trim.add(rod([sx * 0.55, 0.84, zw], [sx * 0.55, def.height - 0.02, zw - 0.08], 0.022, 6), chrome);
  trim.add(rod([-0.56, def.height - 0.02, zw - 0.08], [0.56, def.height - 0.02, zw - 0.08], 0.02, 6), chrome);
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(1.08, def.height - 0.88),
    toon(0xcfeef7, { transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }),
  );
  glass.position.set(0, (def.height + 0.84) / 2, zw - 0.04);
  glass.rotation.x = -0.2;
  b.root.add(glass);
  // Steering wheel.
  const drv = def.seats.find((s) => s.pose === 'drive') ?? seat;
  const sw: V3 = [drv.x, seat.y + 0.33, zSeat + 0.42];
  body.add(tor(0.17, 0.02, 5, 14), PAL.black, sw, [-0.9, 0, 0]);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU + Math.PI / 2;
    trim.add(beam([0, 0, 0], [Math.cos(a) * 0.17, Math.sin(a) * 0.17, 0], 0.016), chrome, sw, [-0.9, 0, 0]);
  }
  trim.add(rod(sw, [drv.x, 0.75, zSeat + 0.72], 0.02, 6), PAL.black);
  // Side exhausts: three pipes out of the bonnet into one along the running board.
  for (let k = 0; k < 3; k++) {
    const z = zb0 + 0.3 + k * 0.18;
    trim.add(rod([0.5, 0.6, z], [0.7, 0.42, z - 0.12], 0.03, 6), chrome);
  }
  trim.add(rod([0.72, 0.4, zb0 + 0.42], [0.72, 0.4, rear.z + rear.r + 0.05], 0.045, 8), chrome);
  trim.add(rod([0.72, 0.4, rear.z + rear.r + 0.05], [0.72, 0.4, rear.z + rear.r - 0.05], 0.045, 8, 0.06), chrome);
  // Cycle mudguards.
  for (const w of def.wheels) {
    const sx = w.x >= 0 ? 1 : -1;
    const [a0, a1] = w.steer ? [0.45, Math.PI + 0.25] : [-0.15, Math.PI - 0.35];
    body.add(arc(w.r + 0.05, w.r + 0.1, 0.3, a0, a1, 7), red, [w.x, w.r, w.z], [0, Math.PI / 2, 0]);
    trim.add(rod([sx * 0.6, 0.5, w.z], [w.x - sx * 0.12, w.r + 0.02, w.z], 0.02, 5), PAL.black);
  }
  wheels(b, def.wheels, {
    tyre: PAL.black,
    rim: PAL.cream,
    hub: PAL.cream,
    cap: chrome,
    spokes: 0,
    disc: PAL.cream,
    width: 0.2,
    tyreDepth: 0.1,
    rimDepth: 0.03,
  });
  return finish(b);
}

// ---------- boats ----------

/** Two oars at the oarlocks, swept in a rowing cycle whose rate follows |throttle|. */
function oars(b: Build, def: BoatDef): void {
  const locks = def.oars ?? [];
  const sides: Array<{ sweep: THREE.Group; dip: THREE.Group; feather: THREE.Group; side: number; phase: number; drive: number }> = [];
  const oarGeo = (() => {
    const p = new Parts();
    p.add(rod([-0.68, 0, 0], [1.3, 0, 0], 0.03, 6), PAL.woodLight);
    p.add(rod([-0.78, 0, 0], [-0.62, 0, 0], 0.036, 6), PAL.woodDark);
    p.add(bev(0.55, 0.17, 0.035, 0.015), PAL.woodLight, [1.5, 0, 0]);
    p.add(box(0.18, 0.172, 0.04), 0xc94f3d, [1.68, 0, 0]);
    p.add(cyl(0.04, 0.04, 0.08, 6), PAL.leather, [0, 0, 0], [0, 0, Math.PI / 2]);
    return p.build();
  })();
  for (const lock of locks) {
    const side = lock.x >= 0 ? 1 : -1;
    b.body.add(box(0.12, 0.06, 0.16), PAL.woodDark, [lock.x - side * 0.02, lock.y - 0.05, lock.z]);
    b.trim.add(tor(0.035, 0.01, 4, 8, Math.PI), PAL.brass, [lock.x, lock.y + 0.005, lock.z], [0, Math.PI / 2, 0]);
    const base = pivot(b.root, lock.x, lock.y + 0.02, lock.z, 'oar');
    base.scale.x = side;
    const sweep = pivot(base, 0, 0, 0);
    const dip = pivot(sweep, 0, 0, 0);
    const feather = pivot(dip, 0, 0, 0);
    mesh(feather, oarGeo, { outline: b.outline * 0.8 });
    sides.push({ sweep, dip, feather, side, phase: 0, drive: 0 });
  }
  const REST_DIP = -0.27;
  b.anims.push((dt, s) => {
    for (const o of sides) {
      // Turning left pulls harder on the right (-X) oar.
      const want = clamp(s.throttle - o.side * clamp(s.steer, -1, 1) * 0.6, -1, 1);
      o.drive += (want - o.drive) * Math.min(1, dt * 4);
      const k = smooth(Math.abs(o.drive) * 1.5);
      const rate = 0.35 + 0.6 * Math.abs(o.drive);
      o.phase = (o.phase + dt * rate * Math.sign(o.drive || 1) * (k > 0.01 ? 1 : 0) + 1) % 1;
      const ph = o.phase;
      const A = 0.55 * k;
      const sweep = ph < 0.55 ? -A * Math.cos((Math.PI * ph) / 0.55) : A * Math.cos((Math.PI * (ph - 0.55)) / 0.45);
      const inWater = 0.5 + 0.5 * Math.cos(TAU * (ph - 0.275));
      o.sweep.rotation.y = sweep;
      o.dip.rotation.z = lerp(REST_DIP, lerp(-0.2, -0.4, inWater), k);
      o.feather.rotation.x = lerp(0.6, (1 - smooth((inWater - 0.25) / 0.4)) * 1.45, k);
    }
  });
}

/** A gaff mainsail on a swinging boom, and a jib on the forestay, both filling with `sail`. */
function sloopRig(b: Build, mastZ: number, deck: number, mastTop: number, bowsprit: V3, stern: number): void {
  const boomY = deck + 1.85;
  const boomLen = mastZ - stern - 0.35;
  const g = pivot(b.root, 0, boomY, mastZ, 'boom');
  const spars = new Parts();
  spars.add(rod([0, 0, -0.1], [0, 0, -boomLen], 0.07, 8, 0.055), PAL.woodLight);
  spars.add(cyl(0.11, 0.11, 0.18, 8), PAL.woodDark, [0, 0, 0]);
  mesh(g, spars.build(), { outline: b.outline });
  const gaff = pivot(g, 0, 0, 0, 'gaff');
  const gaffLen = boomLen * 0.72;
  mesh(gaff, new Parts().add(rod([0, 0, -0.08], [0, 0, -gaffLen], 0.055, 6, 0.045), PAL.woodLight).build(), { outline: b.outline });
  const main = new Cloth(7, 8, (_i, j) => (j === 0 ? 0xc0392b : j % 2 ? PAL.canvas : 0xece0c2));
  const mm = mesh(g, main.geometry, { mat: clothMaterial(), name: 'mainsail', receive: false });
  mm.castShadow = true;
  const throatH = mastTop - 1.6 - boomY;
  const peakH = mastTop - 0.15 - boomY;
  const jib = new Cloth(5, 6, (_i, j) => (j % 2 ? PAL.canvas : 0xece0c2));
  const jm = mesh(b.root, jib.geometry, { mat: clothMaterial(), name: 'jib', receive: false });
  jm.castShadow = true;
  const head = new THREE.Vector3(0, mastTop - 0.9, mastZ + 0.08);
  const tack = new THREE.Vector3(...bowsprit);
  const stay = head.clone().sub(tack).normalize();
  const clew0 = new THREE.Vector3(0, deck + 1.1, mastZ + 0.9);
  const q = new THREE.Quaternion();
  const clew = new THREE.Vector3();
  const n = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  let fill = 1;
  let swing = 0;
  const shape = (time: number) => {
    const f = Math.max(0.06, fill);
    const dir = clamp(swing * 3, -1, 1);
    const depth = 0.55 * fill;
    const throat = lerp(0.25, throatH, f);
    const peak = lerp(0.3, peakH, f);
    gaff.position.y = throat;
    gaff.rotation.x = Math.atan2(peak - throat, gaffLen * 0.95) ;
    main.shape((u, v, out) => {
      const footZ = -u * (boomLen - 0.1);
      const headZ = -u * gaffLen * 0.95;
      const headY = throat + (peak - throat) * u;
      const y = 0.06 + (headY - 0.06) * v;
      const z = lerp(footZ, headZ, v);
      const bulge = Math.sin(Math.PI * u) * Math.sin(Math.PI * (0.15 + 0.75 * v));
      const flutter = Math.sin(time * 7 + v * 6) * 0.04 * u * u * (1.2 - fill);
      out.set(-dir * depth * bulge + flutter, y, z);
    });
    q.setFromAxisAngle(stay, swing * 0.9);
    clew.copy(clew0).sub(tack).applyQuaternion(q);
    clew.multiplyScalar(lerp(0.12, 1, f)).add(tack);
    n.copy(clew).sub(tack).cross(tmp.copy(head).sub(tack)).normalize();
    jib.shape((u, v, out) => {
      const foot = tmp.copy(tack).lerp(clew, u);
      out.copy(foot).lerp(head, v * (1 - u * 0.0));
      const bulge = Math.sin(Math.PI * u) * Math.sin(Math.PI * (0.1 + 0.8 * v)) * (1 - v) * 1.4;
      out.addScaledVector(n, -dir * 0.35 * fill * bulge);
    });
  };
  shape(0);
  b.anims.push((dt, s) => {
    fill += (clamp(s.sail, 0, 1) - fill) * Math.min(1, dt * 2.5);
    swing += (clamp(s.boom, -1.3, 1.3) - swing) * Math.min(1, dt * 3);
    g.rotation.y = swing;
    shape(s.time);
  });
}

function rowboat(def: BoatDef): VehicleModel {
  const b = start(def, 0.02);
  const { body, trim } = b;
  const L = def.length / 2;
  const rows = 8;
  const lock = def.oars?.[0];
  const spec: HullSpec = {
    z0: -L + 0.05,
    z1: L,
    half: def.width / 2,
    halfAt: (t) => (t < 0.5 ? 0.62 + 0.38 * Math.sin((Math.PI / 2) * (t / 0.5)) : Math.pow(Math.cos((Math.PI / 2) * ((t - 0.5) / 0.5)), 0.75)),
    sheerAt: (t) => (lock ? lock.y - 0.04 : 0.55) + (t > 0.5 ? 0.26 * ((t - 0.5) / 0.5) ** 2 : 0.07 * ((0.5 - t) / 0.5) ** 2),
    keelAt: (t) => (def.draft - 0.05) * (t > 0.55 ? 1 - 0.85 * ((t - 0.55) / 0.45) ** 2 : 1 - 0.45 * ((0.55 - t) / 0.55) ** 2),
    floorAt: () => -0.12,
    thick: 0.05,
    fullness: 2.3,
    stations: 12,
    rows,
    outside: strakes(PAL.white, 0x5aa6d6, 0x4e98c8, 0xb5482f, rows),
    inside: PAL.woodLight,
    rim: PAL.woodDark,
    deck: (m) => (m % 2 ? PAL.wood : PAL.woodLight),
    transom: 0x4e98c8,
  };
  body.list.push(hull(spec));
  // Keel strip and stem post.
  body.add(box(0.08, 0.07, def.length * 0.8), PAL.woodDark, [0, -def.draft + 0.035, -0.1]);
  body.add(beam([0, -0.12, L - 0.1], [0, spec.sheerAt(1) + 0.06, L + 0.01], 0.05, 0.06), PAL.woodDark);
  // Thwarts for the rower and the passenger.
  for (const s of def.seats) {
    const hw = innerHalf(spec, s.z, s.y) + 0.02;
    body.add(box(hw * 2, 0.05, 0.3), PAL.wood, [0, s.y - 0.025, s.z]);
    body.add(box(0.08, s.y + 0.1, 0.08), PAL.woodDark, [0, (s.y - 0.12) / 2, s.z]);
  }
  // Stern sheets where the packs ride.
  const cy = Math.min(...def.cargo.map((c) => c.y));
  const cz0 = Math.max(...def.cargo.map((c) => c.z)) + 0.3;
  for (let k = 0; k < 4; k++) {
    const z0 = lerp(cz0, spec.z0 + 0.06, k / 4);
    const z1 = lerp(cz0, spec.z0 + 0.06, (k + 1) / 4);
    const hw = innerHalf(spec, (z0 + z1) / 2, cy) - 0.01;
    body.add(box(hw * 2, 0.04, Math.abs(z1 - z0) - 0.015), k % 2 ? PAL.wood : PAL.woodLight, [0, cy - 0.02, (z0 + z1) / 2]);
  }
  // A coil of rope in the bow, a fender over the side.
  body.add(tor(0.11, 0.035, 4, 10), PAL.rope, [0, -0.07, L - 0.75], [Math.PI / 2, 0, 0]);
  body.add(tor(0.06, 0.03, 4, 8), PAL.rope, [0.02, -0.03, L - 0.75], [Math.PI / 2, 0, 0]);
  const fz = -0.6;
  const fx = innerHalf(spec, fz, spec.sheerAt(0.35)) + 0.1;
  body.add(cyl(0.06, 0.06, 0.24, 8), PAL.white, [-fx, 0.28, fz]);
  trim.add(rod([-fx, 0.4, fz], [-fx + 0.08, spec.sheerAt(0.33) + 0.01, fz], 0.008, 4), PAL.rope);
  // Bow eye.
  trim.add(tor(0.04, 0.012, 4, 8), PAL.brass, [0, spec.sheerAt(1) - 0.12, L + 0.03], [0, Math.PI / 2, 0]);
  oars(b, def);
  return finish(b);
}

function sloop(def: BoatDef): VehicleModel {
  const b = start(def, 0.03);
  const { body, trim } = b;
  const L = def.length / 2;
  const rows = 8;
  const deck = 0.75;
  const z0 = -L + 0.4;
  const z1 = L - 0.55;
  const spec: HullSpec = {
    z0,
    z1,
    half: def.width / 2,
    halfAt: (t) => (t < 0.45 ? 0.58 + 0.42 * Math.sin((Math.PI / 2) * (t / 0.45)) : Math.pow(Math.cos((Math.PI / 2) * ((t - 0.45) / 0.55)), 0.5)),
    sheerAt: (t) => 1.25 + (t > 0.45 ? 0.38 * ((t - 0.45) / 0.55) ** 2 : 0.12 * ((0.45 - t) / 0.45) ** 2),
    keelAt: (t) => 0.78 * (t > 0.5 ? 1 - 0.8 * ((t - 0.5) / 0.5) ** 2 : 1 - 0.55 * ((0.5 - t) / 0.5) ** 2),
    floorAt: () => deck,
    thick: 0.08,
    fullness: 2.2,
    stations: 16,
    rows,
    outside: strakes(0xf2d17a, 0x2f7f73, 0x2a7268, 0xa63c2c, rows, PAL.white),
    inside: PAL.cream,
    rim: PAL.woodDark,
    deck: (m) => (m % 2 ? PAL.woodPale : PAL.woodLight),
    transom: 0x2a7268,
  };
  body.list.push(hull(spec));
  // Ballast keel down to the draft, stem post and bowsprit.
  body.add(extrude([[-2.6, 0], [1.6, 0], [1.1, -def.draft + 0.75], [-2.2, -def.draft + 0.75]], 0.18), 0x3b3f46, [0, -0.72, 0], [0, -Math.PI / 2, 0]);
  body.add(beam([0, -0.3, z1 - 0.03], [0, spec.sheerAt(1) + 0.12, z1 + 0.05], 0.12), PAL.woodDark);
  const sprit: V3 = [0, spec.sheerAt(1) - 0.02, L - 0.02];
  body.add(rod([0, spec.sheerAt(1) - 0.08, z1 - 0.6], sprit, 0.07, 6, 0.05), PAL.woodLight);
  // Cargo hatch: a raised coaming whose lid is where the packs rest.
  const cy = Math.min(...def.cargo.map((c) => c.y));
  const czs = def.cargo.map((c) => c.z);
  const hz0 = Math.min(...czs) - 0.35;
  const hz1 = Math.max(...czs) + 0.35;
  const hx = Math.max(...def.cargo.map((c) => Math.abs(c.x))) + 0.33;
  body.add(bev(hx * 2 + 0.1, cy - deck, hz1 - hz0 + 0.1, 0.03), PAL.woodDark, [0, (cy + deck) / 2 - 0.01, (hz0 + hz1) / 2]);
  for (let k = 0; k < 7; k++) body.add(box((hx * 2) / 7 - 0.01, 0.03, hz1 - hz0), k % 2 ? PAL.woodPale : PAL.woodLight, [-hx + (k + 0.5) * ((hx * 2) / 7), cy - 0.015, (hz0 + hz1) / 2]);
  // Benches on the foredeck; helm seat aft.
  for (const s of def.seats) {
    if (s.pose === 'helm') continue;
    const across = Math.abs(s.x) < 0.1;
    const [w, d] = across ? [Math.min(1.1, innerHalf(spec, s.z, s.y) * 2 - 0.1), 0.4] : [0.42, 0.95];
    body.add(bev(w, s.y - deck, d, 0.03), PAL.wood, [s.x, (s.y + deck) / 2, s.z]);
    body.add(box(w + 0.04, 0.04, d + 0.04), PAL.woodPale, [s.x, s.y - 0.02, s.z]);
  }
  const hs = def.seats.find((s) => s.pose === 'helm');
  if (hs) {
    body.add(bev(0.7, hs.y - deck, 0.45, 0.03), PAL.wood, [hs.x, (hs.y + deck) / 2, hs.z]);
    body.add(bev(0.6, 0.05, 0.4, 0.02), 0x2f7f73, [hs.x, hs.y - 0.025, hs.z]);
    helm(b, [hs.x, hs.y + 0.42, hs.z + 0.55], 0.32, hs.y + 0.42 - deck);
  }
  // Mast and its rigging, topped with a pennant staff.
  const mast = def.mast!;
  const top = mast.height;
  body.add(rod([mast.x, deck - 0.2, mast.z], [mast.x, top, mast.z], 0.12, 8, 0.075), PAL.woodLight);
  body.add(cyl(0.12, 0.12, 0.06, 8), PAL.woodDark, [mast.x, top + 0.03, mast.z]);
  trim.add(rod([mast.x, top + 0.06, mast.z], [mast.x, def.height - 0.35, mast.z], 0.02, 5), PAL.woodDark);
  flag(b, [mast.x, def.height - 0.35, mast.z], 1.1, 0.32, () => PAL.red, true);
  // Forestay to the bowsprit; the backstay splits to the quarters so it clears the helmsman.
  const stays: Array<[V3, V3]> = [[[0, top - 0.9, mast.z + 0.06], sprit]];
  for (const sx of [-1, 1]) {
    const qz = z0 + 0.35;
    stays.push([[0, top - 0.05, mast.z - 0.08], [sx * (innerHalf(spec, qz, spec.sheerAt(0.04)) + 0.02), spec.sheerAt(0.04), qz]]);
  }
  for (const sx of [-1, 1]) {
    const hw = innerHalf(spec, mast.z - 0.2, spec.sheerAt(0.6)) + spec.thick;
    stays.push([[sx * 0.08, top - 1.2, mast.z], [sx * hw, spec.sheerAt(0.6), mast.z - 0.2]]);
    stays.push([[sx * 0.08, top - 1.2, mast.z], [sx * (hw - 0.05), spec.sheerAt(0.5), mast.z - 1.2]]);
  }
  for (const [a, c] of stays) trim.add(rod(a, c, 0.014, 4), 0x3a3a3a);
  // Stern lantern, life ring, fenders, a coil of rope.
  lantern(b, [0.35, spec.sheerAt(0) + 0.02, z0 + 0.25], 1.1);
  body.add(tor(0.22, 0.06, 4, 12), PAL.white, [0.98, deck + 0.45, -2.75], [0, Math.PI / 2, 0]);
  for (let k = 0; k < 4; k++) body.add(tor(0.22, 0.063, 4, 2, Math.PI / 4), PAL.red, [0.98, deck + 0.45, -2.75], [0, Math.PI / 2, (k * Math.PI) / 2]);
  for (const fz of [-1.6, 0.6]) {
    const fx = innerHalf(spec, fz, spec.sheerAt(0.5)) + spec.thick + 0.1;
    body.add(cyl(0.1, 0.1, 0.4, 8), PAL.white, [-fx, 0.95, fz]);
  }
  body.add(tor(0.18, 0.05, 4, 10), PAL.rope, [0.4, deck + 0.05, 3.0], [Math.PI / 2, 0, 0]);
  rudder(b, [0, 0, z0 - 0.08], spec.sheerAt(0) + 0.2, -0.85, 0.42, 0x2a7268);
  sloopRig(b, mast.z, deck, top, sprit, z0);
  return finish(b);
}

// ---------- the hauler (a steam truck) ----------

function hauler(def: WheeledDef): VehicleModel {
  const b = start(def, 0.026);
  const { body, trim, glow } = b;
  const green = 0x2f6e52;
  const greenDark = 0x24563f;
  const cream = 0xf0e2b6;
  const L = def.length / 2;
  const seat = def.seats[0];
  const bedY = Math.min(...def.cargo.map((c) => c.y));
  const czs = def.cargo.map((c) => c.z);
  const zBed1 = Math.max(...czs) + 0.5;
  const zBed0 = -L + 0.05;
  const hw = Math.max(...def.cargo.map((c) => Math.abs(c.x))) + 0.5;
  const front = def.wheels.find((w) => w.steer)!;
  const rear = def.wheels.find((w) => !w.steer)!;
  const r = front.r;

  // Chassis rails, axles on leaf springs.
  for (const x of [-0.62, 0.62]) body.add(box(0.14, 0.2, 2 * L - 0.15), PAL.black, [x, 0.86, 0]);
  for (const w of [front, rear]) {
    trim.add(rod([-Math.abs(w.x) + 0.08, r, w.z], [Math.abs(w.x) - 0.08, r, w.z], 0.05, 6), PAL.iron);
    for (const x of [-0.62, 0.62]) for (let k = 0; k < 3; k++) body.add(box(0.12, 0.05, 0.9 - k * 0.22), PAL.ironLight, [x, r + 0.08 + k * 0.05, w.z]);
  }
  // Cargo bed: planks, painted stake sides, a tailboard with lanterns.
  for (let k = 0; k < 8; k++) {
    const x = -hw + (k + 0.5) * ((2 * hw) / 8);
    body.add(box((2 * hw) / 8 - 0.012, 0.07, zBed1 - zBed0), k % 2 ? PAL.woodLight : PAL.wood, [x, bedY - 0.035, (zBed0 + zBed1) / 2]);
  }
  body.add(box(2 * hw + 0.04, 0.16, zBed1 - zBed0), greenDark, [0, bedY - 0.15, (zBed0 + zBed1) / 2]);
  trim.add(box(2 * hw + 0.06, 0.03, zBed1 - zBed0 + 0.02), cream, [0, bedY - 0.1, (zBed0 + zBed1) / 2]);
  for (const sx of [-1, 1]) {
    body.add(box(0.07, 0.3, zBed1 - zBed0), green, [sx * (hw + 0.035), bedY + 0.15, (zBed0 + zBed1) / 2]);
    trim.add(box(0.075, 0.03, zBed1 - zBed0), cream, [sx * (hw + 0.035), bedY + 0.27, (zBed0 + zBed1) / 2]);
    for (let k = 0; k <= 4; k++) body.add(box(0.08, 0.5, 0.08), PAL.woodDark, [sx * (hw + 0.08), bedY + 0.15, zBed0 + 0.05 + (k * (zBed1 - zBed0 - 0.1)) / 4]);
  }
  body.add(box(2 * hw, 0.3, 0.07), green, [0, bedY + 0.15, zBed0 + 0.035]);
  for (const sx of [-1, 1]) lantern(b, [sx * (hw - 0.05), bedY + 0.32, zBed0 + 0.1], 1);
  // Water tank, toolbox and the chain guard under the bed.
  body.add(cyl(0.3, 0.3, 1.5, 10), green, [0, 0.95, -0.6], [0, 0, Math.PI / 2]);
  body.add(box(0.3, 0.32, 0.8), PAL.black, [-(hw - 0.15), 0.95, 0.4]);
  body.add(box(0.08, 0.18, rear.z - 1.2 > 0 ? 0.1 : 1.2 - rear.z), PAL.black, [0.82, 0.78, (1.2 + rear.z) / 2]);
  // Cab: floor, a bench (cushion top on the seat anchor), low sides and a backrest.
  const zc0 = zBed1 + 0.05;
  const zc1 = L - 0.05;
  body.add(span(-1.12, 1.12, 0.96, seat.y - 0.48, zc0, zc1 - 0.6), green);
  body.add(span(-0.95, 0.95, seat.y - 0.48, seat.y - 0.08, seat.z - 0.22, seat.z + 0.2), greenDark);
  for (const s of def.seats) body.add(box(0.62, 0.08, 0.42), 0x9c3b31, [s.x, seat.y - 0.04, s.z]);
  body.add(box(1.9, 0.45, 0.08), 0x9c3b31, [0, seat.y + 0.24, seat.z - 0.27], [-0.15, 0, 0]);
  body.add(box(2.24, 0.06, 0.12), cream, [0, seat.y - 0.47, zc0 + 0.06]);
  for (const sx of [-1, 1]) {
    body.add(span(sx * 1.06, sx * 1.14, seat.y - 0.48, seat.y + 0.12, zc0, seat.z - 0.3), green);
    trim.add(span(sx * 1.055, sx * 1.145, seat.y + 0.09, seat.y + 0.13, zc0, seat.z - 0.3), cream);
  }
  // The boiler: a drum in front of the crew with a smokebox door facing forward like a face.
  const by = seat.y - 0.1;
  const bz0 = seat.z + 0.42;
  const br = 0.5;
  body.add(cyl(br, br, zc1 - bz0, 12), 0x2b2f33, [0, by, (bz0 + zc1) / 2], [Math.PI / 2, 0, 0]);
  for (const z of [bz0 + 0.12, zc1 - 0.12]) trim.add(ring(br, br + 0.025, 0.06, 12), PAL.brass, [0, by, z], [Math.PI / 2, 0, 0]);
  body.add(cyl(br * 0.82, br * 0.82, 0.06, 12), PAL.iron, [0, by, zc1 + 0.03], [Math.PI / 2, 0, 0]);
  trim.add(ring(br * 0.7, br * 0.82, 0.07, 12), PAL.brass, [0, by, zc1 + 0.04], [Math.PI / 2, 0, 0]);
  trim.add(box(0.36, 0.04, 0.05), PAL.brass, [0, by, zc1 + 0.08]);
  body.add(cyl(br * 0.5, br * 0.5, 0.05, 8), PAL.dark, [0, by, bz0 - 0.03], [Math.PI / 2, 0, 0]);
  glow.add(box(0.3, 0.05, 0.02), PAL.glowHot, [0, by - 0.05, bz0 - 0.06]);
  // Steam pipe (the chimney) up to the truck's height, with a brass lip; a whistle and a gauge.
  const cz = zc1 - 0.3;
  body.add(cyl(0.13, 0.11, def.height - by - br - 0.08, 8), PAL.black, [0, (by + br + def.height - 0.08) / 2, cz]);
  body.add(cyl(0.18, 0.13, 0.1, 8), PAL.brass, [0, def.height - 0.05, cz]);
  body.add(cyl(0.035, 0.05, 0.22, 6), PAL.brass, [0.25, by + br + 0.1, bz0 + 0.25]);
  body.add(cyl(0.09, 0.09, 0.04, 10), PAL.cream, [-0.28, by + br - 0.02, bz0 + 0.02], [Math.PI / 2 + 0.6, 0, 0]);
  // Steering wheel for the driver.
  const drv = def.seats.find((s) => s.pose === 'drive') ?? seat;
  const sw: V3 = [drv.x, seat.y + 0.32, seat.z + 0.42];
  body.add(tor(0.2, 0.025, 4, 10), PAL.black, sw, [-0.7, 0, 0]);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * TAU;
    trim.add(beam([0, 0, 0], [Math.cos(a) * 0.2, Math.sin(a) * 0.2, 0], 0.02), PAL.brass, sw, [-0.7, 0, 0]);
  }
  trim.add(rod(sw, [drv.x, 0.98, seat.z + 0.75], 0.03, 6), PAL.iron);
  // Bumper, brass headlamps, mudguards.
  body.add(box(2.1, 0.16, 0.14), PAL.black, [0, 0.82, L - 0.07]);
  for (const sx of [-1, 1]) {
    body.add(cyl(0.13, 0.1, 0.2, 10), PAL.brass, [sx * 0.78, by - 0.15, zc1 + 0.02], [Math.PI / 2, 0, 0]);
    glow.add(cyl(0.1, 0.1, 0.02, 10), 0xfff2c4, [sx * 0.78, by - 0.15, zc1 + 0.13], [Math.PI / 2, 0, 0]);
    trim.add(rod([sx * 0.78, by - 0.3, zc1], [sx * 0.62, 0.95, zc1 - 0.1], 0.02, 5), PAL.iron);
  }
  for (const w of def.wheels) {
    body.add(arc(w.r + 0.05, w.r + 0.12, 0.32, w.steer ? 0.25 : 0.0, w.steer ? Math.PI - 0.1 : Math.PI - 0.15, 7), greenDark, [w.x, w.r, w.z], [0, Math.PI / 2, 0]);
  }
  // Steam puffs from the pipe, bigger with throttle.
  const puffs: THREE.Mesh[] = [];
  const puffMat = toon(0xf4f4f0);
  for (let k = 0; k < 5; k++) {
    const m = new THREE.Mesh(ico(0.22, 0), puffMat);
    m.castShadow = false;
    b.root.add(m);
    puffs.push(m);
  }
  let t0 = 0;
  b.anims.push((dt, s) => {
    t0 += dt * (0.8 + Math.abs(s.throttle) * 1.4);
    const strength = 0.45 + Math.abs(s.throttle) * 0.75;
    puffs.forEach((m, k) => {
      const u = (t0 * 0.5 + k / puffs.length) % 1;
      m.position.set(Math.sin(k * 2.1 + u * 2) * 0.12, def.height + 0.05 + u * 1.3, cz - u * (0.25 + Math.abs(s.speed) * 0.12));
      m.scale.setScalar(Math.sin(Math.PI * Math.min(1, u * 1.3)) * strength + 0.01);
      m.rotation.set(u * 3, k, u * 2);
    });
  });
  // A brass name plate and a pennant.
  trim.add(box(0.5, 0.12, 0.02), PAL.brass, [0, 0.82, L + 0.005]);
  wheels(b, def.wheels, {
    tyre: PAL.black,
    rim: 0xc8443a,
    hub: 0xc8443a,
    cap: PAL.brass,
    spokes: 8,
    spoke: 0xb93c33,
    width: 0.24,
    tyreDepth: 0.08,
    rimDepth: 0.06,
  });
  return finish(b);
}

// ---------- the merchant cog ----------

function cog(def: BoatDef): VehicleModel {
  const b = start(def, 0.04);
  const { body, trim } = b;
  const L = def.length / 2;
  const rows = 8;
  const deck = Math.min(...def.cargo.map((c) => c.y)) - 0.4;
  const helmSeat = def.seats.find((s) => s.pose === 'helm');
  const castleY = helmSeat ? helmSeat.y - 0.45 : deck + 1.15;
  const z0 = -L + 0.5;
  const z1 = L - 0.5;
  const spec: HullSpec = {
    z0,
    z1,
    half: def.width / 2,
    halfAt: (t) => (t < 0.45 ? 0.72 + 0.28 * Math.sin((Math.PI / 2) * (t / 0.45)) : Math.pow(Math.cos((Math.PI / 2) * ((t - 0.45) / 0.55)), 0.4)),
    sheerAt: (t) => (t < 0.3 ? castleY + 0.05 - ((castleY + 0.05 - (deck + 0.9)) * t) / 0.3 : deck + 0.9 + 0.55 * Math.max(0, (t - 0.55) / 0.45) ** 2),
    keelAt: (t) => (def.draft - 0.2) * (t > 0.55 ? 1 - 0.8 * ((t - 0.55) / 0.45) ** 2 : 1 - 0.3 * ((0.55 - t) / 0.55) ** 2),
    floorAt: () => deck,
    thick: 0.12,
    fullness: 2.6,
    stations: 14,
    rows,
    outside: (row, y) => (row === rows - 1 ? 0x4f3121 : y < -0.04 ? 0x5a3a22 : row % 2 ? 0x8a5a36 : 0x7b4f2f),
    inside: PAL.woodLight,
    rim: PAL.woodDark,
    deck: (m) => (m % 2 ? PAL.woodPale : PAL.woodLight),
    transom: 0x7b4f2f,
  };
  body.list.push(hull(spec));
  body.add(box(0.24, 0.2, def.length * 0.82), 0x3e2a1c, [0, -def.draft + 0.1, 0]);
  body.add(beam([0, -0.8, z1 - 0.2], [0, spec.sheerAt(1) + 0.35, z1 + 0.15], 0.22), PAL.woodDark);
  const sprit: V3 = [0, spec.sheerAt(1) + 0.3, L];
  body.add(rod([0, spec.sheerAt(1) - 0.1, z1 - 0.8], sprit, 0.13, 6, 0.09), PAL.woodLight);
  // Wales: dark bands along the hull.
  // Cargo hatch: planks across the hold, clipped to the hull, the packs resting on it.
  const cy = deck + 0.4;
  const hz0 = Math.min(...def.cargo.map((c) => c.z)) - 0.6;
  const hz1 = Math.max(...def.cargo.map((c) => c.z)) + 0.6;
  const n = Math.round((hz1 - hz0) / 0.4);
  for (let k = 0; k < n; k++) {
    const z = hz0 + ((k + 0.5) * (hz1 - hz0)) / n;
    const half = Math.min(2.2, innerHalf(spec, z, cy) - 0.04);
    trim.add(box(half * 2, 0.08, (hz1 - hz0) / n - 0.015), k % 2 ? PAL.woodPale : PAL.woodLight, [0, cy - 0.04, z]);
  }
  trim.add(span(-2.0, 2.0, deck, cy - 0.08, hz0, hz1), PAL.woodDark);
  // Benches for the passengers.
  for (const s of def.seats) {
    if (s.pose === 'helm') continue;
    const across = Math.abs(s.x) < 0.1;
    const w = across ? Math.min(2.4, innerHalf(spec, s.z, s.y) * 2 - 0.2) : 0.44;
    const d = across ? 0.45 : 0.9;
    trim.add(box(w, s.y - deck, d), PAL.wood, [s.x, (s.y + deck) / 2, s.z]);
    trim.add(box(w + 0.04, 0.04, d + 0.04), PAL.woodPale, [s.x, s.y - 0.02, s.z]);
  }
  // Sterncastle: a raised deck with a railing hung with painted shields, the helm on it.
  const cz1 = z0 + 3.0;
  for (let k = 0; k < 6; k++) {
    const za = z0 + 0.12 + (k * (cz1 - z0 - 0.12)) / 6;
    const zb = z0 + 0.12 + ((k + 1) * (cz1 - z0 - 0.12)) / 6;
    const half = innerHalf(spec, (za + zb) / 2, castleY) + 0.02;
    body.add(box(half * 2, 0.1, zb - za - 0.012), k % 2 ? PAL.woodPale : PAL.woodLight, [0, castleY - 0.05, (za + zb) / 2]);
  }
  const fw = innerHalf(spec, cz1, castleY);
  body.add(span(-fw, fw, deck, castleY - 0.1, cz1 - 0.12, cz1), 0x7b4f2f);
  body.add(span(-0.45, 0.45, deck, deck + 1.0, cz1, cz1 + 0.04), PAL.dark);
  for (const sx of [-1, 1]) {
    const pts: V3[] = [];
    for (let k = 0; k <= 4; k++) {
      const z = z0 + 0.1 + (k * (cz1 - z0 - 0.1)) / 4;
      pts.push([sx * (innerHalf(spec, z, castleY) + 0.04), castleY, z]);
    }
    for (const p of pts) body.add(box(0.1, 0.8, 0.1), PAL.woodDark, [p[0], castleY + 0.4, p[2]]);
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const c = pts[k + 1];
      body.add(beam([a[0], castleY + 0.78, a[2]], [c[0], castleY + 0.78, c[2]], 0.09), PAL.woodDark);
      const m: V3 = [(a[0] + c[0]) / 2 + sx * 0.06, castleY + 0.42, (a[2] + c[2]) / 2];
      trim.add(box(0.06, 0.5, 0.42), k % 2 ? 0xd9a73a : 0xb8352c, m, [0, Math.atan2(c[0] - a[0], c[2] - a[2]), 0]);
      trim.add(box(0.07, 0.4, 0.08), k % 2 ? 0xb8352c : 0xd9a73a, [m[0] + sx * 0.005, m[1], m[2]], [0, Math.atan2(c[0] - a[0], c[2] - a[2]), 0]);
    }
  }
  body.add(beam([-fw, castleY + 0.78, cz1], [fw, castleY + 0.78, cz1], 0.09), PAL.woodDark);
  for (const x of [-fw, -fw / 2, fw / 2, fw]) body.add(box(0.1, 0.8, 0.1), PAL.woodDark, [x, castleY + 0.4, cz1]);
  // Ladder up to the castle.
  for (const sx of [-1, 1]) trim.add(beam([1.2 + sx * 0.22, deck, cz1 + 0.75], [1.2 + sx * 0.22, castleY, cz1 + 0.05], 0.07), PAL.wood);
  for (let k = 1; k < 5; k++) trim.add(box(0.5, 0.05, 0.06), PAL.woodLight, [1.2, deck + (k * (castleY - deck)) / 5, cz1 + 0.75 - (k * 0.7) / 5]);
  if (helmSeat) {
    body.add(bev(0.55, helmSeat.y - castleY, 0.45, 0.03), PAL.wood, [helmSeat.x, (helmSeat.y + castleY) / 2, helmSeat.z]);
    helm(b, [helmSeat.x, helmSeat.y + 0.45, helmSeat.z + 0.6], 0.45, helmSeat.y + 0.45 - castleY);
  }
  lantern(b, [0, castleY + 0.82, z0 + 0.1], 1.6);
  // Mast, crow's nest, flagstaff; rigging to the sides, the bowsprit and the stern.
  const mast = def.mast!;
  const top = mast.height;
  body.add(rod([mast.x, deck - 0.2, mast.z], [mast.x, top, mast.z], 0.22, 8, 0.15), PAL.woodLight);
  const nestY = top - 2.0;
  body.add(lathe([[0.2, nestY - 0.35], [0.62, nestY], [0.62, nestY + 0.55], [0.55, nestY + 0.55], [0.55, nestY + 0.05], [0.2, nestY + 0.05]], 10), (c) => (c.y > nestY + 0.3 ? PAL.red : PAL.woodDark), [mast.x, 0, mast.z]);
  trim.add(rod([mast.x, top, mast.z], [mast.x, def.height - 0.1, mast.z], 0.04, 5), PAL.woodDark);
  flag(b, [mast.x, def.height - 0.15, mast.z], 1.6, 0.9, (_i, j) => (j ? PAL.yellow : PAL.red));
  const stays: Array<[V3, V3]> = [
    [[0, top - 0.6, mast.z + 0.1], sprit],
    [[0, top - 0.6, mast.z - 0.1], [0, castleY + 0.8, z0 + 0.3]],
  ];
  for (const sx of [-1, 1]) {
    for (const dz of [-1.0, 0, 1.0]) {
      const z = mast.z + dz - 0.3;
      stays.push([[sx * 0.15, nestY - 0.4, mast.z], [sx * (innerHalf(spec, z, deck + 0.9) + 0.12), deck + 0.9, z]]);
    }
  }
  for (const [a, c] of stays) trim.add(rod(a, c, 0.025, 4), 0x3a3a3a);
  // Anchor on the bow, a couple of barrels on deck.
  for (const sx of [-1, 1]) {
    const az = z1 - 1.2;
    const ax = sx * (innerHalf(spec, az, deck + 0.5) + spec.thick + 0.06);
    if (sx > 0) {
      body.add(box(0.08, 1.1, 0.08), PAL.iron, [ax, deck + 0.2, az]);
      body.add(arc(0.32, 0.4, 0.08, Math.PI * 1.05, Math.PI * 1.95, 6), PAL.iron, [ax, deck - 0.05, az], [0, Math.PI / 2, 0]);
      body.add(tor(0.09, 0.025, 4, 8), PAL.iron, [ax, deck + 0.8, az], [0, Math.PI / 2, 0]);
    }
  }
  trim.add(cyl(0.3, 0.27, 0.75, 8), 0x9c6a3c, [1.5, deck + 0.375, mast.z + 1.0]);
  trim.add(cyl(0.3, 0.27, 0.75, 8), 0x8a5c34, [1.7, deck + 0.375, mast.z + 1.65]);
  trim.add(tor(0.3, 0.09, 4, 10), PAL.rope, [-1.4, deck + 0.09, mast.z + 1.5], [Math.PI / 2, 0, 0]);
  rudder(b, [0, 0, z0 - 0.1], castleY + 0.1, -def.draft + 0.3, 0.75, 0x6b4a2e);
  // Yard and square sail, braced round with `boom`, bellying forward as it fills.
  const yardY = nestY - 0.6;
  const yard = pivot(b.root, mast.x, yardY, mast.z + 0.3, 'yard');
  const halfYard = def.width * 0.85;
  mesh(yard, new Parts().add(rod([-halfYard, 0, 0], [halfYard, 0, 0], 0.13, 8, 0.13), PAL.woodLight).build(), { outline: b.outline });
  const stripes = 8;
  const sail = new Cloth(stripes, 6, (i) => (i % 2 ? PAL.cream : 0xc8382e));
  const sm = mesh(yard, sail.geometry, { mat: clothMaterial(), name: 'sail', receive: false });
  sm.castShadow = true;
  const drop = yardY - (deck + 2.6);
  let fill = 1;
  let brace = 0;
  const shape = (time: number) => {
    const f = Math.max(0.07, fill);
    sail.shape((u, v, out) => {
      const w = halfYard * (0.96 + 0.06 * v);
      const y = -0.1 - drop * f * v;
      const belly = Math.sin(Math.PI * u) * Math.sin(Math.PI * Math.min(1, v * 1.05)) * 1.3 * fill;
      const flutter = Math.sin(time * 5 + u * 4) * 0.05 * v * (1.15 - fill);
      out.set((u - 0.5) * 2 * w, y, 0.15 + belly + flutter);
    });
  };
  shape(0);
  b.anims.push((dt, s) => {
    fill += (clamp(s.sail, 0, 1) - fill) * Math.min(1, dt * 2);
    brace += (clamp(s.boom, -0.9, 0.9) - brace) * Math.min(1, dt * 2.5);
    yard.rotation.y = brace;
    shape(s.time);
  });
  return finish(b);
}

// ---------- fallbacks (any vehicle without its own build) ----------

function genericWheeled(def: WheeledDef): VehicleModel {
  const b = start(def, 0.025);
  const r = Math.max(...def.wheels.map((w) => w.r));
  const hw = Math.min(...def.wheels.map((w) => Math.abs(w.x))) - 0.12;
  b.body.add(bev(hw * 2, 0.4, def.length * 0.92, 0.06), 0x6a8caf, [0, r + 0.25, 0]);
  for (const s of def.seats) b.body.add(bev(0.5, 0.08, 0.45, 0.03), PAL.mustard, [s.x, s.y - 0.04, s.z]);
  for (const c of def.cargo) b.trim.add(box(0.5, 0.02, 0.5), PAL.woodLight, [c.x, c.y - 0.01, c.z]);
  wheels(b, def.wheels, { tyre: PAL.black, rim: PAL.cream, hub: PAL.cream, cap: PAL.steel, spokes: 6, width: 0.16, tyreDepth: 0.06, rimDepth: 0.05 });
  return finish(b);
}

function genericBoat(def: BoatDef): VehicleModel {
  const b = start(def, 0.03);
  const L = def.length / 2;
  const rows = 6;
  const deck = Math.min(...def.cargo.map((c) => c.y), ...def.seats.map((s) => s.y)) - 0.35;
  const spec: HullSpec = {
    z0: -L * 0.95,
    z1: L * 0.95,
    half: def.width / 2,
    halfAt: (t) => (t < 0.5 ? 0.6 + 0.4 * Math.sin(Math.PI * t) : Math.pow(Math.cos((Math.PI / 2) * ((t - 0.5) / 0.5)), 0.5)),
    sheerAt: (t) => deck + 0.6 + 0.3 * (2 * t - 1) ** 2,
    keelAt: () => def.draft,
    floorAt: () => deck,
    thick: 0.08,
    fullness: 2.2,
    stations: 12,
    rows,
    outside: strakes(PAL.woodDark, PAL.wood, PAL.woodLight, 0x5a3a22, rows),
    inside: PAL.woodLight,
    rim: PAL.woodDark,
    deck: (m) => (m % 2 ? PAL.woodPale : PAL.woodLight),
    transom: PAL.wood,
  };
  b.body.list.push(hull(spec));
  for (const s of def.seats) b.body.add(bev(0.5, Math.max(0.05, s.y - deck), 0.45, 0.03), PAL.wood, [s.x, (s.y + deck) / 2, s.z]);
  if (def.mast) {
    b.body.add(rod([def.mast.x, deck, def.mast.z], [def.mast.x, def.mast.height, def.mast.z], 0.15, 8, 0.1), PAL.woodLight);
    const sail = new Cloth(4, 4, (i) => (i % 2 ? PAL.canvas : PAL.red));
    const yard = pivot(b.root, def.mast.x, def.mast.height * 0.8, def.mast.z + 0.2, 'yard');
    mesh(yard, sail.geometry, { mat: clothMaterial() });
    const hw = def.width * 0.7;
    const hs = def.mast.height * 0.45;
    b.anims.push((_dt, s) => {
      yard.rotation.y = clamp(s.boom, -1, 1);
      const f = Math.max(0.08, clamp(s.sail, 0, 1));
      sail.shape((u, v, out) => out.set((u - 0.5) * hw * 2, -hs * f * (1 - v), Math.sin(Math.PI * u) * Math.sin(Math.PI * v) * 0.6 * f));
    });
  }
  return finish(b);
}

// ---------- entry point ----------

const BUILDERS: Record<string, (def: never) => VehicleModel> = {
  farmCart,
  roadster,
  hauler,
  rowboat,
  sloop,
  cog,
};

/** Builds the model for a vehicle definition; unknown ids get a generic body from the data. */
export function buildVehicle(def: VehicleDef): VehicleModel {
  const custom = BUILDERS[def.id] as ((d: VehicleDef) => VehicleModel) | undefined;
  if (custom) return custom(def);
  return def.class === 'boat' ? genericBoat(def) : genericWheeled(def);
}

