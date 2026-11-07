import { type Ground, type Heightfield, SURFACE } from './terrain';
import type { WorldLayout } from './layout';

// The world's ground as the page reads it: every region it holds, where the world places it, and
// the open sea between, sloping to meet a region near its edge. The same sums as the engine's world
// map (crates/engine/src/open/map.rs), on the same grids, so the camera, the shadows and the drawing
// read the ground the rules walk on, to the bit (tests/conformance/terrain.test.ts). The page holds
// what's near you, as the engine's rules do; a region it doesn't hold reads as open sea.

/**
 * A region's outer two rows and columns of vertices as its recipe grew them, before its borders were
 * blended (the engine's Edges): all that's read of it from across its borders.
 */
export class Edges {
  readonly n: number;

  constructor(
    readonly cells: number,
    readonly cell: number,
    readonly minX: number,
    readonly minZ: number,
    private readonly heights: Float32Array,
  ) {
    this.n = cells + 1;
  }

  private at(i: number, j: number): number {
    const n = this.n;
    const E = 2;
    let k: number;
    if (2 * E >= n || j < E) k = j * n + i;
    else if (j + E >= n) k = E * n + (n - 2 * E) * 2 * E + (j + E - n) * n + i;
    else k = E * n + (j - E) * 2 * E + (i < E ? i : E + i + E - n);
    return this.heights[k];
  }

  /** The grid's ground at a point held to its edges (map.rs vertex_or_height, on the edges alone). */
  heldAtEdge(px: number, pz: number): number {
    const size = this.cells * this.cell;
    const x = Math.min(Math.max(px, this.minX), this.minX + size);
    const z = Math.min(Math.max(pz, this.minZ), this.minZ + size);
    let gx = (x - this.minX) / this.cell;
    let gz = (z - this.minZ) / this.cell;
    if (gx === Math.floor(gx) && gz === Math.floor(gz)) return this.at(gx, gz);
    const last = this.cells - 1e-6;
    gx = gx < 0 ? 0 : gx > last ? last : gx;
    gz = gz < 0 ? 0 : gz > last ? last : gz;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const a = this.at(i, j);
    const b = this.at(i + 1, j);
    const cc = this.at(i, j + 1);
    const d = this.at(i + 1, j + 1);
    return fx >= fz ? a + (b - a) * fx + (d - b) * fz : a + (cc - a) * fz + (d - cc) * fx;
  }
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class WorldGround implements Ground {
  readonly water: number;
  readonly seaFloor: number;
  private readonly held = new Map<number, { hf: Heightfield; edges: Edges }>();
  private readonly byChunk = new Map<number, number>();

  constructor(readonly layout: WorldLayout) {
    this.water = layout.water;
    this.seaFloor = layout.seaFloor;
    layout.regions.forEach((r, i) => {
      for (let cx = r.chunks.x; cx < r.chunks.x + r.chunks.w; cx++)
        for (let cz = r.chunks.z; cz < r.chunks.z + r.chunks.d; cz++) this.byChunk.set(key(cx, cz), i);
    });
  }

  /** Holds a region: its grid (its ground blended along its borders) and its edges as grown. */
  hold(place: number, hf: Heightfield, edges: Float32Array): void {
    this.held.set(place, { hf, edges: new Edges(hf.cells, hf.cell, hf.minX, hf.minZ, edges) });
  }

  release(place: number): void {
    this.held.delete(place);
  }

  holds(place: number): boolean {
    return this.held.has(place);
  }

  /** The grid of a region held. */
  grid(place: number): Heightfield | undefined {
    return this.held.get(place)?.hf;
  }

  /** The place of the region a point is in, or null out at sea. */
  regionAt(x: number, z: number): number | null {
    return this.byChunk.get(key(Math.floor(x / this.layout.chunk), Math.floor(z / this.layout.chunk))) ?? null;
  }

  height(x: number, z: number): number {
    const i = this.regionAt(x, z);
    if (i === null) return this.seaGround(x, z);
    const r = this.held.get(i);
    return r ? r.hf.height(x, z) : this.seaFloor;
  }

  gradient(x: number, z: number): { x: number; z: number } {
    const i = this.regionAt(x, z);
    if (i !== null) {
      const r = this.held.get(i);
      return r ? r.hf.gradient(x, z) : { x: 0, z: 0 };
    }
    if (this.owners(x, z).length < 2) return { x: 0, z: 0 };
    const E = 0.5;
    return { x: (this.seaGround(x + E, z) - this.seaGround(x - E, z)) / (2 * E), z: (this.seaGround(x, z + E) - this.seaGround(x, z - E)) / (2 * E) };
  }

  slope(x: number, z: number): number {
    const g = this.gradient(x, z);
    return Math.sqrt(g.x * g.x + g.z * g.z);
  }

  normal(x: number, z: number): { x: number; y: number; z: number } {
    const g = this.gradient(x, z);
    const l = Math.sqrt(g.x * g.x + 1 + g.z * g.z);
    return { x: -g.x / l, y: 1 / l, z: -g.z / l };
  }

  surfaceAt(x: number, z: number): number {
    const i = this.regionAt(x, z);
    const r = i === null ? undefined : this.held.get(i);
    return r ? r.hf.surfaceAt(x, z) : SURFACE.sand;
  }

  depth(x: number, z: number): number {
    return Math.max(0, this.water - this.height(x, z));
  }

  inside(x: number, z: number, margin = 0): boolean {
    const [x0, z0, x1, z1] = this.layout.bounds;
    return x >= x0 + margin && x <= x1 - margin && z >= z0 + margin && z <= z1 - margin;
  }

  // ---------- The open sea near a region (map.rs owners, steps, blended) ----------

  /** Along one axis, a point `u` metres into its chunk: the weights of the chunk before, its own and after. */
  private steps(u: number): Array<[number, number]> {
    const b = this.layout.blend;
    const chunk = this.layout.chunk;
    if (b > 0 && u < b) {
      const s = smoothstep(0, 1, (u + b) / (2 * b));
      return [
        [-1, 1 - s],
        [0, s],
        [1, 0],
      ];
    }
    if (b > 0 && u > chunk - b) {
      const s = smoothstep(0, 1, (u - (chunk - b)) / (2 * b));
      return [
        [-1, 0],
        [0, 1 - s],
        [1, s],
      ];
    }
    return [
      [-1, 0],
      [0, 1],
      [1, 0],
    ];
  }

  /** Whose ground a point shares and how much each has of it, the open sea (-1) first. */
  private owners(x: number, z: number): Array<[number, number]> {
    const chunk = this.layout.chunk;
    const cx = Math.floor(x / chunk);
    const cz = Math.floor(z / chunk);
    const wx = this.steps(x - cx * chunk);
    const wz = this.steps(z - cz * chunk);
    const out: Array<[number, number]> = [];
    for (const [dx, ax] of wx) {
      if (!(ax > 0)) continue;
      for (const [dz, az] of wz) {
        if (!(az > 0)) continue;
        const owner = this.byChunk.get(key(cx + dx, cz + dz)) ?? -1;
        const w = ax * az;
        const slot = out.find((o) => o[0] === owner);
        if (slot) slot[1] += w;
        else out.push([owner, w]);
      }
    }
    return out.sort((a, b) => a[0] - b[0]);
  }

  /** The open sea's ground at a point: its floor, or blended with a region's near one. */
  private seaGround(x: number, z: number): number {
    const owners = this.owners(x, z);
    if (owners.length < 2) return this.seaFloor;
    const at = (o: number): number => {
      if (o < 0) return this.seaFloor;
      const r = this.held.get(o);
      return r ? r.edges.heldAtEdge(x, z) : this.seaFloor;
    };
    // Out at sea the chunk the point is in is the open sea's.
    const h0 = this.seaFloor;
    let h = h0;
    for (const [o, w] of owners) if (o !== -1) h += w * (at(o) - h0);
    return h;
  }
}

/** A chunk's key in a map (chunks stand within ±2^20 of the origin). */
function key(cx: number, cz: number): number {
  return (cx + 1048576) * 2097152 + (cz + 1048576);
}
