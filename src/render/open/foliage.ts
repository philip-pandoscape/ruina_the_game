import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, range } from '../../rng';
import type { Obstacle } from '../../sim/types';
import { hash2, SURFACE, type Heightfield } from '../../sim/terrain';
import { toon } from '../toon';

// Trees and rocks across a whole island, and grass around wherever you are. Trees are instanced
// per 256 m chunk rather than all in one mesh, so the camera culls the chunks it cannot see.

const CHUNK = 256;
const GRASS_RADIUS = 64;
const GRASS_CELL = 1.25;
const GRASS_CAP = 9000;
const FLOWER_CAP = 1400;

function faceted(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

interface Geos {
  trunk: THREE.BufferGeometry;
  round: THREE.BufferGeometry;
  pine: THREE.BufferGeometry;
  rock: THREE.BufferGeometry;
}

function geometries(): Geos {
  const trunk = faceted(new THREE.CylinderGeometry(0.2, 0.3, 1.9, 6));
  trunk.translate(0, 0.95, 0);
  const a = new THREE.IcosahedronGeometry(1.35, 0);
  a.translate(0, 2.6, 0);
  const b = new THREE.IcosahedronGeometry(0.95, 0);
  b.translate(0.4, 3.5, 0.15);
  const c = new THREE.IcosahedronGeometry(0.8, 0);
  c.translate(-0.55, 3.0, -0.35);
  const round = mergeGeometries([a, b, c]);
  const cones = [
    [1.35, 1.7, 1.75],
    [1.05, 1.5, 2.65],
    [0.7, 1.3, 3.45],
  ].map(([r, h, y]) => {
    const g = faceted(new THREE.ConeGeometry(r, h, 7));
    g.translate(0, y, 0);
    return g;
  });
  const pine = mergeGeometries(cones);
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
  return { trunk, round, pine, rock };
}

export class FoliageView {
  readonly group = new THREE.Group();
  private grass: THREE.InstancedMesh;
  private flowers: THREE.InstancedMesh;
  private grassAt = { x: Infinity, z: Infinity };
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private c = new THREE.Color();

  constructor(
    private hf: Heightfield,
    obstacles: readonly Obstacle[],
    private clear: Uint8Array,
    seed: number,
  ) {
    const geo = geometries();
    const rng = makeRng(seed + 1);
    const greens = [0x4caf50, 0x3e9a45, 0x5cb85c, 0x2e7d32, 0x6abf4b].map((h) => new THREE.Color(h));
    const pick = () => greens[Math.floor(rng() * greens.length)].clone().offsetHSL(0, 0, range(rng, -0.04, 0.04));
    const mat = toon(0xffffff);

    // Bucket by chunk.
    const chunks = new Map<number, Obstacle[]>();
    for (const o of obstacles) {
      if (o.kind !== 'tree' && o.kind !== 'rock') continue;
      const k = Math.floor((o.x - hf.min) / CHUNK) * 64 + Math.floor((o.z - hf.min) / CHUNK);
      let list = chunks.get(k);
      if (!list) chunks.set(k, (list = []));
      list.push(o);
    }
    for (const list of chunks.values()) {
      const trees = list.filter((o) => o.kind === 'tree');
      // Pines grow in the highlands and the north; broadleaf in the lowlands.
      const isPine = (o: Obstacle) => hash2(Math.round(o.x * 10), Math.round(o.z * 10), 77) < 0.28 + Math.min(0.5, Math.max(0, (o.z - 100) / 500)) + Math.min(0.3, hf.height(o.x, o.z) / 120);
      const pines = trees.filter(isPine);
      const rounds = trees.filter((o) => !isPine(o));
      const rocks = list.filter((o) => o.kind === 'rock');
      this.place(geo.trunk, mat, trees, () => new THREE.Color(0x8d5a3b));
      this.place(geo.round, mat, rounds, pick);
      this.place(geo.pine, mat, pines, () => pick().offsetHSL(0.02, -0.05, -0.06));
      this.place(geo.rock, mat, rocks, () => new THREE.Color(0x9a9a94).offsetHSL(0, 0, range(rng, -0.06, 0.06)), 0.75);
    }

    // Grass and flowers: a field around the player that moves with them.
    const blade = faceted(new THREE.ConeGeometry(0.07, 0.42, 3));
    blade.translate(0, 0.21, 0);
    const blades = [-1, 0, 1].map((k) => {
      const b = blade.clone();
      b.rotateZ(k * 0.35);
      b.translate(k * 0.06, 0, 0);
      b.rotateY(k * 1.1);
      return b;
    });
    this.grass = new THREE.InstancedMesh(mergeGeometries(blades), toon(0xffffff), GRASS_CAP);
    this.grass.frustumCulled = false;
    this.grass.receiveShadow = true;
    this.grass.count = 0;
    const flower = new THREE.IcosahedronGeometry(0.075, 0);
    flower.translate(0, 0.17, 0);
    this.flowers = new THREE.InstancedMesh(flower, toon(0xffffff), FLOWER_CAP);
    this.flowers.frustumCulled = false;
    this.flowers.count = 0;
    this.group.add(this.grass, this.flowers);
  }

  private place(geo: THREE.BufferGeometry, mat: THREE.Material, items: Obstacle[], color: (o: Obstacle) => THREE.Color, squashY = 1): void {
    if (!items.length) return;
    const mesh = new THREE.InstancedMesh(geo, mat, items.length);
    items.forEach((o, i) => {
      this.q.setFromAxisAngle(this.up, o.rot);
      this.m.compose(this.v.set(o.x, this.hf.height(o.x, o.z) - 0.05, o.z), this.q, this.s.set(o.scale, o.scale * squashY, o.scale));
      mesh.setMatrixAt(i, this.m);
      mesh.setColorAt(i, color(o));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
  }

  /** Lays the grass again on the next update (the ground changed: a new plot, a house). */
  invalidate(): void {
    this.grassAt = { x: Infinity, z: Infinity };
  }

  /** Re-seeds the grass around (x, z) once you have moved far enough from where it was laid. */
  update(x: number, z: number): void {
    if (Math.hypot(x - this.grassAt.x, z - this.grassAt.z) < 10) return;
    this.grassAt = { x, z };
    const hf = this.hf;
    const grassCols = [0x6fb64a, 0x5aa33f, 0x82c95b, 0x4f9a38];
    const flowerCols = [0xffffff, 0xffe066, 0xff8fab, 0xb8a1ff];
    let g = 0;
    let f = 0;
    const r = GRASS_RADIUS;
    const i0 = Math.floor((x - r) / GRASS_CELL);
    const i1 = Math.floor((x + r) / GRASS_CELL);
    const j0 = Math.floor((z - r) / GRASS_CELL);
    const j1 = Math.floor((z + r) / GRASS_CELL);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const h0 = hash2(i, j, 5151);
        if (h0 > 0.62) continue;
        const px = (i + hash2(i, j, 17)) * GRASS_CELL;
        const pz = (j + hash2(i, j, 29)) * GRASS_CELL;
        const dx = px - x;
        const dz = pz - z;
        if (dx * dx + dz * dz > r * r) continue;
        if (!hf.inside(px, pz, 2)) continue;
        const ci = Math.floor((px - hf.min) / hf.cell);
        const cj = Math.floor((pz - hf.min) / hf.cell);
        const s = hf.surface[cj * hf.cells + ci];
        if (s !== SURFACE.grass && s !== SURFACE.forest) continue;
        if (this.clear[cj * hf.cells + ci]) continue; // roadsides, floors, plots
        const h = hf.height(px, pz);
        if (h < hf.water + 0.4 || hf.slope(px, pz) > 0.9) continue;
        const scale = 0.7 + hash2(i, j, 41) * 0.65;
        this.q.setFromAxisAngle(this.up, hash2(i, j, 53) * Math.PI * 2);
        this.m.compose(this.v.set(px, h - 0.02, pz), this.q, this.s.set(scale, scale, scale));
        const flower = h0 < 0.045;
        if (flower && f < FLOWER_CAP) {
          this.flowers.setMatrixAt(f, this.m);
          this.flowers.setColorAt(f, this.c.setHex(flowerCols[Math.floor(hash2(i, j, 61) * 4)]));
          f++;
        } else if (g < GRASS_CAP) {
          this.grass.setMatrixAt(g, this.m);
          this.grass.setColorAt(g, this.c.setHex(grassCols[Math.floor(hash2(i, j, 67) * 4)]).offsetHSL(0, 0, s === SURFACE.forest ? -0.06 : 0));
          g++;
        }
      }
    this.grass.count = g;
    this.flowers.count = f;
    this.grass.instanceMatrix.needsUpdate = true;
    this.flowers.instanceMatrix.needsUpdate = true;
    if (this.grass.instanceColor) this.grass.instanceColor.needsUpdate = true;
    if (this.flowers.instanceColor) this.flowers.instanceColor.needsUpdate = true;
  }
}
