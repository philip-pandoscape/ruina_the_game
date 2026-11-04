import type { Obstacle } from '../types';
import type { BoxCollider, Deck } from './types';
import type { Heightfield } from '../terrain';

// Everything solid in an open world, bucketed on a coarse grid so a query only looks at what is
// nearby. A zone has thousands of trees; the training yard's straight loop over its few dozen
// obstacles would not scale.

const BUCKET = 16;

export class ColliderIndex {
  private obstacleCells = new Map<number, number[]>();
  private boxCells = new Map<number, number[]>();
  private deckCells = new Map<number, number[]>();

  constructor(
    readonly obstacles: Obstacle[],
    readonly boxes: BoxCollider[],
    readonly decks: Deck[],
  ) {
    obstacles.forEach((o, i) => this.insert(this.obstacleCells, o.x, o.z, o.r, i));
    boxes.forEach((b, i) => this.insert(this.boxCells, b.x, b.z, Math.hypot(b.hw, b.hd), i));
    decks.forEach((d, i) => this.insert(this.deckCells, d.x, d.z, Math.hypot(d.hw, d.hd), i));
  }

  /** Adds a box after the fact (a house that just got its walls). Returns its index. */
  addBox(b: BoxCollider): number {
    const i = this.boxes.push(b) - 1;
    this.insert(this.boxCells, b.x, b.z, Math.hypot(b.hw, b.hd), i);
    return i;
  }

  addDeck(d: Deck): number {
    const i = this.decks.push(d) - 1;
    this.insert(this.deckCells, d.x, d.z, Math.hypot(d.hw, d.hd), i);
    return i;
  }

  addObstacle(o: Obstacle): number {
    const i = this.obstacles.push(o) - 1;
    this.insert(this.obstacleCells, o.x, o.z, o.r, i);
    return i;
  }

  /** Disables a box without reshuffling indices (a demolished wall). */
  removeBox(i: number): void {
    const b = this.boxes[i];
    if (b) b.top = -Infinity;
  }

  removeObstacle(i: number): void {
    const o = this.obstacles[i];
    if (o) o.r = 0;
  }

  private key(bx: number, bz: number): number {
    return (bx + 2048) * 4096 + (bz + 2048);
  }

  private insert(cells: Map<number, number[]>, x: number, z: number, r: number, i: number): void {
    const x0 = Math.floor((x - r) / BUCKET);
    const x1 = Math.floor((x + r) / BUCKET);
    const z0 = Math.floor((z - r) / BUCKET);
    const z1 = Math.floor((z + r) / BUCKET);
    for (let bx = x0; bx <= x1; bx++)
      for (let bz = z0; bz <= z1; bz++) {
        const k = this.key(bx, bz);
        let list = cells.get(k);
        if (!list) cells.set(k, (list = []));
        list.push(i);
      }
  }

  private visit(cells: Map<number, number[]>, x: number, z: number, r: number, fn: (i: number) => void): void {
    const x0 = Math.floor((x - r) / BUCKET);
    const x1 = Math.floor((x + r) / BUCKET);
    const z0 = Math.floor((z - r) / BUCKET);
    const z1 = Math.floor((z + r) / BUCKET);
    if (x0 === x1 && z0 === z1) {
      const list = cells.get(this.key(x0, z0));
      if (list) for (const i of list) fn(i);
      return;
    }
    // A thing spanning two buckets is listed in both; visit it once.
    const seen = new Set<number>();
    for (let bx = x0; bx <= x1; bx++)
      for (let bz = z0; bz <= z1; bz++) {
        const list = cells.get(this.key(bx, bz));
        if (!list) continue;
        for (const i of list) {
          if (seen.has(i)) continue;
          seen.add(i);
          fn(i);
        }
      }
  }

  eachObstacle(x: number, z: number, r: number, fn: (o: Obstacle) => void): void {
    this.visit(this.obstacleCells, x, z, r, (i) => fn(this.obstacles[i]));
  }

  eachBox(x: number, z: number, r: number, fn: (b: BoxCollider) => void): void {
    this.visit(this.boxCells, x, z, r, (i) => fn(this.boxes[i]));
  }

  eachDeck(x: number, z: number, r: number, fn: (d: Deck) => void): void {
    this.visit(this.deckCells, x, z, r, (i) => fn(this.decks[i]));
  }
}

/** Is (x, z) inside a rectangle? */
export function inRect(b: BoxCollider, x: number, z: number, pad = 0): boolean {
  const dx = x - b.x;
  const dz = z - b.z;
  const lx = dx * b.cos - dz * b.sin;
  const lz = dx * b.sin + dz * b.cos;
  return Math.abs(lx) <= b.hw + pad && Math.abs(lz) <= b.hd + pad;
}

/**
 * Pushes a circle out of a rectangle. Returns the push (world dx, dz), or null if not touching.
 * Works in the box's own frame: closest point on the box, then back out along the gap.
 */
export function pushOutOfBox(b: BoxCollider, x: number, z: number, r: number): { x: number; z: number } | null {
  const dx = x - b.x;
  const dz = z - b.z;
  const lx = dx * b.cos - dz * b.sin;
  const lz = dx * b.sin + dz * b.cos;
  const cx = Math.max(-b.hw, Math.min(b.hw, lx));
  const cz = Math.max(-b.hd, Math.min(b.hd, lz));
  let ox = lx - cx;
  let oz = lz - cz;
  const d2 = ox * ox + oz * oz;
  if (d2 >= r * r) return null;
  let px: number;
  let pz: number;
  if (d2 > 1e-10) {
    const d = Math.sqrt(d2);
    px = (ox / d) * (r - d);
    pz = (oz / d) * (r - d);
  } else {
    // Centre inside the box: leave by the nearest face.
    const ex = b.hw - Math.abs(lx);
    const ez = b.hd - Math.abs(lz);
    if (ex < ez) {
      px = (lx >= 0 ? 1 : -1) * (ex + r);
      pz = 0;
    } else {
      px = 0;
      pz = (lz >= 0 ? 1 : -1) * (ez + r);
    }
    ox = px;
    oz = pz;
  }
  // Back to world: inverse of the rotation above.
  return { x: px * b.cos + pz * b.sin, z: -px * b.sin + pz * b.cos };
}

/**
 * The ground under a point for something whose feet are at `y`: the terrain, or a deck or a
 * box top it is standing on (anything at most `stepUp` above its feet).
 */
export function groundAt(hf: Heightfield, index: ColliderIndex | undefined, x: number, z: number, y: number, stepUp: number): number {
  let g = hf.height(x, z);
  if (!index) return g;
  const reach = y + stepUp;
  index.eachDeck(x, z, 0.5, (d) => {
    if (d.top > g && d.top <= reach && inRect(d, x, z)) g = d.top;
  });
  index.eachBox(x, z, 0.5, (b) => {
    if (b.top > g && b.top <= reach && inRect(b, x, z)) g = b.top;
  });
  return g;
}
