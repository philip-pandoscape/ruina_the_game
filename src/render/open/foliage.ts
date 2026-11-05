import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, range } from '../../rng';
import type { Obstacle } from '../../sim/types';
import { hash2, SURFACE, type Heightfield } from '../../sim/terrain';
import { NEW_LOOK, PALETTE } from '../look';
import { toon } from '../toon';

// Trees and rocks across a whole island, and grass around wherever you are. Trees are instanced
// per 256 m chunk rather than all in one mesh, so the camera culls the chunks it cannot see.

const CHUNK = NEW_LOOK ? 128 : 256;
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

// The new look's soft light: a canopy's normals point out from its middle, so it shades like a ball
// of leaves rather than a cut gem; grass takes the light of the ground it grows from.
function puffy(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!NEW_LOOK) return g;
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    n.setXYZ(i, v.x, v.y, v.z);
  }
  n.needsUpdate = true;
  return g;
}

function upright(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!NEW_LOOK) return g;
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  n.needsUpdate = true;
  return g;
}

function geometries(): Geos {
  const trunk = faceted(new THREE.CylinderGeometry(0.2, 0.3, 1.9, 6));
  trunk.translate(0, 0.95, 0);
  const a = puffy(new THREE.IcosahedronGeometry(1.35, 0));
  a.translate(0, 2.6, 0);
  const b = puffy(new THREE.IcosahedronGeometry(0.95, 0));
  b.translate(0.4, 3.5, 0.15);
  const c = puffy(new THREE.IcosahedronGeometry(0.8, 0));
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

// ---------- the new look's trees ----------
// Full-size trees: a broadleaf about 10 m tall with a canopy of many lumps, and a pine of jagged
// tiers about 12 m tall, both shaded darker underneath and inside (baked into vertex colours) so
// they read as masses of leaves. The trunk's foot keeps the width of the tree's collider. Each comes
// in two levels of detail: the near one for the chunks around you, a plain one for the rest.

/** Darkens a geometry's vertex colours by height and closeness to a centre, like light in a canopy. */
function shade(g: THREE.BufferGeometry, y0: number, y1: number, cx: number, cy: number, cz: number, reach: number, floor = 0.5): THREE.BufferGeometry {
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const up = THREE.MathUtils.clamp((p.getY(i) - y0) / (y1 - y0), 0, 1);
    const out = THREE.MathUtils.clamp(Math.hypot(p.getX(i) - cx, (p.getY(i) - cy) * 0.6, p.getZ(i) - cz) / reach, 0, 1);
    const k = floor + (1 - floor) * (0.55 * up + 0.45 * out);
    col.set([k, k, k], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function plain(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const col = new Float32Array(g.attributes.position.count * 3).fill(1);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** A lump of leaves: a ball pushed in and out a little, its normals leaning out from the canopy's middle. */
function lump(r: number, detail: number, at: [number, number, number], centre: THREE.Vector3, seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 + (hash2(Math.round(v.x * 40) + seed * 7, Math.round(v.y * 40 + v.z * 13), 311) - 0.5) * 0.26;
    p.setXYZ(i, v.x * k, v.y * k, v.z * k);
  }
  g.translate(at[0], at[1], at[2]);
  const n = g.attributes.normal;
  const own = new THREE.Vector3();
  const out = new THREE.Vector3();
  const c = new THREE.Vector3(...at);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    own.copy(v).sub(c).normalize();
    out.copy(v).sub(centre).normalize();
    own.lerp(out, 0.6).normalize();
    n.setXYZ(i, own.x, own.y, own.z);
  }
  return g;
}

/** A trunk from the ground up, its foot as wide as the tree's collider (0.45 m at scale 1). */
function trunkGeo(top: number, sides: number, branches: boolean): THREE.BufferGeometry {
  const parts = [new THREE.CylinderGeometry(0.24, 0.45, top, sides).translate(0, top / 2, 0)];
  if (branches) {
    const branch = (to: [number, number, number], from: number, r: number) => {
      const dir = new THREE.Vector3(...to).sub(new THREE.Vector3(0, from, 0));
      const g = new THREE.CylinderGeometry(r * 0.6, r, dir.length(), 5).translate(0, dir.length() / 2, 0);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()));
      g.translate(0, from, 0);
      return g;
    };
    parts.push(branch([1.5, 6.0, 0.5], 3.6, 0.18), branch([-1.3, 6.2, -0.7], 4.0, 0.16), branch([0.3, 6.4, 1.5], 4.4, 0.14));
  }
  return plain(mergeGeometries(parts.map((g) => g.toNonIndexed())));
}

function broadleafCanopy(detail: number): THREE.BufferGeometry {
  const centre = new THREE.Vector3(0, 7.0, 0);
  const all: Array<[number, number, number, number]> = [
    [0, 7.2, 0, 2.6],
    [1.9, 6.4, 0.6, 1.9],
    [-1.8, 6.6, -0.5, 2.0],
    [0.5, 6.2, -1.9, 1.8],
    [-0.6, 6.3, 1.9, 1.8],
    [1.0, 8.5, 0.4, 1.7],
    [-1.0, 8.2, -0.6, 1.6],
    [0.2, 9.3, -0.1, 1.2],
    [1.6, 5.4, -1.2, 1.3],
    [-1.5, 5.5, 1.3, 1.3],
  ];
  const few: Array<[number, number, number, number]> = [
    [0, 7.2, 0, 2.9],
    [1.6, 6.3, 0.5, 2.0],
    [-1.6, 6.5, -0.5, 2.1],
    [0, 8.4, 0, 1.9],
  ];
  const parts = (detail > 0 ? all : few).map(([x, y, z, r], k) => lump(r, detail, [x, y, z], centre, k).toNonIndexed());
  return shade(mergeGeometries(parts), 4.4, 9.8, 0, 7.0, 0, 3.4);
}

function pineCanopy(detail: number): THREE.BufferGeometry {
  const tiers = detail > 0 ? 7 : 4;
  const segs = detail > 0 ? 11 : 7;
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < tiers; k++) {
    const u = k / (tiers - 1);
    const radius = 3.1 - u * 2.4;
    const height = 3.2 - u * 1.2;
    const y0 = 2.2 + u * 8.6;
    const g = new THREE.ConeGeometry(radius, height, segs, 2, true).toNonIndexed();
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y < -height / 2 + 1e-3) {
        // The rim: ragged, and drooping where the boughs are longest.
        const a = Math.atan2(p.getZ(i), p.getX(i));
        const ragged = 1 + 0.18 * Math.sin(a * segs * 0.5 + k * 1.7) + (hash2(Math.round(a * 100), k, 97) - 0.5) * 0.16;
        p.setXYZ(i, p.getX(i) * ragged, y - 0.35 * ragged, p.getZ(i) * ragged);
      }
    }
    g.translate(0, y0 + height / 2, 0);
    g.computeVertexNormals();
    // Soften: lean each normal out from the trunk, so tiers shade as boughs, not as cut cones.
    const n = g.attributes.normal;
    const v = new THREE.Vector3();
    const own = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.set(p.getX(i), 0.6, p.getZ(i)).normalize();
      v.lerp(own.set(n.getX(i), n.getY(i), n.getZ(i)), 0.5).normalize();
      n.setXYZ(i, v.x, v.y, v.z);
    }
    parts.push(shade(g, y0 - 0.4, y0 + height, 0, y0 + height * 0.3, 0, radius, 0.45));
  }
  return mergeGeometries(parts);
}

type Lod = [THREE.BufferGeometry, THREE.BufferGeometry];

interface TreeLods {
  trunk: Lod;
  pineTrunk: Lod;
  round: Lod;
  pine: Lod;
}

function treeLods(): TreeLods {
  return {
    trunk: [trunkGeo(6.2, 8, true), trunkGeo(6.2, 5, false)],
    pineTrunk: [trunkGeo(10.5, 7, false), trunkGeo(10.5, 5, false)],
    round: [broadleafCanopy(1), broadleafCanopy(0)],
    pine: [pineCanopy(1), pineCanopy(0)],
  };
}

/** Within this far of a tree chunk's middle, its trees are drawn in full detail. */
const TREE_NEAR = 230;
/** Blossom trees, pink, near the town square, as in the island's reference picture. */
const BLOSSOM = [0xf2b5c8, 0xeaa0bb, 0xf6c7d6, 0xe7a6c0];
const TOWN = { x: 0, z: -264, r: 190 };

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
    const greens = PALETTE.leaves.map((h) => new THREE.Color(h));
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
    const lods = NEW_LOOK ? treeLods() : null;
    const treeMat = NEW_LOOK ? toon(0xffffff, { vertexColors: true }) : mat;
    for (const list of chunks.values()) {
      const trees = list.filter((o) => o.kind === 'tree');
      // Pines grow in the highlands and the north; broadleaf in the lowlands.
      const isPine = (o: Obstacle) => hash2(Math.round(o.x * 10), Math.round(o.z * 10), 77) < 0.28 + Math.min(0.5, Math.max(0, (o.z - 100) / 500)) + Math.min(0.3, hf.height(o.x, o.z) / 120);
      const pines = trees.filter(isPine);
      const rounds = trees.filter((o) => !isPine(o));
      const rocks = list.filter((o) => o.kind === 'rock');
      if (lods) {
        const blossom = (o: Obstacle) => Math.hypot(o.x - TOWN.x, o.z - TOWN.z) < TOWN.r && hash2(Math.round(o.x * 10), Math.round(o.z * 10), 131) < 0.35;
        const bark = () => new THREE.Color(PALETTE.trunk).offsetHSL(0, 0, range(rng, -0.04, 0.03));
        const leafy = (o: Obstacle) => (blossom(o) ? new THREE.Color(BLOSSOM[Math.floor(rng() * BLOSSOM.length)]) : pick());
        this.placeLod(lods.trunk, treeMat, rounds, bark);
        this.placeLod(lods.pineTrunk, treeMat, pines, bark);
        this.placeLod(lods.round, treeMat, rounds, leafy);
        this.placeLod(lods.pine, treeMat, pines, () => pick().offsetHSL(0.03, -0.08, -0.08));
      } else {
        this.place(geo.trunk, mat, trees, () => new THREE.Color(PALETTE.trunk));
        this.place(geo.round, mat, rounds, pick);
        this.place(geo.pine, mat, pines, () => pick().offsetHSL(0.02, -0.05, -0.06));
      }
      this.place(geo.rock, mat, rocks, () => new THREE.Color(PALETTE.rock).offsetHSL(0, 0, range(rng, -0.06, 0.06)), 0.75);
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
    this.grass = new THREE.InstancedMesh(upright(mergeGeometries(blades)), toon(0xffffff), GRASS_CAP);
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

  private place(geo: THREE.BufferGeometry, mat: THREE.Material, items: Obstacle[], color: (o: Obstacle) => THREE.Color, squashY = 1): THREE.InstancedMesh | null {
    if (!items.length) return null;
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
    return mesh;
  }

  private lodMeshes: Array<{ mesh: THREE.InstancedMesh; lod: Lod; x: number; z: number }> = [];

  /** Trees with a near and a far shape: the chunk's mesh swaps between them as you come and go. */
  private placeLod(lod: Lod, mat: THREE.Material, items: Obstacle[], color: (o: Obstacle) => THREE.Color): void {
    const mesh = this.place(lod[1], mat, items, color);
    if (!mesh) return;
    let cx = 0;
    let cz = 0;
    for (const o of items) {
      cx += o.x / items.length;
      cz += o.z / items.length;
    }
    this.lodMeshes.push({ mesh, lod, x: cx, z: cz });
  }

  /** Near chunks get the detailed trees; each keeps the bounding sphere its far shape gave it. */
  private updateLod(x: number, z: number): void {
    for (const t of this.lodMeshes) {
      const geo = t.lod[Math.hypot(t.x - x, t.z - z) < TREE_NEAR ? 0 : 1];
      if (t.mesh.geometry !== geo) t.mesh.geometry = geo;
    }
  }

  /** Lays the grass again on the next update (the ground changed: a new plot, a house). */
  invalidate(): void {
    this.grassAt = { x: Infinity, z: Infinity };
  }

  /** Re-seeds the grass around (x, z) once you have moved far enough from where it was laid. */
  update(x: number, z: number): void {
    this.updateLod(x, z);
    if (Math.hypot(x - this.grassAt.x, z - this.grassAt.z) < 10) return;
    this.grassAt = { x, z };
    const hf = this.hf;
    const grassCols = PALETTE.grass;
    const flowerCols = PALETTE.flowers;
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
