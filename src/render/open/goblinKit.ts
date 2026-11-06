import * as THREE from 'three';
import { bev, box, cone, cyl, faceted, glowMaterial, jiggle, lathe, makeRng, merge, mesh, PAL, ring, rod, sph, tint, vary, xf, type V3 } from '../models/kit';

// What the goblins of Goblin's Dread build with, for the grotto behind the Windspire's falls
// (src/render/open/grotto.ts) and the inside of the dungeon (src/render/open/dungeonView.ts): rough
// rock, planks on barrels, rope nets, a totem of bones and slime jars, lanterns and torches, a pot
// for a gong, crude pictures daubed on the rock, and the portal's swirling veil. Procedural, in the
// kit's way (src/render/models/kit.ts): shapes placed, coloured per face and merged into one mesh.

/** The rock the goblins' caves are cut in: the island's own greys, mossy on top. */
const ROCK = { top: 0x8f877d, side: 0x746c63, moss: 0x5d7240, dark: 0x5a534c };

/** A rough slab of rock: a box jiggled out of true, faces in the island's rock colours, moss on top. `flatTop` keeps the top no higher than that (something walked on). */
export function rockSlab(w: number, h: number, d: number, seed: number, flatTop?: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d, Math.max(2, Math.round(w / 1.3)), 2, Math.max(2, Math.round(d / 1.3)));
  jiggle(g, Math.min(w, h, d) * 0.25, seed);
  if (flatTop !== undefined) {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) if (p.getY(i) > flatTop) p.setY(i, flatTop - Math.abs(Math.sin(i * 12.7 + seed)) * 0.04);
  }
  const f = faceted(g);
  const rng = makeRng(seed * 7 + 3);
  return tint(f, (_c, n) =>
    n.y > 0.75 && rng() < 0.45
      ? vary(ROCK.moss, rng, 0.1)
      : n.y > 0.3
        ? vary(ROCK.top, rng, 0.1)
        : n.y < -0.5
          ? vary(ROCK.dark, rng, 0.08)
          : vary(ROCK.side, rng, 0.1),
  );
}

/** A boulder: a lumpy ball of rock, `r` across, flattened a little. */
export function boulder(r: number, seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, 1);
  jiggle(g, r * 0.28, seed);
  g.scale(1, 0.78, 1);
  const f = faceted(g);
  const rng = makeRng(seed * 13 + 5);
  return tint(f, (_c, n) => (n.y > 0.7 && rng() < 0.4 ? vary(ROCK.moss, rng, 0.1) : vary(n.y > 0.2 ? ROCK.top : ROCK.side, rng, 0.12)));
}

/** A barrel standing up, `h` tall, its hoops on. */
export function barrel(h = 0.9, seed = 1): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const r = h * 0.3;
  const body = tint(
    faceted(
      lathe(
        [
          [r * 0.82, 0],
          [r, h * 0.25],
          [r * 1.06, h * 0.5],
          [r, h * 0.75],
          [r * 0.82, h],
        ],
        12,
      ),
    ),
    vary(PAL.wood, rng, 0.1),
  );
  const lid = tint(xf(cyl(r * 0.8, r * 0.8, 0.03, 12), [0, h - 0.01, 0]), PAL.woodDark);
  const hoops = [0.16, 0.84].map((y) =>
    tint(xf(ring(r * (0.98 + 0.06 * Math.sin(Math.PI * y)), r * (1.04 + 0.06 * Math.sin(Math.PI * y)), 0.05, 12), [0, h * y, 0]), PAL.iron),
  );
  return merge([body, lid, ...hoops]);
}

/**
 * A stage of rough planks, `w` across and `d` deep, its top at y = 0, on two runners, and on
 * barrels lying on their sides `below` metres down to the ground (0: no barrels).
 */
export function plankDeck(w: number, d: number, seed: number, below = 0): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const parts: THREE.BufferGeometry[] = [];
  let z = -d / 2;
  while (z < d / 2 - 0.08) {
    const pw = Math.min(0.24 + rng() * 0.1, d / 2 - z);
    if (rng() > 0.06)
      parts.push(
        tint(
          xf(bev(w + (rng() - 0.5) * 0.5, 0.07, pw - 0.03, 0.015), [(rng() - 0.5) * 0.2, -0.035, z + pw / 2], [0, (rng() - 0.5) * 0.06, 0]),
          vary(rng() < 0.55 ? PAL.woodGreyDark : PAL.woodDark, rng, 0.14),
        ),
      );
    z += pw;
  }
  for (const x of [-w * 0.33, w * 0.33]) parts.push(tint(xf(box(0.16, 0.16, d), [x, -0.15, 0]), PAL.woodDeep));
  if (below > 0.25) {
    const r = Math.min(0.32, (below - 0.23) / 2);
    for (let k = 0; k < Math.max(2, Math.round(d / 1.6)); k++) {
      const bz = -d / 2 + 0.6 + (k * (d - 1.2)) / Math.max(1, Math.round(d / 1.6) - 1);
      for (const x of [-w * 0.33, w * 0.33])
        parts.push(xf(barrel(r * 3.3, seed + k * 7 + (x > 0 ? 1 : 0)), [x - r * 1.65, -below + r, bz], [0, 0, -Math.PI / 2]));
    }
  }
  return merge(parts);
}

/** A rope net in the XY plane, `w` across and `h` high from y = 0, bellying out toward +Z. */
export function net(w: number, h: number, cell = 0.45, belly = 0.3): THREE.BufferGeometry {
  const nx = Math.max(2, Math.round(w / cell));
  const ny = Math.max(2, Math.round(h / cell));
  const at = (i: number, j: number): V3 => [
    -w / 2 + (i * w) / nx,
    (j * h) / ny - belly * 0.4 * Math.sin((Math.PI * i) / nx),
    belly * Math.sin((Math.PI * i) / nx) * Math.sin((Math.PI * j) / ny),
  ];
  const parts: THREE.BufferGeometry[] = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i < nx; i++) parts.push(rod(at(i, j), at(i + 1, j), j === 0 || j === ny ? 0.03 : 0.016, 3));
  for (let i = 0; i <= nx; i++) for (let j = 0; j < ny; j++) parts.push(rod(at(i, j), at(i, j + 1), i === 0 || i === nx ? 0.03 : 0.016, 3));
  return tint(merge(parts), PAL.rope);
}

/** A soft round glow (lanterns, torches, the slime jars), drawn over everything near it. */
function haloTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const grad = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = grad;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let halo: THREE.Texture | null = null;

export function haloSprite(color: number, size: number, opacity = 0.55): THREE.Sprite {
  halo ??= haloTexture();
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: halo, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  );
  s.scale.setScalar(size);
  s.renderOrder = 6;
  s.name = 'halo';
  return s;
}

/** Things that flicker (flames, halos): what flicker() wobbles each frame. */
export interface Flickers {
  list: Array<{ obj: THREE.Object3D; base: number; phase: number }>;
}

export function flicker(f: Flickers, time: number): void {
  for (const { obj, base, phase } of f.list) {
    const k = 1 + 0.08 * Math.sin(time * 9.1 + phase) + 0.06 * Math.sin(time * 15.7 + phase * 1.7);
    obj.scale.setScalar(base * k);
  }
}

/** A lantern on a hook: an iron cage round a glowing flame, and its halo. Hangs from y = 0. */
export function lantern(flickers: Flickers, seed = 1): THREE.Group {
  const g = new THREE.Group();
  const frame: THREE.BufferGeometry[] = [];
  frame.push(tint(xf(ring(0.05, 0.07, 0.02, 8), [0, -0.05, 0], [Math.PI / 2, 0, 0]), PAL.iron));
  frame.push(tint(xf(cone(0.17, 0.14, 4), [0, -0.17, 0], [0, Math.PI / 4, 0]), PAL.iron));
  frame.push(tint(xf(box(0.24, 0.04, 0.24), [0, -0.52, 0]), PAL.iron));
  for (const [x, z] of [
    [-0.1, -0.1],
    [0.1, -0.1],
    [-0.1, 0.1],
    [0.1, 0.1],
  ])
    frame.push(tint(xf(box(0.025, 0.3, 0.025), [x, -0.36, z]), PAL.iron));
  mesh(g, merge(frame), { shadow: false });
  const flame = mesh(g, tint(xf(new THREE.OctahedronGeometry(0.08, 0), [0, -0.36, 0], [0, 0, 0], [1, 1.6, 1]), PAL.glowHot, 2.2), {
    mat: glowMaterial(),
    shadow: false,
    name: 'flame',
  });
  const glass = mesh(g, tint(xf(box(0.19, 0.26, 0.19), [0, -0.36, 0]), PAL.glow, 1.3), { mat: glowMaterial(), shadow: false });
  glass.scale.setScalar(0.98);
  const h = haloSprite(0xffb45e, 1.3, 0.32);
  h.position.set(0, -0.36, 0);
  g.add(h);
  flickers.list.push({ obj: flame, base: 1, phase: seed * 1.7 }, { obj: h, base: 1.3, phase: seed * 1.7 + 0.4 });
  g.name = 'lantern';
  return g;
}

/** A torch in a bracket, flame and halo, for walls: its foot at y = 0, leaning out toward +Z. */
export function torch(flickers: Flickers, seed = 1): THREE.Group {
  const g = new THREE.Group();
  const parts: THREE.BufferGeometry[] = [];
  parts.push(tint(xf(box(0.12, 0.3, 0.06), [0, 0.05, -0.03]), PAL.iron));
  parts.push(tint(rod([0, 0, 0.02], [0, 0.85, 0.28], 0.045, 5), PAL.woodDark));
  parts.push(tint(xf(cyl(0.085, 0.06, 0.2, 6), [0, 0.86, 0.29], [0.32, 0, 0]), PAL.sack));
  mesh(g, merge(parts), { shadow: false });
  const flames = new THREE.Group();
  flames.position.set(0, 1.02, 0.34);
  mesh(flames, tint(xf(cone(0.11, 0.34, 6), [0, 0.12, 0]), PAL.glowHot, 2.4), { mat: glowMaterial(), shadow: false });
  mesh(flames, tint(xf(cone(0.06, 0.24, 5), [0.03, 0.18, 0.02]), 0xfff1c4, 2.6), { mat: glowMaterial(), shadow: false });
  g.add(flames);
  const h = haloSprite(0xff9a45, 1.8, 0.4);
  h.position.set(0, 1.15, 0.36);
  g.add(h);
  flickers.list.push({ obj: flames, base: 1, phase: seed * 2.3 }, { obj: h, base: 1.8, phase: seed * 2.3 + 0.6 });
  g.name = 'torch';
  return g;
}

/**
 * The goblins' totem: a carved post with a grinning face, horns, bones strung from a crossbar, a
 * painted shield and two jars of glowing slime jelly. Its foot at y = 0, `h` tall, facing +Z.
 */
export function totem(flickers: Flickers, h = 2.6, seed = 3): THREE.Group {
  const g = new THREE.Group();
  const rng = makeRng(seed);
  const s = h / 2.6;
  const wood: THREE.BufferGeometry[] = [];
  wood.push(tint(faceted(xf(cyl(0.24, 0.3, 2.2, 7), [0, 1.1, 0])), vary(PAL.woodDark, rng, 0.1)));
  wood.push(tint(faceted(xf(bev(0.72, 0.8, 0.52, 0.06), [0, 2.1, 0])), PAL.wood));
  // Ochre and white bands down the post.
  for (const y of [0.55, 0.95, 1.35]) wood.push(tint(xf(cyl(0.285, 0.29, 0.07, 7), [0, y, 0]), y === 0.95 ? PAL.cream : PAL.redDark));
  // The face: dark eyes under red brows, a wide grin full of teeth, a long nose.
  for (const x of [-0.17, 0.17]) {
    wood.push(tint(xf(box(0.15, 0.12, 0.06), [x, 2.24, 0.27]), 0x15100c));
    wood.push(tint(xf(box(0.2, 0.05, 0.07), [x, 2.34, 0.27], [0, 0, x > 0 ? -0.35 : 0.35]), PAL.red));
  }
  wood.push(tint(xf(cone(0.07, 0.3, 4), [0, 2.08, 0.33], [Math.PI / 2, 0, 0]), PAL.woodDeep));
  wood.push(tint(xf(box(0.5, 0.13, 0.06), [0, 1.86, 0.27]), 0x2a1610));
  for (let k = 0; k < 6; k++) {
    const x = -0.2 + k * 0.08;
    wood.push(tint(xf(cone(0.025, 0.07, 3), [x, 1.92, 0.31], [Math.PI, 0, 0]), PAL.white));
    wood.push(tint(xf(cone(0.025, 0.06, 3), [x + 0.04, 1.81, 0.31]), PAL.white));
  }
  // Horns.
  for (const side of [-1, 1]) wood.push(tint(xf(cone(0.09, 0.6, 6), [side * 0.36, 2.66, 0], [0, 0, -side * 0.75]), PAL.cream));
  // A crossbar with bones strung under it.
  wood.push(tint(xf(box(1.3, 0.09, 0.09), [0, 1.58, 0.05]), PAL.woodDeep));
  for (let k = 0; k < 7; k++) {
    const x = -0.58 + k * 0.19 + (rng() - 0.5) * 0.04;
    const len = 0.22 + rng() * 0.25;
    wood.push(tint(rod([x, 1.55, 0.08], [x, 1.55 - len, 0.08], 0.006, 3), PAL.rope));
    wood.push(tint(xf(cyl(0.022, 0.022, 0.16, 5), [x, 1.5 - len, 0.08], [0, 0, rng() * 0.6 - 0.3]), 0xe8e0c8));
    wood.push(tint(xf(sph(0.035, 5, 4), [x, 1.58 - len, 0.08]), 0xe8e0c8));
  }
  // A round shield on the post, painted with a spiral.
  const shield = faceted(xf(cyl(0.34, 0.34, 0.06, 12), [0, 0.95, 0.33], [Math.PI / 2, 0, 0]));
  wood.push(
    tint(shield, (c) => {
      const r = Math.hypot(c.x, c.y - 0.95);
      const a = Math.atan2(c.y - 0.95, c.x);
      return Math.sin(a * 2 + r * 26) > 0 ? PAL.redDark : PAL.cream;
    }),
  );
  const body = mesh(g, merge(wood), { name: 'totem' });
  body.scale.setScalar(s);
  // Jars of slime jelly on a little shelf, glowing green.
  const jars: THREE.BufferGeometry[] = [];
  for (const x of [-0.18, 0.18]) jars.push(tint(xf(cyl(0.09, 0.08, 0.2, 8), [x, 0.12, 0]), 0x86f25c, 1.7));
  const jar = mesh(g, merge(jars), { mat: glowMaterial(), shadow: false, name: 'slime-jars' });
  jar.position.set(0, 0.42 * s, 0.32 * s);
  mesh(g, tint(xf(box(0.6, 0.05, 0.22), [0, 0.4, 0.32]), PAL.woodDark)).scale.setScalar(s);
  const h2 = haloSprite(0x7cf26a, 1.4 * s, 0.35);
  h2.position.set(0, 0.55 * s, 0.34 * s);
  g.add(h2);
  flickers.list.push({ obj: h2, base: 1.4 * s, phase: seed });
  return g;
}

/** A cooking pot hung on a frame: the goblin lookout's gong, with the ladle to bang it. Foot at y = 0. */
export function potGong(): THREE.Group {
  const g = new THREE.Group();
  const parts: THREE.BufferGeometry[] = [];
  parts.push(tint(rod([-0.6, 0, 0], [-0.55, 1.5, 0], 0.05, 5), PAL.woodDark));
  parts.push(tint(rod([0.6, 0, 0], [0.55, 1.5, 0], 0.05, 5), PAL.woodDark));
  parts.push(tint(rod([-0.62, 1.48, 0], [0.62, 1.48, 0], 0.05, 5), PAL.woodDark));
  parts.push(tint(rod([0, 1.48, 0], [0, 1.2, 0], 0.01, 3), PAL.rope));
  const pot = faceted(
    xf(
      lathe(
        [
          [0.02, 0],
          [0.3, 0.05],
          [0.36, 0.25],
          [0.33, 0.42],
          [0.3, 0.44],
        ],
        12,
      ),
      [0, 0.74, 0],
    ),
  );
  parts.push(tint(pot, PAL.iron));
  parts.push(tint(xf(ring(0.3, 0.34, 0.04, 12), [0, 1.18, 0]), PAL.ironLight));
  parts.push(tint(rod([0.42, 0.9, 0.2], [0.7, 0.55, 0.35], 0.025, 4), PAL.woodLight));
  parts.push(tint(xf(sph(0.07, 6, 4), [0.42, 0.9, 0.2]), PAL.woodLight));
  mesh(g, merge(parts), { name: 'pot-gong' });
  return g;
}

/**
 * The lookout's perch: a platform `h` up on four stilts with a ladder, a striped sailcloth awning,
 * and the pot gong hung beside it. Foot at y = 0; the ladder faces +Z.
 */
export function lookout(h: number, seed: number): THREE.Group {
  const g = new THREE.Group();
  const rng = makeRng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const legs: Array<[number, number]> = [
    [-1.1, -1.1],
    [1.1, -1.1],
    [-1.1, 1.1],
    [1.1, 1.1],
  ];
  for (const [x, z] of legs) parts.push(tint(rod([x * 1.12, 0, z * 1.12], [x, h, z], 0.09, 6), vary(PAL.woodDark, rng, 0.1)));
  // Cross braces.
  parts.push(tint(rod([-1.2, 0.4, -1.2], [1.12, h * 0.6, -1.15], 0.05, 4), PAL.woodDark));
  parts.push(tint(rod([1.2, 0.4, 1.2], [-1.12, h * 0.6, 1.15], 0.05, 4), PAL.woodDark));
  parts.push(xf(plankDeck(2.6, 2.6, seed + 1), [0, h + 0.07, 0]));
  // Rails, and the awning on poles.
  for (const [x, z] of legs) parts.push(tint(rod([x, h, z], [x, h + 2.3, z], 0.05, 5), PAL.woodDark));
  for (const z of [-1.1, 1.1]) parts.push(tint(rod([-1.1, h + 0.9, z], [1.1, h + 0.9, z], 0.035, 4), PAL.wood));
  const awning = faceted(xf(new THREE.PlaneGeometry(2.6, 2.6, 6, 1), [0, h + 2.3, 0], [-Math.PI / 2 + 0.12, 0, 0]));
  parts.push(tint(awning, (c) => (Math.floor((c.x + 1.3) / 0.43) % 2 ? PAL.redDark : PAL.canvas)));
  // The ladder up its front.
  for (const x of [-0.32, 0.32]) parts.push(tint(rod([x, 0, 1.75], [x, h + 0.2, 1.15], 0.04, 4), PAL.wood));
  for (let k = 1; k * 0.38 < h; k++) {
    const u = (k * 0.38) / (h + 0.2);
    parts.push(tint(rod([-0.32, u * (h + 0.2), 1.75 - 0.6 * u], [0.32, u * (h + 0.2), 1.75 - 0.6 * u], 0.03, 4), PAL.woodLight));
  }
  mesh(g, merge(parts), { name: 'lookout' });
  const gong = potGong();
  gong.position.set(0.3, h, -0.4);
  g.add(gong);
  return g;
}

/** The goblins' barricade across a tunnel: crossed spiked logs, crates and planks, a skull on a pole. Foot at y = 0, `w` across, facing +Z. */
export function barricade(w: number, seed: number): THREE.Group {
  const g = new THREE.Group();
  const rng = makeRng(seed);
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 5; k++) {
    const x = -w / 2 + (k + 0.5) * (w / 5);
    const lean = (k % 2 ? 1 : -1) * 0.5;
    parts.push(tint(rod([x - lean, 0, -0.3], [x + lean, 2.3, 0.4], 0.12, 6, 0.04), vary(PAL.woodDark, rng, 0.12)));
  }
  for (const y of [0.6, 1.4]) parts.push(tint(xf(box(w, 0.24, 0.16), [0, y, 0.1], [0, 0, (rng() - 0.5) * 0.08]), vary(PAL.woodGrey, rng, 0.1)));
  for (let k = 0; k < 4; k++)
    parts.push(
      tint(xf(bev(0.8, 0.8, 0.8, 0.03), [-w / 2 + 0.6 + (k * (w - 1.2)) / 3, 0.4 + (k % 2) * 0.8, 0.7], [0, rng() * 0.6, 0]), vary(PAL.crate, rng, 0.12)),
    );
  parts.push(tint(rod([w / 2 - 0.5, 0, 0.6], [w / 2 - 0.5, 2.6, 0.6], 0.04, 4), PAL.woodDark));
  parts.push(tint(xf(sph(0.18, 7, 5), [w / 2 - 0.5, 2.7, 0.6], [0, 0, 0], [1, 0.9, 1.15]), 0xe8e0c8));
  parts.push(tint(xf(box(0.06, 0.05, 0.03), [w / 2 - 0.56, 2.72, 0.79]), 0x15100c));
  parts.push(tint(xf(box(0.06, 0.05, 0.03), [w / 2 - 0.44, 2.72, 0.79]), 0x15100c));
  mesh(g, merge(parts), { name: 'barricade' });
  return g;
}

/**
 * Crude pictures daubed on the rock in ochre and soot: goblins with spears, a grinning face, a sun
 * wheel, a fish, hand prints, arrows pointing the way in. A transparent texture to lay on a wall.
 */
export function drawingsTexture(seed: number): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const x = c.getContext('2d')!;
  const rng = makeRng(seed);
  x.lineCap = 'round';
  x.lineJoin = 'round';
  const ink = (a: number) => (rng() < 0.65 ? `rgba(132,40,26,${a})` : `rgba(28,22,20,${a})`);
  const goblin = (cx: number, cy: number, k: number) => {
    x.strokeStyle = ink(0.85);
    x.lineWidth = 5 * k;
    x.beginPath();
    x.arc(cx, cy - 34 * k, 10 * k, 0, Math.PI * 2);
    x.moveTo(cx - 10 * k, cy - 38 * k);
    x.lineTo(cx - 22 * k, cy - 46 * k);
    x.moveTo(cx + 10 * k, cy - 38 * k);
    x.lineTo(cx + 22 * k, cy - 46 * k);
    x.moveTo(cx, cy - 24 * k);
    x.lineTo(cx, cy);
    x.lineTo(cx - 12 * k, cy + 20 * k);
    x.moveTo(cx, cy);
    x.lineTo(cx + 12 * k, cy + 20 * k);
    x.moveTo(cx - 16 * k, cy - 14 * k);
    x.lineTo(cx + 16 * k, cy - 14 * k);
    x.moveTo(cx + 16 * k, cy - 40 * k);
    x.lineTo(cx + 16 * k, cy + 18 * k);
    x.moveTo(cx + 9 * k, cy - 30 * k);
    x.lineTo(cx + 16 * k, cy - 44 * k);
    x.lineTo(cx + 23 * k, cy - 30 * k);
    x.stroke();
  };
  for (let k = 0; k < 4; k++) goblin(40 + k * 62 + rng() * 14, 150 + rng() * 40, 0.75 + rng() * 0.35);
  // A big grinning face.
  x.strokeStyle = ink(0.9);
  x.lineWidth = 7;
  x.beginPath();
  x.arc(380, 110, 46, 0, Math.PI * 2);
  x.moveTo(345, 125);
  x.quadraticCurveTo(380, 160, 415, 125);
  for (let k = 0; k < 5; k++) {
    x.moveTo(352 + k * 14, 132 + Math.sin(k) * 3);
    x.lineTo(359 + k * 14, 146);
  }
  x.stroke();
  x.fillStyle = ink(0.9);
  for (const ex of [362, 398]) {
    x.beginPath();
    x.arc(ex, 98, 7, 0, Math.PI * 2);
    x.fill();
  }
  // A sun wheel, a fish and hand prints.
  x.lineWidth = 4;
  x.strokeStyle = ink(0.75);
  x.beginPath();
  x.arc(470, 50, 18, 0, Math.PI * 2);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    x.moveTo(470 + Math.cos(a) * 24, 50 + Math.sin(a) * 24);
    x.lineTo(470 + Math.cos(a) * 34, 50 + Math.sin(a) * 34);
  }
  x.moveTo(220, 50);
  x.quadraticCurveTo(250, 25, 280, 50);
  x.quadraticCurveTo(250, 75, 220, 50);
  x.lineTo(205, 35);
  x.moveTo(220, 50);
  x.lineTo(205, 65);
  x.stroke();
  for (let k = 0; k < 3; k++) {
    x.fillStyle = ink(0.55);
    const hx = 120 + k * 36 + rng() * 10;
    const hy = 40 + rng() * 20;
    x.beginPath();
    x.ellipse(hx, hy, 9, 12, 0, 0, Math.PI * 2);
    x.fill();
    for (let f = 0; f < 4; f++) {
      x.beginPath();
      x.ellipse(hx - 9 + f * 6, hy - 16, 2.5, 7, (f - 1.5) * 0.15, 0, Math.PI * 2);
      x.fill();
    }
  }
  // Arrows pointing the way in.
  x.strokeStyle = ink(0.85);
  x.lineWidth = 6;
  for (const ay of [214, 234]) {
    x.beginPath();
    x.moveTo(300, ay);
    x.lineTo(470, ay);
    x.moveTo(452, ay - 12);
    x.lineTo(472, ay);
    x.lineTo(452, ay + 12);
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Pictures on a wall: a plane `w` by `h` facing +Z, drawn just in front of the rock. */
export function drawings(w: number, h: number, seed: number): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({
    map: drawingsTexture(seed),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  m.name = 'drawings';
  m.renderOrder = 1;
  return m;
}

const veilVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const veilFragment = /* glsl */ `
  uniform float uTime;
  uniform vec3 uDeep;
  uniform vec3 uRim;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    // The arch's outline: a rectangle with a round top (uv 0..1 across, 0..1 up).
    vec2 p = vec2(vUv.x * 2.0 - 1.0, vUv.y);
    float top = 1.0 - 0.38;
    float inside = p.y < top ? step(abs(p.x), 1.0) : step(length(vec2(p.x, (p.y - top) / 0.38)), 1.0);
    if (inside < 0.5) discard;
    vec2 c = vec2(p.x, (p.y - 0.42) * 1.25);
    float r = length(c);
    float a = atan(c.y, c.x);
    float swirl = sin(a * 3.0 - r * 9.0 + uTime * 1.8) * 0.5 + 0.5;
    float swirl2 = sin(a * 5.0 + r * 13.0 - uTime * 2.6) * 0.5 + 0.5;
    vec3 col = mix(uDeep, uRim, smoothstep(0.15, 1.15, r) * (0.55 + 0.45 * swirl));
    col += uRim * swirl2 * 0.12 * r;
    // Motes drifting into the dark.
    vec2 cell = vUv * vec2(26.0, 34.0) + vec2(0.0, uTime * 3.0);
    vec2 g = floor(cell);
    float spot = 1.0 - smoothstep(0.08, 0.22, length(fract(cell) - 0.5));
    float mote = step(0.985, hash(g)) * spot * (0.5 + 0.5 * sin(uTime * 6.0 + hash(g + 3.0) * 30.0));
    col += vec3(0.75, 0.95, 1.0) * mote * 0.8;
    gl_FragColor = vec4(col, 0.94);
    #include <colorspace_fragment>
  }
`;

/** The portal's veil: a dark swirl in an arch `w` wide and `h` tall, facing +Z, its foot at y = 0. */
export function portalVeil(w: number, h: number, uniforms: { uTime: THREE.IUniform }): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: uniforms.uTime, uDeep: { value: new THREE.Color(0x07040d) }, uRim: { value: new THREE.Color(0x3c8a92) } },
    vertexShader: veilVertex,
    fragmentShader: veilFragment,
    transparent: true,
    toneMapped: false,
  });
  const geo = new THREE.PlaneGeometry(w, h);
  geo.translate(0, h / 2, 0);
  const m = new THREE.Mesh(geo, mat);
  m.name = 'portal-veil';
  return m;
}

/** A rock arch round a doorway `w` wide and `h` tall (its veil goes inside), facing +Z, foot at y = 0. */
export function rockArch(w: number, h: number, seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const stones = 11;
  const rTop = w / 2 + 0.35;
  const top = h - w / 2;
  for (let k = 0; k < stones; k++) {
    const u = k / (stones - 1);
    let x: number;
    let y: number;
    if (u < 0.3) {
      x = -rTop;
      y = (u / 0.3) * top;
    } else if (u > 0.7) {
      x = rTop;
      y = ((1 - u) / 0.3) * top;
    } else {
      const a = Math.PI - ((u - 0.3) / 0.4) * Math.PI;
      x = Math.cos(a) * rTop;
      y = top + Math.sin(a) * rTop;
    }
    parts.push(xf(rockSlab(0.9, 0.9, 1.0, seed + k * 13), [x, y + 0.35, 0.15], [0.1 * Math.sin(k), k * 0.7, 0.15 * Math.cos(k)]));
  }
  return merge(parts);
}
