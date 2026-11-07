import { type Ground, SURFACE } from '../../engine/zone';

// Painting the world from above for the maps (map.ts): shaded relief, the sea by depth, roads and
// fields, pixel by pixel from the ground. No page needed, so the page's worker paints each region as
// it grows it (src/app/grower.ts), and the map has it the moment the region arrives.

/** How many pixels a side a region's picture is painted. */
export const PICTURE_PX = 768;

/** A square of the world a map shows: its corner and its size in metres. North is up and east to the right: x grows to the left, z down. */
export interface MapFrame {
  minX: number;
  minZ: number;
  size: number;
}

/** Where (x, z) is on a map `n` pixels across showing `f`. */
export function toMapPx(f: MapFrame, x: number, z: number, n: number): [number, number] {
  return [((f.minX + f.size - x) / f.size) * n, ((f.minZ + f.size - z) / f.size) * n];
}

/** The world under pixel (px, py) of a map `n` pixels across showing `f`. */
export function fromMapPx(f: MapFrame, px: number, py: number, n: number): [number, number] {
  return [f.minX + f.size - (px / n) * f.size, f.minZ + f.size - (py / n) * f.size];
}

const SURF: Record<number, [number, number, number]> = {
  [SURFACE.grass]: [128, 190, 88],
  [SURFACE.road]: [196, 160, 110],
  [SURFACE.sand]: [232, 214, 158],
  [SURFACE.rock]: [150, 150, 144],
  [SURFACE.soil]: [120, 86, 56],
  [SURFACE.plaza]: [214, 204, 180],
  [SURFACE.forest]: [88, 152, 72],
};

/** The ground in `f` from above, `n` pixels a side, as RGBA. */
export function paintMap(ground: Ground, f: MapFrame, n: number): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8ClampedArray(n * n * 4);
  for (let py = 0; py < n; py++)
    for (let px = 0; px < n; px++) {
      const [x, z] = fromMapPx(f, px + 0.5, py + 0.5, n);
      const h = ground.height(x, z);
      let col: [number, number, number];
      if (h < ground.water) {
        const d = Math.min(1, (ground.water - h) / 20);
        col = [Math.round(96 - 56 * d), Math.round(200 - 96 * d), Math.round(214 - 50 * d)];
      } else {
        const base = SURF[ground.surfaceAt(x, z)] ?? SURF[SURFACE.grass];
        const gr = ground.gradient(x, z);
        const shade = Math.max(0.55, Math.min(1.3, 1 + gr.x * 0.55 - gr.z * 0.55));
        const lift = Math.min(1.2, 0.9 + h / 200);
        col = [base[0] * shade * lift, base[1] * shade * lift, base[2] * shade * lift].map((v) => Math.max(0, Math.min(255, Math.round(v)))) as [
          number,
          number,
          number,
        ];
      }
      const o = (py * n + px) * 4;
      data[o] = col[0];
      data[o + 1] = col[1];
      data[o + 2] = col[2];
      data[o + 3] = 255;
    }
  return data;
}
