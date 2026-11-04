import * as THREE from 'three';
import type { MountDef } from '../../content/vehicles';
import { PAL, Parts, bev, box, cone, cyl, mesh, octa, pivot, rod, tor, type Rgb, type V3 } from './kit';
import type { Holds } from './vehicles';

// Mounts: a horse and a donkey built from soft blocks like the hero. Four legs hang from hip
// pivots with a knee pivot halfway down; animate() runs a walk that blends into a gallop as
// speed rises, bobs the head, swishes the tail, and tucks the legs while airborne.
// Frame: faces +Z, origin on the ground under the middle. The saddle top is the seat anchor;
// the donkey's pack frame top is its cargo anchor.

export interface MountAnim {
  /** m/s along the facing, signed. */
  speed: number;
  grounded: boolean;
}

export interface MountModel {
  root: THREE.Group;
  animate(dt: number, s: MountAnim): void;
  /** Where the rider's feet go: the stirrup irons, left then right, riding along with the body. */
  holds: Holds;
}

const TAU = Math.PI * 2;
const OUTLINE = 0.018;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

interface Build {
  /** Coat colours. */
  coat: Rgb;
  dark: Rgb;
  pale: Rgb;
  mane: Rgb;
  hoof: Rgb;
  muzzle: Rgb;
  /** Hip height, and how the legs split. */
  hip: number;
  upper: number;
  legW: number;
  /** Barrel: top of the back, width, height, half-length; and where the legs attach along it. */
  back: number;
  bw: number;
  bh: number;
  bl: number;
  frontZ: number;
  hindZ: number;
  legX: number;
  neck: { base: V3; len: number; w: number; angle: number };
  head: { len: number; w: number; h: number; tilt: number };
  ear: { len: number; w: number; back: number; out: number };
  tail: { at: V3; len: number };
  /** Which legs wear white socks: FL, FR, HL, HR. */
  socks: boolean[];
  /** Stride length (m per cycle) at a walk and at a full gallop. */
  stride: [number, number];
}

interface Leg {
  hip: THREE.Group;
  knee: THREE.Group;
  front: boolean;
  walk: number;
  gallop: number;
}

// Footfall order as a fraction of the stride: a four-beat walk and a transverse gallop.
const PHASES: Record<string, [number, number]> = { FL: [0.25, 0.55], FR: [0.75, 0.45], HL: [0, 0.1], HR: [0.5, 0] };

function soft(p: Parts, w: number, h: number, d: number, c: Rgb, at: V3, r?: V3, round = 0.07): void {
  p.add(bev(w, h, d, Math.min(round, w / 2, h / 2, d / 2), 1), c, at, r, undefined, { smooth: true });
}

function body(def: MountDef, b: Build, extra: (body: Parts, root: THREE.Group, torso: THREE.Group) => Holds | void): MountModel {
  const root = new THREE.Group();
  root.name = `mount:${def.id}`;
  const torso = pivot(root, 0, 0, 0, 'body');
  const p = new Parts();
  const cy = b.back - b.bh / 2;
  // Barrel, chest and rump, a paler belly.
  soft(p, b.bw, b.bh, b.bl * 2, b.coat, [0, cy, 0], undefined, 0.12);
  soft(p, b.bw * 0.96, b.bh * 0.92, b.bl * 0.55, b.coat, [0, cy + 0.01, b.bl * 0.95], undefined, 0.14);
  soft(p, b.bw * 1.04, b.bh * 0.98, b.bl * 0.62, b.coat, [0, cy + 0.02, -b.bl * 0.95], undefined, 0.14);
  soft(p, b.bw * 0.8, b.bh * 0.2, b.bl * 1.6, b.pale, [0, cy - b.bh * 0.42, 0], undefined, 0.05);
  const holds = extra(p, root, torso) ?? {};
  mesh(torso, p.build(), { outline: OUTLINE, name: 'torso' });

  // Neck and head (the head counter-rotates so it can be built level, then tips its nose down).
  const neck = pivot(torso, ...b.neck.base, 'neck');
  neck.rotation.x = b.neck.angle;
  const np = new Parts();
  soft(np, b.neck.w, b.neck.len + 0.12, b.neck.w * 1.15, b.coat, [0, b.neck.len / 2, 0], undefined, 0.1);
  soft(np, 0.07, b.neck.len + 0.06, 0.12, b.mane, [0, b.neck.len / 2 + 0.03, -b.neck.w * 0.52], undefined, 0.03);
  mesh(neck, np.build(), { outline: OUTLINE });
  const head = pivot(neck, 0, b.neck.len, 0, 'head');
  const headRest = -b.neck.angle + b.head.tilt;
  head.rotation.x = headRest;
  const hp = new Parts();
  const { len, w, h } = b.head;
  soft(hp, w, h, len * 0.7, b.coat, [0, 0, len * 0.22], undefined, 0.08);
  soft(hp, w * 0.88, h * 0.82, len * 0.42, b.muzzle, [0, -h * 0.1, len * 0.62], undefined, 0.07);
  for (const sx of [-1, 1]) {
    hp.add(box(0.02, 0.05, 0.05), PAL.dark, [sx * (w / 2 + 0.004), h * 0.12, len * 0.18]);
    hp.add(box(0.03, 0.03, 0.02), PAL.dark, [sx * w * 0.22, -h * 0.12, len * 0.84]);
  }
  hp.add(box(w * 0.3, 0.02, len * 0.55), b.pale, [0, h / 2 + 0.002, len * 0.28], [0.06, 0, 0]);
  soft(hp, w * 0.5, 0.08, 0.14, b.mane, [0, h / 2 + 0.02, 0.02], undefined, 0.03);
  // Bridle: noseband, cheek straps, brass bit rings.
  hp.add(box(w * 0.92, h * 0.12, 0.05), PAL.leatherDark, [0, -h * 0.05, len * 0.5]);
  for (const sx of [-1, 1]) {
    hp.add(box(0.015, h * 0.9, 0.04), PAL.leatherDark, [sx * (w / 2 + 0.006), 0, len * 0.08]);
    hp.add(tor(0.035, 0.01, 4, 8), PAL.brass, [sx * (w * 0.44 + 0.02), -h * 0.22, len * 0.66], [0, Math.PI / 2, 0]);
  }
  mesh(head, hp.build(), { outline: OUTLINE });
  const ears = [-1, 1].map((sx) => {
    const e = pivot(head, sx * w * 0.3, h * 0.42, 0.0, 'ear');
    const ep = new Parts();
    soft(ep, b.ear.w, b.ear.len, b.ear.w * 0.5, b.coat, [0, b.ear.len / 2, 0], undefined, 0.02);
    ep.add(box(b.ear.w * 0.55, b.ear.len * 0.7, 0.012), b.pale, [0, b.ear.len * 0.45, b.ear.w * 0.26]);
    ep.add(cone(b.ear.w * 0.52, b.ear.len * 0.22, 4), b.dark, [0, b.ear.len + b.ear.len * 0.08, 0], [0, Math.PI / 4, 0]);
    mesh(e, ep.build(), { outline: OUTLINE * 0.7 });
    e.rotation.set(-b.ear.back, 0, sx * -b.ear.out);
    return { e, sx };
  });

  // Tail in two pieces so it can curl as it swishes.
  const tail = pivot(torso, ...b.tail.at, 'tail');
  const tp = new Parts();
  soft(tp, 0.1, b.tail.len * 0.45, 0.1, b.mane, [0, -b.tail.len * 0.2, 0], undefined, 0.04);
  mesh(tail, tp.build(), { outline: OUTLINE });
  const tail2 = pivot(tail, 0, -b.tail.len * 0.4, 0);
  const tp2 = new Parts();
  soft(tp2, 0.15, b.tail.len * 0.65, 0.11, b.mane, [0, -b.tail.len * 0.3, -0.01], undefined, 0.05);
  tp2.add(cone(0.09, 0.14, 5), b.mane, [0, -b.tail.len * 0.66, 0], [Math.PI, 0, 0]);
  mesh(tail2, tp2.build(), { outline: OUTLINE });

  // Legs: hip and knee pivots, hooves on the ground at rest.
  const legs: Leg[] = [];
  const lower = b.hip - b.upper - 0.07;
  const corners: Array<[string, number, number, boolean]> = [
    ['FL', 1, b.frontZ, true],
    ['FR', -1, b.frontZ, true],
    ['HL', 1, b.hindZ, false],
    ['HR', -1, b.hindZ, false],
  ];
  corners.forEach(([name, sx, z, front], i) => {
    const hip = pivot(torso, sx * b.legX, b.hip, z, `hip${name}`);
    const up = new Parts();
    const thick = front ? 1 : 1.25;
    soft(up, b.legW * thick, b.upper + 0.12, b.legW * 1.15 * thick, b.coat, [0, -b.upper / 2 + 0.04, 0], undefined, 0.06);
    mesh(hip, up.build(), { outline: OUTLINE });
    const knee = pivot(hip, 0, -b.upper, 0, `knee${name}`);
    const lo = new Parts();
    soft(lo, b.legW * 0.72, lower + 0.04, b.legW * 0.78, b.socks[i] ? b.pale : b.coat, [0, -lower / 2, 0], undefined, 0.04);
    lo.add(bev(b.legW * 0.92, 0.075, b.legW * 1.05, 0.02), b.hoof, [0, -lower - 0.035, 0.012]);
    mesh(knee, lo.build(), { outline: OUTLINE });
    const [walk, gallop] = PHASES[name];
    legs.push({ hip, knee, front, walk, gallop });
  });

  let phase = 0;
  let sm = 0;
  let air = 0;
  let time = 0;
  const neckRest = b.neck.angle;
  return {
    root,
    holds,
    animate(dt, s) {
      time += dt;
      const v = Math.abs(s.speed);
      sm += (v - sm) * Math.min(1, dt * 6);
      air += ((s.grounded ? 0 : 1) - air) * Math.min(1, dt * 8);
      const amp = smooth(0, def.walkSpeed * 0.5, sm);
      const g = smooth(def.walkSpeed * 1.15, def.runSpeed, sm);
      const stride = lerp(b.stride[0], b.stride[1], g);
      phase = (phase + ((dt * sm) / stride) * (s.speed < 0 ? -1 : 1) + 1) % 1;
      for (const leg of legs) {
        const p = phase + lerp(leg.walk, leg.gallop, g);
        const sw = Math.sin(TAU * p);
        const lift = Math.max(0, Math.cos(TAU * p));
        const A = lerp(0.32, 0.72, g) * amp;
        const K = (leg.front ? lerp(0.7, 1.5, g) : lerp(0.45, 0.9, g)) * amp;
        const hipX = -A * sw + (leg.front ? 0 : 0.05 * amp);
        const kneeX = K * lift * lift;
        const airHip = leg.front ? -0.85 : 0.65;
        const airKnee = leg.front ? 1.6 : 0.7;
        leg.hip.rotation.x = lerp(hipX, airHip, air);
        leg.knee.rotation.x = lerp(kneeX, airKnee, air);
      }
      const bob = amp * (lerp(0.018, 0.05, g) * Math.sin(TAU * phase * (g > 0.5 ? 1 : 2)));
      torso.position.y = bob * (1 - air);
      torso.rotation.x = lerp(g * amp * 0.07 * Math.sin(TAU * phase + 1), -0.12, air);
      torso.scale.y = 1 + 0.01 * Math.sin(time * 1.6) * (1 - amp);
      const walkNod = Math.sin(TAU * phase * 2) * 0.06;
      const gallopNod = Math.sin(TAU * phase + 0.6) * 0.13;
      neck.rotation.x = neckRest + amp * lerp(walkNod, gallopNod, g) + (1 - amp) * 0.05 * Math.sin(time * 0.7) + air * 0.15;
      head.rotation.x = headRest - (neck.rotation.x - neckRest) * 0.5;
      head.rotation.y = (1 - amp) * 0.18 * Math.sin(time * 0.31);
      for (const { e, sx } of ears) {
        const flick = Math.pow(Math.max(0, Math.sin(time * 1.3 + sx)), 14) * 0.5;
        e.rotation.x = -b.ear.back - flick - g * amp * 0.4;
      }
      tail.rotation.x = lerp(0.22, 1.05, g * amp) + air * 0.4;
      tail.rotation.z = Math.sin(time * 1.8) * 0.28 * (1 - 0.7 * amp);
      tail2.rotation.x = lerp(0.15, 0.4, g * amp) + Math.sin(time * 6) * 0.08 * amp;
      tail2.rotation.z = Math.sin(time * 1.8 - 0.8) * 0.3 * (1 - 0.6 * amp);
    },
  };
}

/**
 * Saddle: blanket, seat (its top on the seat anchor), cantle, pommel, flaps, stirrups, girth. The
 * stirrups hang as low as the hero's legs reach with the knees bent round the barrel, and their
 * irons are returned as holds for the feet.
 */
function saddle(p: Parts, torso: THREE.Group, def: MountDef, back: number, bw: number, blanket: Rgb, trim: Rgb, leather: Rgb): Holds {
  const seat = def.seats[0];
  const z = seat.z;
  const len = bw * 1.25;
  p.add(box(bw + 0.06, 0.03, len), blanket, [0, back + 0.015, z]);
  for (const sx of [-1, 1]) {
    p.add(box(0.025, 0.3, len), blanket, [sx * (bw / 2 + 0.035), back - 0.14, z]);
    p.add(box(0.03, 0.035, len + 0.01), trim, [sx * (bw / 2 + 0.04), back - 0.29, z]);
    p.add(bev(0.03, 0.26, len * 0.6, 0.012), leather, [sx * (bw / 2 + 0.055), back - 0.1, z + 0.02]);
    // Stirrup leather and iron.
    const sy = back - 0.3;
    p.add(box(0.012, back - sy, 0.04), PAL.leatherDark, [sx * (bw / 2 + 0.08), (back + sy) / 2, z + 0.06]);
    p.add(tor(0.05, 0.012, 4, 8), PAL.iron, [sx * (bw / 2 + 0.08), sy - 0.03, z + 0.06], [0, Math.PI / 2, 0]);
  }
  p.add(bev(bw * 0.78, seat.y - back - 0.03, len * 0.7, 0.03), leather, [0, (seat.y + back + 0.03) / 2, z]);
  p.add(bev(bw * 0.72, 0.13, 0.07, 0.025), leather, [0, seat.y + 0.035, z - len * 0.4]);
  p.add(bev(bw * 0.4, 0.11, 0.08, 0.025), leather, [0, seat.y + 0.025, z + len * 0.36]);
  p.add(octa(0.03), PAL.brass, [0, seat.y + 0.09, z + len * 0.37]);
  // Girth strap under the belly.
  p.add(box(bw + 0.03, 0.05, 0.08), PAL.leatherDark, [0, back - 0.3, z + 0.05]);
  // The feet rest on the irons' bottom bars, left then right (+X is the rider's left).
  const iron = (sx: number) => {
    const o = new THREE.Object3D();
    o.position.set(sx * (bw / 2 + 0.08), back - 0.3 - 0.08, z + 0.06);
    torso.add(o);
    return o;
  };
  return { feet: [iron(1), iron(-1)] as [THREE.Object3D, THREE.Object3D] };
}

function horse(def: MountDef): MountModel {
  const seat = def.seats[0];
  const back = seat.y - 0.1;
  const b: Build = {
    coat: 0xa8622f,
    dark: 0x3b2416,
    pale: 0xf3ead8,
    mane: 0x3b2416,
    hoof: 0x3a3530,
    muzzle: 0x8a4f26,
    hip: 1.0,
    upper: 0.48,
    legW: 0.16,
    back,
    bw: 0.5,
    bh: 0.6,
    bl: 0.52,
    frontZ: 0.5,
    hindZ: -0.52,
    legX: 0.15,
    neck: { base: [0, back - 0.14, 0.62], len: 0.52, w: 0.26, angle: 0.78 },
    head: { len: 0.56, w: 0.24, h: 0.27, tilt: 0.32 },
    ear: { len: 0.13, w: 0.07, back: 0.25, out: 0.15 },
    tail: { at: [0, back - 0.06, -0.72], len: 0.75 },
    socks: [true, false, false, true],
    stride: [2.4, 6.5],
  };
  return body(def, b, (p, _root, torso) => saddle(p, torso, def, back, b.bw, 0xc23b32, PAL.gold, 0x6b3f22));
}

function donkey(def: MountDef): MountModel {
  const seat = def.seats[0];
  const back = seat.y - 0.1;
  const b: Build = {
    coat: 0x9d958c,
    dark: 0x4a4440,
    pale: 0xe6dfd2,
    mane: 0x4a4440,
    hoof: 0x3a3530,
    muzzle: 0xe6dfd2,
    hip: 0.7,
    upper: 0.34,
    legW: 0.12,
    back,
    bw: 0.42,
    bh: 0.47,
    bl: 0.45,
    frontZ: 0.38,
    hindZ: -0.44,
    legX: 0.12,
    neck: { base: [0, back - 0.1, 0.46], len: 0.3, w: 0.22, angle: 1.15 },
    head: { len: 0.44, w: 0.22, h: 0.25, tilt: 0.55 },
    ear: { len: 0.23, w: 0.08, back: 1.05, out: 0.4 },
    tail: { at: [0, back - 0.05, -0.62], len: 0.55 },
    socks: [false, false, false, false],
    stride: [1.6, 4.2],
  };
  return body(def, b, (p, _root, torso) => {
    const holds = saddle(p, torso, def, back, b.bw, 0x3f8f8a, PAL.cream, PAL.leather);
    // Dark shoulder cross, a donkey's mark.
    p.add(box(0.05, 0.02, b.bl * 1.6), b.dark, [0, back + 0.003, -0.05]);
    for (const sx of [-1, 1]) p.add(box(0.02, 0.22, 0.05), b.dark, [sx * (b.bw / 2 + 0.002), back - 0.11, b.bl * 0.62]);
    // Pack saddle frame on the rump: crossbucks, side bars, a slatted top at the cargo anchor.
    const c = def.cargo[0];
    if (c) {
      const fz = c.z;
      const topY = c.y;
      const half = 0.24;
      for (const dz of [-0.2, 0.2]) {
        for (const sx of [-1, 1]) p.add(rod([sx * (b.bw / 2 + 0.02), back - 0.12, fz + dz], [-sx * 0.04, topY - 0.02, fz + dz], 0.025, 5), PAL.wood);
      }
      for (const sx of [-1, 1]) {
        p.add(box(0.05, 0.05, 0.56), PAL.woodDark, [sx * (b.bw / 2 + 0.03), back - 0.12, fz]);
        p.add(box(0.05, 0.04, 0.52), PAL.woodDark, [sx * half, topY - 0.04, fz]);
        // Leather saddlebags hanging off the side bars.
        p.add(bev(0.12, 0.3, 0.42, 0.05), PAL.leather, [sx * (b.bw / 2 + 0.1), back - 0.33, fz]);
        p.add(bev(0.13, 0.1, 0.43, 0.03), PAL.leatherDark, [sx * (b.bw / 2 + 0.105), back - 0.2, fz]);
        p.add(box(0.02, 0.04, 0.04), PAL.brass, [sx * (b.bw / 2 + 0.17), back - 0.27, fz]);
      }
      for (let k = -2; k <= 2; k++) p.add(box(half * 2 + 0.05, 0.02, 0.1), k % 2 ? PAL.woodLight : PAL.wood, [0, topY - 0.01, fz + k * 0.12]);
      p.add(box(b.bw + 0.04, 0.03, 0.62), 0x3f8f8a, [0, back + 0.015, fz]);
    }
    // A brass bell under the chin strap.
    p.add(cyl(0.025, 0.04, 0.05, 6), PAL.brass, [0, back - 0.2, b.bl * 1.25]);
    return holds;
  });
}

/** Builds a mount; unknown ids get a horse-like build scaled to the data. */
export function buildMount(def: MountDef): MountModel {
  if (def.id === 'donkey') return donkey(def);
  return horse(def);
}
