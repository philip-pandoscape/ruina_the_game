import type { Heightfield } from '../../engine/zone';

// How deep the sea is over a region, baked for the sea's colours and foam (water.ts): no three.js,
// so the page's worker bakes it as it grows the region (src/app/grower.ts).

/** Metres of depth the baked depths span (deeper reads as this deep). */
export const DEPTH_RANGE = 30;

/** How deep the water is over each cell of a region's grid (0 to DEPTH_RANGE m, a byte a cell). */
export function seaDepths(hf: Heightfield): Uint8Array {
  const N = hf.cells;
  const data = new Uint8Array(N * N);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const x = hf.minX + (i + 0.5) * hf.cell;
      const z = hf.minZ + (j + 0.5) * hf.cell;
      const d = Math.max(0, Math.min(1, (hf.water - hf.height(x, z)) / DEPTH_RANGE));
      data[j * N + i] = Math.round(d * 255);
    }
  return data;
}
