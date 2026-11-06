import { SURFACE } from '../../sim/terrain';
import type { World } from '../../sim/types';
import { uiImage } from '../theme/icons';

// Drawing the island's maps, the minimap (hud/minimap.ts) and the map window (windows/map.ts): the
// island from above, drawn once, and the marks they draw over it.

/** The island from above, drawn the first time a map wants it. */
export class IslandPicture {
  private image: HTMLCanvasElement | null = null;

  constructor(private world: World) {}

  get(): HTMLCanvasElement {
    if (!this.image) this.image = buildMapImage(this.world);
    return this.image;
  }
}

/** A painted icon centred on a map, with a shadow to stand off the ground (nothing until it has loaded). */
export function mapIcon(g: CanvasRenderingContext2D, img: HTMLImageElement | null, x: number, y: number, size: number): void {
  if (!img) return;
  g.save();
  g.shadowColor = 'rgba(20, 10, 4, 0.7)';
  g.shadowBlur = size * 0.18;
  g.shadowOffsetY = size * 0.06;
  g.drawImage(img, x - size / 2, y - size / 2, size, size);
  g.restore();
}

/**
 * A quest marker on a map: the mark over people's heads (! for a quest on offer, ? for one to hand
 * in) on a dark disc with a brass rim, to stand out from the ground. `r` is its radius in the canvas's pixels.
 */
export function questMark(g: CanvasRenderingContext2D, x: number, y: number, ready: boolean, r: number): void {
  g.save();
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  const fill = g.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
  fill.addColorStop(0, '#7a4a2a');
  fill.addColorStop(1, '#2b1a0e');
  g.fillStyle = fill;
  g.shadowColor = 'rgba(20, 10, 4, 0.6)';
  g.shadowBlur = r * 0.5;
  g.shadowOffsetY = r * 0.1;
  g.fill();
  g.shadowColor = 'transparent';
  g.lineWidth = Math.max(1.5, r * 0.16);
  g.strokeStyle = '#e0a84a';
  g.stroke();
  const img = uiImage(ready ? 'quest-done' : 'quest-new');
  if (img) g.drawImage(img, x - r * 0.95, y - r * 0.95, r * 1.9, r * 1.9);
  g.restore();
}

/** The island drawn from above, once: shaded relief, sea by depth, roads and fields. */
export function buildMapImage(world: World): HTMLCanvasElement {
  const hf = world.terrain!;
  const N = 768;
  const c = document.createElement('canvas');
  c.width = N;
  c.height = N;
  const g = c.getContext('2d')!;
  const img = g.createImageData(N, N);
  const SURF: Record<number, [number, number, number]> = {
    [SURFACE.grass]: [128, 190, 88],
    [SURFACE.road]: [196, 160, 110],
    [SURFACE.sand]: [232, 214, 158],
    [SURFACE.rock]: [150, 150, 144],
    [SURFACE.soil]: [120, 86, 56],
    [SURFACE.plaza]: [214, 204, 180],
    [SURFACE.forest]: [88, 152, 72],
  };
  for (let py = 0; py < N; py++)
    for (let px = 0; px < N; px++) {
      const x = hf.max - ((px + 0.5) / N) * hf.size;
      const z = hf.max - ((py + 0.5) / N) * hf.size;
      const h = hf.height(x, z);
      let col: [number, number, number];
      if (h < hf.water) {
        const d = Math.min(1, (hf.water - h) / 20);
        col = [Math.round(96 - 56 * d), Math.round(200 - 96 * d), Math.round(214 - 50 * d)];
      } else {
        const base = SURF[hf.surfaceAt(x, z)] ?? SURF[SURFACE.grass];
        const gr = hf.gradient(x, z);
        const shade = Math.max(0.55, Math.min(1.3, 1 + gr.x * 0.55 - gr.z * 0.55));
        const lift = Math.min(1.2, 0.9 + h / 200);
        col = [base[0] * shade * lift, base[1] * shade * lift, base[2] * shade * lift].map((v) => Math.max(0, Math.min(255, Math.round(v)))) as [
          number,
          number,
          number,
        ];
      }
      const o = (py * N + px) * 4;
      img.data[o] = col[0];
      img.data[o + 1] = col[1];
      img.data[o + 2] = col[2];
      img.data[o + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return c;
}
