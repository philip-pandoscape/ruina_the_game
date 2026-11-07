import * as THREE from 'three';
import type { CaveDressing, CaveLamp } from '../../content/looks';
import type { DungeonDef, DungeonPiece } from '../../engine/zone';
import {
  barrel,
  barricade,
  boulder,
  drawings,
  flicker,
  lookout,
  net,
  plankDeck,
  portalVeil,
  rockArch,
  rockSlab,
  torch,
  totem,
  type Flickers,
} from './goblinKit';
import { bev, cone, faceted, jiggle, makeRng, merge, PAL, tint, vary, xf } from '../models/kit';

// The inside of a copy of an instance drawn as a cave (content/instances/<id>.json; a cave is the
// default style), round its origin, only while you're in one (src/app/dungeonVisit.ts), dressed as
// its file says (`dressing`, src/content/looks.ts CaveDressing): rock lining its hall, and the tunnel
// off the hall's north wall if it has one, along the faces of the walls it names, under a ceiling
// hung with stalactites, rubble at the walls' feet and an earth floor; the back of a waterfall
// glowing and rippling across the hall's south end with the way out through it, if it has one, or
// the way out in a rock arch where its file puts it; and its torches, props, catch nets, stolen
// goods and pictures on the walls.
//
// There's no sun in here. The cave's own pieces carry their light in their colours, worked out once
// from its lamps (bake below: a fill, its torches, the daylight through the falls and the way out,
// as its dressing lights them), so a handful of torches light it without a light that every
// material in the world would have to take into account.

const curtainVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const curtainFragment = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vWorld;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  void main() {
    // The falls seen from behind, the daylight coming through them: streaks racing down, brighter
    // where the water's thin, ripples of light.
    float n1 = noise(vec2(vUv.x * 22.0, vUv.y * 3.0 + uTime * 2.4));
    float n2 = noise(vec2(vUv.x * 60.0, vUv.y * 9.0 + uTime * 5.5));
    float n3 = noise(vec2(vUv.x * 5.0 + uTime * 0.1, vUv.y * 1.2 + uTime * 0.6));
    float bright = 0.55 + 0.35 * n1 + 0.18 * n2 + 0.25 * n3;
    vec3 col = mix(vec3(0.32, 0.62, 0.68), vec3(0.86, 0.97, 1.0), smoothstep(0.55, 1.15, bright));
    col *= 0.9 + 0.5 * smoothstep(0.2, 0.9, vUv.y);
    float edge = smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.94, vUv.x);
    gl_FragColor = vec4(col * 1.25, 0.96 * edge);
    #include <colorspace_fragment>
  }
`;

/** A light the cave's colours are baked from. */
interface Lamp {
  at: THREE.Vector3;
  color: THREE.Color;
  power: number;
  reach: number;
}

/** What a prop is fitted to: the piece it stands on, its seed, and what the cave keeps for it. */
interface PropFit {
  piece: DungeonPiece;
  seed: number;
  flickers: Flickers;
  unlit: THREE.Material;
}

/** What can stand on a cave's pieces, by the names its dressing gives them: each fitted to its piece, and how high its foot is. */
const PROPS: Record<string, (f: PropFit) => { obj: THREE.Object3D; y: number }> = {
  /** A landing stage of planks on barrels filling a deck, at its top. */
  stage: ({ piece, seed, unlit }) => ({ obj: new THREE.Mesh(plankDeck(piece.hw * 2, piece.hd * 2, seed, piece.top), unlit), y: piece.top }),
  /** A lookout on stilts as tall as its box, with a cooking pot for a gong. */
  lookout: ({ piece, seed }) => ({ obj: lookout(piece.top, seed), y: 0 }),
  /** The goblins' totem, as tall as its box. */
  totem: ({ piece, seed, flickers }) => ({ obj: totem(flickers, piece.top, seed), y: 0 }),
  /** A barricade across its box. */
  barricade: ({ piece, seed }) => ({ obj: barricade(piece.hw * 2, seed), y: 0 }),
};

/** How each kind of pile is stacked from its corner (x, z), `count` of them, into `out`; `rng` turns and colours them. */
const PILES: Record<string, (out: THREE.BufferGeometry[], x: number, z: number, count: number, seed: number, rng: () => number) => void> = {
  /** Barrels three abreast, staggered, a second row on top. */
  barrels: (out, x, z, count, seed) => {
    for (let k = 0; k < count; k++) out.push(xf(barrel(0.95, k + seed), [x - (k % 3) * 0.75, k >= 3 ? 0.95 : 0, z - (k % 2) * 0.7]));
  },
  /** Wooden boxes (crates) three abreast, a second row on top. */
  boxes: (out, x, z, count, _seed, rng) => {
    for (let k = 0; k < count; k++)
      out.push(tint(xf(bev(1, 0.9, 1, 0.03), [x + (k % 3) * 1.05, 0.45 + (k >= 3 ? 0.9 : 0), z], [0, rng() * 0.5, 0]), vary(PAL.crate, rng, 0.12)));
  },
  /** Bales of canvas in a leaning stack. */
  bales: (out, x, z, count, _seed, rng) => {
    for (let k = 0; k < count; k++)
      out.push(tint(xf(bev(1.4, 0.7, 0.9, 0.08), [x, 0.35 + k * 0.7, z + k * 0.2], [0, rng() * 0.4, 0]), vary(PAL.canvasShade, rng, 0.1)));
  },
};

/** The props and piles a cave's dressing can name. */
export const caveProps = (): string[] => Object.keys(PROPS);
export const cavePiles = (): string[] => Object.keys(PILES);

export class DungeonView {
  readonly group = new THREE.Group();
  readonly def: DungeonDef;
  /** Lit by its own light, the island put away (an arena, arenaView.ts, keeps the sky). */
  readonly dark = true;
  private flickers: Flickers = { list: [] };
  private veil = { uTime: { value: 0 } as THREE.IUniform };
  private curtain = { uTime: { value: 0 } as THREE.IUniform };
  private lamps: Lamp[] = [];
  private fill: [number, number, number] = [0, 0, 0];
  private unlit = new THREE.MeshBasicMaterial({ vertexColors: true });

  constructor(def: DungeonDef) {
    this.def = def;
    this.group.name = `dungeon-${def.id}`;
    if (def.dressing) this.build(def.dressing);
    this.group.visible = false;
  }

  /** One of its pieces, a box or a deck, by id. */
  private piece(id: string): DungeonPiece {
    const p = this.def.boxes.find((b) => b.id === id) ?? this.def.decks.find((d) => d.id === id);
    if (!p) throw new Error(`${this.def.id}'s dressing names ${id}, which isn't one of its pieces`);
    return p;
  }

  private build(dress: CaveDressing): void {
    const g = this.group;
    // The hall's inside faces, west and east (x), south and north (z), from its walls; the tunnel's.
    const [west, east, south, north] = [dress.hall.west, dress.hall.east, dress.hall.south, dress.hall.north].map((id) => this.piece(id));
    const b = { w: west.x - west.hw, e: east.x + east.hw, s: south.z + south.hd, n: north.z - north.hd };
    const tun = dress.tunnel && {
      w: this.piece(dress.tunnel.west).x - this.piece(dress.tunnel.west).hw,
      e: this.piece(dress.tunnel.east).x + this.piece(dress.tunnel.east).hw,
      n: this.piece(dress.tunnel.end).z - this.piece(dress.tunnel.end).hd,
      ceiling: dress.tunnel.ceiling,
    };
    const top = dress.hall.ceiling;
    const falls = dress.falls;
    const light = dress.light;
    const exit = this.def.exit;
    this.fill = light.fill;
    const lamp = (l: CaveLamp) => ({ color: new THREE.Color(...l.colour), power: l.power, reach: l.reach });
    // Where the light comes from: the torches, the daylight through the falls, the way out.
    const torches = dress.torches ?? [];
    if (light.torch) {
      const l = lamp(light.torch);
      for (const {
        at: [x, y, z],
      } of torches)
        this.lamps.push({ at: new THREE.Vector3(x, y + 1.1, z), ...l });
    }
    if (falls && light.falls) {
      const l = lamp(light.falls);
      const n = falls.lights;
      const [x0, step] = n > 1 ? [b.e + 2, (b.w - b.e - 4) / (n - 1)] : [(b.w + b.e) / 2, 0];
      for (let k = 0; k < n; k++) this.lamps.push({ at: new THREE.Vector3(x0 + k * step, 5, b.s + 0.4), ...l });
    }
    // The way out: in the falls, or where the file puts it.
    const [archZ, veilZ, glowZ] = falls ? [b.s + 0.6, b.s + 0.75, b.s + 1.5] : [exit.z, exit.z + 0.15, exit.z + 0.9];
    this.lamps.push({ at: new THREE.Vector3(exit.x, 1.8, glowZ), ...lamp(light.exit) });

    // ---- the rock: floor, walls, ceiling ----
    const rock: THREE.BufferGeometry[] = [];
    const rng = makeRng(17);
    // Walls of big rough slabs, two courses high, set into the walls' line.
    const wall = (x0: number, z0: number, x1: number, z1: number, inward: [number, number], seed: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.max(1, Math.round(len / 3.2));
      const yaw = Math.atan2(x1 - x0, z1 - z0);
      for (let k = 0; k < n; k++) {
        const u = (k + 0.5) / n;
        const x = x0 + (x1 - x0) * u - inward[0] * 0.9;
        const z = z0 + (z1 - z0) * u - inward[1] * 0.9;
        for (const [y, h] of [
          [2.6, 6.4],
          [8.6, 7.4],
        ] as const)
          rock.push(
            xf(
              rockSlab(2.4, h, (len / n) * 1.25, seed + k * 7 + y),
              [x + (rng() - 0.5) * 0.5 * inward[0], y, z + (rng() - 0.5) * 0.5 * inward[1]],
              [0, yaw + Math.PI / 2, (rng() - 0.5) * 0.15],
            ),
          );
      }
    };
    wall(b.w, b.s, b.w, b.n, [-1, 0], 1);
    wall(b.e, b.s, b.e, b.n, [1, 0], 101);
    if (tun) {
      // The north wall either side of the tunnel's mouth, then the tunnel's walls and its end.
      wall(b.e, b.n, tun.e, b.n, [0, -1], 201);
      wall(tun.w, b.n, b.w, b.n, [0, -1], 301);
      wall(tun.w, b.n, tun.w, tun.n, [-1, 0], 401);
      wall(tun.e, b.n, tun.e, tun.n, [1, 0], 501);
      wall(tun.e, tun.n, tun.w, tun.n, [0, -1], 601);
    } else wall(b.e, b.n, b.w, b.n, [0, -1], 201);
    if (!falls) wall(b.w, b.s, b.e, b.s, [0, 1], 701);
    // The ceiling: slabs, lower in the tunnel, with stalactites.
    for (let x = b.e + 2; x < b.w; x += 5.5)
      for (let z = b.s + 2; z < b.n; z += 5.5)
        rock.push(xf(rockSlab(6.2, 2.2, 6.2, 900 + Math.round(x * 13 + z * 7)), [x + rng() - 0.5, top + rng() * 1.6, z + rng() - 0.5]));
    if (tun) for (let z = b.n; z < tun.n + 1; z += 4) rock.push(xf(rockSlab(8, 2, 4.6, 1300 + z), [(tun.w + tun.e) / 2, tun.ceiling + rng(), z + 1]));
    for (let k = 0; k < (dress.stalactites ?? 0); k++) {
      const x = b.e + 2 + rng() * (b.w - b.e - 4);
      const z = b.s + 2 + rng() * (b.n - b.s - 4);
      const len = 0.8 + rng() * 2.6;
      rock.push(
        tint(faceted(jiggle(xf(cone(0.25 + rng() * 0.35, len, 5), [x, top - 0.6 - len / 2, z], [Math.PI, rng() * 3, 0]), 0.06, k)), vary(0x6d665e, rng, 0.1)),
      );
    }
    // Rubble along the foot of the walls, and down the tunnel.
    const strips = tun ? 4 : 3;
    for (let k = 0; k < (dress.rubble ?? 0); k++) {
      const side = k % strips;
      const along = rng();
      const [x, z] =
        side === 0
          ? [b.w - 0.8, b.s + along * (b.n - b.s)]
          : side === 1
            ? [b.e + 0.8, b.s + along * (b.n - b.s)]
            : side === 2
              ? [b.e + along * (b.w - b.e), b.n - 0.8]
              : [tun!.e + 0.4 + along * (tun!.w - tun!.e - 0.8), b.n + 1 + rng() * (tun!.n - b.n - 2)];
      // Nothing in the tunnel's mouth.
      if (side === 2 && tun && x > tun.e && x < tun.w) continue;
      rock.push(xf(boulder(0.4 + rng() * 0.8, k + 40), [x, 0.1, z]));
    }
    // The floor: packed earth and rock, wet and darker toward the falls.
    const far = tun ? tun.n : b.n;
    const floor = new THREE.PlaneGeometry(b.w - b.e + 1, far - b.s + 1, 36, 52);
    floor.rotateX(-Math.PI / 2);
    floor.translate((b.w + b.e) / 2, 0, (far + b.s) / 2);
    const fl = faceted(floor);
    tint(fl, (c) => {
      const n = Math.sin(c.x * 1.7 + c.z * 0.9) * Math.sin(c.x * 0.6 - c.z * 1.3);
      const wet = falls ? Math.max(0, 1 - (c.z - b.s) / 7) : 0;
      return new THREE.Color(0x5e554b).lerp(new THREE.Color(0x40463f), wet * 0.7).multiplyScalar(0.92 + 0.12 * n);
    });
    rock.push(fl);
    this.bakeAndAdd(merge(rock), 'dungeon-rock', false);

    // ---- the back of the falls, and the way out ----
    if (falls) {
      const curtain = new THREE.Mesh(
        new THREE.PlaneGeometry(b.w - b.e - 0.6, top + 1.5),
        new THREE.ShaderMaterial({
          uniforms: this.curtain,
          vertexShader: curtainVertex,
          fragmentShader: curtainFragment,
          transparent: true,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      curtain.position.set((b.w + b.e) / 2, (top + 1.5) / 2, b.s + 0.25);
      curtain.name = 'dungeon-falls';
      g.add(curtain);
      // Rock behind the falls, so nothing of the world shows through them.
      const backing = new THREE.Mesh(new THREE.PlaneGeometry(b.w - b.e + 4, top + 4), new THREE.MeshBasicMaterial({ color: 0x0a1418 }));
      backing.position.set((b.w + b.e) / 2, (top + 4) / 2 - 1, b.s - 1.2);
      backing.name = 'dungeon-falls-backing';
      g.add(backing);
    }
    const arch = new THREE.Mesh(rockArch(2.8, 3.8, 77), this.unlit);
    this.bake(arch.geometry, new THREE.Matrix4().makeTranslation(exit.x, 0, archZ));
    arch.position.set(exit.x, 0, archZ);
    arch.name = 'exit-arch';
    g.add(arch);
    const veil = portalVeil(2.9, 3.9, this.veil);
    veil.position.set(exit.x, 0.05, veilZ);
    (veil.material as THREE.ShaderMaterial).uniforms.uDeep.value = new THREE.Color(0x14303a);
    (veil.material as THREE.ShaderMaterial).uniforms.uRim.value = new THREE.Color(0x8fdce3);
    g.add(veil);

    // ---- what stands in it ----
    const props: Array<[THREE.Object3D, string]> = [];
    for (const p of dress.props ?? []) {
      const make = PROPS[p.body];
      if (!make) continue;
      const on = this.piece(p.on);
      const { obj, y } = make({ piece: on, seed: p.seed, flickers: this.flickers, unlit: this.unlit });
      obj.position.set(on.x, y, on.z);
      obj.rotation.y = on.rot + (p.turn ?? 0);
      props.push([obj, p.body]);
    }
    for (const n of dress.nets ?? []) {
      const m = new THREE.Mesh(net(n.size[0], n.size[1], 0.45, 0.4), this.unlit);
      m.position.set(...n.at);
      m.rotation.y = n.turn;
      props.push([m, 'catch-net']);
    }
    const loot: THREE.BufferGeometry[] = [];
    const lr = makeRng(23);
    for (const pile of dress.loot ?? []) PILES[pile.pile]?.(loot, pile.at[0], pile.at[1], pile.count, pile.seed ?? 1, lr);
    if (loot.length) props.push([new THREE.Mesh(merge(loot), this.unlit), 'loot']);
    for (const [obj, name] of props) {
      obj.name = name;
      g.add(obj);
    }
    g.updateMatrixWorld(true);
    // Their light baked in (the group's own placement aside: the bake works round the origin).
    const inverse = new THREE.Matrix4().copy(g.matrixWorld).invert();
    for (const [obj] of props)
      obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || (m.material !== this.unlit && !(m.material as THREE.MeshToonMaterial).vertexColors)) return;
        if ((m.material as THREE.MeshBasicMaterial).toneMapped === false) return;
        const local = new THREE.Matrix4().multiplyMatrices(inverse, m.matrixWorld);
        m.geometry = m.geometry.clone();
        this.bake(m.geometry, local);
        m.material = this.unlit;
        m.castShadow = false;
      });

    // Torches on the walls, pictures beside them.
    torches.forEach(({ at: [x, y, z], turn }, k) => {
      const t = torch(this.flickers, k + 1);
      t.position.set(x, y, z);
      t.rotation.y = turn;
      g.add(t);
    });
    for (const d of dress.drawings ?? []) {
      const m = drawings(d.size[0], d.size[1], d.seed);
      m.position.set(...d.at);
      m.rotation.y = d.turn;
      g.add(m);
    }
  }

  /** Light at a point of the cave facing `n` (both round the origin): a little fill, then the lamps. */
  private lightAt(p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color): THREE.Color {
    out.setRGB(this.fill[0], this.fill[1], this.fill[2]).multiplyScalar(0.7 + 0.6 * Math.max(0, n.y));
    const l = new THREE.Vector3();
    for (const lamp of this.lamps) {
      l.subVectors(lamp.at, p);
      const d = l.length();
      if (d > lamp.reach * 6) continue;
      l.divideScalar(d || 1);
      const facing = 0.08 + 0.92 * Math.max(0, n.dot(l));
      const k = (lamp.power * facing) / (1 + (d / lamp.reach) * (d / lamp.reach));
      out.r += lamp.color.r * k;
      out.g += lamp.color.g * k;
      out.b += lamp.color.b * k;
    }
    return out;
  }

  /** Multiplies a geometry's colours by the light where each vertex ends up (`m` places it round the origin). */
  private bake(geo: THREE.BufferGeometry, m: THREE.Matrix4): void {
    const pos = geo.getAttribute('position');
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    const nor = geo.getAttribute('normal');
    let col = geo.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!col) {
      col = new THREE.BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3);
      geo.setAttribute('color', col);
    }
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(m);
      n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      this.lightAt(p, n, c);
      col.setXYZ(i, col.getX(i) * Math.min(2.2, c.r), col.getY(i) * Math.min(2.2, c.g), col.getZ(i) * Math.min(2.2, c.b));
    }
    col.needsUpdate = true;
  }

  private bakeAndAdd(geo: THREE.BufferGeometry, name: string, shadow: boolean): void {
    this.bake(geo, new THREE.Matrix4());
    const m = new THREE.Mesh(geo, this.unlit);
    m.name = name;
    m.castShadow = shadow;
    m.receiveShadow = false;
    this.group.add(m);
  }

  update(time: number): void {
    if (!this.group.visible) return;
    this.veil.uTime.value = time;
    this.curtain.uTime.value = time;
    flicker(this.flickers, time);
  }
}
