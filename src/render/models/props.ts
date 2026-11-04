import * as THREE from 'three';
import { propData } from './data';
import { PAL, Parts, TAU, beam, box, cone, cyl, ico, jiggle, lathe, makeRng, mix, octa, ring, rod, vary, type Rgb } from './kit';

// Small props for dressing the world, as single vertex-coloured geometries (origin at the base
// centre, facing +Z) so the zone builder can scatter hundreds with InstancedMesh and
// toon(0xffffff, { vertexColors: true }). Sizes follow the `props` list in shared/structures.json.

const cache = new Map<string, THREE.BufferGeometry>();

/** Merged, vertex-coloured geometry for a prop (cached; do not dispose it). */
export function propGeometry(id: string): THREE.BufferGeometry {
  let g = cache.get(id);
  if (!g) {
    g = propParts(id).build();
    g.name = `prop:${id}`;
    cache.set(id, g);
  }
  return g;
}

/**
 * The lamp's glass alone, a hair larger than in propGeometry, for drawing over it with an unlit
 * material at night. Null for props with nothing that glows.
 */
export function propGlowGeometry(id: string): THREE.BufferGeometry | null {
  if (id !== 'lamp') return null;
  const key = `${id}:glow`;
  let g = cache.get(key);
  if (!g) {
    g = new Parts().add(box(0.2, 0.28, 0.2), PAL.glow, [0, LAMP_GLASS_Y, 0], undefined, 1.03).build();
    cache.set(key, g);
  }
  return g;
}

const LAMP_GLASS_Y = 2.93;

/** The prop's pieces before merging, for buildings that want a barrel or a bench of their own. */
export function propParts(id: string, seed = 1): Parts {
  const p = new Parts();
  const rng = makeRng(seed * 7919 + id.length * 31);
  const d = propData(id) ?? { w: 1, d: 1, h: 1 };
  switch (id) {
    case 'fence':
      fence(p, d.w, d.h, rng);
      break;
    case 'lamp':
      lamp(p);
      break;
    case 'signpost':
      signpost(p, d.h);
      break;
    case 'bench':
      bench(p, d.w);
      break;
    case 'barrel':
      barrel(p, d.w / 2, d.h, rng);
      break;
    case 'crates':
      crates(p, rng);
      break;
    case 'haycart':
      haycart(p, rng);
      break;
    case 'bollard':
      bollard(p, d.h);
      break;
    default:
      p.add(box(d.w, d.h, d.d), PAL.crate, [0, d.h / 2, 0]);
  }
  return p;
}

function fence(p: Parts, w: number, h: number, rng: () => number): void {
  const x = w / 2 - 0.04;
  // Posts at both ends, a touch different so two fences meeting end to end never coincide.
  p.add(cyl(0.065, 0.075, h, 6), PAL.woodGreyDark, [-x, h / 2, 0], [0, 0.3, 0]);
  p.add(cone(0.068, 0.08, 6), PAL.woodGreyDark, [-x, h + 0.04, 0], [0, 0.3, 0]);
  p.add(cyl(0.065, 0.075, h - 0.04, 6), PAL.woodGreyDark, [x, (h - 0.04) / 2, 0]);
  p.add(cone(0.068, 0.08, 6), PAL.woodGreyDark, [x, h, 0]);
  for (const y of [h * 0.42, h * 0.78]) {
    p.add(box(w - 0.02, 0.075, 0.07), vary(PAL.woodGrey, rng, 0.08), [0, y, 0.0], [rng() * 0.08, 0, (rng() - 0.5) * 0.03]);
  }
}

function lamp(p: Parts): void {
  p.add(cyl(0.15, 0.19, 0.24, 8), PAL.stoneDark, [0, 0.12, 0]);
  p.add(cyl(0.08, 0.1, 0.12, 8), PAL.iron, [0, 0.3, 0]);
  p.add(cyl(0.045, 0.055, 2.4, 8), PAL.iron, [0, 1.56, 0]);
  p.add(ring(0.045, 0.075, 0.05, 8), PAL.ironLight, [0, 1.1, 0]);
  p.add(ring(0.045, 0.07, 0.05, 8), PAL.ironLight, [0, 2.6, 0]);
  // Lantern: iron frame, glowing glass, a hat and a finial.
  const y = LAMP_GLASS_Y;
  p.add(cyl(0.13, 0.08, 0.08, 4), PAL.iron, [0, y - 0.18, 0], [0, Math.PI / 4, 0]);
  p.add(box(0.2, 0.28, 0.2), PAL.glow, [0, y, 0], undefined, undefined, { glow: 1.7 });
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) p.add(box(0.03, 0.3, 0.03), PAL.iron, [dx * 0.1, y, dz * 0.1]);
  p.add(cone(0.2, 0.16, 4), PAL.iron, [0, y + 0.22, 0], [0, Math.PI / 4, 0]);
  p.add(octa(0.035), PAL.brass, [0, y + 0.33, 0]);
}

function signpost(p: Parts, h: number): void {
  p.add(box(0.12, h - 0.1, 0.12), PAL.wood, [0, (h - 0.1) / 2, 0]);
  p.add(cone(0.11, 0.1, 4), PAL.woodDark, [0, h - 0.05, 0], [0, Math.PI / 4, 0]);
  const arrows: Array<[number, number, Rgb]> = [
    [h - 0.38, 0.35, PAL.cream],
    [h - 0.72, 2.3, 0xe9d6a8],
    [h - 1.06, -1.25, PAL.cream],
  ];
  for (const [y, yaw, c] of arrows) {
    const g = new Parts();
    g.add(box(0.5, 0.16, 0.04), c, [0.31, 0, 0]);
    g.add(cyl(0.113, 0.113, 0.04, 3), c, [0.6, 0, 0], [Math.PI / 2, 0, -Math.PI / 2]);
    g.add(box(0.46, 0.035, 0.045), PAL.woodDark, [0.3, -0.06, 0]);
    for (let k = 0; k < 3; k++) g.add(box(0.07, 0.025, 0.046), PAL.woodDeep, [0.16 + k * 0.11, 0.025, 0]);
    p.take(g, [0, y, 0], [0, yaw, 0]);
  }
}

function bench(p: Parts, w: number): void {
  const half = w / 2;
  for (let k = 0; k < 3; k++) p.add(box(w, 0.04, 0.12), k % 2 ? PAL.woodLight : PAL.wood, [0, 0.45, 0.2 - k * 0.135]);
  for (let k = 0; k < 2; k++) p.add(box(w, 0.11, 0.035), k % 2 ? PAL.woodLight : PAL.wood, [0, 0.62 + k * 0.15, -0.235 - k * 0.025], [-0.2, 0, 0]);
  for (const sx of [-1, 1]) {
    const x = sx * (half - 0.12);
    p.add(box(0.06, 0.43, 0.06), PAL.iron, [x, 0.215, 0.18]);
    p.add(box(0.06, 0.88, 0.06), PAL.iron, [x, 0.44, -0.2], [-0.12, 0, 0]);
    p.add(box(0.05, 0.05, 0.46), PAL.iron, [x, 0.41, 0]);
    p.add(box(0.07, 0.04, 0.42), PAL.woodDark, [x, 0.66, 0.0]);
    p.add(box(0.05, 0.22, 0.05), PAL.iron, [x, 0.54, 0.18]);
  }
}

function barrel(p: Parts, r: number, h: number, rng: () => number): void {
  const bulge = (t: number) => r * (0.84 + 0.16 * Math.sin(Math.PI * t));
  const prof: Array<[number, number]> = [[0, 0.02], [bulge(0) - 0.01, 0.0]];
  for (let k = 0; k <= 6; k++) prof.push([bulge(k / 6), (h * k) / 6]);
  prof.push([bulge(1) - 0.035, h], [bulge(1) - 0.035, h - 0.03], [0, h - 0.03]);
  const staves = 12;
  const tone = Array.from({ length: staves }, () => vary(0x9c6a3c, rng, 0.1));
  p.add(lathe(prof, staves), (c) => (c.y > h - 0.035 ? 0x7a5230 : tone[Math.floor(((Math.atan2(c.z, c.x) + Math.PI) / TAU) * staves) % staves]));
  for (const t of [0.1, 0.3, 0.7, 0.9]) p.add(ring(bulge(t) - 0.01, bulge(t) + 0.014, 0.05, staves), PAL.iron, [0, h * t, 0]);
}

function crate(p: Parts, s: number, at: [number, number, number], yaw: number, rng: () => number): void {
  const g = new Parts();
  g.add(box(s - 0.04, s - 0.04, s - 0.04), vary(PAL.crate, rng, 0.08), [0, s / 2, 0]);
  const e = 0.07;
  const c = mix(PAL.crate, PAL.woodDark, 0.55);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) g.add(box(e, s, e), c, [(sx * (s - e)) / 2, s / 2, (sz * (s - e)) / 2]);
    for (const sy of [0, 1]) {
      g.add(box(e, e, s - 0.02), c, [(sx * (s - e)) / 2, sy * (s - e) + e / 2, 0]);
      g.add(box(s - 0.02, e, e), c, [0, sy * (s - e) + e / 2, (sx * (s - e)) / 2]);
    }
  }
  g.add(beam([-s / 2 + e, e, s / 2 - 0.005], [s / 2 - e, s - e, s / 2 - 0.005], 0.07, 0.03), c);
  p.take(g, at, [0, yaw, 0]);
}

function crates(p: Parts, rng: () => number): void {
  crate(p, 0.74, [-0.4, 0, 0.1], 0.08, rng);
  crate(p, 0.68, [0.42, 0, -0.12], -0.12, rng);
  crate(p, 0.62, [0.02, 0.74, 0.0], 0.2, rng);
}

function spokedWheel(p: Parts, r: number, at: [number, number, number], rng: () => number): void {
  const axle: [number, number, number] = [0, 0, -Math.PI / 2];
  p.add(ring(r - 0.07, r, 0.09, 12), PAL.woodDark, at, axle);
  p.add(cyl(0.07, 0.07, 0.16, 6), PAL.woodDark, at, axle);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU + rng() * 0.01;
    p.add(beam([0, Math.cos(a) * 0.06, Math.sin(a) * 0.06], [0, Math.cos(a) * (r - 0.05), Math.sin(a) * (r - 0.05)], 0.035), PAL.wood, at);
  }
}

function haycart(p: Parts, rng: () => number): void {
  const r = 0.45;
  for (const sx of [-1, 1]) spokedWheel(p, r, [sx * 0.72, r, -0.15], rng);
  p.add(rod([-0.7, r, -0.15], [0.7, r, -0.15], 0.035, 6), PAL.iron);
  p.add(box(1.2, 0.08, 1.7), PAL.wood, [0, 0.62, -0.25]);
  for (const sx of [-1, 1]) {
    p.add(box(0.06, 0.22, 1.7), PAL.woodDark, [sx * 0.6, 0.75, -0.25]);
    // Shafts resting on the ground in front.
    p.add(beam([sx * 0.42, 0.62, 0.55], [sx * 0.3, 0.12, 1.38], 0.07), PAL.woodDark);
  }
  p.add(box(1.2, 0.22, 0.06), PAL.woodDark, [0, 0.75, -1.08]);
  p.add(box(0.64, 0.05, 0.05), PAL.woodDark, [0, 0.15, 1.3]);
  // A heap of hay, lumpy, with a few loose wisps.
  p.add(jiggle(ico(0.5, 1), 0.06, 4), PAL.hay, [0, 1.1, -0.25], undefined, [1.22, 1.35, 1.75]);
  p.add(jiggle(ico(0.32, 1), 0.04, 5), 0xead27e, [0.1, 1.55, -0.4], undefined, [1.1, 0.8, 1.3]);
  for (let k = 0; k < 7; k++) {
    const a = rng() * TAU;
    p.add(cone(0.025, 0.28, 3), 0xead27e, [Math.cos(a) * 0.45, 1.0 + rng() * 0.5, -0.25 + Math.sin(a) * 0.65], [rng() - 0.5, rng() * 3, Math.cos(a) * 0.9]);
  }
}

function bollard(p: Parts, h: number): void {
  p.add(cyl(0.17, 0.18, 0.06, 8), PAL.iron, [0, 0.03, 0]);
  p.add(cyl(0.1, 0.125, h - 0.16, 8), PAL.iron, [0, 0.06 + (h - 0.16) / 2, 0]);
  p.add(cyl(0.16, 0.11, 0.08, 8), PAL.iron, [0, h - 0.06, 0]);
  p.add(cyl(0.13, 0.16, 0.03, 8), PAL.ironLight, [0, h - 0.008, 0]);
  p.add(ring(0.1, 0.13, 0.03, 8), PAL.ironLight, [0, h * 0.35, 0]);
}

