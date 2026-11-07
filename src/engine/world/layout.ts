import { answer, wasm } from '../wasm';

// Where the world's regions stand (content/world.json, as the engine reads it: the shipped world, or
// a fixture world given in its place), for the page: which regions are near you, where a region's grid
// is, the edge of the world. The engine's world map is crates/engine/src/open/map.rs.

/** One region of the world, by its place in the world's map. */
export interface RegionPlace {
  id: string;
  name: string;
  climate: string;
  /** Its first chunk and how many it spans along x (w) and z (d). */
  chunks: { x: number; z: number; w: number; d: number };
  /** Its grid: cells a side, metres a cell, and its corner. */
  cells: number;
  cell: number;
  minX: number;
  minZ: number;
}

export interface WorldLayout {
  /** Metres a chunk is on a side. */
  chunk: number;
  /** Metres either side of a chunk's edge over which the ground is shared with what's across it. */
  blend: number;
  /** Sea level, and the open sea's floor where no region stands. */
  water: number;
  seaFloor: number;
  /** The edge of the world: min x, min z, max x, max z. */
  bounds: [number, number, number, number];
  regions: RegionPlace[];
}

/** The world's layout as the engine reads it (after any content given in place of the shipped). */
export function worldLayout(): WorldLayout {
  return answer<WorldLayout>(wasm().world_layout());
}

/** A region's square in the world: min x, min z, max x, max z. */
export function regionBounds(l: WorldLayout, r: RegionPlace): [number, number, number, number] {
  const c = r.chunks;
  return [c.x * l.chunk, c.z * l.chunk, (c.x + c.w) * l.chunk, (c.z + c.d) * l.chunk];
}

/** How far a point is from a region's square (0 inside it). */
export function distanceTo(l: WorldLayout, r: RegionPlace, x: number, z: number): number {
  const [x0, z0, x1, z1] = regionBounds(l, r);
  const dx = Math.max(x0 - x, x - x1, 0);
  const dz = Math.max(z0 - z, z - z1, 0);
  return Math.sqrt(dx * dx + dz * dz);
}

/** The regions with a chunk within `reach` metres of a point, nearest first (the engine's WorldMap::near). */
export function regionsNear(l: WorldLayout, x: number, z: number, reach: number): number[] {
  return l.regions
    .map((r, i) => ({ d: distanceTo(l, r, x, z), i }))
    .filter((e) => e.d <= reach)
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((e) => e.i);
}

/** The place of the region a point is in, or null out at sea. */
export function regionAt(l: WorldLayout, x: number, z: number): number | null {
  const cx = Math.floor(x / l.chunk);
  const cz = Math.floor(z / l.chunk);
  const i = l.regions.findIndex((r) => cx >= r.chunks.x && cx < r.chunks.x + r.chunks.w && cz >= r.chunks.z && cz < r.chunks.z + r.chunks.d);
  return i < 0 ? null : i;
}
