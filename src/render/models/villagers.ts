import * as THREE from 'three';
import { PAL, Parts, bev, box, cone, cyl, extrude, glowMaterial, ico, mesh, mix, octa, pivot, rod, sph, tor, type Rgb, type V3 } from './kit';
import { clamp } from '../../util/math';
import type { Hair, VillagerLook } from '../../content/looks';
import { madeBody, madeBodyNow, type WornBody } from '../detail/madeBody';
import { wearTownsperson, type MadeTownsperson } from '../detail/madeTownsfolk';

// The townsfolk of Emberholm, built like the hero (src/render/creatures/heroBody.ts): chunky
// rounded blocks, a big head, ~1.7-1.9 m tall, facing +Z with the origin at the feet. Each is
// five merged meshes on pivots - legs, torso, head and two arms - so animate() can breathe, look
// around and gesture (more when `talking`) for about ten draw calls. Each is built and dressed
// by their look (src/content/looks.ts VillagerLook: colours, build and hair, and an outfit by name,
// hats and a prop in hand that say their job at a glance); one with no look gets a plain villager
// dressed from their id. One whose look names a made body (`model`) wears it once it has loaded,
// on the hero's rig (src/render/detail/madeTownsfolk.ts), the box one standing in until then.

export interface VillagerAnim {
  /** Seconds. */
  time: number;
  talking: boolean;
}

export interface VillagerModel {
  root: THREE.Group;
  animate(dt: number, s: VillagerAnim): void;
}

const ease = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const inside = (p: number, a: number, b: number, e: number) => ease(a - e, a, p) * (1 - ease(b, b + e, p));

interface Look {
  skin: Rgb;
  /** Build: shoulder width, depth, torso height, arm thickness, leg length (1 = the hero). */
  w?: number;
  d?: number;
  h?: number;
  arm?: number;
  leg?: number;
  /** Forward stoop of the upper body (radians). */
  hunch?: number;
  shirt: Rgb;
  sleeve?: Rgb;
  rolled?: boolean;
  gloves?: Rgb;
  pants: Rgb;
  boots: Rgb;
  tallBoots?: boolean;
  /** A robe or dress down to the ankles, in place of trousers. */
  skirt?: Rgb;
  trim?: Rgb;
  /** Long coat tails behind the legs. */
  tails?: Rgb;
  belt?: Rgb | null;
  hair: Rgb;
  style: Hair;
  beard?: { c: Rgb; kind: 'bushy' | 'long' | 'stubble' | 'moustache' };
  blush?: boolean;
  /** Arm rest poses (Euler XYZ, radians) and which arms are free to gesture. */
  rest?: { l?: V3; r?: V3 };
  free?: Array<'l' | 'r'>;
}

interface Kit {
  look: Look;
  legs: Parts;
  torso: Parts;
  head: Parts;
  armL: Parts;
  armR: Parts;
  glow: Parts;
  /** Torso width/depth/height factors and the shoulder's height above the ground. */
  w: number;
  d: number;
  h: number;
  shoulderY: number;
  /**
   * A prop in hand: built in the shoulder's upright frame round the resting hand, then hung on the
   * arm. A made body holds it too, built round its own hand, unless `on` is 'built' (a made body
   * that wears its own: the captain's spyglass, the woodcutter's axe); 'made' is a made body's only.
   */
  held(side: 'l' | 'r', build: HeldProp['build'], on?: 'both' | 'built' | 'made'): void;
}

/** A prop in a townsperson's hand: built round the hand where it rests, upright, the ground `ground` below. */
interface HeldProp {
  side: 'l' | 'r';
  build: (p: Parts, hand: THREE.Vector3, ground: number) => void;
}

/** What each built townsperson holds that a made body of theirs holds too. */
const CARRIED = new WeakMap<VillagerModel, HeldProp[]>();

type Extra = (k: Kit, root: THREE.Group, body: THREE.Group) => ((t: number, talk: number) => void) | void;

function soft(p: Parts, w: number, h: number, d: number, c: Rgb, at: V3, r?: V3, round = 0.06): void {
  p.add(bev(w, h, d, Math.min(round, w / 2, h / 2, d / 2), 1), c, at, r, undefined, { smooth: true });
}

let born = 0;
/** The next townsfolk built start their idle as the first one did (the animation library compares frames across builds). */
export const restartIdles = (): void => {
  born = 0;
};

function villager(id: string, look: Look, extra?: Extra): VillagerModel {
  const root = new THREE.Group();
  root.name = `villager:${id}`;
  const off = (born++ * 3.77) % 23;
  const w = look.w ?? 1;
  const d = look.d ?? 1;
  const h = look.h ?? 1;
  const aw = look.arm ?? 1;
  const hips = 0.64 * (look.leg ?? 1);
  const shoulderY = hips + 0.46 * h;
  const restL = new THREE.Euler(...(look.rest?.l ?? [0, 0, 0.08]));
  const restR = new THREE.Euler(...(look.rest?.r ?? [0, 0, -0.08]));
  const carried: HeldProp[] = [];
  const k: Kit = {
    look,
    legs: new Parts(),
    torso: new Parts(),
    head: new Parts(),
    armL: new Parts(),
    armR: new Parts(),
    glow: new Parts(),
    w,
    d,
    h,
    shoulderY,
    held(side, build, on = 'both') {
      if (on !== 'built') carried.push({ side, build });
      if (on === 'made') return;
      // The arm hangs from a body that may stoop, so undo both turns to build the prop upright.
      const rest = side === 'l' ? restL : restR;
      const total = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(look.hunch ?? 0, 0, 0)).multiply(new THREE.Matrix4().makeRotationFromEuler(rest));
      const p = new Parts();
      build(p, new THREE.Vector3(0, -0.45, 0).applyMatrix4(total), -(hips + 0.46 * h * Math.cos(look.hunch ?? 0)));
      const inv = total.clone().invert();
      for (const g of p.list) (side === 'l' ? k.armL : k.armR).list.push(g.applyMatrix4(inv));
    },
  };
  const { legs, torso, head, armL, armR } = k;

  // Legs and feet, or a robe to the ankles.
  if (look.skirt !== undefined) {
    legs.add(cyl(0.25 * w, 0.34 * w, hips + 0.1, 10), look.skirt, [0, (hips + 0.1) / 2 + 0.05, 0], undefined, [1, 1, 0.8]);
    if (look.trim !== undefined) legs.add(cyl(0.345 * w, 0.35 * w, 0.06, 10), look.trim, [0, 0.09, 0], undefined, [1, 1, 0.8]);
    for (const sx of [-1, 1]) legs.add(box(0.17, 0.1, 0.24), look.boots, [sx * 0.1, 0.05, 0.08]);
  } else {
    for (const sx of [-1, 1]) {
      soft(legs, 0.15 * Math.max(1, w * 0.9), hips - 0.08, 0.17 * Math.max(1, d * 0.9), look.pants, [sx * 0.12 * w, (hips + 0.12) / 2, 0], undefined, 0.05);
      const bh = look.tallBoots ? hips * 0.62 : 0.13;
      legs.add(box(0.19 * Math.max(1, w * 0.9), bh, look.tallBoots ? 0.22 : 0.27), look.boots, [sx * 0.12 * w, bh / 2, look.tallBoots ? 0.01 : 0.04]);
      if (look.tallBoots) legs.add(box(0.19, 0.12, 0.27), look.boots, [sx * 0.12 * w, 0.06, 0.04]);
    }
  }

  // Torso (in the body pivot at the hips).
  const body = pivot(root, 0, hips, 0, 'body');
  if (look.skirt === undefined) torso.add(box(0.4 * w, 0.16, 0.26 * d), look.pants, [0, 0, 0]);
  soft(torso, 0.46 * w, 0.44 * h, 0.3 * d, look.shirt, [0, 0.29 * h, 0], undefined, 0.08);
  if (look.belt !== null) torso.add(box(0.48 * w, 0.07, 0.32 * d), look.belt ?? PAL.leather, [0, 0.1, 0]);
  if (look.tails !== undefined) {
    torso.add(box(0.46 * w, 0.52, 0.05), look.tails, [0, -0.2, -0.14 * d], [-0.06, 0, 0]);
    for (const sx of [-1, 1]) torso.add(box(0.05, 0.52, 0.24 * d), look.tails, [sx * 0.235 * w, -0.2, -0.02]);
  }

  // Arms: sleeves (rolled up to the elbow for workers), hands or gloves.
  for (const arm of [armL, armR]) {
    const sleeve = look.sleeve ?? look.shirt;
    if (look.rolled) {
      soft(arm, 0.15 * aw, 0.24, 0.16 * aw, sleeve, [0, -0.11, 0], undefined, 0.05);
      arm.add(box(0.165 * aw, 0.06, 0.175 * aw), mix(sleeve, PAL.white, 0.25), [0, -0.23, 0]);
      soft(arm, 0.12 * aw, 0.22, 0.13 * aw, look.skin, [0, -0.33, 0], undefined, 0.05);
    } else soft(arm, 0.14 * aw, 0.42, 0.15 * aw, sleeve, [0, -0.21, 0], undefined, 0.05);
    arm.add(sph(0.075 * Math.max(1, aw * 0.9), 6, 4), look.gloves ?? look.skin, [0, -0.45, 0], undefined, undefined, { smooth: true });
  }

  // Head: face, eyes, hair, beard.
  const hp = head;
  soft(hp, 0.5, 0.46, 0.46, look.skin, [0, 0.23, 0], undefined, 0.12);
  for (const sx of [-1, 1]) hp.add(box(0.07, 0.11, 0.02), PAL.dark, [sx * 0.11, 0.23, 0.235]);
  if (look.blush) for (const sx of [-1, 1]) hp.add(box(0.08, 0.04, 0.012), 0xf09a8a, [sx * 0.16, 0.14, 0.232]);
  hair(hp, look);
  if (look.beard) beard(hp, look.beard.c, look.beard.kind);

  const anim = extra?.(k, root, body);
  mesh(root, legs.build(), { name: 'legs' });
  mesh(body, torso.build(), { name: 'torso' });
  const headPivot = pivot(body, 0, 0.53 * h, 0, 'head');
  mesh(headPivot, head.build(), { name: 'head' });
  if (!k.glow.empty) mesh(headPivot, k.glow.build(), { mat: glowMaterial(), shadow: false, name: 'glow' });
  const left = pivot(body, 0.31 * w, 0.46 * h, 0, 'armL');
  const right = pivot(body, -0.31 * w, 0.46 * h, 0, 'armR');
  left.rotation.copy(restL);
  right.rotation.copy(restR);
  mesh(left, armL.build(), { name: 'armL' });
  mesh(right, armR.build(), { name: 'armR' });

  const free = new Set(look.free ?? ['l', 'r']);
  const hunch = look.hunch ?? 0;
  let talk = 0;
  const model: VillagerModel = {
    root,
    animate(dt, s) {
      const t = s.time + off;
      talk += ((s.talking ? 1 : 0) - talk) * Math.min(1, dt * 3);
      body.scale.y = 1 + 0.012 * Math.sin(t * 1.7);
      body.rotation.x = hunch + talk * 0.03 * Math.sin(t * 1.3);
      body.rotation.z = Math.sin(t * 0.45) * 0.012 + talk * Math.sin(t * 1.9) * 0.025;
      headPivot.rotation.y = (Math.sin(t * 0.31) * 0.42 + Math.sin(t * 0.73) * 0.14) * (1 - talk * 0.75);
      headPivot.rotation.x = -hunch * 0.6 + Math.sin(t * 0.9) * 0.025 + talk * (0.07 * Math.sin(t * 6.3) - 0.04);
      headPivot.rotation.z = Math.sin(t * 0.53) * 0.04 * (1 - talk) + talk * 0.05 * Math.sin(t * 1.1);
      const idle = inside(t % 9, 6.2, 7.4, 0.5);
      for (const [arm, rest, side, phase] of [
        [left, restL, 1, 0],
        [right, restR, -1, 2.1],
      ] as const) {
        if (!free.has(side > 0 ? 'l' : 'r')) {
          arm.rotation.set(rest.x + Math.sin(t * 1.7) * 0.015, rest.y, rest.z);
          continue;
        }
        const lift = idle * (side > 0 ? 0.3 : 0.4) + talk * (0.5 + 0.35 * Math.sin(t * 2.3 + phase));
        arm.rotation.set(rest.x - lift, rest.y, rest.z + side * (0.08 * idle + talk * (0.18 + 0.14 * Math.sin(t * 1.7 + phase))));
      }
      anim?.(t, talk);
    },
  };
  CARRIED.set(model, carried);
  return model;
}

function hair(p: Parts, look: Look): void {
  const c = look.hair;
  if (look.style === 'none') return;
  if (look.style === 'bald') {
    for (const sx of [-1, 1]) soft(p, 0.08, 0.2, 0.32, c, [sx * 0.255, 0.28, -0.05], undefined, 0.03);
    soft(p, 0.5, 0.18, 0.08, c, [0, 0.26, -0.22], undefined, 0.03);
    for (const sx of [-1, 1]) p.add(box(0.12, 0.04, 0.03), c, [sx * 0.11, 0.33, 0.235]);
    return;
  }
  soft(p, 0.55, 0.17, 0.5, c, [0, 0.43, -0.01], undefined, 0.07);
  if (look.style === 'long') {
    p.add(box(0.55, 0.58, 0.15), c, [0, 0.17, -0.19]);
    for (const sx of [-1, 1]) p.add(box(0.07, 0.42, 0.28), c, [sx * 0.265, 0.2, -0.05]);
    return;
  }
  p.add(box(0.55, 0.36, 0.15), c, [0, 0.28, -0.19]);
  if (look.style === 'braid') {
    for (let i = 0; i < 4; i++) p.add(box(0.12 - i * 0.012, 0.13, 0.12 - i * 0.01), c, [0, 0.12 - i * 0.12, -0.27 - i * 0.015], [0.1, 0, i % 2 ? 0.2 : -0.2]);
    p.add(box(0.08, 0.04, 0.08), PAL.green, [0, -0.33, -0.31]);
  } else if (look.style === 'ponytail') {
    soft(p, 0.13, 0.36, 0.12, c, [0, 0.12, -0.31], [0.25, 0, 0], 0.05);
    p.add(box(0.15, 0.05, 0.14), PAL.red, [0, 0.27, -0.28]);
  } else if (look.style === 'bun') {
    soft(p, 0.2, 0.18, 0.18, c, [0, 0.45, -0.26], undefined, 0.07);
  }
}

function beard(p: Parts, c: Rgb, kind: 'bushy' | 'long' | 'stubble' | 'moustache'): void {
  if (kind === 'long') {
    soft(p, 0.4, 0.52, 0.16, c, [0, 0.0, 0.18], [0.15, 0, 0], 0.07);
    p.add(box(0.32, 0.07, 0.06), c, [0, 0.15, 0.245]);
  } else if (kind === 'bushy') {
    soft(p, 0.52, 0.3, 0.22, c, [0, 0.07, 0.15], undefined, 0.09);
    p.add(box(0.3, 0.07, 0.05), c, [0, 0.16, 0.25]);
  } else if (kind === 'stubble') {
    p.add(box(0.44, 0.16, 0.03), c, [0, 0.08, 0.228]);
  } else {
    p.add(box(0.26, 0.05, 0.05), c, [0, 0.14, 0.245]);
    for (const sx of [-1, 1]) p.add(box(0.05, 0.08, 0.05), c, [sx * 0.13, 0.11, 0.245]);
  }
}

// ---------- outfits ----------

/** A gold-trimmed collar and a gnarled staff with a green shoot: the village elder's. */
const elder: Extra = (k) => {
  k.torso.add(box(0.5, 0.08, 0.34), PAL.gold, [0, 0.49, 0]);
  k.torso.add(box(0.06, 0.4, 0.02), PAL.gold, [0, 0.28, 0.157]);
  k.held('r', (p, hand, ground) => {
    p.add(rod([hand.x, ground, hand.z], [hand.x + 0.02, hand.y + 0.75, hand.z], 0.035, 6, 0.03), PAL.woodDark);
    p.add(ico(0.07, 0), PAL.woodDark, [hand.x + 0.02, hand.y + 0.8, hand.z], undefined, [1, 1.2, 1]);
    p.add(octa(0.045), PAL.leaf, [hand.x + 0.07, hand.y + 0.85, hand.z], undefined, [0.6, 1.2, 0.3]);
  });
};

/** A white apron, a red headscarf and a basket of produce on the arm: the grocer's. */
const grocer: Extra = (k) => {
  k.torso.add(box(0.34, 0.34, 0.03), PAL.cream, [0, 0.24, 0.158]);
  k.legs.add(box(0.44, 0.52, 0.03), PAL.cream, [0, 0.42, 0.245], [-0.12, 0, 0]);
  k.legs.add(box(0.2, 0.12, 0.035), 0xe8dcbc, [0.07, 0.48, 0.255], [-0.12, 0, 0]);
  k.torso.add(box(0.48, 0.05, 0.33), PAL.cream, [0, 0.1, 0]);
  soft(k.head, 0.57, 0.24, 0.53, PAL.red, [0, 0.43, -0.02], undefined, 0.09);
  for (const sx of [-1, 1]) k.head.add(box(0.09, 0.12, 0.05), PAL.red, [sx * 0.05, 0.28, -0.28], [0, 0, sx * 0.4]);
  for (const [x, z] of [
    [-0.15, 0.1],
    [0.12, 0.15],
    [0.0, -0.12],
    [0.18, -0.08],
  ] as const)
    k.head.add(box(0.04, 0.04, 0.012), PAL.white, [x, 0.5, z + 0.12], [-1.2, 0, 0]);
  k.held('l', (p, hand) => {
    const b = hand.clone().add(new THREE.Vector3(0.05, -0.2, 0.06));
    p.add(cyl(0.17, 0.13, 0.15, 8), 0xb98a55, [b.x, b.y, b.z]);
    p.add(tor(0.15, 0.015, 3, 8, Math.PI), 0x9a6a3c, [b.x, b.y + 0.07, b.z], [0, Math.PI / 2, 0]);
    const fruit: Array<[number, number, Rgb]> = [
      [-0.06, 0.03, PAL.red],
      [0.06, 0.04, 0xd9a441],
      [0.0, -0.06, 0x6fbf4a],
      [0.07, -0.05, PAL.red],
    ];
    for (const [x, z, c] of fruit) p.add(ico(0.06, 0), c, [b.x + x, b.y + 0.09, b.z + z]);
  });
};

/** A leather apron, a pack strap over one shoulder and the crate it holds on the back: the packwright's. */
const packer: Extra = (k) => {
  k.torso.add(box(0.38, 0.62, 0.03), 0x7a4a2a, [0, 0.12, 0.16]);
  for (const sx of [-1, 1]) k.torso.add(box(0.03, 0.2, 0.03), 0x5a341d, [sx * 0.14, 0.42, 0.16]);
  k.torso.add(box(0.08, 0.04, 0.035), PAL.brass, [0.1, 0.0, 0.18]);
  k.torso.add(box(0.06, 0.62, 0.035), PAL.leatherDark, [0.02, 0.28, 0.165], [0, 0, 0.62]);
  k.torso.add(box(0.06, 0.5, 0.035), PAL.leatherDark, [0.08, 0.3, -0.165], [0, 0, -0.5]);
  k.torso.add(box(0.3, 0.36, 0.2), PAL.crate, [-0.06, 0.36, -0.27], [0.1, 0, -0.12]);
  k.torso.add(box(0.32, 0.05, 0.22), PAL.woodDark, [-0.07, 0.5, -0.27], [0.1, 0, -0.12]);
};

/** A brown work apron and a hammer at the belt: the wainwright's. */
const wainwright: Extra = (k) => {
  k.torso.add(box(0.5, 0.68, 0.03), 0x7d5a3a, [0, 0.12, 0.21]);
  for (const sx of [-1, 1]) k.torso.add(box(0.035, 0.2, 0.03), 0x5a3a24, [sx * 0.18, 0.44, 0.205]);
  k.torso.add(box(0.05, 0.3, 0.05), PAL.woodLight, [-0.33, -0.05, 0.06]);
  k.torso.add(box(0.16, 0.08, 0.08), PAL.iron, [-0.33, -0.2, 0.06]);
};

/** Riding-jacket buttons and a coil of rope over the shoulder: the stablemaster's. */
const stablemaster: Extra = (k) => {
  for (let i = 0; i < 3; i++) k.torso.add(box(0.04, 0.04, 0.02), PAL.brass, [0, 0.42 - i * 0.12, 0.158]);
  k.torso.add(box(0.48, 0.06, 0.32), PAL.leatherDark, [0, 0.1, 0]);
  k.torso.add(tor(0.2, 0.045, 4, 12), PAL.rope, [0.18, 0.36, 0.0], [0, Math.PI / 2, 0.75]);
  k.torso.add(tor(0.17, 0.04, 4, 10), 0xc2a676, [0.2, 0.36, 0.0], [0, Math.PI / 2, 0.75]);
};

/** A long navy coat with gold buttons, a white cravat, a tricorn and a brass spyglass: a ship's captain's. */
const captain: Extra = (k) => {
  for (let i = 0; i < 4; i++) for (const sx of [-1, 1]) k.torso.add(box(0.035, 0.035, 0.02), PAL.gold, [sx * 0.1, 0.42 - i * 0.1, 0.158]);
  k.torso.add(box(0.12, 0.14, 0.03), PAL.white, [0, 0.43, 0.16]);
  for (const arm of [k.armL, k.armR]) arm.add(box(0.15, 0.06, 0.16), PAL.gold, [0, -0.37, 0]);
  const hat = new Parts();
  hat.add(
    extrude(
      [
        [0, -0.4],
        [0.4, 0.24],
        [-0.4, 0.24],
      ],
      0.07,
    ),
    0x1f2430,
    [0, 0.52, 0],
    [-Math.PI / 2, 0, 0],
  );
  hat.add(
    extrude(
      [
        [0, -0.43],
        [0.43, 0.26],
        [-0.43, 0.26],
      ],
      0.03,
    ),
    PAL.gold,
    [0, 0.5, 0],
    [-Math.PI / 2, 0, 0],
  );
  hat.add(cyl(0.2, 0.24, 0.16, 8), 0x1f2430, [0, 0.62, -0.02]);
  k.head.take(hat);
  k.held(
    'r',
    (p, hand) => {
      p.add(rod([hand.x, hand.y - 0.03, hand.z - 0.12], [hand.x, hand.y + 0.06, hand.z + 0.36], 0.035, 8, 0.05), PAL.brass);
      p.add(cyl(0.056, 0.056, 0.05, 8), 0x8a5a34, [hand.x, hand.y + 0.03, hand.z + 0.18], [Math.PI / 2 - 0.18, 0, 0]);
    },
    'built',
  );
};

/** A white collar, buttons, spectacles, a quill behind the ear and a ledger under the arm: the land clerk's. */
const clerk: Extra = (k) => {
  k.torso.add(box(0.14, 0.12, 0.03), PAL.white, [0, 0.46, 0.15]);
  for (let i = 0; i < 4; i++) k.torso.add(box(0.035, 0.035, 0.02), PAL.steel, [0, 0.36 - i * 0.1, 0.143]);
  k.torso.add(box(0.06, 0.32, 0.26), 0x8a2f2a, [0.26, 0.24, 0.02]);
  k.torso.add(box(0.065, 0.3, 0.02), PAL.cream, [0.262, 0.24, 0.15]);
  for (const sx of [-1, 1]) k.head.add(tor(0.055, 0.01, 3, 10), PAL.gold, [sx * 0.11, 0.23, 0.25]);
  k.head.add(box(0.06, 0.012, 0.012), PAL.gold, [0, 0.24, 0.25]);
  k.head.add(cone(0.025, 0.28, 4), PAL.white, [0.27, 0.42, -0.05], [0.4, 0, -0.3], [1, 1, 0.3]);
  // A made body has a satchel and no ledger under the arm: it carries one, as the trader does.
  k.held(
    'l',
    (p, hand) => {
      p.add(box(0.06, 0.3, 0.22), 0x8a2f2a, [hand.x + 0.02, hand.y + 0.05, hand.z + 0.03], [0.3, 0, 0]);
      p.add(box(0.065, 0.28, 0.02), PAL.cream, [hand.x + 0.02, hand.y + 0.05, hand.z + 0.14], [0.3, 0, 0]);
    },
    'made',
  );
};

/** A flight jacket with a fleece collar, goggles pushed up and a red scarf streaming out: the wingwright's. */
const wingwright: Extra = (k, _root, body) => {
  k.torso.add(box(0.5, 0.1, 0.34), 0xf1e6cc, [0, 0.46, 0]);
  k.torso.add(box(0.03, 0.4, 0.02), PAL.iron, [0.05, 0.26, 0.157]);
  k.torso.add(box(0.5, 0.09, 0.35), PAL.red, [0, 0.5, 0]);
  k.head.add(box(0.53, 0.07, 0.49), 0x3a2a20, [0, 0.39, 0]);
  for (const sx of [-1, 1]) {
    k.head.add(cyl(0.075, 0.075, 0.05, 8), PAL.brass, [sx * 0.11, 0.4, 0.25], [Math.PI / 2, 0, 0]);
    k.head.add(cyl(0.058, 0.058, 0.02, 8), 0x7fd3c8, [sx * 0.11, 0.4, 0.28], [Math.PI / 2, 0, 0]);
  }
  const scarf = pivot(body, 0.08, 0.5 * k.h, -0.16, 'scarf');
  mesh(
    scarf,
    new Parts()
      .add(box(0.12, 0.42, 0.04), PAL.red, [0, -0.2, -0.02])
      .add(box(0.13, 0.06, 0.05), 0xf2c84b, [0, -0.39, -0.02])
      .build(),
  );
  return (t, talk) => {
    scarf.rotation.x = 0.35 + Math.sin(t * 2.6) * 0.12 + talk * 0.1;
    scarf.rotation.z = Math.sin(t * 1.9) * 0.15;
  };
};

/** A maroon vest with brass buttons, a fat coin purse, a flat cap and a ledger in hand: a trader's. */
const trader: Extra = (k) => {
  const v = 0x8a2f3a;
  for (const sx of [-1, 1]) k.torso.add(box(0.19 * k.w, 0.4, 0.03), v, [sx * 0.135 * k.w, 0.29, 0.18]);
  k.torso.add(box(0.48 * k.w, 0.4, 0.03), v, [0, 0.29, -0.18]);
  for (let i = 0; i < 3; i++) k.torso.add(box(0.035, 0.035, 0.02), PAL.brass, [0.06, 0.4 - i * 0.1, 0.2]);
  k.torso.add(bev(0.16, 0.18, 0.1, 0.04), PAL.leather, [0.2, -0.04, 0.17]);
  k.torso.add(box(0.12, 0.03, 0.06), PAL.gold, [0.2, 0.06, 0.17]);
  soft(k.head, 0.54, 0.1, 0.52, 0x6b5a48, [0, 0.47, -0.02], undefined, 0.04);
  k.head.add(box(0.42, 0.03, 0.16), 0x5a4a3a, [0, 0.45, 0.27], [-0.15, 0, 0]);
  k.held('l', (p, hand) => {
    p.add(box(0.06, 0.3, 0.22), 0x2f5a3a, [hand.x + 0.02, hand.y + 0.05, hand.z + 0.03], [0.3, 0, 0]);
    p.add(box(0.065, 0.28, 0.02), PAL.cream, [hand.x + 0.02, hand.y + 0.05, hand.z + 0.14], [0.3, 0, 0]);
  });
};

/** A gold brocade waistcoat and watch chain, a cravat, a monocle, a top hat and a cane: an exchange's factor's. */
const factor: Extra = (k) => {
  for (const sx of [-1, 1]) k.torso.add(box(0.12, 0.34, 0.03), sx > 0 ? 0xd9a73a : 0xc9932a, [sx * 0.07, 0.26, 0.158]);
  for (let i = 0; i < 3; i++) k.torso.add(box(0.03, 0.03, 0.02), PAL.white, [0.0, 0.36 - i * 0.09, 0.176]);
  k.torso.add(beamish(0.06, 0.2, -0.1, 0.12), PAL.gold);
  k.torso.add(box(0.12, 0.12, 0.04), PAL.white, [0, 0.45, 0.16]);
  k.head.add(tor(0.055, 0.012, 3, 10), PAL.gold, [-0.11, 0.23, 0.25]);
  k.head.add(cyl(0.32, 0.32, 0.03, 10), 0x16141a, [0, 0.5, 0]);
  k.head.add(cyl(0.2, 0.21, 0.4, 10), 0x16141a, [0, 0.71, 0]);
  k.head.add(cyl(0.212, 0.212, 0.07, 10), 0x6a3a8a, [0, 0.56, 0]);
  k.held('r', (p, hand, ground) => {
    p.add(rod([hand.x, ground, hand.z + 0.06], [hand.x, hand.y + 0.04, hand.z], 0.02, 5), 0x16141a);
    p.add(sph(0.045, 6, 4), PAL.gold, [hand.x, hand.y + 0.07, hand.z]);
  });
};

/** Plaid, a green knit cap and an axe over the shoulder: the woodcutter's. */
const woodcutter: Extra = (k) => {
  for (const y of [0.15, 0.3, 0.45]) k.torso.add(box(0.47 * k.w, 0.035, 0.31), 0x2a1c1c, [0, y, 0]);
  for (const x of [-0.12, 0.12]) k.torso.add(box(0.035, 0.44, 0.31), 0x2a1c1c, [x * k.w, 0.29, 0]);
  for (const y of [-0.07, -0.16]) k.armL.add(box(0.155, 0.03, 0.165), 0x2a1c1c, [0, y, 0]);
  for (const y of [-0.07, -0.16]) k.armR.add(box(0.155, 0.03, 0.165), 0x2a1c1c, [0, y, 0]);
  soft(k.head, 0.55, 0.22, 0.51, 0x4f7a3a, [0, 0.44, -0.01], undefined, 0.08);
  k.head.add(box(0.57, 0.07, 0.53), 0x3f6a2e, [0, 0.36, -0.01]);
  k.head.add(ico(0.07, 0), 0x3f6a2e, [0, 0.58, -0.02]);
  k.held(
    'r',
    (p, hand) => {
      // The haft runs from the hand up over the shoulder; the head rides just above and behind it.
      const top = new THREE.Vector3(hand.x - 0.1, 0.36, -0.12);
      p.add(rod([hand.x, hand.y - 0.06, hand.z + 0.05], [top.x, top.y, top.z], 0.032, 6), PAL.woodLight);
      p.add(box(0.06, 0.1, 0.3), PAL.iron, [top.x, top.y - 0.02, top.z - 0.08], [0.35, 0, 0]);
      p.add(box(0.05, 0.22, 0.06), PAL.steel, [top.x, top.y - 0.05, top.z - 0.24], [0.35, 0, 0]);
    },
    'built',
  );
};

/** A leather vest, a brass miner's helmet with a little lamp and a pickaxe planted: the quarrymaster's. */
const quarrymaster: Extra = (k) => {
  for (const sx of [-1, 1]) k.torso.add(box(0.2 * k.w, 0.42, 0.03), PAL.leatherDark, [sx * 0.13 * k.w, 0.29, 0.18]);
  k.torso.add(box(0.48 * k.w, 0.42, 0.03), PAL.leatherDark, [0, 0.29, -0.18]);
  k.head.add(cyl(0.27, 0.3, 0.17, 10), 0xb8913f, [0, 0.52, -0.01]);
  k.head.add(cyl(0.34, 0.34, 0.03, 10), 0x9a7a35, [0, 0.45, -0.01]);
  k.head.add(box(0.1, 0.1, 0.06), PAL.iron, [0, 0.53, 0.3]);
  k.glow.add(box(0.07, 0.07, 0.02), PAL.glow, [0, 0.53, 0.335]);
  k.held(
    'r',
    (p, hand, ground) => {
      const foot = new THREE.Vector3(hand.x - 0.05, ground + 0.05, hand.z + 0.32);
      p.add(rod([hand.x, hand.y + 0.06, hand.z], [foot.x, foot.y + 0.14, foot.z], 0.03, 6), PAL.woodLight);
      p.add(beam3([foot.x, foot.y + 0.1, foot.z - 0.26], [foot.x, foot.y + 0.1, foot.z + 0.26]), PAL.ironLight);
      p.add(cone(0.035, 0.12, 4), PAL.ironLight, [foot.x, foot.y + 0.05, foot.z + 0.3], [Math.PI / 2 + 0.6, 0, 0]);
    },
    'built',
  );
};

/** A short slanted strip (the waistcoat's watch chain). */
function beamish(x: number, y: number, x2: number, y2: number): THREE.BufferGeometry {
  return rod([x, y, 0.177], [x2, y2, 0.177], 0.01, 3);
}

function beam3(a: V3, b: V3): THREE.BufferGeometry {
  return rod(a, b, 0.035, 4, 0.025);
}

const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];

/** A townsperson with no look: a plain villager, dressed from their id. */
const plain = (id: string) => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const pick = <T>(xs: T[], salt: number) => xs[(h >>> salt) % xs.length];
  return villager(id, {
    skin: pick(SKIN, 1),
    shirt: pick([0x3a6ea5, 0x8a4a2a, 0x4f8f4a, 0xb8913f, 0x7a4a7a, 0xc0503a], 3),
    pants: pick([0x2f3e46, 0x5a4030, 0x4a4a38], 5),
    boots: 0x3a2a20,
    hair: pick([0x2b1d14, 0x5b3a29, 0xa0522d, 0xe8c46a, 0x9aa0a8], 7),
    style: pick<Hair>(['short', 'long', 'ponytail', 'bun'], 9),
  });
};

/** What a townsperson wears over their clothes and holds, by name: a look's `outfit`. */
const OUTFITS: Record<string, Extra> = {
  elder,
  grocer,
  packer,
  wainwright,
  stablemaster,
  captain,
  clerk,
  wingwright,
  trader,
  factor,
  woodcutter,
  quarrymaster,
};

/** The outfits a look can name. */
export const outfits = (): string[] => Object.keys(OUTFITS);

const colour = (c: string): number => Number.parseInt(c.slice(1), 16);

/** A look as content gives it (colours as #rrggbb, a beard in the hair's colour), as the body is built from it. */
function bodyLook(l: VillagerLook): Look {
  const maybe = (c: string | undefined) => (c === undefined ? undefined : colour(c));
  return {
    skin: colour(l.skin),
    w: l.w,
    d: l.d,
    h: l.h,
    arm: l.arm,
    leg: l.leg,
    hunch: l.hunch,
    shirt: colour(l.shirt),
    sleeve: maybe(l.sleeve),
    rolled: l.rolled,
    gloves: maybe(l.gloves),
    pants: colour(l.pants),
    boots: colour(l.boots),
    tallBoots: l.tallBoots,
    skirt: maybe(l.skirt),
    trim: maybe(l.trim),
    tails: maybe(l.tails),
    belt: l.belt === null ? null : maybe(l.belt),
    hair: colour(l.hair),
    style: l.style,
    beard: l.beard && { c: colour(l.hair), kind: l.beard },
    blush: l.blush,
    rest: l.rest,
    free: l.free,
  };
}

/**
 * Builds a townsperson (`id` names the model) dressed by their look and its outfit, facing +Z with
 * the origin at their feet; with no look, a plain villager dressed from their id. `at`, where they
 * stand in the world, brings a made body's file in as you come near them.
 */
export function buildVillager(id: string, look?: VillagerLook, at?: { x: number; z: number }): VillagerModel {
  const built = look ? villager(id, bodyLook(look), look.outfit ? OUTFITS[look.outfit] : undefined) : plain(id);
  const made = madeOf(id, look);
  return made ? inMadeBody(id, built, made, look, at) : built;
}

// ---------- made bodies ----------

/** How tall a made body stands where its look doesn't say: the hero's height. */
const MADE_HEIGHT = 1.78;

/**
 * Trying a townsperson's made body without shipping it: ?npcModel=mara:/scratch/mara.glb (several
 * with commas), standing as tall as their look says, the hero if it doesn't, or &npcHeight=1.68.
 */
const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const TRIED = new Map(
  (params?.get('npcModel') ?? '')
    .split(',')
    .filter((s) => s.includes(':'))
    .map((s) => [s.slice(0, s.indexOf(':')), s.slice(s.indexOf(':') + 1)] as const),
);
const TRIED_HEIGHT = Number(params?.get('npcHeight')) || 0;
/** ?npcModel=none: everyone in their built body, to compare with the look before the made ones. */
const BUILT_ONLY = params?.get('npcModel') === 'none';

interface Made {
  /** A file in src/render/assets/models by name, or an address. */
  source: string;
  height: number;
  yaw: number;
}

/** The made body a townsperson wears, if any: one tried by address, or the first file their look names. */
function madeOf(id: string, look?: VillagerLook): Made | null {
  const tried = TRIED.get(id);
  const file = tried ?? look?.model?.files[0];
  if (!file || BUILT_ONLY) return null;
  return { source: file, height: (tried && TRIED_HEIGHT) || look?.model?.h || MADE_HEIGHT, yaw: look?.model?.yaw ?? 0 };
}

/** A townsperson's moment in their idle, the same each time they're built, so no two move as one. */
const offsetOf = (id: string): number => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 9973;
  return (h % 230) / 10;
};

/**
 * The built townsperson until their made body has come (and for good if it can't), then the made
 * one in its place, under the same root: what holds them (the land, the content library) is none
 * the wiser.
 */
function inMadeBody(id: string, built: VillagerModel, made: Made, look: VillagerLook | undefined, at?: { x: number; z: number }): VillagerModel {
  const off = offsetOf(id);
  const carried = CARRIED.get(built) ?? [];
  const holds = carried.map((c) => c.side);
  // An arm rests as the look says only to hold what it holds: one whose prop a made body wears
  // instead (the captain's spyglass, the woodcutter's axe) hangs.
  const rest = { l: holds.includes('l') ? look?.rest?.l : undefined, r: holds.includes('r') ? look?.rest?.r : undefined };
  const stance = { hunch: look?.hunch, free: look?.free, rest, holds };
  let worn: MadeTownsperson | null = null;
  const dress = (body: WornBody | null | undefined) => {
    if (!body || worn) return;
    worn = wearTownsperson(body, stance);
    for (const c of built.root.children) c.visible = false;
    built.root.add(worn.root);
    built.root.userData.face = worn.face;
    // Stood up out of the pose it was made in, though it may never come near enough to move.
    worn.animate(0, { time: off, talking: false });
    holdIn(worn, carried);
  };
  const now = madeBodyNow(made.source, made.height, made.yaw);
  if (now !== undefined) dress(now);
  else void madeBody(made.source, made.height, made.yaw, at ? { need: 'near', at: () => at } : undefined)?.then(dress);
  return {
    root: built.root,
    animate(dt, s) {
      if (worn) worn.animate(dt, { time: s.time + off, talking: s.talking });
      else built.animate(dt, s);
    },
  };
}

const _toRoot = new THREE.Matrix4();
const _inHand = new THREE.Matrix4();
const _wrist = new THREE.Vector3();
const _knuckles = new THREE.Vector3();

/**
 * Puts what a townsperson carries in their made hands: each prop built as the built body builds it,
 * round the middle of the made palm as they stand at rest (upright, the ground under their feet),
 * then hung on the hand so it goes where the hand goes.
 */
function holdIn(worn: MadeTownsperson, carried: readonly HeldProp[]): void {
  if (!carried.length) return;
  worn.root.updateMatrixWorld(true);
  _toRoot.copy(worn.root.matrixWorld).invert();
  for (const { side, build } of carried) {
    const s = side === 'l' ? 'L' : 'R';
    const hand = worn.rig.joint(`hand${s}`);
    hand.getWorldPosition(_wrist).applyMatrix4(_toRoot);
    if (worn.rig.has(`fingers${s}`)) worn.rig.joint(`fingers${s}`).getWorldPosition(_knuckles).applyMatrix4(_toRoot);
    else _knuckles.copy(_wrist);
    const p = new Parts();
    build(p, _wrist.clone().lerp(_knuckles, 0.6), 0);
    const geo = p.build();
    // From the townsperson's frame into the hand's, as the hand is now.
    geo.applyMatrix4(_inHand.multiplyMatrices(_toRoot, hand.matrixWorld).invert());
    mesh(hand, geo, { name: `held${s}` });
  }
}

/** Waits for a townsperson's made body, if their look names one (the content library, before it films them). */
export async function villagerReady(id: string, look?: VillagerLook): Promise<void> {
  const made = madeOf(id, look);
  if (made) await madeBody(made.source, made.height, made.yaw);
}
