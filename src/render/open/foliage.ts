import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, range } from '../../util/rng';
import type { Obstacle } from '../../engine/rules';
import { hash2, SURFACE, type Heightfield } from '../../engine/zone';
import { track } from '../assets';
import { GRAPHICS, PALETTE } from '../look';
import { ROCKS, madeProp } from '../models/glb';
import type { MadeModel } from '../../content/looks';
import { bushClumps, clumpDepthMaterial, clumpMaterial, clumpTexture, crownClumps, type CrownShape, pineClumps, type PineShape, tuftTexture } from './canopy';
import { barkTexture, solidMaterial } from './leaves';
import { toon } from '../toon';

// Trees and rocks across a whole region, and grass around wherever you are. Trees are instanced
// per 128 m chunk rather than all in one mesh, so the camera culls the chunks it cannot see. How
// far round you the grass and the undergrowth reach, and how near trees take their full shape,
// is the quality's (src/render/look.ts).

const CHUNK = 128;
const GRASS_RADIUS = GRAPHICS.grassReach;
const GRASS_CELL = 1.25;
const GRASS_CAP = 9000;
const FLOWER_CAP = 1400;
/** The undergrowth: low bushes in a field around you, one chance per cell. */
const BUSH_RADIUS = GRAPHICS.bushReach;
const BUSH_CELL = 5;
const BUSH_CAP = 2600;

function faceted(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

// Grass takes the light of the ground it grows from: its normals all point straight up.
function upright(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  n.needsUpdate = true;
  return g;
}

/** A loose rock, drawn until the made boulder for it has loaded. */
function rockGeometry(): THREE.BufferGeometry {
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
  return rock;
}

// ---------- trees ----------
// Full-size trees: a broadleaf about 10 m tall (or a taller, narrower one) and a pine about 13 m
// tall, their crowns soft masses of leaf clumps or needle tufts that turn to face the camera
// (src/render/open/canopy.ts). The trunk's foot keeps the width of the tree's collider. Near the
// camera a crown is a few hundred clumps; far off, fewer and bigger ones make the same shape.

function plain(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const col = new Float32Array(g.attributes.position.count * 3).fill(1);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** A trunk from the ground up, its foot as wide as the tree's collider (0.45 m at scale 1). */
function trunkGeo(top: number, sides: number, branches: boolean): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.24, 0.45, top, sides, 6).translate(0, top / 2, 0);
  if (sides >= 7) {
    // Roots: the foot flares out in ribs over the last half metre, onto the ground round it.
    const p = trunk.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y > 0.9) continue;
      const a = Math.atan2(p.getZ(i), p.getX(i));
      const rib = Math.max(0, Math.cos(a * 5 + 0.7));
      const flare = 1 + (1 - y / 0.9) ** 2 * (0.25 + 0.75 * rib * rib);
      p.setXYZ(i, p.getX(i) * flare, y, p.getZ(i) * flare);
    }
    trunk.computeVertexNormals();
  }
  const parts = [trunk];
  if (branches) {
    const branch = (to: [number, number, number], from: number, r: number) => {
      const dir = new THREE.Vector3(...to).sub(new THREE.Vector3(0, from, 0));
      const g = new THREE.CylinderGeometry(r * 0.6, r, dir.length(), 5).translate(0, dir.length() / 2, 0);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()));
      g.translate(0, from, 0);
      return g;
    };
    // Boughs up into the crown, seen under it and through its gaps.
    parts.push(
      branch([1.7, 6.6, 0.5], 3.4, 0.2),
      branch([-1.5, 6.8, -0.8], 3.8, 0.18),
      branch([0.4, 6.9, 1.8], 4.2, 0.17),
      branch([-0.7, 6.4, -1.7], 4.4, 0.15),
      branch([1.2, 8.0, -0.9], 4.9, 0.14),
    );
  }
  return plain(mergeGeometries(parts.map((g) => g.toNonIndexed())));
}

/** A broad, rounded crown (oak, linden): balls round a middle 7 m up. */
const ROUND: CrownShape = {
  lumps: [
    [0, 7.4, 0, 2.5],
    [2.0, 6.8, 0.4, 1.9],
    [-1.9, 6.9, -0.6, 1.9],
    [0.6, 6.7, 2.0, 1.8],
    [-0.5, 6.8, -2.0, 1.8],
    [1.4, 6.0, -1.5, 1.5],
    [-1.4, 6.1, 1.4, 1.5],
    [0.9, 8.7, 0.6, 1.7],
    [-0.9, 8.6, -0.5, 1.7],
    [0.1, 9.5, 0, 1.3],
    [0, 5.6, 0, 1.6],
  ],
  middle: new THREE.Vector3(0, 7.2, 0),
};

/** A taller, oval crown (elm, birch). */
const OVAL: CrownShape = {
  lumps: [
    [0, 6.8, 0, 1.9],
    [0, 8.4, 0, 2.1],
    [0, 10.0, 0, 1.8],
    [0, 11.3, 0, 1.2],
    [1.2, 7.5, 0.5, 1.4],
    [-1.2, 7.7, -0.4, 1.4],
    [0.5, 9.2, -1.2, 1.3],
    [-0.5, 9.0, 1.2, 1.3],
  ],
  middle: new THREE.Vector3(0, 8.8, 0),
};

const PINE: PineShape = {
  tiers: Array.from({ length: 7 }, (_, k) => {
    const u = k / 6;
    return { y0: 2.0 + u * 8.8, radius: 3.2 - u * 2.5, height: 3.0 - u * 1.2 };
  }),
  top: 13.2,
};

type Lod = [THREE.BufferGeometry, THREE.BufferGeometry];

/** A tree's crown stretched its own way, [across, up], so a wood of one shape doesn't look cloned. */
type Stretch = (o: Obstacle) => [number, number];

const crownShape: Stretch = (o) => [
  0.86 + hash2(Math.round(o.x * 10), Math.round(o.z * 10), 167) * 0.3,
  0.88 + hash2(Math.round(o.x * 10), Math.round(o.z * 10), 173) * 0.3,
];
const pineShape: Stretch = (o) => [
  0.84 + hash2(Math.round(o.x * 10), Math.round(o.z * 10), 179) * 0.28,
  0.9 + hash2(Math.round(o.x * 10), Math.round(o.z * 10), 181) * 0.28,
];

interface TreeLods {
  trunk: Lod;
  pineTrunk: Lod;
  round: Lod;
  oval: Lod;
  pine: Lod;
}

/**
 * Each tree's near and far shape. The quality can thin the far crowns (GRAPHICS.farClumps: fewer
 * clumps, each bigger, so the crown stays as full), and where no tree is ever near enough for its
 * near shape (GRAPHICS.treeNear 0) the far shape stands in for both.
 */
function treeLods(): TreeLods {
  const k = GRAPHICS.farClumps;
  const grow = 1 / Math.sqrt(k);
  const far = {
    trunk: trunkGeo(6.2, 5, false),
    pineTrunk: trunkGeo(11.5, 5, false),
    round: crownClumps(ROUND, 0.42 * k, [1.05 * grow, 1.45 * grow], 42),
    oval: crownClumps(OVAL, 0.42 * k, [1.0 * grow, 1.4 * grow], 48),
    pine: pineClumps(PINE, 3 * k, [0.85 * grow, 1.2 * grow], 44),
  };
  const near = GRAPHICS.treeNear > 0;
  return {
    trunk: [near ? trunkGeo(6.2, 8, true) : far.trunk, far.trunk],
    pineTrunk: [near ? trunkGeo(11.5, 7, false) : far.pineTrunk, far.pineTrunk],
    round: [near ? crownClumps(ROUND, 2.4, [0.45, 0.7], 41) : far.round, far.round],
    oval: [near ? crownClumps(OVAL, 2.4, [0.44, 0.66], 47) : far.oval, far.oval],
    pine: [near ? pineClumps(PINE, 15, [0.4, 0.62], 43) : far.pine, far.pine],
  };
}

/** Pines grow in the highlands and the north; broadleaf in the lowlands. (The look test asks too.) */
export function isPine(x: number, z: number, height: number): boolean {
  return hash2(Math.round(x * 10), Math.round(z * 10), 77) < 0.28 + Math.min(0.5, Math.max(0, (z - 100) / 500)) + Math.min(0.3, height / 120);
}

/** Within this far of a tree chunk's middle, its trees are drawn in full detail. */
const TREE_NEAR = GRAPHICS.treeNear;
/** Blossom trees, pink, near the town square, as in Emberholm's reference picture. */
const BLOSSOM = [0xf2b5c8, 0xeaa0bb, 0xf6c7d6, 0xe7a6c0];
const TOWN = { x: 0, z: -264, r: 190 };

export class FoliageView {
  readonly group = new THREE.Group();
  private grass: THREE.InstancedMesh;
  private flowers: THREE.InstancedMesh;
  private bushes: THREE.InstancedMesh;
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
    /** Somewhere no crag may cover (a waterfall's slot): true if a crag `r` across at (x, z) would. */
    private keepOff: (x: number, z: number, r: number) => boolean = () => false,
  ) {
    const rock = rockGeometry();
    const rng = makeRng(seed + 1);
    const greens = PALETTE.leaves.map((h) => new THREE.Color(h));
    const pick = () => greens[Math.floor(rng() * greens.length)].clone().offsetHSL(0, 0, range(rng, -0.04, 0.04));
    const mat = toon(0xffffff);

    // Bucket by chunk.
    const chunks = new Map<number, Obstacle[]>();
    for (const o of obstacles) {
      if (o.kind !== 'tree' && o.kind !== 'rock') continue;
      const k = Math.floor((o.x - hf.minX) / CHUNK) * 64 + Math.floor((o.z - hf.minZ) / CHUNK);
      let list = chunks.get(k);
      if (!list) chunks.set(k, (list = []));
      list.push(o);
    }
    const lods = treeLods();
    const barkMat = solidMaterial(barkTexture('broadleaf'));
    const pineBarkMat = solidMaterial(barkTexture('pine'));
    const leaves = { mat: clumpMaterial(clumpTexture()), depth: clumpDepthMaterial(clumpTexture()) };
    // A pine's clumps are boughs seen end on: twice as wide as they are tall.
    const BOUGH: [number, number] = [1.5, 0.75];
    const needleTufts = { mat: clumpMaterial(tuftTexture(), BOUGH), depth: clumpDepthMaterial(tuftTexture(), BOUGH) };
    for (const list of chunks.values()) {
      const trees = list.filter((o) => o.kind === 'tree');
      const pine = (o: Obstacle) => isPine(o.x, o.z, hf.height(o.x, o.z));
      const pines = trees.filter(pine);
      const rounds = trees.filter((o) => !pine(o));
      const rocks = list.filter((o) => o.kind === 'rock');
      const blossom = (o: Obstacle) => Math.hypot(o.x - TOWN.x, o.z - TOWN.z) < TOWN.r && hash2(Math.round(o.x * 10), Math.round(o.z * 10), 131) < 0.35;
      // The bark texture brings its own colour; trunks only vary its brightness a little.
      const bark = () => new THREE.Color(1, 1, 1).multiplyScalar(range(rng, 0.82, 1.05));
      const leafColour = new Map<Obstacle, THREE.Color>();
      const leafy = (o: Obstacle) => {
        let c = leafColour.get(o);
        if (!c) leafColour.set(o, (c = blossom(o) ? new THREE.Color(BLOSSOM[Math.floor(rng() * BLOSSOM.length)]) : pick()));
        return c;
      };
      const needles = (o: Obstacle) => {
        let c = leafColour.get(o);
        if (!c) leafColour.set(o, (c = pick().offsetHSL(0.06, -0.08, 0.02)));
        return c;
      };
      this.placeLod(lods.trunk, barkMat, rounds, bark);
      this.placeLod(lods.pineTrunk, pineBarkMat, pines, bark);
      // Four in ten broadleaf trees grow the taller, oval crown.
      const oval = (o: Obstacle) => hash2(Math.round(o.x * 10), Math.round(o.z * 10), 191) < 0.4;
      this.placeLod(
        lods.round,
        leaves.mat,
        rounds.filter((o) => !oval(o)),
        leafy,
        crownShape,
        leaves.depth,
      );
      this.placeLod(lods.oval, leaves.mat, rounds.filter(oval), leafy, crownShape, leaves.depth);
      this.placeLod(lods.pine, needleTufts.mat, pines, needles, pineShape, needleTufts.depth);
      // Made boulders once they load: granite inland, sharp grey-brown rock by the shore.
      const coast = (o: Obstacle) => hf.height(o.x, o.z) < 6 || hash2(Math.round(o.x * 10), Math.round(o.z * 10), 149) < 0.3;
      this.madeRocks(ROCKS.coast, rocks.filter(coast), rock, mat, rng);
      this.madeRocks(
        ROCKS.granite,
        rocks.filter((o) => !coast(o)),
        rock,
        mat,
        rng,
      );
    }

    // Crags break up the cliffs: big jagged rocks set into slopes far too steep to walk (well past
    // the rules' steepest), and only where all around is as steep, so nothing ever stands on a path.
    // Drawing only: no rule knows of them.
    this.crags(seed);

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
    // Knee- to waist-high: something to wade through, not a wall. Drawing only.
    const shape: CrownShape = {
      lumps: [
        [0, 0.42, 0, 0.62],
        [0.5, 0.32, 0.15, 0.48],
        [-0.45, 0.3, -0.2, 0.45],
        [0.1, 0.3, -0.48, 0.42],
      ],
      middle: new THREE.Vector3(0, 0.4, 0),
    };
    this.bushes = new THREE.InstancedMesh(bushClumps(shape, 7, [0.24, 0.38], 53), clumpMaterial(clumpTexture()), BUSH_CAP);
    this.bushes.customDepthMaterial = clumpDepthMaterial(clumpTexture());
    this.bushes.frustumCulled = false;
    this.bushes.castShadow = true;
    this.bushes.receiveShadow = true;
    this.bushes.count = 0;
    this.group.add(this.bushes);
  }

  private place(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    items: Obstacle[],
    color: (o: Obstacle) => THREE.Color,
    squashY = 1,
    stretch?: Stretch,
  ): THREE.InstancedMesh | null {
    if (!items.length) return null;
    const mesh = new THREE.InstancedMesh(geo, mat, items.length);
    items.forEach((o, i) => {
      this.q.setFromAxisAngle(this.up, o.rot);
      const [w, h] = stretch ? stretch(o) : [1, 1];
      this.m.compose(this.v.set(o.x, this.hf.height(o.x, o.z) - 0.05, o.z), this.q, this.s.set(o.scale * w, o.scale * squashY * h, o.scale * w));
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

  private crags(seed: number): void {
    const hf = this.hf;
    const items: Obstacle[] = [];
    const STEP = 7;
    const steep = (x: number, z: number, k: number) => hf.inside(x, z, 4) && hf.slope(x, z) > k;
    for (let z = hf.minZ + STEP; z < hf.maxZ - STEP; z += STEP)
      for (let x = hf.minX + STEP; x < hf.maxX - STEP; x += STEP) {
        const jx = x + (hash2(x, z, seed + 401) - 0.5) * STEP;
        const jz = z + (hash2(x, z, seed + 409) - 0.5) * STEP;
        if (!steep(jx, jz, 1.45) || hf.height(jx, jz) < hf.water + 1) continue;
        let ok = true;
        for (let a = 0; a < 8 && ok; a++) ok = steep(jx + Math.cos(a * 0.785) * 5, jz + Math.sin(a * 0.785) * 5, 1.15);
        if (!ok || hash2(x, z, seed + 419) > 0.6) continue;
        const scale = 5 + hash2(x, z, seed + 421) * 7;
        if (this.keepOff(jx, jz, scale * 1.1)) continue;
        items.push({ kind: 'rock', x: jx, z: jz, r: 0, scale, rot: hash2(x, z, seed + 431) * Math.PI * 2 });
      }
    if (!items.length) return;
    const made = madeProp(ROCKS.coast, { w: 1.6, h: 1.2, d: 1.6 });
    if (!made) return;
    track(
      made.then((m) => {
        if (!m) return;
        const mesh = new THREE.InstancedMesh(m.geometry, m.material, items.length);
        items.forEach((o, i) => {
          // Leaning with the face and set into it, nearly half below the ground where it stands, so
          // neighbours run together into ledges and buttresses.
          const e = 1.5;
          const nx = -(hf.height(o.x + e, o.z) - hf.height(o.x - e, o.z)) / (2 * e);
          const nz = -(hf.height(o.x, o.z + e) - hf.height(o.x, o.z - e)) / (2 * e);
          const lean = this.v.set(nx, 1, nz).normalize().lerp(this.up, 0.45).normalize();
          this.q.setFromUnitVectors(this.up, lean).multiply(new THREE.Quaternion().setFromAxisAngle(this.up, o.rot));
          this.m.compose(new THREE.Vector3(o.x, hf.height(o.x, o.z) - 0.45 * o.scale, o.z), this.q, this.s.set(o.scale, o.scale * 1.2, o.scale));
          mesh.setMatrixAt(i, this.m);
          mesh.setColorAt(i, this.c.setScalar(1.05 + hash2(i, 7, 433) * 0.25));
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        mesh.name = 'crags';
        this.group.add(mesh);
      }),
    );
  }

  /** Rocks drawn plain at once, then as a made boulder (src/render/models/glb.ts) when it arrives. */
  private madeRocks(rock: MadeModel, items: Obstacle[], plainGeo: THREE.BufferGeometry, plainMat: THREE.Material, rng: () => number): void {
    const plain = this.place(plainGeo, plainMat, items, () => new THREE.Color(PALETTE.rock).offsetHSL(0, 0, range(rng, -0.06, 0.06)), 0.75);
    const made = plain && madeProp(rock, { w: 1.6, h: 1.2, d: 1.6 });
    if (!plain || !made) return;
    const tints = items.map(() => new THREE.Color().setScalar(range(rng, 0.86, 1.04)));
    track(
      made.then((m) => {
        if (!m) return;
        this.group.remove(plain);
        const mesh = this.place(m.geometry, m.material, items, (o) => tints[items.indexOf(o)]);
        if (mesh) mesh.receiveShadow = true;
      }),
    );
  }

  /** Trees with a near and a far shape: the chunk's mesh swaps between them as you come and go. */
  private placeLod(lod: Lod, mat: THREE.Material, items: Obstacle[], color: (o: Obstacle) => THREE.Color, stretch?: Stretch, depth?: THREE.Material): void {
    const mesh = this.place(lod[1], mat, items, color, 1, stretch);
    if (!mesh) return;
    if (depth) mesh.customDepthMaterial = depth;
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

  /** Bushes around (x, z): on grass and in woods, off paths, plots and slopes, thicker in the woods. */
  private layBushes(x: number, z: number): void {
    const hf = this.hf;
    const bushes = this.bushes;
    const greens = PALETTE.leaves;
    let n = 0;
    const r = BUSH_RADIUS;
    const i0 = Math.floor((x - r) / BUSH_CELL);
    const i1 = Math.floor((x + r) / BUSH_CELL);
    const j0 = Math.floor((z - r) / BUSH_CELL);
    const j1 = Math.floor((z + r) / BUSH_CELL);
    for (let j = j0; j <= j1 && n < BUSH_CAP; j++)
      for (let i = i0; i <= i1 && n < BUSH_CAP; i++) {
        const px = (i + hash2(i, j, 701)) * BUSH_CELL;
        const pz = (j + hash2(i, j, 709)) * BUSH_CELL;
        const dx = px - x;
        const dz = pz - z;
        if (dx * dx + dz * dz > r * r || !hf.inside(px, pz, 3)) continue;
        const ci = Math.floor((px - hf.minX) / hf.cell);
        const cj = Math.floor((pz - hf.minZ) / hf.cell);
        const s = hf.surface[cj * hf.cells + ci];
        const chance = s === SURFACE.forest ? 0.4 : s === SURFACE.grass ? 0.09 : 0;
        if (hash2(i, j, 719) > chance || this.clear[cj * hf.cells + ci]) continue;
        const h = hf.height(px, pz);
        if (h < hf.water + 0.8 || hf.slope(px, pz) > 0.7) continue;
        const scale = 0.7 + hash2(i, j, 727) * 0.9;
        this.q.setFromAxisAngle(this.up, hash2(i, j, 733) * Math.PI * 2);
        this.m.compose(this.v.set(px, h - 0.08, pz), this.q, this.s.set(scale, scale * (0.8 + hash2(i, j, 739) * 0.4), scale));
        bushes.setMatrixAt(n, this.m);
        // Mostly leaf greens; now and then one in flower.
        const bloom = hash2(i, j, 743);
        if (bloom < 0.06) this.c.setHex(BLOSSOM[Math.floor(hash2(i, j, 751) * BLOSSOM.length)]);
        else if (bloom < 0.09) this.c.setHex(0xf2efe4);
        else this.c.setHex(greens[Math.floor(hash2(i, j, 757) * greens.length)]).offsetHSL(0.01, -0.05, -0.04);
        bushes.setColorAt(n, this.c);
        n++;
      }
    bushes.count = n;
    bushes.instanceMatrix.needsUpdate = true;
    if (bushes.instanceColor) bushes.instanceColor.needsUpdate = true;
  }

  /** Lays the grass again on the next update (the ground changed: a new plot, a house). */
  invalidate(): void {
    this.grassAt = { x: Infinity, z: Infinity };
  }

  /** Re-seeds the grass around (x, z) once you have moved far enough from where it was laid. */
  update(x: number, z: number): void {
    this.updateLod(x, z);
    // Off its region and out of the grass's reach of it, there's none of its grass to lay.
    if (!this.hf.inside(x, z, -GRASS_RADIUS)) return;
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
        const ci = Math.floor((px - hf.minX) / hf.cell);
        const cj = Math.floor((pz - hf.minZ) / hf.cell);
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
    this.layBushes(x, z);
    this.grass.instanceMatrix.needsUpdate = true;
    this.flowers.instanceMatrix.needsUpdate = true;
    if (this.grass.instanceColor) this.grass.instanceColor.needsUpdate = true;
    if (this.flowers.instanceColor) this.flowers.instanceColor.needsUpdate = true;
  }
}
