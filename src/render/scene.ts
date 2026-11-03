import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, range } from '../rng';
import type { Obstacle, World } from '../sim/types';
import { toon } from './toon';

const SKY = 0xbfe3f2;
const YARD = { x: 0, z: 1.5, r: 7 };

export interface Terrain {
  flatRadius: number; // flat play area
  hillWidth: number; // how far the hills take to rise
  hillHeight: number;
}

export interface StageOptions {
  terrain: Terrain;
  groundSize: number;
  groundSegments: number;
  grass: number;
  flowers: number;
  plantRadius: number;
  fogNear: number;
  fogFar: number;
  yard: boolean;
  worldTree: { x: number; z: number; scale: number };
}

export const TRAINING_STAGE: StageOptions = {
  terrain: { flatRadius: 34, hillWidth: 30, hillHeight: 9 },
  groundSize: 240,
  groundSegments: 120,
  grass: 2600,
  flowers: 340,
  plantRadius: 46,
  fogNear: 32,
  fogFar: 105,
  yard: true,
  worldTree: { x: -70, z: 240, scale: 1 },
};

export const BATTLEFIELD_STAGE: StageOptions = {
  terrain: { flatRadius: 150, hillWidth: 60, hillHeight: 18 },
  groundSize: 760,
  groundSegments: 152,
  grass: 9000,
  flowers: 1200,
  plantRadius: 150,
  fogNear: 90,
  fogFar: 420,
  yard: false,
  worldTree: { x: -170, z: 560, scale: 2.2 },
};

// Flat play area in the middle, rolling hills beyond it.
export function groundHeight(x: number, z: number, t: Terrain = TRAINING_STAGE.terrain): number {
  const r = Math.hypot(x, z);
  if (r < t.flatRadius) return 0;
  const k = Math.min(1, (r - t.flatRadius) / t.hillWidth);
  const rise = k * k * (3 - 2 * k);
  const a = Math.atan2(z, x);
  const bumps = 0.65 + 0.35 * Math.sin(a * 5 + 1.3) * Math.cos(a * 3 - 0.7) + 0.2 * Math.sin(x * 0.21) * Math.cos(z * 0.17);
  return rise * t.hillHeight * bumps;
}

// Faceted low-poly shading: split shared vertices so each face gets its own normal.
function faceted(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

// The world around the player: lights, ground, trees, rocks, props and plants.
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly sun: THREE.DirectionalLight;
  private height: (x: number, z: number) => number;

  constructor(canvas: HTMLCanvasElement, world: World, private opts: StageOptions = TRAINING_STAGE) {
    this.height = (x, z) => groundHeight(x, z, opts.terrain);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, opts.fogNear, opts.fogFar);

    this.scene.add(new THREE.HemisphereLight(0xdff1ff, 0x5d7f3a, 1.25));
    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const cam = this.sun.shadow.camera;
    cam.left = -22;
    cam.right = 22;
    cam.top = 22;
    cam.bottom = -22;
    cam.near = 1;
    cam.far = 90;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    this.buildGround();
    this.buildObstacles(world);
    this.buildPlants(world);
    this.buildWorldTree();
  }

  // Keeps the sun's shadow area centred on the player.
  follow(x: number, z: number): void {
    this.sun.position.set(x + 14, 24, z + 9);
    this.sun.target.position.set(x, 0, z);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
  }

  private placeInstances(
    geo: THREE.BufferGeometry,
    items: Obstacle[],
    color: (i: number) => THREE.Color,
    squashY = 1,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, toon(0xffffff), items.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    items.forEach((o, i) => {
      q.setFromAxisAngle(up, o.rot);
      m.compose(
        new THREE.Vector3(o.x, this.height(o.x, o.z), o.z),
        q,
        new THREE.Vector3(o.scale, o.scale * squashY, o.scale),
      );
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, color(i));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    this.scene.add(mesh);
    return mesh;
  }

  private buildGround(): void {
    const { groundSize, groundSegments } = this.opts;
    const geo = new THREE.PlaneGeometry(groundSize, groundSize, groundSegments, groundSegments);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const a = new THREE.Color(0x86c55a);
    const b = new THREE.Color(0x5fa843);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, this.height(x, z));
      const n = 0.5 + 0.5 * Math.sin(x * 0.35 + Math.cos(z * 0.27) * 2) * Math.cos(z * 0.31 - x * 0.12);
      c.copy(a).lerp(b, n);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, toon(0xffffff, { vertexColors: true }));
    ground.receiveShadow = true;
    this.scene.add(ground);

    if (!this.opts.yard) return;
    // Packed-dirt training yard with a slightly ragged edge.
    const yard = new THREE.CircleGeometry(YARD.r, 40);
    const yp = yard.attributes.position;
    for (let i = 1; i < yp.count; i++) {
      const x = yp.getX(i);
      const y = yp.getY(i);
      const f = 1 + 0.06 * Math.sin(Math.atan2(y, x) * 7) + 0.03 * Math.sin(Math.atan2(y, x) * 13);
      yp.setXY(i, x * f, y * f);
    }
    yard.rotateX(-Math.PI / 2);
    const yardMat = toon(0xc9a46a, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const yardMesh = new THREE.Mesh(yard, yardMat);
    yardMesh.position.set(YARD.x, 0.01, YARD.z);
    yardMesh.receiveShadow = true;
    this.scene.add(yardMesh);
  }

  private buildObstacles(world: World): void {
    const rng = makeRng(world.seed + 1);
    const trees = world.obstacles.filter((o) => o.kind === 'tree');
    const round = trees.filter((_, i) => i % 3 !== 0);
    const pines = trees.filter((_, i) => i % 3 === 0);
    const greens = [0x4caf50, 0x3e9a45, 0x5cb85c, 0x2e7d32, 0x6abf4b].map((h) => new THREE.Color(h));
    const pick = () => greens[Math.floor(rng() * greens.length)].clone().offsetHSL(0, 0, range(rng, -0.04, 0.04));

    const trunk = faceted(new THREE.CylinderGeometry(0.2, 0.3, 1.9, 6));
    trunk.translate(0, 0.95, 0);
    this.placeInstances(trunk, [...round, ...pines], () => new THREE.Color(0x8d5a3b));

    const blobA = new THREE.IcosahedronGeometry(1.35, 0);
    blobA.translate(0, 2.6, 0);
    const blobB = new THREE.IcosahedronGeometry(0.95, 0);
    blobB.translate(0.4, 3.5, 0.15);
    const blobC = new THREE.IcosahedronGeometry(0.8, 0);
    blobC.translate(-0.55, 3.0, -0.35);
    this.placeInstances(mergeGeometries([blobA, blobB, blobC]), round, pick);

    const cones = [
      [1.35, 1.7, 1.75],
      [1.05, 1.5, 2.65],
      [0.7, 1.3, 3.45],
    ].map(([r, h, y]) => {
      const g = faceted(new THREE.ConeGeometry(r, h, 7));
      g.translate(0, y, 0);
      return g;
    });
    this.placeInstances(mergeGeometries(cones), pines, () => pick().offsetHSL(0.02, -0.05, -0.06));

    const rock = new THREE.DodecahedronGeometry(0.75, 0);
    const rp = rock.attributes.position;
    for (let i = 0; i < rp.count; i++) {
      const x = rp.getX(i);
      const y = rp.getY(i);
      const z = rp.getZ(i);
      const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
      const f = 0.82 + 0.32 * (h - Math.floor(h));
      rp.setXYZ(i, x * f, y * f, z * f);
    }
    rock.computeVertexNormals();
    rock.translate(0, 0.3, 0);
    const rocks = world.obstacles.filter((o) => o.kind === 'rock');
    this.placeInstances(rock, rocks, () => new THREE.Color(0x9a9a94).offsetHSL(0, 0, range(rng, -0.06, 0.06)), 0.75);

    const crate = new RoundedBoxGeometry(0.9, 0.9, 0.9, 2, 0.06);
    crate.translate(0, 0.45, 0);
    const crates = world.obstacles.filter((o) => o.kind === 'crate');
    if (crates.length) this.placeInstances(crate, crates, () => new THREE.Color(0xb07a45).offsetHSL(0, 0, range(rng, -0.05, 0.05)));

    const hay = faceted(new THREE.CylinderGeometry(0.55, 0.55, 1.15, 10));
    hay.rotateZ(Math.PI / 2);
    hay.translate(0, 0.55, 0);
    const bales = world.obstacles.filter((o) => o.kind === 'hay');
    if (bales.length) this.placeInstances(hay, bales, () => new THREE.Color(0xe2c158));
  }

  private buildPlants(world: World): void {
    const rng = makeRng(world.seed + 2);
    const { yard, plantRadius } = this.opts;
    const blocked = (x: number, z: number) =>
      (yard && Math.hypot(x - YARD.x, z - YARD.z) < YARD.r + 0.3) ||
      world.obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 0.2);

    const blade = faceted(new THREE.ConeGeometry(0.07, 0.4, 3));
    blade.translate(0, 0.2, 0);
    const blades = [-1, 0, 1].map((k) => {
      const b = blade.clone();
      b.rotateZ(k * 0.35);
      b.translate(k * 0.06, 0, 0);
      b.rotateY(k * 1.1);
      return b;
    });
    const tuftGeo = mergeGeometries(blades);
    const flowerGeo = new THREE.IcosahedronGeometry(0.075, 0);
    flowerGeo.translate(0, 0.16, 0);

    const scatter = (count: number, maxR: number, colors: THREE.Color[], geo: THREE.BufferGeometry) => {
      const items: Obstacle[] = [];
      let tries = 0;
      while (items.length < count && tries < count * 4) {
        tries++;
        const a = rng() * Math.PI * 2;
        const r = Math.sqrt(rng()) * maxR;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        if (blocked(x, z)) continue;
        items.push({ kind: 'rock', x, z, r: 0, scale: range(rng, 0.7, 1.35), rot: rng() * Math.PI * 2 });
      }
      const mesh = this.placeInstances(geo, items, () => colors[Math.floor(rng() * colors.length)].clone());
      mesh.castShadow = false;
    };

    scatter(this.opts.grass, plantRadius, [0x6fb64a, 0x5aa33f, 0x82c95b, 0x4f9a38].map((h) => new THREE.Color(h)), tuftGeo);
    scatter(this.opts.flowers, plantRadius * 0.87, [0xffffff, 0xffe066, 0xff8fab, 0xb8a1ff].map((h) => new THREE.Color(h)), flowerGeo);
  }

  // A giant tree on the horizon: the world tree the game is named after. It sits far past the
  // fog with hazy colours baked in, so it reads as a silhouette rising above the hills.
  private buildWorldTree(): void {
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(faceted(new THREE.CylinderGeometry(5, 9, 40, 8)), toon(0x9db3b6, { fog: false }));
    trunk.position.y = 20;
    tree.add(trunk);
    const leaf = toon(0x93c2ab, { fog: false });
    const blobs: Array<[number, number, number, number]> = [
      [0, 40, 0, 16],
      [-17, 36, 5, 11],
      [16, 37, -4, 12],
      [5, 48, 4, 10],
      [-8, 45, -9, 10],
    ];
    for (const [x, y, z, r] of blobs) {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), leaf);
      m.position.set(x, y, z);
      tree.add(m);
    }
    const { x, z, scale } = this.opts.worldTree;
    tree.position.set(x, 0, z);
    tree.scale.setScalar(scale);
    this.scene.add(tree);
  }
}
