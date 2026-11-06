// The island drawn as a map: grown by the game's own terrain generator and shaded by height and
// surface, with its roads, plots, trade routes, rising air and places over it. The bible's zone and
// place pages draw it, and so does the design page's world map (design/bible.ts).
//
// The island and its waters are 1280 m square around the origin. North (+Z) is up and east (-X) is
// to the right, so a world point lands ((HALF - x) / SPAN, (HALF - z) / SPAN) of the way across.

import { generateZone, EMBERHOLM as Z, SURFACE } from '../engine/zone';

const HALF = 640;
const SPAN = HALF * 2;
/** Pixels across the shaded relief: one per 2 m cell. */
const RELIEF = 640;

/** Where a world point is on a map drawn `w` pixels across. */
export const toMap = (x: number, z: number, w: number): [number, number] => [((HALF - x) / SPAN) * w, ((HALF - z) / SPAN) * w];

const SURF: Record<number, [number, number, number]> = {
  [SURFACE.grass]: [134, 194, 92],
  [SURFACE.road]: [201, 166, 116],
  [SURFACE.sand]: [234, 216, 162],
  [SURFACE.rock]: [152, 152, 146],
  [SURFACE.soil]: [124, 88, 58],
  [SURFACE.plaza]: [216, 206, 184],
  [SURFACE.forest]: [92, 154, 76],
};

export interface Island {
  relief: HTMLCanvasElement;
  roads: Array<{ id: string; points: Array<[number, number]> }>;
  ramps: Array<Array<[number, number]>>;
  trees: number;
  rocks: number;
  peak: number;
  cell: number;
}

let grown: Island | null = null;

/** Grows the island with the game's own generator and shades its relief (once a page: it takes a few hundred milliseconds). */
export function growIsland(): Island {
  if (grown) return grown;
  const gen = generateZone(Z);
  const hf = gen.terrain;
  const relief = document.createElement('canvas');
  relief.width = relief.height = RELIEF;
  const g = relief.getContext('2d');
  if (!g) throw new Error('no 2D canvas');
  const img = g.createImageData(RELIEF, RELIEF);
  const rgba = img.data; // clamped: values round and clip to 0..255
  for (let py = 0; py < RELIEF; py++)
    for (let px = 0; px < RELIEF; px++) {
      const x = HALF - ((px + 0.5) / RELIEF) * SPAN;
      const z = HALF - ((py + 0.5) / RELIEF) * SPAN;
      const h = hf.height(x, z);
      const o = (py * RELIEF + px) * 4;
      if (h < hf.water) {
        // Water, paler in the shallows.
        const d = Math.min(1, (hf.water - h) / 22);
        rgba[o] = 122 - 70 * d;
        rgba[o + 1] = 206 - 96 * d;
        rgba[o + 2] = 216 - 52 * d;
      } else {
        // Land: the surface's colour, shaded by its slope and lifted with height.
        const base = SURF[hf.surfaceAt(x, z)] ?? SURF[SURFACE.grass];
        const grad = hf.gradient(x, z);
        const k = Math.max(0.55, Math.min(1.3, 1 + grad.x * 0.5 - grad.z * 0.5)) * Math.min(1.18, 0.92 + h / 220);
        rgba[o] = base[0] * k;
        rgba[o + 1] = base[1] * k;
        rgba[o + 2] = base[2] * k;
      }
      rgba[o + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  let peak = 0;
  for (const v of hf.heights) peak = Math.max(peak, v);
  grown = {
    relief,
    roads: gen.roads,
    ramps: gen.ramps,
    trees: gen.obstacles.filter((o) => o.kind === 'tree').length,
    rocks: gen.obstacles.filter((o) => o.kind === 'rock').length,
    peak: Math.round(peak),
    cell: hf.cell,
  };
  return grown;
}

export interface Layers {
  places: boolean;
  roads: boolean;
  routes: boolean;
  plots: boolean;
  nodes: boolean;
  air: boolean;
}

export const LAYER_NAMES: Record<keyof Layers, [string, string]> = {
  places: ['Places', 'var(--ink)'],
  roads: ['Roads', '#f6e7c4'],
  routes: ['Trade routes', '#e0a72e'],
  plots: ['Plots & fields', '#7e5636'],
  nodes: ['Gathering', '#9a9a94'],
  air: ['Ledge path & rising air', '#ffffff'],
};

const NODE_COLOR: Record<string, string> = { timberNode: '#8d5a3b', stoneNode: '#d6d0c3', oreNode: '#b5651d', herbNode: '#3e9a45' };

function routeLines(isle: Island): Array<{ pts: Array<[number, number]>; dash: number[] }> {
  const out: Array<{ pts: Array<[number, number]>; dash: number[] }> = [];
  const wb = Z.workbenches[0];
  const west = isle.roads.find((r) => r.id === 'west');
  if (west) out.push({ pts: [[wb.x, wb.z], ...west.points], dash: [] });
  const docks = Z.places.find((p) => p.id === 'docks');
  const gull = Z.outposts.find((o) => o.id === 'gullrock');
  if (docks && gull)
    out.push({
      pts: [
        [wb.x, wb.z],
        [docks.x, docks.z],
        [docks.x - 120, docks.z - 120],
        [gull.x + 40, gull.z + 50],
        [gull.x, gull.z],
      ],
      dash: [7, 6],
    });
  return out;
}

/** Draws the island on a canvas as wide as it is laid out, with the layers asked for; `mark` rings one place. */
export function drawIsland(canvas: HTMLCanvasElement, isle: Island, L: Layers, labels: boolean, mark?: string): void {
  const W = canvas.clientWidth;
  if (!W) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(W * dpr);
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const P = (x: number, z: number) => toMap(x, z, W);
  g.drawImage(isle.relief, 0, 0, W, W);
  const line = (pts: Array<[number, number]>, color: string, width: number, dash: number[] = []) => {
    g.beginPath();
    pts.forEach(([x, z], i) => {
      const [px, py] = P(x, z);
      if (i) g.lineTo(px, py);
      else g.moveTo(px, py);
    });
    g.setLineDash(dash);
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.stroke();
    g.setLineDash([]);
  };
  if (L.roads)
    for (const r of isle.roads) {
      line(r.points, 'rgba(70,45,20,0.35)', 3.6);
      line(r.points, '#f6e7c4', 1.8);
    }
  if (L.plots) {
    const f = Z.farmland;
    const [a, b] = P(f.x + f.w / 2, f.z + f.d / 2);
    const [c, d] = P(f.x - f.w / 2, f.z - f.d / 2);
    g.setLineDash([4, 3]);
    g.strokeStyle = 'rgba(90,55,25,0.85)';
    g.lineWidth = 1.2;
    g.strokeRect(a, b, c - a, d - b);
    g.setLineDash([]);
    const s = (16 / SPAN) * W;
    for (const p of Z.housePlots) {
      const [px, py] = P(p.x, p.z);
      g.fillStyle = 'rgba(255,240,210,0.85)';
      g.strokeStyle = 'rgba(90,55,25,0.9)';
      g.fillRect(px - s / 2, py - s / 2, s, s);
      g.strokeRect(px - s / 2, py - s / 2, s, s);
    }
  }
  if (L.nodes)
    for (const n of Z.nodes) {
      const [px, py] = P(n.x, n.z);
      g.fillStyle = NODE_COLOR[n.kind] ?? '#999';
      g.beginPath();
      g.arc(px, py, 3, 0, Math.PI * 2);
      g.fill();
    }
  if (L.air) {
    for (const r of isle.ramps) line(r, 'rgba(255,255,255,0.95)', 1.6, [3, 3]);
    for (const u of Z.updrafts) {
      const [px, py] = P(u.x, u.z);
      g.strokeStyle = 'rgba(255,255,255,0.95)';
      g.lineWidth = 1.5;
      for (const k of [1, 0.6]) {
        g.beginPath();
        g.arc(px, py, Math.max(4, (u.r / SPAN) * W * 2.2 * k), 0, Math.PI * 2);
        g.stroke();
      }
    }
  }
  if (L.routes)
    for (const r of routeLines(isle)) {
      line(r.pts, 'rgba(60,35,0,0.35)', 4.5, r.dash);
      line(r.pts, '#e0a72e', 2.6, r.dash);
    }
  if (L.places) {
    g.font = '600 ' + (W < 420 ? 10 : 11.5) + 'px "Instrument Sans", "Ruina Serif", system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (const p of Z.places) {
      const [px, py] = P(p.x, p.z);
      if (p.id === mark) {
        g.strokeStyle = '#7a1f26';
        g.lineWidth = 3;
        g.beginPath();
        g.arc(px, py, 14, 0, Math.PI * 2);
        g.stroke();
      }
      g.fillStyle = p.kind === 'outpost' ? '#e0a72e' : '#13202b';
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(px, py, p.kind === 'village' ? 6 : 4.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      if (!labels && p.id !== mark) continue;
      const w = g.measureText(p.name).width + 10;
      const lx = Math.min(W - w - 2, Math.max(2, px + 8));
      g.fillStyle = p.id === mark ? 'rgba(255,240,200,0.95)' : 'rgba(255,255,255,0.86)';
      g.beginPath();
      g.roundRect(lx, py - 9, w, 18, 6);
      g.fill();
      g.fillStyle = '#13202b';
      g.fillText(p.name, lx + 5, py + 0.5);
    }
  }
}
