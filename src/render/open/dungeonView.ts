import * as THREE from 'three';
import type { DungeonDef, DungeonPiece } from '../../sim/zone/dungeon';
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

// The inside of a copy of a dungeon (shared/dungeons/<id>.json), drawn round its origin only while
// you're in one (src/app/dungeonVisit.ts): for Goblin's Dread, the inner grotto behind the
// Windspire's waterfall. Rock all round, the back of the falls glowing and rippling across its south
// end with the portal back out, the goblins' landing stage, catch nets, their lookout on its stilts
// with a cooking pot for a gong, their totem, torches, pictures on the walls, stolen goods, and a
// tunnel north that ends, for now, at their barricade.
//
// There's no sun in here. The cave's own pieces carry their light in their colours, worked out once
// from the torches and the falls (bake below), so a handful of torches light it without a light
// that every material in the world would have to take into account.

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

const WARM = new THREE.Color(1.0, 0.66, 0.4);
const COOL = new THREE.Color(0.55, 0.8, 0.86);
const TEAL = new THREE.Color(0.35, 0.75, 0.8);

export class DungeonView {
  readonly group = new THREE.Group();
  readonly def: DungeonDef;
  private flickers: Flickers = { list: [] };
  private veil = { uTime: { value: 0 } as THREE.IUniform };
  private curtain = { uTime: { value: 0 } as THREE.IUniform };
  private lamps: Lamp[] = [];
  private unlit = new THREE.MeshBasicMaterial({ vertexColors: true });

  constructor(def: DungeonDef) {
    this.def = def;
    this.group.name = `dungeon-${def.id}`;
    this.group.position.set(def.origin.x, def.origin.y, def.origin.z);
    this.build();
    this.group.visible = false;
  }

  private box(id: string): DungeonPiece | undefined {
    return this.def.boxes.find((b) => b.id === id);
  }

  /** The room's inside faces: west/east (x), south/north (z), from the walls' boxes. */
  private bounds(): { w: number; e: number; s: number; n: number; tw: number; te: number; tn: number } {
    const west = this.box('westWall');
    const east = this.box('eastWall');
    const south = this.box('curtain');
    const north = this.box('northWallWest');
    const tWest = this.box('tunnelWest');
    const tEast = this.box('tunnelEast');
    const end = this.box('tunnelEnd');
    return {
      w: west ? west.x - west.hw : 14,
      e: east ? east.x + east.hw : -14,
      s: south ? south.z + south.hd : -6,
      n: north ? north.z - north.hd : 29,
      tw: tWest ? tWest.x - tWest.hw : 3,
      te: tEast ? tEast.x + tEast.hw : -3,
      tn: end ? end.z - end.hd : 42,
    };
  }

  private build(): void {
    const g = this.group;
    const b = this.bounds();
    const top = 13;
    // Where the light comes from: torches round the walls and in the tunnel, the falls, the portal.
    const torches: Array<[number, number, number, number]> = [
      [b.w - 0.1, 3.2, 4, -Math.PI / 2],
      [b.e + 0.1, 3.2, 4, Math.PI / 2],
      [b.w - 0.1, 3.2, 17, -Math.PI / 2],
      [b.e + 0.1, 3.2, 17, Math.PI / 2],
      [b.w - 0.1, 3.2, 26, -Math.PI / 2],
      [b.e + 0.1, 3.2, 26, Math.PI / 2],
      [b.tw - 0.1, 2.6, b.n + 4, -Math.PI / 2],
      [b.te + 0.1, 2.6, b.n + 9, Math.PI / 2],
    ];
    for (const [x, y, z] of torches) this.lamps.push({ at: new THREE.Vector3(x, y + 1.1, z), color: WARM, power: 2.6, reach: 3.2 });
    for (let k = 0; k < 6; k++) this.lamps.push({ at: new THREE.Vector3(-12 + k * 4.8, 5, b.s + 0.4), color: COOL, power: 1.15, reach: 4.2 });
    const exit = this.def.exit;
    this.lamps.push({ at: new THREE.Vector3(exit.x, 1.8, b.s + 1.5), color: TEAL, power: 1.3, reach: 2.6 });

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
    wall(b.e, b.n, b.te, b.n, [0, -1], 201);
    wall(b.tw, b.n, b.w, b.n, [0, -1], 301);
    wall(b.tw, b.n, b.tw, b.tn, [-1, 0], 401);
    wall(b.te, b.n, b.te, b.tn, [1, 0], 501);
    wall(b.te, b.tn, b.tw, b.tn, [0, -1], 601);
    // The ceiling: slabs, lower in the tunnel, with stalactites.
    for (let x = b.e + 2; x < b.w; x += 5.5)
      for (let z = b.s + 2; z < b.n; z += 5.5)
        rock.push(xf(rockSlab(6.2, 2.2, 6.2, 900 + Math.round(x * 13 + z * 7)), [x + rng() - 0.5, top + rng() * 1.6, z + rng() - 0.5]));
    for (let z = b.n; z < b.tn + 1; z += 4) rock.push(xf(rockSlab(8, 2, 4.6, 1300 + z), [(b.tw + b.te) / 2, 7.2 + rng(), z + 1]));
    for (let k = 0; k < 26; k++) {
      const x = b.e + 2 + rng() * (b.w - b.e - 4);
      const z = b.s + 2 + rng() * (b.n - b.s - 4);
      const len = 0.8 + rng() * 2.6;
      rock.push(
        tint(faceted(jiggle(xf(cone(0.25 + rng() * 0.35, len, 5), [x, top - 0.6 - len / 2, z], [Math.PI, rng() * 3, 0]), 0.06, k)), vary(0x6d665e, rng, 0.1)),
      );
    }
    // Rubble along the foot of the walls.
    for (let k = 0; k < 30; k++) {
      const side = k % 4;
      const along = rng();
      const [x, z] =
        side === 0
          ? [b.w - 0.8, b.s + along * (b.n - b.s)]
          : side === 1
            ? [b.e + 0.8, b.s + along * (b.n - b.s)]
            : side === 2
              ? [b.e + along * (b.w - b.e), b.n - 0.8]
              : [b.te + 0.4 + along * (b.tw - b.te - 0.8), b.n + 1 + rng() * (b.tn - b.n - 2)];
      if (Math.abs(x) < 3 && side === 2) continue;
      rock.push(xf(boulder(0.4 + rng() * 0.8, k + 40), [x, 0.1, z]));
    }
    // The floor: packed earth and rock, wet and darker toward the falls.
    const floor = new THREE.PlaneGeometry(b.w - b.e + 1, b.tn - b.s + 1, 36, 52);
    floor.rotateX(-Math.PI / 2);
    floor.translate((b.w + b.e) / 2, 0, (b.tn + b.s) / 2);
    const fl = faceted(floor);
    tint(fl, (c) => {
      const n = Math.sin(c.x * 1.7 + c.z * 0.9) * Math.sin(c.x * 0.6 - c.z * 1.3);
      const wet = Math.max(0, 1 - (c.z - b.s) / 7);
      return new THREE.Color(0x5e554b).lerp(new THREE.Color(0x40463f), wet * 0.7).multiplyScalar(0.92 + 0.12 * n);
    });
    rock.push(fl);
    this.bakeAndAdd(merge(rock), 'dungeon-rock', false);

    // ---- the back of the falls, and the way out through them ----
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
    const arch = new THREE.Mesh(rockArch(2.8, 3.8, 77), this.unlit);
    this.bake(arch.geometry, new THREE.Matrix4().makeTranslation(exit.x, 0, b.s + 0.6));
    arch.position.set(exit.x, 0, b.s + 0.6);
    arch.name = 'exit-arch';
    g.add(arch);
    const veil = portalVeil(2.9, 3.9, this.veil);
    veil.position.set(exit.x, 0.05, b.s + 0.75);
    (veil.material as THREE.ShaderMaterial).uniforms.uDeep.value = new THREE.Color(0x14303a);
    (veil.material as THREE.ShaderMaterial).uniforms.uRim.value = new THREE.Color(0x8fdce3);
    g.add(veil);

    // ---- what the goblins have built and brought ----
    const props: Array<[THREE.Object3D, string]> = [];
    const landing = this.def.decks.find((d) => d.id === 'landing');
    if (landing) {
      const stage = new THREE.Mesh(plankDeck(landing.hw * 2, landing.hd * 2, 61, landing.top), this.unlit);
      stage.position.set(landing.x, landing.top, landing.z);
      props.push([stage, 'landing-stage']);
    }
    const look = this.box('lookout');
    if (look) {
      const l = lookout(look.top, 5);
      l.position.set(look.x, 0, look.z);
      l.rotation.y = Math.PI;
      props.push([l, 'lookout']);
    }
    const tot = this.box('totem');
    if (tot) {
      const t = totem(this.flickers, tot.top, 9);
      t.position.set(tot.x, 0, tot.z);
      t.rotation.y = -0.5;
      props.push([t, 'totem']);
    }
    const bar = this.box('barricade');
    if (bar) {
      const bb = barricade(bar.hw * 2, 13);
      bb.position.set(bar.x, 0, bar.z);
      bb.rotation.y = Math.PI;
      props.push([bb, 'barricade']);
    }
    // Catch nets either side of the landing, stolen goods in the corners.
    for (const side of [-1, 1]) {
      const n = new THREE.Mesh(net(8, 5.5, 0.45, 0.4), this.unlit);
      n.position.set(side > 0 ? b.w - 1.1 : b.e + 1.1, 0.4, 4);
      n.rotation.y = -side * (Math.PI / 2);
      props.push([n, 'catch-net']);
    }
    const loot: THREE.BufferGeometry[] = [];
    const lr = makeRng(23);
    for (let k = 0; k < 6; k++) loot.push(xf(barrel(0.95, k + 3), [b.w - 1.6 - (k % 3) * 0.75, k >= 3 ? 0.95 : 0, b.n - 1.4 - (k % 2) * 0.7]));
    for (let k = 0; k < 5; k++)
      loot.push(
        tint(xf(bev(1, 0.9, 1, 0.03), [b.e + 1.4 + (k % 3) * 1.05, 0.45 + (k >= 3 ? 0.9 : 0), b.n - 1.5], [0, lr() * 0.5, 0]), vary(PAL.crate, lr, 0.12)),
      );
    for (let k = 0; k < 3; k++)
      loot.push(tint(xf(bev(1.4, 0.7, 0.9, 0.08), [b.e + 1.8, 0.35 + k * 0.7, 14 + k * 0.2], [0, lr() * 0.4, 0]), vary(PAL.canvasShade, lr, 0.1)));
    props.push([new THREE.Mesh(merge(loot), this.unlit), 'loot']);
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
    torches.forEach(([x, y, z, yaw], k) => {
      const t = torch(this.flickers, k + 1);
      t.position.set(x, y, z);
      t.rotation.y = yaw;
      g.add(t);
    });
    for (const [x, z, yaw, seed] of [
      [b.w - 0.25, 10.5, -Math.PI / 2, 3],
      [b.e + 0.25, 21.5, Math.PI / 2, 7],
      [b.tw - 0.2, b.n + 6.5, -Math.PI / 2, 11],
    ] as const) {
      const d = drawings(4.4, 2.2, seed);
      d.position.set(x, 2.6, z);
      d.rotation.y = yaw;
      g.add(d);
    }
  }

  /** Light at a point of the cave facing `n` (both round the origin): a little cool fill, then the lamps. */
  private lightAt(p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color): THREE.Color {
    out.setRGB(0.045, 0.055, 0.065).multiplyScalar(0.7 + 0.6 * Math.max(0, n.y));
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
