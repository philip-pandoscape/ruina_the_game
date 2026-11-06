import type { World } from '../shapes';
import { GROUND } from '../../content/traversal';
import { inRect } from './colliders';

// A short walk across open ground, found on a fine grid: across a town square between the roads
// that start in it, or off the end of a road to the spot picked on the map. A* round whatever stands
// in the way (a well, stalls, benches, lamps, the townsfolk at their posts), kept off deep water and
// slopes too steep to climb, then pulled tight so it runs straight wherever it can. Plain arithmetic
// over the island's own colliders: the same island always gives the same way.

export type Point = [number, number];

/** Townsfolk stand at their posts and are as solid as a post this wide. */
const STANDER = 0.5;
const SQRT2 = Math.SQRT2;

export interface GridOptions {
  /** How far from anything solid your middle stays: a rider needs more room than someone on foot. */
  clearance: number;
  /** When given, only ground of these surfaces (SURFACE codes) counts. */
  surfaces?: ReadonlySet<number>;
}

/** A binary min-heap of numbered things by cost, ties going to the lower number (so it is deterministic). */
export class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.vals.length;
  }

  private less(a: number, b: number): boolean {
    const ka = this.keys[a];
    const kb = this.keys[b];
    return ka < kb || (ka === kb && this.vals[a] < this.vals[b]);
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.vals[a], this.vals[b]] = [this.vals[b], this.vals[a]];
  }

  push(key: number, val: number): void {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.vals.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!this.less(i, up)) break;
      this.swap(i, up);
      i = up;
    }
  }

  pop(): number {
    const top = this.vals[0];
    const last = this.vals.length - 1;
    this.swap(0, last);
    this.keys.pop();
    this.vals.pop();
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < last && this.less(l, m)) m = l;
      if (r < last && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }
}

/** A patch of the island cut into half-metre cells you can or can't stand in. */
export class WalkGrid {
  readonly cell = 0.5;
  readonly nx: number;
  readonly nz: number;
  /** The height you would stand at in each cell; NaN where you can't stand. */
  private ground: Float32Array;
  /** Whether that is a deck rather than the land: getting onto one is a step, not a slope. */
  private deck: Uint8Array;

  constructor(
    world: World,
    readonly x0: number,
    readonly z0: number,
    x1: number,
    z1: number,
    opts: GridOptions,
  ) {
    const hf = world.terrain!;
    const idx = world.index;
    this.nx = Math.max(1, Math.ceil((x1 - x0) / this.cell));
    this.nz = Math.max(1, Math.ceil((z1 - z0) / this.cell));
    this.ground = new Float32Array(this.nx * this.nz).fill(NaN);
    this.deck = new Uint8Array(this.nx * this.nz);
    const c = opts.clearance;
    const standers: Point[] = (world.zone?.recipe.npcs ?? []).map((n) => [n.x, n.z]);
    if (world.zone) standers.push([world.dummy.x, world.dummy.z]);
    for (let j = 0; j < this.nz; j++)
      for (let i = 0; i < this.nx; i++) {
        const [x, z] = this.centre(i, j);
        if (!hf.inside(x, z, 4)) continue;
        if (opts.surfaces && !opts.surfaces.has(hf.surfaceAt(x, z))) continue;
        const h = hf.height(x, z);
        let ground = h;
        let onDeck = false;
        // A pier or a floor over the land or the sea is where you would stand.
        idx?.eachDeck(x, z, 0.5, (d) => {
          if (d.top > ground && d.top <= Math.max(h, hf.water) + 2.2 && inRect(d, x, z)) {
            ground = d.top;
            onDeck = true;
          }
        });
        if (ground < hf.water - GROUND.wadeDepth) continue; // deeper than wading
        if (!onDeck && hf.slope(x, z) > GROUND.maxSlope * 0.9) continue; // too steep to climb
        let blocked = false;
        idx?.eachObstacle(x, z, c + 2, (o) => {
          if (!blocked && o.r > 0 && (x - o.x) * (x - o.x) + (z - o.z) * (z - o.z) < (o.r + c) * (o.r + c)) blocked = true;
        });
        idx?.eachBox(x, z, c + 1, (b) => {
          if (!blocked && b.top > ground + GROUND.stepUp && inRect(b, x, z, c)) blocked = true;
        });
        for (const [sx, sz] of standers) if ((x - sx) * (x - sx) + (z - sz) * (z - sz) < (STANDER + c) * (STANDER + c)) blocked = true;
        if (blocked) continue;
        const k = j * this.nx + i;
        this.ground[k] = ground;
        this.deck[k] = onDeck ? 1 : 0;
      }
  }

  centre(i: number, j: number): Point {
    return [this.x0 + (i + 0.5) * this.cell, this.z0 + (j + 0.5) * this.cell];
  }

  /** The cell under a point, or -1 off the grid. */
  cellAt(x: number, z: number): number {
    const i = Math.floor((x - this.x0) / this.cell);
    const j = Math.floor((z - this.z0) / this.cell);
    return i < 0 || j < 0 || i >= this.nx || j >= this.nz ? -1 : j * this.nx + i;
  }

  free(k: number): boolean {
    return k >= 0 && !Number.isNaN(this.ground[k]);
  }

  /** Whether you can walk straight from one cell into a neighbouring one. */
  private step(a: number, b: number): boolean {
    if (!this.free(a) || !this.free(b)) return false;
    // The land's own slopes were checked cell by cell; onto or off a deck is a step up or down.
    if (this.deck[a] || this.deck[b]) return Math.abs(this.ground[a] - this.ground[b]) <= GROUND.deckStep;
    return true;
  }

  /** The free cell nearest a point, within `reach` metres, or -1. */
  nearestFree(x: number, z: number, reach: number): number {
    const k0 = this.cellAt(x, z);
    if (this.free(k0)) return k0;
    const i0 = Math.floor((x - this.x0) / this.cell);
    const j0 = Math.floor((z - this.z0) / this.cell);
    const rings = Math.ceil(reach / this.cell);
    let best = -1;
    let bestD = Infinity;
    for (let r = 1; r <= rings; r++) {
      for (let j = j0 - r; j <= j0 + r; j++)
        for (let i = i0 - r; i <= i0 + r; i++) {
          if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r || i < 0 || j < 0 || i >= this.nx || j >= this.nz) continue;
          const k = j * this.nx + i;
          if (!this.free(k)) continue;
          const [cx, cz] = this.centre(i, j);
          const d = (cx - x) * (cx - x) + (cz - z) * (cz - z);
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
      // A ring further out can't hold anything nearer than one cell beyond this one.
      if (best >= 0 && Math.sqrt(bestD) <= (r + 0.5) * this.cell) break;
    }
    return best >= 0 && Math.sqrt(bestD) <= reach + this.cell ? best : -1;
  }

  /**
   * A walk from a to b round whatever is in the way, pulled tight, from a itself to b (or the
   * nearest spot to b you can stand on, within `goalReach` metres); null when there is none.
   */
  path(a: Point, b: Point, goalReach = 1): Point[] | null {
    const start = this.nearestFree(a[0], a[1], 2.5);
    const goal = this.nearestFree(b[0], b[1], goalReach);
    if (start < 0 || goal < 0) return null;
    const cells = this.search(start, goal);
    if (!cells) return null;
    const tight = this.pull(cells);
    const out: Point[] = [a];
    for (let n = 1; n < tight.length - 1; n++) out.push(this.centreOf(tight[n]));
    // Finish on b itself when b is somewhere you can stand; otherwise on the spot nearest it.
    out.push(this.free(this.cellAt(b[0], b[1])) ? b : this.centreOf(goal));
    return out;
  }

  private centreOf(k: number): Point {
    return this.centre(k % this.nx, Math.floor(k / this.nx));
  }

  /** A* over the cells, eight ways, never cutting a blocked corner. */
  private search(start: number, goal: number): number[] | null {
    const n = this.nx * this.nz;
    const cost = new Float64Array(n).fill(Infinity);
    const from = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    const gi = goal % this.nx;
    const gj = Math.floor(goal / this.nx);
    const guess = (k: number): number => {
      const dx = Math.abs((k % this.nx) - gi);
      const dz = Math.abs(Math.floor(k / this.nx) - gj);
      return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz);
    };
    const open = new MinHeap();
    cost[start] = 0;
    open.push(guess(start), start);
    while (open.size) {
      const k = open.pop();
      if (done[k]) continue;
      done[k] = 1;
      if (k === goal) break;
      const i = k % this.nx;
      const j = Math.floor(k / this.nx);
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= this.nx || nj >= this.nz) continue;
          const m = nj * this.nx + ni;
          if (done[m] || !this.step(k, m)) continue;
          if (di && dj && (!this.free(j * this.nx + ni) || !this.free(nj * this.nx + i))) continue;
          const c = cost[k] + (di && dj ? SQRT2 : 1);
          if (c < cost[m]) {
            cost[m] = c;
            from[m] = k;
            open.push(c + guess(m), m);
          }
        }
    }
    if (!done[goal]) return null;
    const cells: number[] = [];
    for (let k = goal; k >= 0; k = from[k]) cells.push(k);
    return cells.reverse();
  }

  /** Drops every corner the walk can cut in a straight line. */
  private pull(cells: number[]): number[] {
    const out = [cells[0]];
    let i = 0;
    while (i < cells.length - 1) {
      let j = cells.length - 1;
      while (j > i + 1 && !this.straight(cells[i], cells[j])) j--;
      out.push(cells[j]);
      i = j;
    }
    return out;
  }

  /** Whether a straight walk between two cells' middles stays on cells you can walk between. */
  private straight(a: number, b: number): boolean {
    const [ax, az] = this.centreOf(a);
    const [bx, bz] = this.centreOf(b);
    const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / (this.cell * 0.25));
    let prev = a;
    for (let s = 1; s <= steps; s++) {
      const k = this.cellAt(ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps);
      if (k === prev) continue;
      if (!this.step(prev, k)) return false;
      // Slipping diagonally between two cells must not squeeze past a blocked corner.
      const pi = prev % this.nx;
      const pj = Math.floor(prev / this.nx);
      const ki = k % this.nx;
      const kj = Math.floor(k / this.nx);
      if (pi !== ki && pj !== kj && (!this.free(pj * this.nx + ki) || !this.free(kj * this.nx + pi))) return false;
      prev = k;
    }
    return true;
  }
}

/** Length of a walk through the points in order. */
export function pathLength(pts: readonly Point[]): number {
  let l = 0;
  for (let k = 1; k < pts.length; k++) l += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  return l;
}
