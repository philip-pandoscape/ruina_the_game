import * as THREE from 'three';
import { CROPS } from './data';
import { PAL, Parts, TAU, cone, cyl, ico, jiggle, makeRng, octa, rod, vary, vcMaterial, type Rgb } from './kit';

// Crops and orchard trees as instancing-ready geometry: one non-indexed, faceted, vertex-
// coloured BufferGeometry per (id, stage), origin at the base centre, cached. Draw thousands
// with an InstancedMesh and toon(0xffffff, { vertexColors: true }). Stage 0 is just planted, the
// last stage is ripe. Crops stay inside ~1.6 m of their 2 m cell; trees grow up to ~4 m across.

const cache = new Map<string, THREE.BufferGeometry>();

/** The stage indices a crop has (0 .. stages-1). */
export function cropStages(id: string): number[] {
  const n = CROPS.find((c) => c.id === id)?.stages ?? 4;
  return Array.from({ length: n }, (_, i) => i);
}

/** Cached geometry for a crop at a stage (clamped to its range). Do not dispose it. */
export function cropGeometry(id: string, stage: number): THREE.BufferGeometry {
  const last = cropStages(id).length - 1;
  const s = Math.max(0, Math.min(last, Math.round(stage)));
  const key = `${id}:${s}`;
  let g = cache.get(key);
  if (!g) {
    const p = new Parts();
    const rng = makeRng(id.length * 131 + s * 17 + id.charCodeAt(0));
    const build = BUILD[id] ?? generic;
    build(p, s / Math.max(1, last), s, rng);
    g = p.build();
    g.name = `crop:${key}`;
    cache.set(key, g);
  }
  return g;
}

/** A ready-made mesh of one crop (for previews; use InstancedMesh for fields). */
export function buildCrop(id: string, stage: number): THREE.Mesh {
  const m = new THREE.Mesh(cropGeometry(id, stage), vcMaterial());
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

type Build = (p: Parts, grown: number, stage: number, rng: () => number) => void;

const GREEN = [PAL.leaf, PAL.leafMid, 0x5cb85c];
const leafy = (rng: () => number, cols: readonly Rgb[] = GREEN) => vary(cols[Math.floor(rng() * cols.length)], rng, 0.06);

/** A low heap of fresh soil. */
function mound(p: Parts, r: number, h: number, c: Rgb = PAL.soilDark): void {
  p.add(ico(r, 0), c, [0, 0, 0], [0, 0.3, 0], [1, h / r, 1]);
}

/** Stage 0: a mound with a twig marker carrying a little tag in the crop's colour. */
function planted(p: Parts, tag: Rgb): void {
  mound(p, 0.32, 0.13);
  p.add(rod([0.16, 0.05, 0.1], [0.19, 0.42, 0.12], 0.012, 4), PAL.woodDark);
  p.add(cone(0.06, 0.12, 3), tag, [0.24, 0.37, 0.12], [0, 0, -Math.PI / 2], [1, 1, 0.3]);
}

/** A leaf blob: a flattened icosahedron. */
function blob(p: Parts, r: number, at: [number, number, number], c: Rgb, rng: () => number, squash = 0.65): void {
  p.add(jiggle(ico(r, 0), r * 0.12, Math.floor(rng() * 100)), c, at, [rng() * 2, rng() * TAU, 0], [1, squash, 1]);
}

const sunroot: Build = (p, _g, s, rng) => {
  if (s === 0) return planted(p, PAL.yellow);
  mound(p, 0.3 + s * 0.04, 0.1);
  if (s === 1) {
    p.add(rod([0, 0, 0], [0, 0.14, 0], 0.012, 4), PAL.leafMid);
    for (const a of [0.4, 0.4 + Math.PI]) p.add(ico(0.075, 0), PAL.leaf, [Math.cos(a) * 0.07, 0.15, Math.sin(a) * 0.07], [0, -a, 0.4], [1.3, 0.35, 1]);
    return;
  }
  const n = s === 2 ? 6 : 8;
  const R = s === 2 ? 0.34 : 0.48;
  const lr = s === 2 ? 0.21 : 0.27;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU + rng() * 0.4;
    const r = R * (0.55 + rng() * 0.45);
    blob(p, lr, [Math.cos(a) * r, 0.2 + rng() * (s === 2 ? 0.16 : 0.26), Math.sin(a) * r], leafy(rng, [PAL.leafDark, PAL.leafMid, 0x357f3a]), rng);
  }
  const crown = s === 2 ? 0.42 : 0.58;
  blob(p, lr * 1.15, [0, crown, 0], PAL.leafMid, rng);
  if (s === 3) {
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * TAU + 0.3;
      const r = k === 0 ? 0 : 0.18 + rng() * 0.12;
      p.add(cone(0.07, 0.03, 5), PAL.yellow, [Math.cos(a) * r, crown + lr * 0.55 - r * 0.35, Math.sin(a) * r], [Math.PI, 0, 0], undefined, { glow: 1.15 });
    }
    for (const [x, z, a] of [
      [0.36, 0.38, 0.4],
      [-0.4, 0.3, -0.6],
    ] as const)
      p.add(ico(0.12, 0), 0xd9a441, [x, 0.05, z], [0, a, 0.3], [1.35, 0.8, 1]);
  }
};

const barley: Build = (p, _g, s, rng) => {
  if (s === 0) return planted(p, 0xd8b26a);
  mound(p, 0.34, 0.08, PAL.soil);
  if (s === 1) {
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU + rng();
      const r = 0.05 + rng() * 0.12;
      p.add(cone(0.016, 0.2 + rng() * 0.1, 3), 0x7cc35a, [Math.cos(a) * r, 0.11, Math.sin(a) * r], [Math.sin(a) * 0.25, rng() * 3, -Math.cos(a) * 0.25]);
    }
    return;
  }
  const ripe = s === 3;
  const n = ripe ? 26 : 18;
  const h = ripe ? 1.0 : 0.5;
  for (let k = 0; k < n; k++) {
    const a = k * 2.399 + rng() * 0.3;
    const r = 0.05 + Math.sqrt((k + 0.5) / n) * 0.55;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const lean = 0.06 + rng() * 0.1;
    const hh = h * (0.82 + rng() * 0.25) * (1 - r * 0.25);
    const top: [number, number, number] = [x + Math.cos(a) * lean * hh, hh, z + Math.sin(a) * lean * hh];
    p.add(rod([x, 0, z], top, ripe ? 0.017 : 0.02, 3, 0.008, true), ripe ? vary(0xd9b552, rng, 0.08) : leafy(rng, [0x6fb84f, 0x5fa843, 0x7cc35a]));
    if (ripe) {
      // A bearded ear nodding over at the top: one long cone whose tip is the awns.
      const t = 1.75 + rng() * 0.5;
      const dir = new THREE.Vector3(Math.cos(a) * Math.sin(t), Math.cos(t), Math.sin(a) * Math.sin(t));
      const ear = cone(0.045, 0.3, 3);
      ear.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
      ear.translate(top[0] + dir.x * 0.14, top[1] + dir.y * 0.14, top[2] + dir.z * 0.14);
      p.add(ear, vary(0xe8c45a, rng, 0.07));
    }
  }
};

const flax: Build = (p, _g, s, rng) => {
  if (s === 0) return planted(p, 0x8fb6ef);
  mound(p, 0.32, 0.08, PAL.soil);
  const n = s === 1 ? 6 : 14;
  const h = [0, 0.14, 0.6, 0.85][s];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU * 1.7 + rng() * 0.6;
    const r = 0.04 + Math.sqrt((k + 0.5) / n) * (s === 1 ? 0.18 : 0.5);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const hh = h * (0.85 + rng() * 0.25);
    const top: [number, number, number] = [x + Math.cos(a) * 0.04, hh, z + Math.sin(a) * 0.04];
    p.add(rod([x, 0, z], top, 0.015, 3, 0.009, true), 0x6fae7f);
    if (s >= 2 && k % 2 === 0) p.add(cone(0.015, 0.1, 3), 0x7dbb8a, [x, hh * 0.55, z], [0.6, a, 0]);
    if (s === 1) p.add(cone(0.03, 0.05, 3), 0x7dbb8a, top);
    if (s === 3) {
      p.add(cone(0.075, 0.03, 5), k % 4 === 0 ? 0xb9d5f6 : 0x8fb6ef, [top[0], top[1] + 0.012, top[2]], [Math.PI + rng() * 0.4, rng() * TAU, 0], undefined, {
        glow: 1.1,
      });
      if (k % 2 === 0) p.add(octa(0.014), PAL.yellow, [top[0], top[1] + 0.02, top[2]]);
    }
  }
};

const emberberry: Build = (p, _g, s, rng) => {
  if (s === 0) return planted(p, PAL.red);
  mound(p, 0.34, 0.1);
  const glossy = [0x2f8a4a, 0x277a40, 0x3a9a55];
  if (s === 1) {
    p.add(rod([0, 0, 0], [0, 0.12, 0], 0.012, 4), 0x2f6f3a);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * TAU;
      p.add(ico(0.07, 0), glossy[k], [Math.cos(a) * 0.07, 0.13, Math.sin(a) * 0.07], [0, -a, 0.3], [1.4, 0.4, 1]);
    }
    return;
  }
  const ripe = s === 3;
  const n = ripe ? 6 : 5;
  const R = ripe ? 0.4 : 0.3;
  const bush: Array<[number, number, number]> = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU + rng() * 0.3;
    const at: [number, number, number] = [Math.cos(a) * R, ripe ? 0.25 : 0.2, Math.sin(a) * R];
    bush.push(at);
    blob(p, ripe ? 0.3 : 0.25, at, leafy(rng, glossy), rng, 0.75);
  }
  blob(p, ripe ? 0.36 : 0.28, [0, ripe ? 0.44 : 0.34, 0], glossy[0], rng, 0.75);
  if (ripe) {
    // Clusters of glowing berries on the outside of the bush.
    for (let c = 0; c < 6; c++) {
      const a = (c / 6) * TAU + 0.5;
      const cx = Math.cos(a) * 0.55;
      const cz = Math.sin(a) * 0.55;
      const cy = 0.3 + (c % 2) * 0.2;
      for (let k = 0; k < 4; k++) {
        p.add(
          octa(0.06),
          k % 2 ? 0xff6a2a : 0xff4a22,
          [cx + Math.cos(k * 1.7) * 0.06, cy + (k % 2) * 0.06, cz + Math.sin(k * 1.7) * 0.06],
          [rng(), rng(), 0],
          undefined,
          { glow: 1.45 },
        );
      }
    }
  }
};

/** Canopy blobs for a round-headed tree: [x, y, z, r]. */
function canopy(p: Parts, blobs: Array<[number, number, number, number]>, rng: () => number): void {
  for (const [x, y, z, r] of blobs) p.add(jiggle(ico(r, 0), r * 0.1, Math.floor(rng() * 50)), leafy(rng), [x, y, z], [rng(), rng() * TAU, 0], [1, 0.9, 1]);
}

const apple: Build = (p, _g, s, rng) => {
  const bark = PAL.trunk;
  if (s === 0) {
    mound(p, 0.3, 0.1);
    p.add(rod([0, 0, 0], [0.02, 0.9, 0], 0.025, 5, 0.015), bark);
    p.add(rod([0.14, 0, -0.04], [0.14, 0.8, -0.04], 0.018, 4), PAL.woodPale);
    p.add(octa(0.03), PAL.rope, [0.08, 0.55, -0.02], undefined, [2, 0.6, 1]);
    for (const [x, y, z] of [
      [0.08, 0.78, 0.03],
      [-0.07, 0.7, 0.05],
      [0.0, 0.92, -0.06],
      [-0.04, 0.55, -0.05],
    ] as const)
      blob(p, 0.08, [x, y, z], PAL.leaf, rng, 0.6);
    return;
  }
  if (s === 1) {
    p.add(cyl(0.05, 0.08, 1.1, 6), bark, [0, 0.55, 0]);
    canopy(
      p,
      [
        [0, 1.45, 0, 0.45],
        [0.3, 1.3, 0.1, 0.32],
        [-0.25, 1.35, -0.1, 0.32],
        [0.05, 1.78, -0.05, 0.3],
      ],
      rng,
    );
    return;
  }
  p.add(cyl(0.16, 0.25, 2.0, 7), bark, [0, 1.0, 0]);
  p.add(rod([0, 1.8, 0], [0.7, 2.6, 0.2], 0.1, 5, 0.06), bark);
  p.add(rod([0, 1.7, 0], [-0.6, 2.5, -0.3], 0.1, 5, 0.06), bark);
  p.add(cone(0.35, 0.2, 7), bark, [0, 0.1, 0]);
  const blobs: Array<[number, number, number, number]> = [
    [0, 3.2, 0, 1.25],
    [1.0, 2.8, 0.3, 0.95],
    [-0.95, 2.85, -0.35, 0.95],
    [0.25, 3.0, -0.95, 0.85],
    [-0.2, 3.95, 0.15, 0.75],
  ];
  canopy(p, blobs, rng);
  if (s === 3) {
    // Bright red apples dotted through the canopy, a couple fallen in the grass.
    for (let k = 0; k < 18; k++) {
      const [bx, by, bz, br] = blobs[k % blobs.length];
      const a = rng() * TAU;
      const e = (rng() - 0.35) * 1.2;
      const d = br * 0.95;
      p.add(
        octa(0.14),
        k % 3 ? PAL.red : 0xe8342a,
        [bx + Math.cos(a) * Math.cos(e) * d, by + Math.sin(e) * d * 0.85, bz + Math.sin(a) * Math.cos(e) * d],
        [rng(), rng(), 0],
        [1, 0.9, 1],
      );
    }
    for (const [x, z] of [
      [0.7, 0.6],
      [-0.5, 0.8],
    ] as const)
      p.add(octa(0.1), PAL.red, [x, 0.07, z], undefined, [1, 0.85, 1]);
  }
};

const pine: Build = (p, _g, s, rng) => {
  const bark = PAL.trunk;
  const needles = [0x2f7d4a, 0x3a8a52, 0x2a6f42];
  const tiers = (base: number, rs: number[], hs: number[], step: number) => {
    let y = base;
    rs.forEach((r, i) => {
      p.add(cone(r, hs[i], 7), vary(needles[i % needles.length], rng, 0.05), [0, y + hs[i] / 2, 0], [0, rng() * TAU, 0]);
      y += step * hs[i];
    });
  };
  if (s === 0) {
    mound(p, 0.25, 0.08);
    p.add(cyl(0.02, 0.025, 0.12, 4), bark, [0, 0.06, 0]);
    p.add(cone(0.15, 0.32, 6), needles[0], [0, 0.26, 0]);
    return;
  }
  if (s === 1) {
    p.add(cyl(0.05, 0.07, 0.5, 5), bark, [0, 0.25, 0]);
    tiers(0.35, [0.55, 0.42, 0.28], [0.75, 0.62, 0.5], 0.52);
    return;
  }
  const k = s === 3 ? 1.18 : 1;
  p.add(cyl(0.14 * k, 0.22 * k, 1.2 * k, 6), bark, [0, 0.6 * k, 0]);
  tiers(0.9 * k, [1.55 * k, 1.25 * k, 0.95 * k, 0.6 * k], [1.7 * k, 1.5 * k, 1.3 * k, 1.1 * k], 0.62);
  if (s === 3) {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU + rng();
      const tier = i % 3;
      const r = [1.35, 1.05, 0.8][tier] * k;
      const y = [1.0, 2.05, 2.95][tier] * k;
      p.add(octa(0.07), 0x7a4a26, [Math.cos(a) * r * 0.85, y, Math.sin(a) * r * 0.85], undefined, [0.8, 1.5, 0.8]);
    }
  }
};

const generic: Build = (p, g, s, rng) => {
  if (s === 0) return planted(p, PAL.white);
  mound(p, 0.3, 0.1);
  blob(p, 0.15 + g * 0.3, [0, 0.12 + g * 0.3, 0], PAL.leaf, rng);
};

const BUILD: Record<string, Build> = { sunroot, barley, flax, emberberry, apple, pine };
