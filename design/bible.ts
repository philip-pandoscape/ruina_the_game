// The design bible's live half. design/index.html holds the prose; everything drawn from data (the
// tables, charts, calculators, the map and the tracker) is drawn here, from the same modules the
// game runs on: the content in src/content/ (shared/*.json), the tuning, the rules' own formulas,
// the zone recipe grown by the real terrain generator, and the tracker in design/status.json.
// Nothing is copied or generated, so the page cannot fall behind the game.
//
// Open it from the dev server: `npm run dev`, then http://localhost:5173/design/. It reloads by
// itself when any of those files change.

import status from './status.json' with { type: 'json' };
import { GLIDERS, MOUNTS, VEHICLES } from '../src/content/vehicles';
import { CARRY, CLOCK, CONTRACTS, DEMAND, FRESHNESS, LABOR, PACKS, ROUTES, formatCoins as coins, packDef, placeName, type PackDef } from '../src/content/trade';
import { ANIMALS, CLIMATES, CROPS, FARM, GATHERING, climateFactor } from '../src/content/farming';
import { ITEMS, VENDORS } from '../src/content/items';
import { BLUEPRINTS } from '../src/content/housing';
import { QUESTS, questDef, type QuestDef } from '../src/content/quests';
import { SHIP_DESIGNS } from '../src/content/shipyard';
import { GROUND, STORM, SWIM } from '../src/content/traversal';
import { ABILITIES, JUMP, MOVE, MOVEMENT_SKILLS, SKILLS, WEAPONS } from '../src/tuning';
import { LADDERS, actorKind } from '../src/content/actors';
import { behaviour } from '../src/sim/ai/brain';
import { freshness } from '../src/sim/life/trade';
import { EMBERHOLM as Z } from '../src/sim/zone/world';
import { generateZone } from '../src/sim/zone/generate';
import { SURFACE } from '../src/sim/terrain';
import type { ZonePlace } from '../src/sim/zone/types';

// ---------- the tracker (design/status.json) ----------

type Status = 'done' | 'building' | 'planned' | 'idea';

interface Tracker {
  updated: string;
  systems: Array<{ id: string; name: string }>;
  features: Array<{ system: string; status: Status; title: string; notes: string; files?: string[] }>;
  next: string[];
  questions: Array<{ q: string; context: string }>;
  sessions: Array<{ date: string; title: string; summary: string; points: string[] }>;
}

const S = status as Tracker;
const STATUS: Status[] = ['done', 'building', 'planned', 'idea'];
const LABEL: Record<Status, string> = { done: 'Done', building: 'Building', planned: 'Planned', idea: 'Idea' };
const SWATCH: Record<Status, string> = { done: 'var(--ok)', building: 'var(--wip)', planned: 'var(--plan)', idea: 'var(--idea)' };
const sysName = new Map(S.systems.map((s) => [s.id, s.name]));

// ---------- helpers ----------

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`no ${sel} on the page`);
  return el;
};
const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, (c) => ENTITIES[c]);
const mmss = (sec: number): string => (sec >= 3600 ? (sec / 3600).toFixed(1) + ' h' : sec >= 60 ? Math.round(sec / 60) + ' min' : Math.round(sec) + ' s');
const degrees = (slope: number): number => Math.round((Math.atan(slope) * 180) / Math.PI);
const itemName = (id: string): string => ITEMS.find((i) => i.id === id)?.name ?? id;
const npcName = (id: string): string => Z.npcs.find((n) => n.id === id)?.name ?? id;
const packName = (id: string): string => PACKS.find((p) => p.id === id)?.name ?? id;
/** Material packs go to building sites; the rest are trade goods. */
const isMaterial = (p: PackDef): boolean => (p as { kind?: string }).kind === 'material';

function place(id: string): ZonePlace {
  const p = Z.places.find((x) => x.id === id);
  if (!p) throw new Error(`${Z.name} has no place "${id}"`);
  return p;
}

type Cell = string | number;

function table(el: HTMLElement, head: string[], rows: Cell[][], numeric: number[] = []): void {
  const n = (i: number) => (numeric.includes(i) ? ' class="n"' : '');
  el.innerHTML =
    '<thead><tr>' + head.map((h, i) => `<th${n(i)}>${h}</th>`).join('') + '</tr></thead><tbody>' +
    rows.map((r) => '<tr>' + r.map((c, i) => `<td${n(i)}>${c}</td>`).join('') + '</tr>').join('') + '</tbody>';
}

/** Draws one part of the page. If the data stops fitting it, the console says so and the rest still draws. */
function part(name: string, draw: () => void): void {
  try {
    draw();
  } catch (e) {
    console.error(`design bible: could not draw ${name}:`, e);
  }
}

// ---------- navigation ----------

const SECTIONS: Array<[id: string, name: string, system?: string]> = [
  ['overview', 'Overview'], ['pillars', 'Pillars'], ['world', 'World', 'world'], ['getting-around', 'Getting around', 'traversal'],
  ['vehicles', 'Vehicles & mounts', 'vehicles'], ['trade', 'Trade & packs', 'trade'], ['farming', 'Farming', 'farming'],
  ['housing', 'Housing', 'housing'], ['economy', 'Economy', 'economy'], ['quests', 'Quests', 'quests'], ['combat', 'Combat & skills', 'combat'],
  ['interface', 'Interface', 'ui'], ['architecture', 'Architecture', 'tech'], ['controls', 'Controls'], ['tracker', 'Tracker'], ['research', 'ArcheAge notes'], ['questions', 'Open questions'], ['log', 'Session log'],
];

function countBy(system: string | null): Record<Status, number> {
  const c: Record<Status, number> = { done: 0, building: 0, planned: 0, idea: 0 };
  for (const f of S.features) if (!system || f.system === system) c[f.status]++;
  return c;
}

const sum = (c: Record<Status, number>): number => STATUS.reduce((a, st) => a + c[st], 0);

function pips(system: string): string {
  const c = countBy(system);
  const total = sum(c);
  const on = Math.round((c.done / Math.max(1, total)) * 5);
  return `<span class="pips" title="${c.done} of ${total} done">` + Array.from({ length: 5 }, (_, i) => `<i style="background:${i < on ? 'var(--ok)' : 'var(--rule)'}"></i>`).join('') + '</span>';
}

part('the navigation', () => {
  $('#railnav').innerHTML = SECTIONS.map(
    ([id, name, sys], i) => (i === 2 ? '<div class="group">Systems</div>' : i === 12 ? '<div class="group">Reference</div>' : '') + `<a href="#${id}" data-id="${id}"><span>${esc(name)}</span>${sys ? pips(sys) : ''}</a>`,
  ).join('');
  $('#topnav').innerHTML = SECTIONS.map(([id, name]) => `<a href="#${id}">${esc(name)}</a>`).join('');
  $('#railfoot').innerHTML = `Drawn live from the game's data<br>Tracker updated ${esc(S.updated)}`;
  const links = [...document.querySelectorAll<HTMLAnchorElement>('#railnav a')];
  const spy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) links.forEach((a) => a.classList.toggle('on', a.dataset.id === e.target.id));
    },
    { rootMargin: '-30% 0px -65% 0px' },
  );
  for (const [id] of SECTIONS) {
    const el = document.getElementById(id);
    if (el) spy.observe(el);
  }
});

// ---------- status ----------

const ALL = countBy(null);
const TOTAL = S.features.length;
const bar = (c: Record<Status, number>, n: number): string => '<div class="bar">' + STATUS.map((st) => `<i class="${st}" style="width:${(c[st] / Math.max(1, n)) * 100}%"></i>`).join('') + '</div>';

/** The hero's line of facts. The island's own numbers join it once the island has grown. */
function facts(isle: Island | null): void {
  $('#facts').innerHTML = [
    `<span>Starter zone <b>${esc(Z.name)}</b></span>`,
    `<span><b>${Z.npcs.length}</b> townsfolk</span>`,
    isle ? `<span><b>${isle.trees.toLocaleString()}</b> trees</span>` : '',
    isle ? `<span>Peak <b>${isle.peak} m</b></span>` : '',
    `<span><b>${VEHICLES.length + MOUNTS.length}</b> rides · <b>${GLIDERS.length}</b> gliders</span>`,
    `<span><b>${QUESTS.length}</b> quests</span>`,
  ].join('');
}

part('the status summary', () => {
  $('#statusSum').innerHTML =
    `<div class="total"><strong class="num">${ALL.done}/${TOTAL}</strong><span>tracked features built · ${ALL.building} in progress · ${ALL.planned} planned</span></div>` +
    bar(ALL, TOTAL) +
    '<div class="legend">' + STATUS.map((st) => `<span><i style="background:${SWATCH[st]}"></i>${LABEL[st]} ${ALL[st]}</span>`).join('') + '</div>';
  facts(null);
  document.querySelectorAll<HTMLElement>('[data-status]').forEach((el) => {
    const c = countBy(el.dataset.status ?? null);
    el.innerHTML = STATUS.filter((st) => c[st]).map((st) => `<span class="chip ${st}">${c[st]} ${LABEL[st].toLowerCase()}</span>`).join('');
  });
  document.querySelectorAll<HTMLElement>('[data-next]').forEach((el) => {
    const f = S.features.filter((x) => x.system === el.dataset.next && x.status !== 'done');
    if (!f.length) {
      el.remove();
      return;
    }
    el.innerHTML =
      '<h3>Not yet built</h3>' +
      f.map((x) => `<div class="row"><span class="chip ${x.status}">${LABEL[x.status]}</span><span><b>${esc(x.title)}.</b> <span class="sub">${esc(x.notes)}</span></span></div>`).join('');
  });
});

// ---------- map ----------
// The island and its waters, 1280 m square around the origin. North (+Z) is up and east (-X) is to
// the right, so a world point lands ((HALF - x) / SPAN, (HALF - z) / SPAN) of the way across.

const HALF = 640;
const SPAN = HALF * 2;
/** Pixels across the shaded relief: one per 2 m cell. */
const RELIEF = 640;

const SURF: Record<number, [number, number, number]> = {
  [SURFACE.grass]: [134, 194, 92],
  [SURFACE.road]: [201, 166, 116],
  [SURFACE.sand]: [234, 216, 162],
  [SURFACE.rock]: [152, 152, 146],
  [SURFACE.soil]: [124, 88, 58],
  [SURFACE.plaza]: [216, 206, 184],
  [SURFACE.forest]: [92, 154, 76],
};

interface Island {
  relief: HTMLCanvasElement;
  roads: Array<{ id: string; points: Array<[number, number]> }>;
  ramps: Array<Array<[number, number]>>;
  trees: number;
  rocks: number;
  peak: number;
  cell: number;
}

/** Grows the island with the game's own generator and shades its relief. */
function growIsland(): Island {
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
  return {
    relief,
    roads: gen.roads,
    ramps: gen.ramps,
    trees: gen.obstacles.filter((o) => o.kind === 'tree').length,
    rocks: gen.obstacles.filter((o) => o.kind === 'rock').length,
    peak: Math.round(peak),
    cell: hf.cell,
  };
}

interface Layers {
  places: boolean;
  roads: boolean;
  routes: boolean;
  plots: boolean;
  nodes: boolean;
  air: boolean;
}

const LAYER_NAMES: Record<keyof Layers, [string, string]> = {
  places: ['Places', 'var(--ink)'],
  roads: ['Roads', '#f6e7c4'],
  routes: ['Trade routes', '#e0a72e'],
  plots: ['Plots & fields', '#7e5636'],
  nodes: ['Gathering', '#9a9a94'],
  air: ['Ledge path & rising air', '#ffffff'],
};
const layers: Layers = { places: true, roads: true, routes: true, plots: true, nodes: false, air: true };
const HERO_LAYERS: Layers = { places: true, roads: true, routes: true, plots: false, nodes: false, air: true };
const NODE_COLOR: Record<string, string> = { timberNode: '#8d5a3b', stoneNode: '#d6d0c3', oreNode: '#b5651d', herbNode: '#3e9a45' };
const SECTION_OF: Record<string, string> = {
  village: 'trade', docks: 'vehicles', farmland: 'farming', housing: 'housing', landmark: 'getting-around',
  outpost: 'trade', forest: 'farming', quarry: 'farming', meadow: 'combat', beach: 'getting-around',
};
const BLURB: Record<string, string> = {
  lanternwick: 'The harbour village: the Specialty Workbench, vendors, the wainwright, stables and the land registry. You arrive here.',
  docks: 'Two piers and the shipwright. Summon boats here; the bay opens south to the sea.',
  barleybrook: 'Open, level farmland. The first scarecrow plot usually goes here, beside the villagers’ fields.',
  hearthside: 'Eight house plots on a rise above the village, each 16 m square.',
  windspire: 'A 128 m crag with a ledge path spiralling up its face and the glider launch on top. Rising air at its foot.',
  westwatch: 'Trading post on the western headland, reached by the west road and up the cliffs. Pays ×1.0 for Lanternwick packs.',
  gullrock: 'An islet trading post off the south-east coast. Reachable only by boat (or a long glide). Pays ×1.5 and more seals.',
  thornwood: 'Dense forest with deadfall timber and Hob’s sawhorse, where lumber becomes bundles.',
  quarry: 'A stone pit with stone and iron outcrops and the stonecutter’s table.',
  meadow: 'A slime pack and a training dummy. The slimes leave you alone until you hit one; then they call each other in, grow, and burst into pieces that reform bigger.',
  strand: 'A sandy beach on a sheltered bay; good for learning to swim and row.',
};

function routeLines(isle: Island): Array<{ pts: Array<[number, number]>; dash: number[] }> {
  const out: Array<{ pts: Array<[number, number]>; dash: number[] }> = [];
  const wb = Z.workbenches[0];
  const west = isle.roads.find((r) => r.id === 'west');
  if (west) out.push({ pts: [[wb.x, wb.z], ...west.points], dash: [] });
  const docks = Z.places.find((p) => p.id === 'docks');
  const gull = Z.outposts.find((o) => o.id === 'gullrock');
  if (docks && gull) out.push({ pts: [[wb.x, wb.z], [docks.x, docks.z], [docks.x - 120, docks.z - 120], [gull.x + 40, gull.z + 50], [gull.x, gull.z]], dash: [7, 6] });
  return out;
}

function draw(canvas: HTMLCanvasElement, isle: Island, L: Layers, labels: boolean): void {
  const W = canvas.clientWidth;
  if (!W) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(W * dpr);
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const P = (x: number, z: number): [number, number] => [((HALF - x) / SPAN) * W, ((HALF - z) / SPAN) * W];
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
    g.font = '600 ' + (W < 420 ? 10 : 11.5) + 'px "Instrument Sans", system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (const p of Z.places) {
      const [px, py] = P(p.x, p.z);
      g.fillStyle = p.kind === 'outpost' ? '#e0a72e' : '#13202b';
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(px, py, p.kind === 'village' ? 6 : 4.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      if (!labels) continue;
      const w = g.measureText(p.name).width + 10;
      const lx = Math.min(W - w - 2, Math.max(2, px + 8));
      g.fillStyle = 'rgba(255,255,255,0.86)';
      g.beginPath();
      g.roundRect(lx, py - 9, w, 18, 6);
      g.fill();
      g.fillStyle = '#13202b';
      g.fillText(p.name, lx + 5, py + 0.5);
    }
  }
}

let island: Island | null = null;

function drawMaps(): void {
  if (!island) return;
  const hero = document.querySelector<HTMLCanvasElement>('#heroMap');
  const world = document.querySelector<HTMLCanvasElement>('#worldMap');
  if (hero) draw(hero, island, HERO_LAYERS, false);
  if (world) draw(world, island, layers, true);
}

part('the map controls', () => {
  $('#layers').innerHTML =
    '<h3>Layers</h3>' +
    (Object.keys(LAYER_NAMES) as Array<keyof Layers>)
      .map((k) => `<label><input type="checkbox" id="layer-${k}" ${layers[k] ? 'checked' : ''}><span class="sw" style="background:${LAYER_NAMES[k][1]}"></span>${LAYER_NAMES[k][0]}</label>`)
      .join('') +
    '<p class="caption" id="mapStats" style="margin-top:8px">Growing the island…</p>';
  for (const k of Object.keys(layers) as Array<keyof Layers>)
    $<HTMLInputElement>('#layer-' + k).addEventListener('change', (e) => {
      layers[k] = (e.target as HTMLInputElement).checked;
      drawMaps();
    });
  let resizing = 0;
  addEventListener('resize', () => {
    clearTimeout(resizing);
    resizing = window.setTimeout(drawMaps, 120);
  });

  const canvas = $<HTMLCanvasElement>('#worldMap');
  const tip = $('#tip');
  /** The place under the pointer, if any, and where it sits on the canvas. */
  const placeAt = (e: MouseEvent): { p: ZonePlace; px: number; py: number; W: number } | null => {
    const r = canvas.getBoundingClientRect();
    const W = r.width;
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    let best: { p: ZonePlace; px: number; py: number; W: number } | null = null;
    let bd = 18;
    for (const p of Z.places) {
      const px = ((HALF - p.x) / SPAN) * W;
      const py = ((HALF - p.z) / SPAN) * W;
      const d = Math.hypot(px - mx, py - my);
      if (d < bd) {
        bd = d;
        best = { p, px, py, W };
      }
    }
    return best;
  };
  canvas.addEventListener('mousemove', (e) => {
    const hit = placeAt(e);
    canvas.style.cursor = hit ? 'pointer' : 'crosshair';
    tip.hidden = !hit;
    if (!hit) return;
    tip.innerHTML = `<b>${esc(hit.p.name)}</b>${esc(BLURB[hit.p.id] || '')}`;
    tip.style.left = Math.min(hit.W - 250, hit.px + 12) + 'px';
    tip.style.top = Math.min(hit.W - 90, hit.py + 12) + 'px';
  });
  canvas.addEventListener('mouseleave', () => (tip.hidden = true));
  canvas.addEventListener('click', (e) => {
    const s = SECTION_OF[placeAt(e)?.p.kind ?? ''];
    if (s) location.hash = s;
  });
  table($('#placesTable'), ['Place', 'What is there'], Z.places.map((p) => [`<b>${esc(p.name)}</b><span class="sub">${esc(p.kind)}</span>`, esc(BLURB[p.id] || '')]));
});

// ---------- getting around ----------

part('getting around', () => {
  const jumpH = (v: number) => (v * v) / (2 * JUMP.gravityUp);
  table($('#footTable'), ['On foot & in water', 'Value'], [
    ['Walk / run / sprint', `${MOVE.walkSpeed} / ${MOVE.runSpeed} / ${MOVE.sprintSpeed} m/s`],
    ['Jump, then double jump', `${jumpH(JUMP.velocity).toFixed(1)} m + ${jumpH(JUMP.doubleJumpVelocity).toFixed(1)} m`],
    ['Steepest walkable slope', `${degrees(GROUND.maxSlope)}°`],
    ['Highest step without jumping', `${GROUND.stepUp} m`],
    ['Wading (water over ' + GROUND.wadeDepth + ' m)', `${Math.round(GROUND.wadeSpeed * 100)}% speed`],
    ['Swimming / sprint-swimming', `${SWIM.speed} / ${SWIM.sprintSpeed} m/s`],
    ['Carrying a pack', `${Math.round(CARRY.speedFactor * 100)}% speed, no sprint or double jump`],
  ], [1]);
  table($('#gliderTable'), ['Glider', 'Cruise', 'Sink', 'Glide ratio', 'Dive'], GLIDERS.map((g) => [
    `<b>${esc(g.name)}</b><span class="sub">${esc(g.desc)}</span>`, `${g.cruiseSpeed} m/s`, `${g.sink} m/s`, `1 : ${(g.cruiseSpeed / g.sink).toFixed(1)}`, `${g.diveSpeed} m/s`,
  ]), [1, 2, 3, 4]);
});

part('the glide chart', () => {
  const svg = $<SVGSVGElement>('#glideChart');
  const W = 520, H = 300, l = 48, r = 16, t = 16, b = 34;
  const maxH = 140, maxD = 1000;
  const x = (h: number) => l + (h / maxH) * (W - l - r);
  const y = (d: number) => t + (1 - d / maxD) * (H - t - b);
  let s = '';
  for (let d = 0; d <= maxD; d += 250) s += `<line class="grid" x1="${l}" x2="${W - r}" y1="${y(d)}" y2="${y(d)}"/><text class="axis" x="${l - 6}" y="${y(d) + 4}" text-anchor="end">${d}</text>`;
  for (let h = 0; h <= maxH; h += 20) s += `<text class="axis" x="${x(h)}" y="${H - b + 16}" text-anchor="middle">${h}</text>`;
  s += `<text class="axis" x="${W - r}" y="${H - 4}" text-anchor="end">launch height (m)</text><text class="axis" x="${l}" y="${t - 4}">range (m)</text>`;
  const spire = place('windspire');
  const dist = (id: string) => Math.round(Math.hypot(place(id).x - spire.x, place(id).z - spire.z));
  for (const [id, name] of [['lanternwick', 'Lanternwick'], ['docks', 'Docks'], ['gullrock', 'Gullrock']]) {
    const d = dist(id);
    if (d > maxD) continue;
    s += `<line class="ref" x1="${l}" x2="${W - r}" y1="${y(d)}" y2="${y(d)}"/><text class="reftext" x="${l + 6}" y="${y(d) - 5}">${name} ${d} m</text>`;
  }
  // Launched from the top of the Windspire, where the glider deck is.
  const at = Z.terrain.mountains.find((m) => m.id === 'windspire')?.top ?? 128;
  GLIDERS.forEach((g, i) => {
    const ratio = g.cruiseSpeed / g.sink;
    const end = Math.min(maxH, maxD / ratio);
    s += `<line class="${i ? 'line2' : 'line'}" x1="${x(0)}" y1="${y(0)}" x2="${x(end)}" y2="${y(end * ratio)}"/>`;
    s += `<circle class="${i ? 'dot2' : 'dot'}" cx="${x(at)}" cy="${y(at * ratio)}" r="4.5"/><text class="lbl" x="${x(at) - 8}" y="${y(at * ratio) - 9}" text-anchor="end">${esc(g.name.replace(' Glider', ''))} ${Math.round(at * ratio)} m</text>`;
  });
  svg.innerHTML = s;
});

part('the glide calculator', () => {
  const el = $('#glideCalc');
  el.innerHTML = `<div class="controls"><h3>Glide calculator</h3>
    <label for="gc-g">Glider<select id="gc-g">${GLIDERS.map((g, i) => `<option value="${i}">${esc(g.name)}</option>`).join('')}</select></label>
    <label for="gc-h">Height above the landing <span class="num" id="gc-hv"></span><input type="range" id="gc-h" min="5" max="140" value="128"></label>
    <label for="gc-a">Attitude<select id="gc-a"><option value="cruise">Cruise</option><option value="dive">Dive (sprint)</option><option value="flare">Flare (crouch)</option></select></label></div>
    <div class="out"><div class="big num" id="gc-out"></div><div class="breakdown" id="gc-bd"></div></div>`;
  const glider = $<HTMLSelectElement>('#gc-g', el);
  const height = $<HTMLInputElement>('#gc-h', el);
  const attitude = $<HTMLSelectElement>('#gc-a', el);
  const upd = () => {
    const g = GLIDERS[+glider.value];
    const h = +height.value;
    const a = attitude.value;
    const v = a === 'dive' ? g.diveSpeed : a === 'flare' ? g.flareSpeed : g.cruiseSpeed;
    const sink = a === 'dive' ? g.diveSink : a === 'flare' ? g.flareSink : g.sink;
    const time = h / sink;
    $('#gc-hv', el).textContent = h + ' m';
    $('#gc-out', el).textContent = Math.round(v * time) + ' m';
    $('#gc-bd', el).innerHTML = `${v} m/s forward, ${sink} m/s down<br>${time.toFixed(0)} s in the air · ratio 1:${(v / sink).toFixed(1)}`;
  };
  el.querySelectorAll('select,input').forEach((i) => i.addEventListener('input', upd));
  upd();
});

// ---------- vehicles ----------

part('vehicles', () => {
  const kmh = (v: number) => Math.round(v * 3.6);
  table($('#vehicleTable'), ['Vehicle', 'Top speed', 'Packs', 'Seats', 'Handling'], VEHICLES.map((v) => [
    `<b>${esc(v.name)}</b><span class="sub">${esc(v.desc)}</span>`,
    `${v.maxSpeed} m/s<span class="sub">${kmh(v.maxSpeed)} km/h${v.class === 'wheeled' && v.boostSpeed ? ` · boost ${v.boostSpeed} m/s` : ''}</span>`,
    v.cargo.length,
    v.seats.length,
    v.class === 'boat'
      ? v.sail ? `Sail; turns ${v.turnRate} rad/s, draft ${v.draft} m` : `Oars; turns on the spot, draft ${v.draft} m`
      : `Offroad ${Math.round(v.offroad * 100)}%, climbs ${degrees(v.climb)}°, drift grip ${v.driftGrip}`,
  ]), [1, 2, 3]);
  table($('#mountTable'), ['Mount', 'Walk / run / gallop', 'With a pack', 'Jump'], MOUNTS.map((m) => [
    `<b>${esc(m.name)}</b><span class="sub">${esc(m.desc)}</span>`, `${m.walkSpeed} / ${m.runSpeed} / ${m.gallopSpeed} m/s`, m.canCarryPack ? `${m.packSpeed} m/s` : 'Refuses', `${m.jump} m/s`,
  ]), [1, 2, 3]);
  const SD = SHIP_DESIGNS[0];
  table($('#shipTable'), [`${esc(SD.name)} stage`, 'Haul to the slip', 'Labor'], SD.stages.map((st) => [
    `<b>${esc(st.name)}</b><span class="sub">${esc(st.desc)}</span>`, Object.entries(st.needs).map(([p, n]) => `${n} × ${esc(packName(p))}`).join('<br>'), st.labor,
  ]), [2]);
  $('#aaVehicles').innerHTML = [
    'ArcheAge carts carried 2 to 8 packs at 4 to 9.7 m/s and were built from wheels, a shaft and an engine. Ours are summoned from deeds made of lumber and iron.',
    'ArcheAge ships were built at a drydock by hauling material packs in stages; our Merchant Cog is built exactly that way on the Lanternwick slipway.',
    'Mount sprints were disabled while carrying a pack and normal mounts slowed by 80%; we simply let only the donkey carry one.',
    'ArcheAge had no wind; our sloop sails on it, which makes the sea routes a little more about seamanship.',
  ].map((t) => `<li>${t}</li>`).join('');
});

// ---------- trade ----------

const tradePacks = PACKS.filter((p) => !isMaterial(p));
const routesFrom = (origin: string) => ROUTES.filter((r) => r.from === origin);
const seals = (n: number) => `${n} seal${n > 1 ? 's' : ''}`;

part('trade packs', () => {
  table($('#packTable'), ['Trade pack', 'Made from', 'Labor · fee', 'Fresh, at 110% demand'], tradePacks.map((p) => [
    `<b>${esc(p.name)}</b><span class="sub">Workbench at ${esc(placeName(p.origin))}</span>`,
    p.inputs.map((i) => `${i.n} ${esc(itemName(i.item))}`).join(', '),
    `${p.labor} · ${coins(p.fee)}`,
    routesFrom(p.origin)
      .map((r) => `${esc(placeName(r.to).replace(' Trading Post', '').replace(' Exchange', ''))}: <b>${coins(p.base * r.factor * DEMAND.start * freshness(0))}</b>${r.seals ? ` + ${seals(r.seals)}` : ''}`)
      .join('<br>'),
  ]), [2]);
});

part('the pay calculator', () => {
  const el = $('#payCalc');
  el.innerHTML = `<div class="controls"><h3>What will it fetch?</h3>
    <label for="pc-p">Pack<select id="pc-p">${tradePacks.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('')}</select></label>
    <label for="pc-r">Sold at<select id="pc-r"></select></label>
    <label for="pc-d">Demand there <span class="num" id="pc-dv"></span><input type="range" id="pc-d" min="${DEMAND.min * 100}" max="${DEMAND.max * 100}" value="${DEMAND.start * 100}"></label>
    <label for="pc-a">Pack age <span class="num" id="pc-av"></span><input type="range" id="pc-a" min="0" max="60" value="5"></label></div>
    <div class="out"><div class="big num" id="pc-out"></div><div class="breakdown" id="pc-bd"></div></div>`;
  const pack = $<HTMLSelectElement>('#pc-p', el);
  const sold = $<HTMLSelectElement>('#pc-r', el);
  const demand = $<HTMLInputElement>('#pc-d', el);
  const age = $<HTMLInputElement>('#pc-a', el);
  const fillRoutes = () => {
    sold.innerHTML = routesFrom(tradePacks[+pack.value].origin).map((r, i) => `<option value="${i}">${esc(placeName(r.to))}</option>`).join('');
  };
  const upd = () => {
    const p = tradePacks[+pack.value];
    const r = routesFrom(p.origin)[+sold.value];
    const dmd = +demand.value / 100;
    const minutes = +age.value;
    const fr = freshness(minutes * 60);
    $('#pc-dv', el).textContent = Math.round(dmd * 100) + '%';
    $('#pc-av', el).textContent = minutes + ' min';
    $('#pc-out', el).textContent = coins(p.base * r.factor * dmd * fr) + (r.seals ? ` + ${seals(r.seals)}` : '');
    $('#pc-bd', el).innerHTML =
      `${coins(p.base)} base × ${r.factor} route × ${dmd.toFixed(2)} demand × ${fr.toFixed(2)} fresh` +
      (r.seals ? `<br>plus ${r.seals} Charter Seal${r.seals > 1 ? 's' : ''}` : '') +
      `<br>costs ${p.labor} labor + ${coins(p.fee)} to make`;
  };
  pack.addEventListener('input', fillRoutes); // first, so the routes are the new pack's when upd runs
  el.querySelectorAll('select,input').forEach((i) => i.addEventListener('input', upd));
  fillRoutes();
  upd();
});

part('the freshness chart', () => {
  const svg = $<SVGSVGElement>('#freshChart');
  const W = 520, H = 260, l = 48, r = 16, t = 16, b = 34;
  const lo = -0.15, hi = 0.2, maxA = 60;
  const x = (m: number) => l + (m / maxA) * (W - l - r);
  const y = (v: number) => t + (1 - (v - lo) / (hi - lo)) * (H - t - b);
  let s = '';
  for (const v of [-0.1, 0, 0.1, 0.2]) s += `<line class="grid" x1="${l}" x2="${W - r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${l - 6}" y="${y(v) + 4}" text-anchor="end">${v > 0 ? '+' : ''}${Math.round(v * 100)}%</text>`;
  for (let m = 0; m <= maxA; m += 15) s += `<text class="axis" x="${x(m)}" y="${H - b + 16}" text-anchor="middle">${m}</text>`;
  s += `<text class="axis" x="${W - r}" y="${H - 4}" text-anchor="end">pack age (min)</text>`;
  const pts: Array<[number, number]> = [];
  for (let m = 0; m <= maxA; m += 0.5) pts.push([x(m), y(freshness(m * 60) - 1)]);
  s += `<path class="area" d="M${x(0)},${y(0)} ` + pts.map(([a, c]) => `L${a.toFixed(1)},${c.toFixed(1)}`).join(' ') + ` L${x(maxA)},${y(0)} Z" opacity="0.6"/>`;
  s += `<path class="line" d="` + pts.map(([a, c], i) => `${i ? 'L' : 'M'}${a.toFixed(1)},${c.toFixed(1)}`).join(' ') + `"/>`;
  const F = FRESHNESS;
  s += `<circle class="dot" cx="${x(F.bonusSeconds / 60)}" cy="${y(F.bonus)}" r="4"/><text class="lbl" x="${x(F.bonusSeconds / 60) + 8}" y="${y(F.bonus) - 6}">+${Math.round(F.bonus * 100)}% until ${F.bonusSeconds / 60} min</text>`;
  s += `<circle class="dot2" cx="${x(F.staleSeconds / 60)}" cy="${y(F.penalty)}" r="4"/><text class="lbl" x="${x(F.staleSeconds / 60) - 8}" y="${y(F.penalty) + 18}" text-anchor="end">${Math.round(F.penalty * 100)}% from ${F.staleSeconds / 60} min</text>`;
  svg.innerHTML = s;
});

part('the rules of the road', () => {
  $('#tradeRules').innerHTML = [
    `Price = base × route × demand × freshness. A pack sells for nothing where it was made.`,
    `Each sale lowers that post's demand for that pack by ${Math.round(DEMAND.dropPerSale * 100)}% (never below ${Math.round(DEMAND.min * 100)}%); it recovers ${Math.round(DEMAND.recoverPerMinute * 100)}% a minute, up to ${Math.round(DEMAND.max * 100)}%.`,
    `On your back a pack costs ${100 - Math.round(CARRY.speedFactor * 100)}% of your speed, your sprint, your double jump and your glider; swimming with one is ${Math.round(CARRY.swimFactor * 100)}% speed.`,
    `X sets a pack down; anyone close can pick it up. Packs in a vehicle travel with it; a loaded vehicle cannot be sent home.`,
    `Routes pay Charter Seals on top: ${ROUTES.map((r) => `${placeName(r.to)} ${r.seals}`).join(', ')}.`,
    `Each post keeps ${CONTRACTS.perOutpost} contracts on its board (so many packs of a kind, within ${Math.round(CONTRACTS.durationSeconds / 60)} minutes of taking it). Fill one for bonus seals and about ${Math.round(CONTRACTS.coinBonus * 100)}% extra coin; hold up to ${CONTRACTS.maxActive} at once.`,
    `The sea route is the risky one: in the rain, water deeper than ${STORM.fromDepth} m turns rough. Small boats lose their hull fast, a cog barely notices; a boat that breaks up drops its cargo, which floats where she sank.`,
  ].map((t) => `<li>${esc(t)}</li>`).join('');
  table($('#materialTable'), ['Material pack', 'Made from', 'Where', 'Used for'], PACKS.filter(isMaterial).map((p) => [
    `<b>${esc(p.name)}</b>`, p.inputs.map((i) => `${i.n} ${esc(itemName(i.item))}`).join(', ') + ` · ${p.labor} labor`, esc(placeName(p.origin)), 'Building stages (see Housing)',
  ]));
  $('#aaTrade').innerHTML = [
    'Specialty packs from regional workbenches, carried slowly, sold far away: kept as the heart of the system.',
    'ArcheAge demand swung between 70% and 130% and recovered slowly; we use the same band with faster recovery for a smaller world.',
    'Freshness tiers (up to +30% for luxury goods in the first 15 minutes): we use one gentle curve for every pack, for now.',
    'Payment arrived hours later with interest; ours is paid on the spot.',
    'Packs dropped on death and were stolen and fenced, and the crafter kept a cut: planned with piracy.',
  ].map((t) => `<li>${t}</li>`).join('');
});

// ---------- farming ----------

part('farming', () => {
  table($('#cropTable'), ['Crop', 'Climate', 'Ripens here', 'Watered', 'Yield', 'Harvest'], CROPS.map((c) => {
    const k = climateFactor(c, Z.climate);
    return [
      `<b>${esc(c.name)}</b><span class="sub">${c.kind === 'tree' ? (c.regrowSeconds ? `Fruits again every ${mmss(c.regrowSeconds / k)}` : 'Felled for timber') : 'Crop'}</span>`,
      esc(CLIMATES[c.climate]?.name || c.climate) + (c.climate === Z.climate ? '' : ' <span class="sub">out of climate</span>'),
      mmss(c.growSeconds / k),
      mmss(c.growSeconds / k / FARM.water.boost),
      c.produce ? `${c.yield[0]}–${c.yield[1]} ${esc(itemName(c.produce))}` : c.chop ? `${c.chop.yield[0]}–${c.chop.yield[1]} lumber` : '—',
      c.produce ? `${c.harvestLabor} labor` : c.chop ? `${c.chop.labor} labor` : '—',
    ];
  }), [2, 3]);
  table($('#animalTable'), ['Livestock', 'Grows up', 'Eats', 'Gives', 'Every'], ANIMALS.map((a) => [
    `<b>${esc(a.young)} → ${esc(a.name)}</b><span class="sub">Raised in a plot cell; only grows and produces while fed</span>`,
    mmss(a.growSeconds),
    `${a.feedN} ${esc(itemName(a.feed))} per ${mmss(a.feedSeconds)}`,
    `${a.yield[0]}–${a.yield[1]} ${esc(itemName(a.produce))} · ${a.collectLabor} labor`,
    mmss(a.produceSeconds),
  ]), [1, 4]);
  $('#growthFormula').textContent = `growth per second = climate (${FARM.climateMatch} or ${FARM.climateMismatch}) × wet (${FARM.water.boost} if watered or raining) ÷ grow time`;
  $('#farmRules').innerHTML = [
    `Watering costs ${FARM.water.labor} labor and lasts until the plant's next stage.`,
    `Rain arrives every ${Math.round(FARM.rain.gapSeconds[0] / 60)}–${Math.round(FARM.rain.gapSeconds[1] / 60)} minutes and lasts ${Math.round(FARM.rain.lastsSeconds[0] / 60)}–${Math.round(FARM.rain.lastsSeconds[1] / 60)}; it waters every field.`,
    `Harvests sometimes return a seed. Felling a tree can turn up a thunderstruck log.`,
    `Up to ${FARM.maxScarecrows} plots, each ${FARM.scarecrowCells * FARM.cell} m square, on grass clear of roads, buildings, trees and other plots.`,
    `The world clock keeps running while you are away (up to ${Math.round(CLOCK.maxOfflineSeconds / 3600)} hours), so crops ripen with the game closed.`,
  ].map((t) => `<li>${esc(t)}</li>`).join('');
  table($('#gatherTable'), ['Node', 'Gives', 'Labor', 'Back in'], Object.entries(GATHERING).map(([id, n]) => [
    `<b>${esc(n.verb)}</b><span class="sub">${Z.nodes.filter((x) => x.kind === id).length} on the isle</span>`,
    `${n.n[0]}–${n.n[1]} ${esc(itemName(n.item))}${n.rare ? `<span class="sub">${Math.round(n.rare.chance * 100)}% ${esc(itemName(n.rare.item))}</span>` : ''}`,
    n.labor,
    mmss(n.respawn),
  ]), [2, 3]);
  $('#aaFarm').innerHTML = [
    'Scarecrow gardens (8 × 8 m) from an early quest, crops on a real-time clock, climates that grow some crops about 30% faster: all kept.',
    'ArcheAge timings ran from 10 minutes (potato) to days (fruit trees); ours are minutes for now, see Open questions.',
    'Crops on unprotected land could be stolen, with footprints, reports and a jury: planned as larceny.',
    'Livestock (chickens, sheep, cows) for eggs, wool and milk: planned.',
  ].map((t) => `<li>${t}</li>`).join('');
});

// ---------- housing ----------

part('housing', () => {
  const BP = BLUEPRINTS[0];
  table($('#stageTable'), ['Stage', 'Haul to the site', 'Labor'], BP.stages.map((s) => [
    `<b>${esc(s.name)}</b><span class="sub">${esc(s.desc)}</span>`, Object.entries(s.needs).map(([p, n]) => `${n} × ${esc(packName(p))}`).join('<br>'), s.labor,
  ]), [2]);
  // All in: the packs every stage needs, what those packs are made from, and the labor for both.
  const packs: Record<string, number> = {};
  let labor = 0;
  for (const s of BP.stages) {
    labor += s.labor;
    for (const [p, n] of Object.entries(s.needs)) packs[p] = (packs[p] || 0) + n;
  }
  const raw: Record<string, number> = {};
  for (const [p, n] of Object.entries(packs)) {
    const def = packDef(p);
    for (const i of def.inputs) raw[i.item] = (raw[i.item] || 0) + i.n * n;
    labor += def.labor * n;
  }
  const sale = VENDORS.flatMap((v) => v.sells).find((s) => s.item === 'blueprint.' + BP.id);
  $('#housePerks').innerHTML = `<h3>The ${esc(BP.name.toLowerCase())}, all in</h3><ul>
    <li>Blueprint: ${coins(sale?.price ?? 0)}${sale?.seals ? ` + ${sale.seals} Charter Seals` : ''} at the Land Registry.</li>
    <li>Raw materials: ${Object.entries(raw).map(([i, n]) => `${n} ${esc(itemName(i))}`).join(', ')}.</li>
    <li>${Object.values(packs).reduce((a, b) => a + b, 0)} pack hauls and about ${labor} labor in total.</li>
    <li>Gives: a ${BP.perks.storageSlots}-kind storage chest, a bed where labor returns ${BP.perks.restLaborMultiplier}× faster, a home to wake in.</li>
    <li>Tax: ${coins(BP.taxPerDay * 7)} a week, paid at the plot; the first ${BP.graceDays} days are free.</li></ul>`;
  $('#aaHouse').innerHTML = [
    'Designs bought with Gilda Stars, plots limited to housing zones, construction by hauling material packs that anyone could help with: all kept (Charter Seals play the Gilda Star role).',
    'The land rush (bots and speculators claiming every plot at launch) and unpaid-tax demolitions won by the fastest clicker were the most resented parts. Plot recycling by lottery and per-account caps are planned; open-world vs instanced land is an open question.',
    'Tax rose steeply with each extra property; we start with one house per settler.',
  ].map((t) => `<li>${t}</li>`).join('');
});

// ---------- economy ----------

part('the economy', () => {
  $('#laborRules').innerHTML = [
    `Labor regenerates ${LABOR.perMinute} a minute while you play and ${LABOR.offlinePerMinute} while you are away, up to ${LABOR.max.toLocaleString()}. Resting in your own bed triples it.`,
    `ArcheAge gave 10 every 5 minutes (2 a minute) toward 2,000–5,000, and sold labor potions; ours is six times as generous and never for sale.`,
    `Coins are copper: 100 copper make a silver, 100 silver a gold.`,
  ].map((t) => `<li>${esc(t)}</li>`).join('');
  table($('#flowTable'), ['Coins come from', 'Coins go to'], [
    ['Selling trade packs', 'Seeds and saplings'],
    ['Selling produce and materials to vendors', 'Workbench fees on packs'],
    ['Quest rewards', 'Vehicles, boats, mounts, gliders'],
    ['Thunderstruck logs', 'Blueprints and property tax'],
  ]);
  table($('#vendorTable'), ['Vendor', 'Sells', 'Buys'], VENDORS.map((v) => [
    `<b>${esc(v.name)}</b><span class="sub">${esc(npcName(v.npc))}</span>`,
    v.sells.map((s) => `${esc(itemName(s.item))} <span class="mono">${coins(s.price)}${s.seals ? ` + ${s.seals} seals` : ''}</span>`).join('<br>'),
    v.buys.length ? v.buys.map((i) => esc(itemName(i))).join(', ') : '—',
  ]));
});

// ---------- quests ----------

part('the quest flow', () => {
  // Columns by how many quests stand before each one.
  const depth: Record<string, number> = {};
  const d = (q: QuestDef): number => (depth[q.id] ??= q.after.length ? 1 + Math.max(...q.after.map((a) => d(questDef(a)))) : 0);
  QUESTS.forEach((q) => d(q));
  const cols: Record<number, QuestDef[]> = {};
  QUESTS.forEach((q) => (cols[depth[q.id]] ??= []).push(q));
  const BW = 198, BH = 62, GX = 50, GY = 18;
  const pos: Record<string, { x: number; y: number }> = {};
  const maxRows = Math.max(...Object.values(cols).map((c) => c.length));
  const avg = (q: QuestDef) => q.after.reduce((t, a) => t + (pos[a]?.y ?? 0), 0) / Math.max(1, q.after.length);
  // Column by column, each quest sits level with the quests it follows, so lines do not cross.
  Object.keys(cols).map(Number).sort((a, b) => a - b).forEach((c) => {
    const list = cols[c];
    if (c > 0) list.sort((a, b) => avg(a) - avg(b));
    list.forEach((q, i) => (pos[q.id] = { x: 12 + c * (BW + GX), y: 12 + (i + (maxRows - list.length) / 2) * (BH + GY) }));
  });
  const W = 24 + Object.keys(cols).length * (BW + GX) - GX;
  const H = 24 + maxRows * (BH + GY) - GY;
  const TEACH: Record<string, string> = {
    placeScarecrow: 'FARMING', plant: 'FARMING', harvest: 'HARVEST', reach: 'EXPLORE', glide: 'GLIDING', gather: 'GATHERING', craftPack: 'PACKS', deliver: 'TRADE', summon: 'VEHICLES', load: 'CARGO',
    placeHouse: 'HOUSING', buildStage: 'HOUSING', talk: 'MEET', raise: 'LIVESTOCK', contract: 'CONTRACTS', layKeel: 'SHIPYARD', shipStage: 'SHIPYARD', launch: 'SHIPYARD',
  };
  let s = '';
  for (const q of QUESTS)
    for (const a of q.after) {
      const p = pos[a], c = pos[q.id];
      s += `<path d="M${p.x + BW},${p.y + BH / 2} C${p.x + BW + GX / 2},${p.y + BH / 2} ${c.x - GX / 2},${c.y + BH / 2} ${c.x},${c.y + BH / 2}"/>`;
    }
  for (const q of QUESTS) {
    const p = pos[q.id];
    const types = [...new Set(q.steps.flatMap((st) => st.objectives.map((o) => TEACH[o.type]).filter(Boolean)))].filter((t, _i, a) => !(t === 'MEET' && a.length > 1)).slice(0, 2);
    s += `<g class="node"><rect x="${p.x}" y="${p.y}" width="${BW}" height="${BH}" rx="9"/><text class="tag" x="${p.x + 12}" y="${p.y + 17}">${types.join(' · ')}</text><text class="t" x="${p.x + 12}" y="${p.y + 36}">${esc(q.name)}</text><text class="s" x="${p.x + 12}" y="${p.y + 52}">${esc(npcName(q.giver))}</text></g>`;
  }
  $('#questFlow').innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Quest prerequisites">${s}</svg>`;
});

// ---------- combat ----------

part('combat', () => {
  table($('#weaponTable'), ['Weapon', 'Combo', 'Damage per hit'], WEAPONS.map((w) => [
    `<b>${esc(w.name[0].toUpperCase() + w.name.slice(1))}</b>`, `${w.combo.length} hits`, w.combo.map((c) => c.damage).join(' · '),
  ]), [1]);
  table($('#abilityTable'), ['Skill', 'Kind', 'Notes'], [
    ...ABILITIES.map((a) => [`<b>${esc(a.name)}</b>`, 'Ability', esc(a.desc)]),
    ...MOVEMENT_SKILLS.map((m) => [`<b>${esc(m.name)}</b>`, 'Movement', esc(m.desc)]),
    [`<b>${SKILLS.nodes.length} skill nodes</b>`, 'Trees', `${SKILLS.trees.map((t) => esc(t.name)).join(', ')}; ${SKILLS.points} points to spend`],
  ]);
  // Every size of every creature that comes in sizes, straight from the shared data.
  const NAME: Record<string, string> = { slimelet: 'Slimelet', slime: 'Slime', 'great-slime': 'Great Slime', 'slime-monarch': 'Slime Monarch' };
  table($('#creatureTable'), ['Size', 'Health', 'Mass', 'Slam', 'Dies into', 'Calls and gathers'], LADDERS.flatMap((l) => l.kinds.map((id) => {
    const k = actorKind(id);
    const g = k.brain ? behaviour(k.brain)?.gather : undefined;
    return [
      `<b>${esc(NAME[id] ?? id)}</b>`,
      String(k.maxHp),
      String(k.mass ?? 0),
      k.slam ? `${k.slam.damage} in ${k.slam.radius} m, from ${k.slam.range} m away` : 'none',
      k.burst ? `${k.burst.count} ${esc(NAME[k.burst.into] ?? k.burst.into)}s, ${(l.fuse / 60).toFixed(0)} s to kill them` : 'nothing',
      k.gathers && g ? `yes: ${g.radius} m, ${g.cooldown / 60} s apart, broken by ${Math.round(g.breakAt * 100)}% of its health` : 'no',
    ];
  })), [1, 2]);
});

// ---------- architecture ----------

part('the file map', () => {
  table($('#fileTable'), ['Where', 'What lives there'], [
    ['<code>shared/zones/emberholm.json</code>', 'The starter isle: terrain recipe, roads, buildings, NPCs, plots, nodes, updrafts.'],
    ['<code>shared/vehicles.json</code> · <code>trade.json</code> · <code>farming.json</code> · <code>housing.json</code> · <code>items.json</code> · <code>quests.json</code>', 'Every life-system number and recipe.'],
    ['<code>src/sim/terrain.ts</code> · <code>src/sim/zone/</code>', 'The height grid, the island generator, colliders and decks.'],
    ['<code>src/sim/player/traverse.ts</code>', 'Walking on terrain, swimming, gliding, updrafts.'],
    ['<code>src/sim/life/</code>', 'Trade, farming, housing, vehicles, quests, weather and what F does.'],
    ['<code>src/render/open/</code> · <code>src/render/models/</code>', 'The open-world scene and the procedural models (preview at <code>/models.html</code>).'],
    ['<code>src/ui/life/</code>', 'The open-world HUD and panels.'],
    ['<code>src/app/save.ts</code>', 'Saving the island in the browser, and time passing while away.'],
    ['<code>tests/world.spec.ts</code>', 'The open-world test suite.'],
    ['<code>design/</code>', 'This document (prose in <code>index.html</code>, everything drawn from data in <code>bible.ts</code>), its tracker and the research notes.'],
  ]);
});

// ---------- controls ----------

part('the controls', () => {
  table($('#controlTable'), ['Doing', 'Keyboard & mouse', 'Controller'], [
    ['Move, camera', '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> · mouse (click to capture)', 'Left / right stick'],
    ['Jump, double jump, open glider', '<kbd>Space</kbd> × 1, 2, 3', '<kbd>A</kbd>'],
    ['Interact (talk, plant, harvest, load, drive, build)', '<kbd>F</kbd>', '<kbd>Y</kbd>'],
    ['Drop a pack', '<kbd>X</kbd>', '—'],
    ['Call / dismiss your mount', '<kbd>R</kbd>', 'D-pad down'],
    ['Auto-run where the camera looks (in a cart or boat: hold the throttle)', '<kbd>H</kbd> or <kbd>Num Lock</kbd> · <kbd>W</kbd> / <kbd>S</kbd> stops', 'Left stick click, stick at rest'],
    ['Travel by road to a place picked on the map', 'Click it on the map (right-click for more) · <kbd>H</kbd> sets off again', 'D-pad on the map, then <kbd>A</kbd>'],
    ['Open or fold the glider directly', '<kbd>G</kbd>', '—'],
    ['Change the seed you plant', '<kbd>Z</kbd>', '—'],
    ['Bag · map · vehicles · quest log', '<kbd>I</kbd> · <kbd>M</kbd> · <kbd>V</kbd> · <kbd>L</kbd>', 'Menu · D-pad up'],
    ['Glider: dive / flare', '<kbd>Shift</kbd> / <kbd>Ctrl</kbd>', 'Left / right stick click'],
    ['Driving: throttle, steer, handbrake, boost', '<kbd>W</kbd><kbd>S</kbd>, <kbd>A</kbd><kbd>D</kbd>, <kbd>Space</kbd>, <kbd>Shift</kbd>', 'Left stick, <kbd>A</kbd>, left stick click'],
    ['Sailing: raise / lower the sail', '<kbd>W</kbd> / <kbd>S</kbd>', 'Left stick'],
    ['Combat (unchanged)', 'Mouse / <kbd>J</kbd>, <kbd>C</kbd>, <kbd>1</kbd>–<kbd>8</kbd>, <kbd>Q</kbd> <kbd>E</kbd>, <kbd>T</kbd>', 'X, B, triggers + face buttons, bumpers'],
    ['Developer tools', '<kbd>`</kbd>', '—'],
  ]);
});

// ---------- tracker ----------

part('the tracker', () => {
  $('#sysbars').innerHTML = S.systems.map((s) => {
    const c = countBy(s.id);
    const n = sum(c);
    return `<span>${esc(s.name)}</span>${bar(c, n)}<span class="n">${c.done}/${n}</span>`;
  }).join('');
  const tools = $('#trackerTools');
  tools.innerHTML =
    (['all', ...STATUS] as const).map((st) => `<button type="button" data-st="${st}" aria-pressed="${st === 'all'}">${st === 'all' ? 'All' : LABEL[st]} ${st === 'all' ? TOTAL : ALL[st]}</button>`).join('') +
    `<select id="tr-sys" aria-label="System"><option value="all">Every system</option>${S.systems.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select><input id="tr-q" type="search" placeholder="Search features" aria-label="Search features">`;
  const state = { status: 'all', system: 'all', q: '' };
  const ledger = $('#ledger');
  const render = () => {
    const q = state.q.toLowerCase();
    const rows = S.features.filter(
      (f) => (state.status === 'all' || f.status === state.status) && (state.system === 'all' || f.system === state.system) && (!q || (f.title + ' ' + f.notes + ' ' + (f.files || []).join(' ')).toLowerCase().includes(q)),
    );
    table(ledger, ['Status', 'Feature', 'System', 'Notes', 'Where'], rows.map((f) => [
      `<span class="chip ${f.status}">${LABEL[f.status]}</span>`, esc(f.title), esc(sysName.get(f.system) ?? f.system), esc(f.notes), (f.files || []).map(esc).join('<br>'),
    ]));
    ledger.querySelectorAll('tbody tr').forEach((tr) => {
      tr.children[1].className = 'title';
      tr.children[3].className = 'notes';
      tr.children[4].className = 'files';
    });
    if (!rows.length) $('tbody', ledger).innerHTML = '<tr><td colspan="5">Nothing matches.</td></tr>';
  };
  tools.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button[data-st]');
    if (!b) return;
    state.status = b.dataset.st ?? 'all';
    tools.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  });
  $<HTMLSelectElement>('#tr-sys', tools).addEventListener('input', (e) => {
    state.system = (e.target as HTMLSelectElement).value;
    render();
  });
  $<HTMLInputElement>('#tr-q', tools).addEventListener('input', (e) => {
    state.q = (e.target as HTMLInputElement).value;
    render();
  });
  render();
  $('#nextUp').innerHTML = S.next.map((n) => `<li>${esc(n)}</li>`).join('');
});

// ---------- research ----------

part('the ArcheAge notes', () => {
  table($('#aaTable'), ['Area', 'In ArcheAge', 'Loved / resented', 'In Ruina'], [
    ['Gliders', 'First glider from a level-8–12 quest; double-tap jump to open; 180 s flights; specialist gliders with skills', 'Loved: seamless flight, glider PvP', 'Triple jump to open, dive/flare energy model, updrafts, no time limit yet'],
    ['Mounts', 'Raised from a foal; 7–11.5 m/s; sprint skill; packs slow most mounts by 80%', 'Loved: raising them; resented: cash-shop mounts', 'Donkey (packs) and horse (gallop) from the stables'],
    ['Land vehicles', 'Farm cart, wagon, hauler, freighter: 2–8 packs at 4–9.7 m/s; cars with loose physics', 'Loved: convoys; resented: cart theft', 'Farm cart, roadster with real drift, hauler; theft planned'],
    ['Ships', 'Rowboat to galleon; built at drydocks from hauled packs; Kraken; the sea never at peace', 'Loved: crewing a ship together, piracy', 'Rowboat, a wind-driven sloop, and a Merchant Cog built on a slipway from hauled packs'],
    ['Trade packs', 'Regional workbench packs (~60–80 labor), carried slowly, sold far away; demand 70–130%; freshness tiers', 'Loved: risk and reward; resented: labor cost', 'Same loop, cheaper labor, one freshness curve, instant pay'],
    ['Labor', '10 per 5 min, 2,000–5,000 cap; potions sold for real money', 'The most resented system', '12 a minute, 1,000 cap, bed rest ×3, never sold'],
    ['Farming', 'Scarecrow gardens, climates, real-time growth from minutes to days, theft and juries', 'Loved: building a farm empire', 'Scarecrow plots, climates, rain, watering, offline growth'],
    ['Housing', 'Limited plots, designs for Gilda Stars, built from hauled packs, weekly tax, demolition races', 'Loved: ownership; resented: the land rush', 'Plots, blueprints for seals, hauled stages, tax; lottery plots planned'],
  ]);
});

// ---------- questions & log ----------

part('the open questions and the log', () => {
  $('#qs').innerHTML = S.questions.map((q) => `<div class="q"><b>${esc(q.q)}</b><span>${esc(q.context)}</span></div>`).join('');
  $('#sessions').innerHTML = S.sessions
    .map((s) => `<div class="entry"><time>${esc(s.date)}</time><div><h3>${esc(s.title)}</h3><p>${esc(s.summary)}</p><ul>${s.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div></div>`)
    .join('');
});

// ---------- the island ----------
// Growing the island takes the generator a few hundred milliseconds, so the rest of the page goes
// up first. data-ready on <html> says everything has been drawn (the tests wait for it).

requestAnimationFrame(() =>
  setTimeout(() => {
    part('the map', () => {
      const isle = growIsland();
      island = isle;
      drawMaps();
      facts(isle);
      $('#mapStats').textContent = `Island ~1 km across. Grid cell ${isle.cell} m. ${isle.rocks.toLocaleString()} rocks, ${isle.trees.toLocaleString()} trees.`;
    });
    document.documentElement.dataset.ready = 'true';
  }),
);
