import type { World } from '../../engine/rules';
import type { WorldLayout, ZonePlace } from '../../engine/zone';
import { uiImage } from '../theme/icons';
import { type MapFrame, PICTURE_PX, paintMap } from './mapPaint';

// Drawing the world's maps, the minimap (hud/minimap.ts) and the map window (windows/map.ts): each
// region from above, painted once (by the page's worker as it grows the region, or here the first
// time a map wants it), and the marks they draw over it.

export type { MapFrame } from './mapPaint';
export { PICTURE_PX, toMapPx } from './mapPaint';

/** A region of the world as the maps know it: where it stands, its places, and its picture once painted. */
export interface MapRegion {
  place: number;
  id: string;
  name: string;
  subtitle: string;
  /** Its climate (shared/farming.json's climates): what grows best there. */
  climate: string;
  frame: MapFrame;
  /** Its places, once its recipe is known (the region you start in's from the start, the rest's as they arrive). */
  places: ZonePlace[];
  picture: CanvasImageSource | null;
}

/** The world's regions as the maps draw them: the region you start in from the start, every other as the page's worker hands it over. */
export class WorldPictures {
  private readonly regions: MapRegion[];
  private readonly home: MapRegion;

  constructor(
    private world: World,
    private layout: WorldLayout | null,
  ) {
    const zone = world.zone!;
    const hf = zone.gen.terrain;
    const homeFrame: MapFrame = { minX: hf.minX, minZ: hf.minZ, size: hf.size };
    const own = { name: zone.recipe.name, subtitle: zone.recipe.subtitle ?? '', climate: zone.recipe.climate, places: zone.recipe.places, picture: null };
    const regions = layout?.regions ?? [
      { id: zone.recipe.id, name: zone.recipe.name, climate: zone.recipe.climate, cells: hf.cells, cell: hf.cell, minX: hf.minX, minZ: hf.minZ },
    ];
    this.regions = regions.map((r, place) =>
      r.id === zone.recipe.id
        ? { place, id: r.id, frame: homeFrame, ...own }
        : {
            place,
            id: r.id,
            name: r.name,
            subtitle: '',
            climate: r.climate,
            frame: { minX: r.minX, minZ: r.minZ, size: r.cells * r.cell },
            places: [],
            picture: null,
          },
    );
    this.home = this.regions.find((r) => r.id === zone.recipe.id)!;
  }

  /** Every region of the world. */
  all(): readonly MapRegion[] {
    return this.regions;
  }

  /** Every place of every region known so far, with the name of the region it's in. */
  places(): Array<{ place: ZonePlace; region: string }> {
    return this.regions.flatMap((r) => r.places.map((place) => ({ place, region: r.name })));
  }

  /** The region a point is in, or the nearest (the one you start in, out of the world). */
  at(x: number, z: number): MapRegion {
    let best = this.home;
    let bestD = Infinity;
    for (const r of this.regions) {
      const f = r.frame;
      const d = Math.hypot(Math.max(f.minX - x, x - f.minX - f.size, 0), Math.max(f.minZ - z, z - f.minZ - f.size, 0));
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }

  /** A region's picture, painted here the first time it's wanted if it wasn't handed over (the region you start in). */
  picture(r: MapRegion): CanvasImageSource | null {
    if (!r.picture && r === this.home) r.picture = canvasOf(paintMap(this.world.zone!.gen.terrain, r.frame, PICTURE_PX), PICTURE_PX);
    return r.picture;
  }

  /** A region the page's worker grew, its picture painted there (RGBA, `n` a side). */
  arrive(place: number, recipe: { name: string; subtitle?: string; places: ZonePlace[] }, rgba: Uint8ClampedArray<ArrayBuffer>, n: number): void {
    const r = this.regions[place];
    if (!r || r === this.home) return;
    r.name = recipe.name;
    r.subtitle = recipe.subtitle ?? '';
    r.places = recipe.places;
    if (typeof createImageBitmap === 'function')
      void createImageBitmap(new ImageData(rgba, n, n)).then((bitmap) => {
        r.picture = bitmap;
      });
  }

  /** A square round every region of the world, for the map of all of it. */
  worldFrame(): MapFrame {
    const [x0, z0, x1, z1] = this.layout?.bounds ?? [
      this.home.frame.minX,
      this.home.frame.minZ,
      this.home.frame.minX + this.home.frame.size,
      this.home.frame.minZ + this.home.frame.size,
    ];
    const size = Math.max(x1 - x0, z1 - z0) * 1.08;
    return { minX: (x0 + x1) / 2 - size / 2, minZ: (z0 + z1) / 2 - size / 2, size };
  }
}

/** A picture's pixels on a canvas. */
function canvasOf(rgba: Uint8ClampedArray<ArrayBuffer>, n: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  c.getContext('2d')!.putImageData(new ImageData(rgba, n, n), 0, 0);
  return c;
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
