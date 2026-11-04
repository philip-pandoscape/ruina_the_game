// The ground under an open world: a regular grid of heights plus a surface type per cell.
//
// The rules and the renderer read the *same* grid, split into triangles the same way (each quad
// along its a-d diagonal), so a foot planted by the rules sits exactly on the drawn ground.
// Plain arithmetic only, so server code can reproduce it bit for bit later.

/** What a patch of ground is made of. Vehicles grip and roll differently on each. */
export const SURFACE = {
  grass: 0,
  road: 1,
  sand: 2,
  rock: 3,
  soil: 4,
  plaza: 5,
  forest: 6,
} as const;
export type SurfaceKind = (typeof SURFACE)[keyof typeof SURFACE];

export const SURFACE_NAMES = ['grass', 'road', 'sand', 'rock', 'soil', 'plaza', 'forest'];

export class Heightfield {
  /** Cells per side. */
  readonly cells: number;
  /** Metres per cell. */
  readonly cell: number;
  /** Sea level; anything lower is under water. */
  readonly water: number;
  /** Vertices per side. */
  readonly n: number;
  /** World X/Z of vertex (0, 0). */
  readonly min: number;
  readonly heights: Float32Array;
  /** One per cell ((n-1) x (n-1)). */
  readonly surface: Uint8Array;

  constructor(cells: number, cell: number, water: number) {
    this.cells = cells;
    this.cell = cell;
    this.water = water;
    this.n = cells + 1;
    this.min = -(cells * cell) / 2;
    this.heights = new Float32Array(this.n * this.n);
    this.surface = new Uint8Array(cells * cells);
  }

  get size(): number {
    return this.cells * this.cell;
  }

  get max(): number {
    return this.min + this.size;
  }

  /** World position of vertex (i, j). */
  vx(i: number): number {
    return this.min + i * this.cell;
  }

  at(i: number, j: number): number {
    return this.heights[j * this.n + i];
  }

  /** Ground height at a world point, on the same triangles the renderer draws. */
  height(x: number, z: number): number {
    const c = this.cell;
    let gx = (x - this.min) / c;
    let gz = (z - this.min) / c;
    const last = this.cells - 1e-6;
    gx = gx < 0 ? 0 : gx > last ? last : gx;
    gz = gz < 0 ? 0 : gz > last ? last : gz;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const n = this.n;
    const h = this.heights;
    const a = h[j * n + i];
    const b = h[j * n + i + 1];
    const cc = h[(j + 1) * n + i];
    const d = h[(j + 1) * n + i + 1];
    // Quad a(0,0) b(1,0) c(0,1) d(1,1), split along a-d.
    return fx >= fz ? a + (b - a) * fx + (d - b) * fz : a + (cc - a) * fz + (d - cc) * fx;
  }

  /** Steepness at a point: rise over run along the steepest direction of its triangle. */
  slope(x: number, z: number): number {
    const g = this.gradient(x, z);
    return Math.sqrt(g.x * g.x + g.z * g.z);
  }

  /** dh/dx and dh/dz of the triangle under a point. */
  gradient(x: number, z: number): { x: number; z: number } {
    const c = this.cell;
    let gx = (x - this.min) / c;
    let gz = (z - this.min) / c;
    const last = this.cells - 1e-6;
    gx = gx < 0 ? 0 : gx > last ? last : gx;
    gz = gz < 0 ? 0 : gz > last ? last : gz;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const n = this.n;
    const h = this.heights;
    const a = h[j * n + i];
    const b = h[j * n + i + 1];
    const cc = h[(j + 1) * n + i];
    const d = h[(j + 1) * n + i + 1];
    if (fx >= fz) return { x: (b - a) / c, z: (d - b) / c };
    return { x: (d - cc) / c, z: (cc - a) / c };
  }

  /** Unit surface normal under a point. */
  normal(x: number, z: number): { x: number; y: number; z: number } {
    const g = this.gradient(x, z);
    const l = Math.sqrt(g.x * g.x + 1 + g.z * g.z);
    return { x: -g.x / l, y: 1 / l, z: -g.z / l };
  }

  /** Surface type of the cell under a point (water counts as whatever the seabed is). */
  surfaceAt(x: number, z: number): number {
    const i = Math.floor((x - this.min) / this.cell);
    const j = Math.floor((z - this.min) / this.cell);
    if (i < 0 || j < 0 || i >= this.cells || j >= this.cells) return SURFACE.sand;
    return this.surface[j * this.cells + i];
  }

  /** How deep the water is over a point (0 on dry land). */
  depth(x: number, z: number): number {
    return Math.max(0, this.water - this.height(x, z));
  }

  inside(x: number, z: number, margin = 0): boolean {
    return x >= this.min + margin && x <= this.max - margin && z >= this.min + margin && z <= this.max - margin;
  }
}

// ---------- Noise ----------
// Integer hashing rather than Math.random, so the same seed always grows the same island, in any
// language.

export function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in 0..1. */
export function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

/** Fractal noise in roughly -1..1. */
export function fbm(x: number, z: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * (valueNoise(x * f, z * f, seed + o * 1013) * 2 - 1);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

export const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
