import * as THREE from 'three';
import { PAL, Parts, bev, box, cone, cyl, ico, jiggle, mesh, pivot, tor, type Rgb, type V3 } from './kit';
import { clamp, lerp } from '../../util/math';

// Farm livestock for a 2 m x 2 m cell: chickens, sheep and cows, young (stage 0) or adult (1).
// Origin on the ground under the animal's middle, facing +Z. animate() keeps them alive - pecking,
// grazing, chewing, tail swishing - lifts their heads when `hungry`, and shows what there is to
// collect when `ready`: an egg in a nest, a heavy fleece, a full milk pail (adults only; the
// young have nothing to give yet).

export type AnimalId = 'chicken' | 'sheep' | 'cow';
export const ANIMAL_IDS: AnimalId[] = ['chicken', 'sheep', 'cow'];

export interface AnimalAnim {
  /** Seconds. */
  time: number;
  hungry: boolean;
  ready: boolean;
}

export interface AnimalModel {
  root: THREE.Group;
  animate(dt: number, s: AnimalAnim): void;
}

const ease = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** 1 inside [a, b] of a cycle position, easing in and out over `e`. */
const inside = (p: number, a: number, b: number, e: number) => ease(a - e, a, p) * (1 - ease(b, b + e, p));
/** Moves a value toward a target at a rate (per second). */
const toward = (v: number, target: number, dt: number, rate: number) => v + (target - v) * Math.min(1, dt * rate);

let born = 0;
/** The next animals built start their idle as the first one did (the animation library compares frames across builds). */
export const restartIdles = (): void => {
  born = 0;
};

function soft(p: Parts, w: number, h: number, d: number, c: Rgb, at: V3, r?: V3, round = 0.06): void {
  p.add(bev(w, h, d, Math.min(round, w / 2, h / 2, d / 2), 1), c, at, r, undefined, { smooth: true });
}

/** A wool puff: a lumpy faceted icosahedron. */
function puff(p: Parts, r: number, at: V3, c: Rgb, seed: number, squash = 0.85): void {
  p.add(jiggle(ico(r, 0), r * 0.12, seed), c, at, [seed * 0.7, seed * 1.3, 0], [1, squash, 1]);
}

function eyes(p: Parts, x: number, y: number, z: number, size: number, white = false): void {
  for (const sx of [-1, 1]) {
    if (white) p.add(box(0.012, size * 1.3, size * 1.3), PAL.white, [sx * x, y, z]);
    p.add(box(0.014, size, size), PAL.dark, [sx * (x + 0.002), y, z + (white ? size * 0.15 : 0)]);
  }
}

function part(parent: THREE.Object3D, p: Parts, name?: string): THREE.Mesh {
  return mesh(parent, p.build(), { name });
}

// ---------- chickens ----------

function chicken(young: boolean): AnimalModel {
  const root = new THREE.Group();
  root.name = `animal:chicken:${young ? 'young' : 'adult'}`;
  const off = (born++ * 2.39) % 13;
  const leg = 0xf0a028;
  const legTop = young ? 0.045 : 0.1;
  // Legs and feet stay planted; the body tips forward to peck.
  const legs = new Parts();
  for (const sx of [-1, 1]) {
    legs.add(box(0.022, legTop + 0.02, 0.022), leg, [sx * (young ? 0.03 : 0.05), (legTop + 0.02) / 2, 0]);
    legs.add(box(young ? 0.04 : 0.06, 0.014, young ? 0.05 : 0.08), leg, [sx * (young ? 0.03 : 0.05), 0.007, 0.02]);
  }
  part(root, legs);
  const body = pivot(root, 0, legTop, 0, 'body');
  const b = new Parts();
  let head: THREE.Group;
  const h = new Parts();
  if (young) {
    // A chick: a yellow ball of fluff with a big head and a tiny beak.
    const fluff = 0xffd84a;
    soft(b, 0.13, 0.11, 0.14, fluff, [0, 0.06, -0.01], undefined, 0.05);
    for (const sx of [-1, 1]) soft(b, 0.025, 0.05, 0.07, 0xf5c938, [sx * 0.068, 0.06, -0.01], [0, 0, sx * -0.3], 0.012);
    b.add(cone(0.03, 0.05, 4), 0xf5c938, [0, 0.08, -0.08], [-1.2, 0, 0]);
    part(body, b);
    head = pivot(body, 0, 0.1, 0.04, 'head');
    soft(h, 0.1, 0.09, 0.09, fluff, [0, 0.04, 0.01], undefined, 0.04);
    h.add(cone(0.016, 0.035, 4), 0xf08a1c, [0, 0.035, 0.07], [Math.PI / 2, Math.PI / 4, 0]);
    eyes(h, 0.05, 0.05, 0.03, 0.018);
    h.add(box(0.02, 0.025, 0.02), 0xf5c938, [0, 0.09, 0.0]);
  } else {
    // A hen: cream body, raised tail, red comb and wattle, orange beak.
    const feathers = 0xf6f1e4;
    const shade = 0xe3d8c0;
    soft(b, 0.26, 0.21, 0.32, feathers, [0, 0.11, -0.02], undefined, 0.08);
    soft(b, 0.2, 0.17, 0.12, feathers, [0, 0.12, 0.13], undefined, 0.06);
    for (const k of [-1, 0, 1]) b.add(box(0.05, 0.16, 0.1), k ? shade : feathers, [k * 0.045, 0.24, -0.17], [-0.55, 0, k * 0.25]);
    for (const sx of [-1, 1]) soft(b, 0.04, 0.12, 0.2, shade, [sx * 0.13, 0.12, -0.03], [0.15, 0, 0], 0.02);
    part(body, b);
    head = pivot(body, 0, 0.18, 0.12, 'head');
    soft(h, 0.12, 0.14, 0.13, feathers, [0, 0.06, 0.02], undefined, 0.05);
    for (const [z, hh] of [
      [-0.03, 0.05],
      [0.0, 0.065],
      [0.03, 0.05],
    ] as const)
      h.add(box(0.026, hh, 0.035), 0xd9342b, [0, 0.13 + hh / 2 - 0.01, z]);
    h.add(cone(0.024, 0.06, 4), 0xf08a1c, [0, 0.06, 0.1], [Math.PI / 2, Math.PI / 4, 0]);
    h.add(box(0.03, 0.05, 0.025), 0xd9342b, [0, 0.015, 0.075]);
    eyes(h, 0.061, 0.085, 0.04, 0.022);
  }
  part(head, h);
  // Ready: an egg in a little nest beside her.
  const nest = new THREE.Group();
  if (!young) {
    const n = new Parts();
    n.add(tor(0.11, 0.04, 4, 9), PAL.hay, [0.22, 0.035, -0.12], [Math.PI / 2, 0, 0]);
    n.add(cyl(0.1, 0.07, 0.03, 8), 0xd9b452, [0.22, 0.015, -0.12]);
    n.add(ico(0.055, 1), 0xfbf3e1, [0.22, 0.085, -0.12], undefined, [1, 1.3, 1], { glow: 1.12 });
    part(nest, n);
    root.add(nest);
  }
  nest.visible = false;
  let hunger = 0;
  let look = 0;
  let lookTarget = 0;
  let nextLook = 0;
  const T = young ? 1.7 : 2.6;
  return {
    root,
    animate(dt, s) {
      hunger = toward(hunger, s.hungry ? 1 : 0, dt, 4);
      const t = s.time + off;
      const p = t % T;
      // Two quick pecks per cycle, then a look around with little jerks of the head.
      const peck = (inside(p, 0.35, 0.45, 0.08) + inside(p, 0.7, 0.8, 0.08)) * (1 - hunger);
      if (t >= nextLook) {
        lookTarget = (Math.sin(t * 12.9898) * 43758.5453) % 1;
        nextLook = t + 0.35 + Math.abs(lookTarget) * 0.6;
      }
      look = toward(look, lookTarget * (0.8 + hunger * 0.5), dt, 18);
      body.rotation.x = peck * (young ? 0.6 : 0.55) - hunger * 0.12;
      head.rotation.x = peck * 0.8 - hunger * 0.35;
      head.rotation.y = look * (1 - peck);
      head.position.z = (young ? 0.04 : 0.12) + Math.sin(t * 9) * 0.006 * (1 - peck) * (1 - hunger);
      head.position.y = (young ? 0.1 : 0.18) + hunger * 0.02;
      root.position.y = young ? Math.max(0, Math.sin(t * 5.3)) ** 8 * 0.03 * (1 - hunger) : 0;
      nest.visible = s.ready;
    },
  };
}

// ---------- sheep ----------

function sheep(young: boolean): AnimalModel {
  const root = new THREE.Group();
  root.name = `animal:sheep:${young ? 'young' : 'adult'}`;
  const off = (born++ * 2.39) % 13;
  const wool = 0xf4efe3;
  const woolShade = 0xe6dfcf;
  const face = young ? 0x5a4c44 : 0x3a3330;
  const k = young ? 0.55 : 1;
  const legTop = young ? 0.27 : 0.43;
  const L = 0.95 * k;
  const W = 0.62 * k;
  const H = 0.48 * k;
  const legs = new Parts();
  for (const sx of [-1, 1])
    for (const z of [L * 0.32, -L * 0.32]) {
      legs.add(box(0.075 * Math.max(k, 0.8), legTop + 0.04, 0.08 * Math.max(k, 0.8)), face, [sx * W * 0.28, (legTop + 0.04) / 2, z]);
      legs.add(box(0.085 * Math.max(k, 0.8), 0.05, 0.095 * Math.max(k, 0.8)), 0x2a2420, [sx * W * 0.28, 0.025, z + 0.01]);
    }
  part(root, legs);
  const body = pivot(root, 0, legTop, 0, 'body');
  // Fleece: a soft block with lumpy puffs over it; the heavy fleece is a second layer shown when ready.
  const fleece = new Parts();
  soft(fleece, W, H, L, wool, [0, H / 2 + 0.01, -0.02], undefined, 0.16 * k);
  const puffs: Array<[number, number, number, number]> = [
    [0, H * 0.82, L * 0.18, 0.2],
    [0.1, H * 0.85, -L * 0.15, 0.19],
    [-0.12, H * 0.8, -L * 0.02, 0.18],
    [W * 0.45, H * 0.52, L * 0.15, 0.17],
    [-W * 0.45, H * 0.55, -L * 0.12, 0.17],
    [W * 0.42, H * 0.5, -L * 0.3, 0.16],
    [-W * 0.42, H * 0.45, L * 0.25, 0.16],
    [0, H * 0.55, -L * 0.48, 0.17],
    [0, H * 0.58, L * 0.46, 0.17],
  ];
  puffs.forEach(([x, y, z, r], i) => puff(fleece, r * k, [x, y, z], i % 2 ? wool : woolShade, i + 1));
  const fleeceMesh = part(body, fleece, 'fleece');
  const extra = new Parts();
  const thick: Array<[number, number, number, number]> = [
    [0.15, H * 0.95, 0.05, 0.22],
    [-0.15, H * 0.95, -0.2, 0.22],
    [W * 0.5, H * 0.65, -0.05, 0.2],
    [-W * 0.5, H * 0.65, 0.12, 0.2],
    [0, H * 0.75, -L * 0.42, 0.2],
    [0.05, H * 1.0, L * 0.3, 0.18],
  ];
  thick.forEach(([x, y, z, r], i) => puff(extra, r * k, [x, y, z], 0xfaf6ea, i + 11, 0.8));
  const extraMesh = part(body, extra, 'fleece-ready');
  extraMesh.visible = false;
  const tail = pivot(body, 0, H * 0.7, -L * 0.52, 'tail');
  const tp = new Parts();
  puff(tp, 0.09 * k, [0, -0.04 * k, -0.03], wool, 21);
  part(tail, tp);
  // Head: a dark face with a woolly cap, droopy ears and pale eyes.
  const head = pivot(body, 0, H * 0.78, L * 0.5, 'head');
  const hp = new Parts();
  const hs = young ? 0.75 : 1;
  soft(hp, 0.2 * hs, 0.24 * hs, 0.3 * hs, face, [0, -0.02 * hs, 0.12 * hs], undefined, 0.07 * hs);
  soft(hp, 0.17 * hs, 0.15 * hs, 0.1 * hs, mixFace(face), [0, -0.07 * hs, 0.26 * hs], undefined, 0.04 * hs);
  puff(hp, 0.12 * hs, [0, 0.1 * hs, 0.05 * hs], wool, 31, 0.75);
  for (const sx of [-1, 1]) hp.add(box(0.15 * hs, 0.045 * hs, 0.075 * hs), face, [sx * 0.15 * hs, 0.03 * hs, 0.05 * hs], [0, 0, sx * -0.45]);
  eyes(hp, 0.101 * hs, 0.03 * hs, 0.16 * hs, 0.03 * hs, true);
  part(head, hp);
  let hunger = 0;
  let fluff = 0;
  const T = young ? 6.5 : 9;
  const headY = head.position.y;
  const headZ = head.position.z;
  return {
    root,
    animate(dt, s) {
      hunger = toward(hunger, s.hungry ? 1 : 0, dt, 3);
      fluff = toward(fluff, s.ready && !young ? 1 : 0, dt, 3);
      const t = s.time + off;
      const p = t % T;
      // Graze most of the cycle, lift the head and look about, then back down.
      const up = Math.max(inside(p, T * 0.62, T * 0.92, 0.7), hunger);
      const down = 1 - up;
      const chew = Math.sin(t * 9) * 0.05 * down;
      head.rotation.x = lerp(-0.12, 1.05, down) + chew - hunger * 0.2 + Math.sin(t * 3.1) * 0.04 * hunger;
      head.rotation.y = Math.sin(t * 0.9) * 0.45 * up * (1 - hunger * 0.6);
      head.position.y = headY - 0.24 * k * down;
      head.position.z = headZ + 0.06 * k * down;
      body.rotation.x = 0.05 * down;
      tail.rotation.z = Math.sin(t * 8) * 0.35 * Math.max(0, Math.sin(t * 0.7)) ** 6;
      body.scale.y = 1 + 0.012 * Math.sin(t * 1.8);
      fleeceMesh.scale.setScalar(1 + 0.12 * fluff);
      extraMesh.visible = fluff > 0.02;
      extraMesh.scale.setScalar(0.4 + 0.6 * fluff);
      // A lamb skips now and then.
      root.position.y = young ? Math.max(0, Math.sin(t * 1.1)) ** 30 * 0.12 * (1 - hunger) : 0;
    },
  };
}

function mixFace(c: Rgb): Rgb {
  return new THREE.Color(c).lerp(new THREE.Color(0x8a7a70), 0.35);
}

// ---------- cows ----------

function cow(young: boolean): AnimalModel {
  const root = new THREE.Group();
  root.name = `animal:cow:${young ? 'young' : 'adult'}`;
  const off = (born++ * 2.39) % 13;
  const white = 0xf6f3ec;
  const black = 0x2c2a2b;
  const pink = 0xf0b2a4;
  const k = young ? 0.58 : 1;
  const legTop = young ? 0.42 : 0.65;
  const L = 1.25 * k;
  const W = 0.7 * k;
  const H = 0.68 * k;
  const legs = new Parts();
  const lw = 0.15 * Math.max(k, 0.75);
  for (const sx of [-1, 1])
    for (const z of [L * 0.38, -L * 0.42]) {
      legs.add(box(lw, legTop + 0.06, lw), white, [sx * W * 0.32, (legTop + 0.06) / 2, z]);
      legs.add(box(lw + 0.02, 0.07, lw + 0.03), 0x3a3530, [sx * W * 0.32, 0.035, z + 0.01]);
    }
  part(root, legs);
  const body = pivot(root, 0, legTop, 0, 'body');
  const b = new Parts();
  soft(b, W, H, L, white, [0, H / 2, -0.03], undefined, 0.16 * k);
  soft(b, W * 0.95, H * 0.95, 0.4 * k, white, [0, H * 0.53, L * 0.4], undefined, 0.15 * k);
  soft(b, W * 1.02, H * 0.97, 0.4 * k, white, [0, H * 0.52, -L * 0.45], undefined, 0.15 * k);
  // Holstein patches: slabs that break through the hide on both flanks and the back.
  b.add(box(W + 0.026, H * 0.55, 0.45 * k), black, [0, H * 0.58, L * 0.08]);
  b.add(box(W + 0.03, H * 0.45, 0.32 * k), black, [0, H * 0.4, -L * 0.36]);
  b.add(box(W * 0.55, 0.03, 0.4 * k), black, [W * 0.1, H + 0.004, -L * 0.12]);
  b.add(box(0.03, H * 0.35, 0.28 * k), black, [W / 2 + 0.006, H * 0.62, L * 0.38]);
  if (!young) {
    soft(b, 0.26, 0.13, 0.28, pink, [0, -0.03, -L * 0.28], undefined, 0.05);
    for (const sx of [-1, 1]) for (const z of [-0.07, 0.07]) b.add(box(0.03, 0.06, 0.03), pink, [sx * 0.06, -0.11, -L * 0.28 + z]);
  }
  part(body, b);
  // Tail: a thin rope with a dark tuft, swishing.
  const tail = pivot(body, 0, H * 0.92, -L * 0.62, 'tail');
  const tp = new Parts();
  tp.add(box(0.045 * Math.max(k, 0.7), 0.55 * k, 0.045 * Math.max(k, 0.7)), white, [0, -0.27 * k, -0.02]);
  tp.add(jiggle(ico(0.065 * Math.max(k, 0.7), 0), 0.01, 3), black, [0, -0.57 * k, -0.02], undefined, [1, 1.5, 1]);
  part(tail, tp);
  // Head with a pink muzzle, horns (nubs on a calf), ears, a collar and a bell.
  const head = pivot(body, 0, H * 0.82, L * 0.56, 'head');
  const hp = new Parts();
  const hs = young ? 0.72 : 1;
  soft(hp, 0.34 * hs, 0.38 * hs, 0.44 * hs, white, [0, 0, 0.16 * hs], undefined, 0.09 * hs);
  hp.add(box(0.15 * hs, 0.2 * hs, 0.2 * hs), black, [0.11 * hs, 0.08 * hs, 0.1 * hs]);
  soft(hp, 0.33 * hs, 0.19 * hs, 0.17 * hs, pink, [0, -0.1 * hs, 0.39 * hs], undefined, 0.06 * hs);
  for (const sx of [-1, 1]) {
    hp.add(box(0.04 * hs, 0.05 * hs, 0.02), 0x8a4a40, [sx * 0.07 * hs, -0.08 * hs, 0.48 * hs]);
    hp.add(box(0.2 * hs, 0.05 * hs, 0.11 * hs), sx > 0 ? black : white, [sx * 0.24 * hs, 0.1 * hs, 0.06 * hs], [0, 0, sx * -0.35]);
    hp.add(cone(0.035 * hs, (young ? 0.05 : 0.17) * hs, 5), 0xf1e6c8, [sx * 0.12 * hs, 0.24 * hs, 0.04 * hs], [0, 0, sx * -0.55]);
  }
  eyes(hp, 0.172 * hs, 0.07 * hs, 0.2 * hs, 0.045 * hs);
  hp.add(box(0.38 * hs, 0.07 * hs, 0.1 * hs), young ? 0x3a6ea5 : 0xb8352c, [0, -0.2 * hs, -0.06 * hs]);
  hp.add(cyl(0.05 * hs, 0.07 * hs, 0.09 * hs, 6), PAL.brass, [0, -0.29 * hs, -0.02 * hs]);
  part(head, hp);
  // Ready: a full pail of milk beside her.
  const pail = new THREE.Group();
  if (!young) {
    const pp = new Parts();
    pp.add(cyl(0.17, 0.14, 0.3, 10), PAL.steel, [0, 0.15, 0]);
    pp.add(cyl(0.155, 0.155, 0.02, 10), 0xfffdf6, [0, 0.29, 0], undefined, undefined, { glow: 1.08 });
    pp.add(tor(0.17, 0.015, 3, 10, Math.PI), PAL.ironLight, [0, 0.3, 0], [0, Math.PI / 2, 0]);
    for (const y of [0.06, 0.24]) pp.add(cyl(0.16, 0.16, 0.025, 10), PAL.ironLight, [0, y, 0], undefined, [1.02, 1, 1.02]);
    part(pail, pp);
    pail.position.set(W / 2 + 0.38, 0, -0.25);
    root.add(pail);
  }
  pail.visible = false;
  let hunger = 0;
  const T = young ? 8 : 11;
  const headY = head.position.y;
  const headZ = head.position.z;
  return {
    root,
    animate(dt, s) {
      hunger = toward(hunger, s.hungry ? 1 : 0, dt, 2.5);
      const t = s.time + off;
      const p = t % T;
      const up = Math.max(inside(p, T * 0.6, T * 0.9, 0.9), hunger);
      const down = 1 - up;
      const chew = Math.sin(t * 6) * 0.04 * down;
      head.rotation.x = lerp(-0.08, 0.95, down) + chew - hunger * 0.25;
      head.rotation.y = Math.sin(t * 0.6) * 0.35 * up;
      head.position.y = headY - 0.42 * k * down;
      head.position.z = headZ + 0.1 * k * down;
      // Tail swishes at flies, now and then with a flick.
      const flick = Math.max(0, Math.sin(t * 0.9)) ** 8;
      tail.rotation.z = Math.sin(t * (1.6 + flick * 5)) * (0.25 + flick * 0.4);
      tail.rotation.x = 0.12 + flick * 0.2;
      body.scale.y = 1 + 0.01 * Math.sin(t * 1.3);
      root.position.y = young ? Math.max(0, Math.sin(t * 0.9)) ** 30 * 0.1 * (1 - hunger) : 0;
      pail.visible = s.ready;
    },
  };
}

/** Builds a farm animal: stage 0 is young (chick, lamb, calf), 1 is adult. */
export function buildAnimal(id: string, stage: number): AnimalModel {
  const young = stage < 1;
  switch (id) {
    case 'chicken':
      return chicken(young);
    case 'sheep':
      return sheep(young);
    case 'cow':
      return cow(young);
    default:
      return sheep(young);
  }
}
