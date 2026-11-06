import * as THREE from 'three';
import { PACKS } from './data';
import { PAL, Parts, beam, bev, box, cone, cyl, glowMaterial, ico, jiggle, lathe, makeRng, mesh, octa, ring, rod, span, vary, type V3 } from './kit';
import { grainify } from './detail';
import { madePack } from './glb';

// Trade packs: what you craft at a workbench and carry on your back to a trading post.
// Origin: bottom-centre of the strap face. The straps face +Z (they press against the
// carrier's back) and the pack extends toward -Z. Roughly 0.56 wide, 0.7 tall, 0.5 deep. Each is
// drawn with the body its look names (BODIES), or as a plain sack if it names none.

export const PACK_SIZE = { w: 0.56, h: 0.7, d: 0.5 } as const;
/** Every pack in shared/trade.json (trade goods and raw materials). */
export const PACK_IDS: string[] = PACKS.map((p) => p.id);

/** Two shoulder straps on the +Z face: flat on the face, with a loop standing off it. */
function straps(p: Parts, h: number, spread = 0.14): void {
  for (const x of [-spread, spread]) {
    p.add(span(x - 0.03, x + 0.03, 0.05, h - 0.03, -0.006, 0.012), PAL.leather);
    const pts: V3[] = [
      [x, h - 0.05, 0.006],
      [x, h - 0.11, 0.07],
      [x, h * 0.5, 0.08],
      [x, 0.12, 0.04],
      [x, 0.06, 0.008],
    ];
    for (let i = 0; i < pts.length - 1; i++) p.add(beam(pts[i], pts[i + 1], 0.05, 0.016), PAL.leatherDark);
    p.add(box(0.07, 0.05, 0.02), PAL.brass, [x, h * 0.5, 0.092]);
  }
}

/** An open slatted crate from the strap face back: corner posts proud of inset slats. */
function crate(p: Parts, rng: () => number, w: number, h: number, z0: number, z1: number, rows: number): void {
  const zc = (z0 + z1) / 2;
  const d = z0 - z1;
  const post = 0.055;
  // Dark inside, seen through the gaps.
  p.add(box(w - 0.07, h - 0.03, d - 0.07), PAL.woodDeep, [0, h / 2, zc]);
  p.add(box(w - 0.03, 0.035, d - 0.03), PAL.woodDark, [0, 0.0175, zc]);
  for (const sx of [-1, 1]) {
    for (const z of [z0 - post / 2, z1 + post / 2]) p.add(box(post, h, post), PAL.woodDark, [sx * (w / 2 - post / 2), h / 2, z]);
  }
  const gap = 0.028;
  const slat = (h - 0.02 - gap * (rows - 1)) / rows;
  for (let r = 0; r < rows; r++) {
    const y = 0.02 + slat / 2 + r * (slat + gap);
    const c = () => vary(PAL.crate, rng, 0.1);
    const t = 0.018;
    const inset = 0.009;
    for (const sx of [-1, 1]) p.add(box(t, slat, d - post), c(), [sx * (w / 2 - inset - t / 2), y, zc]);
    p.add(box(w - post, slat, t), c(), [0, y, z0 - inset - t / 2]);
    p.add(box(w - post, slat, t), c(), [0, y, z1 + inset + t / 2]);
  }
}

function harvestCrate(p: Parts): void {
  const rng = makeRng(11);
  const w = 0.55;
  const h = 0.6;
  const z0 = -0.02;
  const z1 = -0.52;
  const zc = (z0 + z1) / 2;
  crate(p, rng, w, h, z0, z1, 4);
  // Golden tubers heaped over the rim.
  const tubers: V3[] = [
    [-0.13, h + 0.01, zc + 0.1],
    [0.1, h + 0.02, zc + 0.12],
    [-0.02, h + 0.05, zc - 0.02],
    [0.14, h + 0.0, zc - 0.1],
    [-0.15, h + 0.01, zc - 0.12],
    [0.03, h + 0.0, zc - 0.17],
  ];
  tubers.forEach((t, i) => p.add(jiggle(ico(0.085, 0), 0.012, i), vary(0xd4a04a, rng, 0.12), t, [rng() * 3, rng() * 3, 0], [1, 0.75, 1.15]));
  // Barley ears poking up at the back corner.
  for (let i = 0; i < 5; i++) {
    const bx = 0.12 + (i - 2) * 0.035;
    const bz = zc - 0.12 + (i % 2) * 0.04;
    const tip: V3 = [bx + (i - 2) * 0.03, h + 0.24 + (i % 3) * 0.03, bz - 0.04];
    p.add(rod([bx, h - 0.1, bz], tip, 0.008, 4), 0xc9a646);
    p.add(octa(0.05), 0xe8c45a, [tip[0], tip[1] + 0.03, tip[2]], [0.3, 0, (i - 2) * 0.12], [0.35, 1.1, 0.35]);
  }
  // A lantern mark burnt into the left side.
  const ink = 0x4a2c18;
  const sx = w / 2 - 0.004;
  const ly = 0.32;
  p.add(box(0.008, 0.11, 0.08), ink, [sx, ly, zc]);
  p.add(box(0.008, 0.025, 0.12), ink, [sx, ly + 0.07, zc]);
  p.add(box(0.008, 0.02, 0.1), ink, [sx, ly - 0.065, zc]);
  p.add(box(0.008, 0.035, 0.03), ink, [sx, ly + 0.1, zc]);
  straps(p, h);
}

function flaxBale(p: Parts): void {
  const rng = makeRng(23);
  const zc = -0.215;
  const sq: V3 = [0.95, 1, 0.82];
  const oct = (r: number, hh: number, y: number, c: number) => p.add(cyl(r, r, hh, 8), c, [0, y, zc], [0, Math.PI / 8, 0], sq);
  oct(0.27, 0.54, 0.35, PAL.sack); // sacking
  oct(0.245, 0.09, 0.66, 0xe9ddb2); // fibre ends
  oct(0.245, 0.08, 0.045, 0xe1d3a4);
  // Combed fibre fringe at the top.
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const r = 0.12 + (i % 3) * 0.05;
    p.add(
      cone(0.03, 0.13, 4),
      vary(0xeee3bd, rng, 0.06),
      [Math.cos(a) * r * 0.9, 0.74, zc + Math.sin(a) * r * 0.75],
      [Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3],
    );
  }
  // Three ropes.
  for (const y of [0.18, 0.36, 0.54]) oct(0.283, 0.035, y, PAL.rope);
  // Blue flax flowers tucked under the top rope.
  const flowers: Array<[number, number]> = [
    [Math.PI * 1.5, 0.05],
    [Math.PI * 1.3, -0.04],
    [Math.PI * 1.75, 0.0],
    [Math.PI * 0.95, 0.02],
    [Math.PI * 0.05, -0.03],
  ];
  for (const [a, dy] of flowers) {
    const x = Math.cos(a) * 0.262;
    const z = zc + Math.sin(a) * 0.215;
    const yaw = Math.atan2(Math.cos(a), Math.sin(a));
    p.add(cyl(0.045, 0.04, 0.012, 5), 0x8fb6ef, [x, 0.585 + dy, z], [Math.PI / 2, yaw, 0]);
    p.add(octa(0.014), PAL.yellow, [x + Math.cos(a) * 0.01, 0.585 + dy, z + Math.sin(a) * 0.01]);
  }
  straps(p, 0.68);
}

function emberPreserves(p: Parts, glow: Parts): void {
  const rng = makeRng(37);
  const w = 0.56;
  const h = 0.46;
  const z0 = -0.02;
  const z1 = -0.5;
  const zc = (z0 + z1) / 2;
  crate(p, rng, w, h, z0, z1, 3);
  // Straw packing between the jars.
  p.add(jiggle(box(w - 0.08, 0.06, z0 - z1 - 0.08), 0.012, 3), 0xe6cf7c, [0, h - 0.02, zc]);
  for (let i = 0; i < 8; i++) {
    p.add(cone(0.02, 0.08, 3), 0xead27e, [(rng() - 0.5) * 0.44, h + 0.02, zc + (rng() - 0.5) * 0.36], [rng() - 0.5, rng() * 3, rng() - 0.5]);
  }
  // Two rows of three jars of glowing jam with cloth lids.
  let k = 0;
  for (const z of [zc + 0.11, zc - 0.11]) {
    for (const x of [-0.17, 0, 0.17]) {
      const top = h + 0.13;
      glow.add(cyl(0.07, 0.072, 0.2, 8), k % 2 ? 0xff6a2a : 0xff5426, [x, top - 0.1, z]);
      p.add(cyl(0.06, 0.07, 0.03, 8), 0xe8f4f6, [x, top + 0.01, z]); // glass shoulder
      p.add(cyl(0.085, 0.08, 0.035, 8), k % 2 ? PAL.cream : PAL.red, [x, top + 0.04, z]); // cloth
      p.add(cyl(0.066, 0.066, 0.016, 8), k % 2 ? PAL.red : PAL.cream, [x, top + 0.065, z]);
      p.add(ring(0.072, 0.082, 0.012, 8), PAL.rope, [x, top + 0.022, z]);
      k++;
    }
  }
  straps(p, h + 0.02);
}

function ciderCask(p: Parts): void {
  const zc = -0.28;
  // Carrying frame: two rails, cross bars, a shelf and braces.
  for (const sx of [-1, 1]) {
    p.add(box(0.05, 0.72, 0.05), PAL.woodDark, [sx * 0.25, 0.36, -0.035]);
    p.add(beam([sx * 0.25, 0.56, -0.05], [sx * 0.25, 0.05, -0.48], 0.04), PAL.woodDark);
  }
  for (const y of [0.16, 0.66]) p.add(box(0.55, 0.05, 0.035), PAL.wood, [0, y, -0.035]);
  p.add(box(0.56, 0.04, 0.48), PAL.wood, [0, 0.02, -0.26]);
  // The cask, lying across the back.
  const r = (t: number) => 0.2 - 0.04 * (t / 0.3) ** 2;
  const prof: Array<[number, number]> = [
    [0, -0.275],
    [0.15, -0.275],
    [0.165, -0.3],
  ];
  for (const t of [-0.2, -0.1, 0, 0.1, 0.2]) prof.push([r(t), t]);
  prof.push([0.165, 0.3], [0.15, 0.275], [0, 0.275]);
  const cy = 0.24;
  p.add(
    lathe(prof, 12),
    (c) => {
      const a = Math.atan2(c.y - cy, c.z - zc);
      const stave = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 12);
      return Math.abs(c.x) > 0.27 ? 0xb98a55 : stave % 2 ? 0x9a6436 : 0x8a5830;
    },
    [0, cy, zc],
    [0, 0, -Math.PI / 2],
  );
  for (const t of [-0.22, -0.1, 0.1, 0.22]) {
    p.add(ring(r(t) - 0.004, r(t) + 0.012, 0.028, 12), PAL.iron, [t, cy, zc], [0, 0, -Math.PI / 2]);
  }
  // Lashing to the frame.
  for (const t of [-0.16, 0.16]) p.add(ring(r(t) - 0.002, r(t) + 0.016, 0.04, 12), PAL.leather, [t, cy, zc], [0, 0, -Math.PI / 2]);
  p.add(cyl(0.022, 0.026, 0.04, 6), PAL.woodDark, [0.04, cy + 0.205, zc]);
  // A red apple painted on the left head.
  const hx = 0.281;
  p.add(cyl(0.07, 0.07, 0.008, 10), PAL.red, [hx, cy - 0.005, zc], [0, 0, -Math.PI / 2]);
  p.add(cyl(0.025, 0.025, 0.01, 6), 0xf28a7a, [hx + 0.002, cy + 0.025, zc + 0.025], [0, 0, -Math.PI / 2]);
  p.add(box(0.01, 0.045, 0.012), PAL.woodDeep, [hx + 0.001, cy + 0.08, zc]);
  p.add(box(0.01, 0.025, 0.05), PAL.leaf, [hx + 0.001, cy + 0.085, zc - 0.03], [0.5, 0, 0]);
  straps(p, 0.68, 0.15);
}

/** Ten rough planks standing on end, lashed with two ropes. */
function lumberBundle(p: Parts): void {
  const rng = makeRng(53);
  for (let layer = 0; layer < 5; layer++) {
    for (const col of [-1, 1]) {
      const len = 0.93 + rng() * 0.1;
      const y0 = 0.02 + rng() * 0.05;
      const z = -0.05 - layer * 0.064;
      const x = col * 0.112 + (rng() - 0.5) * 0.02;
      p.add(box(0.21, len, 0.058), vary(0xc4955c, rng, 0.12), [x, y0 + len / 2, z], [0, (rng() - 0.5) * 0.06, (rng() - 0.5) * 0.03]);
      p.add(box(0.2, 0.012, 0.054), 0xe2c393, [x, y0 + len + 0.004, z]);
    }
  }
  for (const y of [0.24, 0.74]) {
    p.add(box(0.48, 0.035, 0.35), PAL.rope, [0, y, -0.178]);
    p.add(box(0.05, 0.06, 0.04), PAL.rope, [0.18, y - 0.03, 0.0]);
  }
  straps(p, 0.85);
}

/** A squared pale building stone sitting in a wooden carrying frame. */
function stoneBlock(p: Parts): void {
  for (const sx of [-1, 1]) {
    p.add(box(0.05, 0.74, 0.05), PAL.woodDark, [sx * 0.27, 0.37, -0.035]);
    p.add(beam([sx * 0.27, 0.6, -0.05], [sx * 0.27, 0.05, -0.58], 0.04), PAL.woodDark);
  }
  for (const y of [0.18, 0.68]) p.add(box(0.58, 0.05, 0.035), PAL.wood, [0, y, -0.035]);
  p.add(box(0.6, 0.04, 0.56), PAL.wood, [0, 0.02, -0.31]);
  const s = 0.5;
  const zc = -0.32;
  p.add(bev(s, s, s, 0.035), PAL.stoneLight, [0, 0.04 + s / 2, zc]);
  // Chisel marks on the faces that show.
  for (let k = 0; k < 4; k++) {
    p.add(box(0.008, 0.16, 0.02), PAL.stoneDark, [s / 2 + 0.002, 0.16 + k * 0.1, zc - 0.12 + k * 0.07], [0.5, 0, 0]);
    p.add(box(0.02, 0.008, 0.14), PAL.stoneDark, [-0.1 + k * 0.07, 0.04 + s + 0.002, zc + 0.05], [0, 0.5, 0]);
  }
  for (const y of [0.2, 0.46]) p.add(box(s + 0.03, 0.03, s + 0.03), PAL.rope, [0, y, zc]);
  straps(p, 0.7, 0.15);
}

/** A small, heavy iron-banded crate brimming with nails, hinges and brackets. */
function ironCrate(p: Parts): void {
  const rng = makeRng(71);
  const w = 0.5;
  const h = 0.42;
  const z0 = -0.03;
  const z1 = -0.48;
  const zc = (z0 + z1) / 2;
  const d = z0 - z1;
  p.add(bev(w, h, d, 0.02), 0x7a5232, [0, h / 2, zc]);
  p.add(box(w - 0.06, 0.02, d - 0.06), PAL.woodDeep, [0, h - 0.005, zc]);
  // Iron bands round the middle and over the corners, with rivets.
  for (const y of [0.1, h - 0.07]) p.add(box(w + 0.016, 0.045, d + 0.016), PAL.iron, [0, y, zc]);
  for (const sx of [-1, 1]) {
    for (const z of [z0, z1]) p.add(box(0.05, h + 0.012, 0.05), PAL.iron, [sx * (w / 2 - 0.018), h / 2, z + (z === z0 ? -0.018 : 0.018)]);
    for (const y of [0.1, h - 0.07]) for (const z of [zc - 0.12, zc + 0.12]) p.add(octa(0.012), PAL.ironLight, [sx * (w / 2 + 0.01), y, z]);
  }
  // Hardware heaped over the rim: nails, hinges, brackets.
  for (let k = 0; k < 16; k++) {
    const x = (rng() - 0.5) * (w - 0.12);
    const z = zc + (rng() - 0.5) * (d - 0.12);
    const y = h + 0.01 + rng() * 0.05;
    if (k % 3 === 0) p.add(box(0.1, 0.012, 0.05), PAL.ironLight, [x, y, z], [rng() * 0.6, rng() * 3, rng() * 0.6]);
    else if (k % 3 === 1) p.add(box(0.08, 0.012, 0.025), 0x59606b, [x, y, z], [0, rng() * 3, 0.5]);
    else p.add(rod([x, y, z], [x + 0.05, y + 0.03, z + 0.02], 0.008, 4), PAL.steel);
  }
  p.add(jiggle(box(w - 0.08, 0.05, d - 0.08), 0.01, 9), 0x6b737e, [0, h + 0.005, zc]);
  straps(p, h + 0.03);
}

function plainSack(p: Parts): void {
  p.add(jiggle(ico(0.3, 1), 0.02, 5), PAL.sack, [0, 0.3, -0.25], undefined, [0.9, 1.05, 0.8]);
  p.add(cyl(0.08, 0.12, 0.12, 6), PAL.sack, [0, 0.64, -0.25]);
  p.add(ring(0.08, 0.1, 0.03, 6), PAL.rope, [0, 0.62, -0.25]);
  straps(p, 0.62);
}

/** The packs' bodies, by name: a pack's look names one. What glows goes in `glow`. */
const BODIES: Record<string, (body: Parts, glow: Parts) => void> = {
  harvestCrate,
  flaxBale,
  emberPreserves,
  ciderCask,
  lumberBundle,
  stoneBlock,
  ironCrate,
};

/** The bodies a look can name. */
export const packBodies = (): string[] => Object.keys(BODIES);

/** A carried trade pack: the body its look names (a plain sack if none), and its made model once loaded. */
export function buildPack(id: string): THREE.Group {
  const root = new THREE.Group();
  root.name = `pack:${id}`;
  const body = new Parts();
  const glow = new Parts();
  const look = PACKS.find((p) => p.id === id)?.look;
  ((look?.body && BODIES[look.body]) || plainSack)(body, glow);
  mesh(root, body.build());
  if (!glow.empty) mesh(root, glow.build(), { mat: glowMaterial(), shadow: false });
  grainify(root);
  // The made pack takes over when it loads (src/render/models/glb.ts).
  madePack(look?.model, root);
  return root;
}
