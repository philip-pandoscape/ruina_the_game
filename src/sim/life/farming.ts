import type { Life } from './life';
import type { Sim } from '../sim';
import type { Plant, Scarecrow } from './state';
import { climateFactor, cropDef, FARM, type RareFind } from '../../content/farming';
import { itemDef } from '../../content/items';
import { SURFACE } from '../terrain';
import { raining } from './weather';
import { stepAnimal } from './livestock';
import { toLocal, toWorld } from '../zone/generate';

// Scarecrow plots and what grows in them. A scarecrow claims an 8 x 8 m patch of open, level
// ground (up to three); each of its 2 m cells holds one plant, which grows in real time - faster
// in its own climate, faster again when watered or rained on - whether or not you are watching.

const HALF = (FARM.scarecrowCells * FARM.cell) / 2;

export function stageOf(p: Plant): number {
  if (p.animal) return p.growth >= 1 ? 1 : 0;
  const def = cropDef(p.crop);
  if (p.growth >= 1) return def.stages - 1;
  return Math.min(def.stages - 2, Math.floor(p.growth * (def.stages - 1)));
}

export const isRipe = (p: Plant): boolean => p.growth >= 1;

/** Growth per second right now. */
export function growthRate(life: Life, p: Plant): number {
  const def = cropDef(p.crop);
  const wet = p.watered || raining(life) ? FARM.water.boost : 1;
  const climate = climateFactor(def, life.zone.recipe.climate);
  // A picked fruit tree only has its last stretch to regrow, at its own pace.
  if (p.picked && def.regrowSeconds) return (wet * climate) / (def.stages - 1) / def.regrowSeconds;
  return (wet * climate) / def.growSeconds;
}

/** Seconds until ripe at the current rate (an estimate: rain comes and goes). */
export function secondsToRipe(life: Life, p: Plant): number {
  if (p.growth >= 1) return 0;
  if (p.animal) return 0;
  return (1 - p.growth) / Math.max(1e-6, growthRate(life, p));
}

export function stepFarms(life: Life, dt: number): void {
  for (const sc of life.state.scarecrows) {
    for (const p of sc.cells) {
      if (p?.animal) {
        if (stepAnimal(life, p, dt)) life.revision++;
        continue;
      }
      if (!p || p.growth >= 1) continue;
      const before = stageOf(p);
      p.growth = Math.min(1, p.growth + growthRate(life, p) * dt);
      if (stageOf(p) !== before) {
        p.watered = false; // each stage wants watering afresh
        life.revision++;
      }
    }
  }
}

/** Advances every plant by a long stretch at once (time away, or the dev panel's warp). */
export function growFor(life: Life, seconds: number): void {
  for (const sc of life.state.scarecrows)
    for (const p of sc.cells) {
      if (p?.animal) {
        stepAnimal(life, p, seconds);
        continue;
      }
      if (!p || p.growth >= 1) continue;
      p.growth = Math.min(1, p.growth + growthRate(life, p) * seconds);
      p.watered = false;
    }
  life.revision++;
}

// ---------- Geometry ----------

export function cellCentre(sc: Scarecrow, idx: number): { x: number; z: number } {
  const n = FARM.scarecrowCells;
  const col = idx % n;
  const row = Math.floor(idx / n);
  const [ox, oz] = toWorld((col - (n - 1) / 2) * FARM.cell, (row - (n - 1) / 2) * FARM.cell, sc.rot);
  return { x: sc.x + ox, z: sc.z + oz };
}

/** The plot cell under a point, if any. */
export function cellAt(life: Life, x: number, z: number): { sc: Scarecrow; idx: number } | null {
  const n = FARM.scarecrowCells;
  for (const sc of life.state.scarecrows) {
    const [lx, lz] = toLocal(x - sc.x, z - sc.z, sc.rot);
    if (Math.abs(lx) >= HALF || Math.abs(lz) >= HALF) continue;
    const col = Math.floor(lx / FARM.cell + n / 2);
    const row = Math.floor(lz / FARM.cell + n / 2);
    return { sc, idx: row * n + col };
  }
  return null;
}

/** Where the scarecrow itself stands: just outside the plot's front-left corner. */
export function scarecrowPost(sc: { x: number; z: number; rot: number }): { x: number; z: number } {
  const [ox, oz] = toWorld(HALF + 0.6, HALF + 0.6, sc.rot);
  return { x: sc.x + ox, z: sc.z + oz };
}

/** Why a scarecrow cannot go here, or null if it can. */
export function plotProblem(life: Life, sim: Sim, x: number, z: number, rot: number): string | null {
  const hf = sim.world.terrain!;
  const s = life.state;
  if (s.scarecrows.length >= FARM.maxScarecrows) return `You already have ${FARM.maxScarecrows} plots`;
  const gen = life.zone.gen;
  let lo = Infinity;
  let hi = -Infinity;
  for (let a = -1; a <= 1; a += 0.5)
    for (let b = -1; b <= 1; b += 0.5) {
      const [ox, oz] = toWorld(a * HALF, b * HALF, rot);
      const px = x + ox;
      const pz = z + oz;
      if (!hf.inside(px, pz, 4)) return 'Too close to the edge of the world';
      const h = hf.height(px, pz);
      if (h < hf.water + 0.8) return 'Too close to the water';
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
      if (hf.slope(px, pz) > 0.32) return 'The ground is too steep';
      const surf = hf.surfaceAt(px, pz);
      if (surf !== SURFACE.grass && surf !== SURFACE.forest && surf !== SURFACE.soil)
        return surf === SURFACE.road || surf === SURFACE.plaza ? 'Not on a road' : 'The soil here is no good';
      const ci = Math.floor((px - hf.min) / hf.cell);
      const cj = Math.floor((pz - hf.min) / hf.cell);
      if (gen.clear[cj * hf.cells + ci]) return 'Too close to a road or building';
    }
  if (hi - lo > 1.3) return 'The ground is too uneven';
  for (const other of s.scarecrows) if (Math.hypot(other.x - x, other.z - z) < HALF * 2 + 1) return 'Overlaps another plot';
  for (const p of life.zone.recipe.housePlots) if (Math.hypot(p.x - x, p.z - z) < 15) return 'That is a house plot';
  let blocked = false;
  sim.world.index?.eachObstacle(x, z, HALF * 1.45, (o) => {
    if (o.r > 0 && (o.kind === 'tree' || o.kind === 'rock' || o.kind === 'post')) {
      const [lx, lz] = toLocal(o.x - x, o.z - z, rot);
      if (Math.abs(lx) < HALF + o.r + 0.3 && Math.abs(lz) < HALF + o.r + 0.3) blocked = true;
    }
  });
  if (blocked) return 'Trees or rocks in the way';
  return null;
}

/** Puts a scarecrow down (the item is already paid for). Its post blocks like any other. */
export function addScarecrow(life: Life, sim: Sim, x: number, z: number, rot: number): Scarecrow {
  const sc: Scarecrow = { id: life.nextId(), x, z, rot, cells: new Array(FARM.scarecrowCells * FARM.scarecrowCells).fill(null) };
  life.state.scarecrows.push(sc);
  addScarecrowCollider(sim, sc);
  life.revision++;
  return sc;
}

export function addScarecrowCollider(sim: Sim, sc: Scarecrow): void {
  const post = scarecrowPost(sc);
  sim.world.index?.addObstacle({ kind: 'post', x: post.x, z: post.z, r: 0.25, scale: 1, rot: sc.rot });
  // Tilled ground: no grass, no new trees.
  const hf = sim.world.terrain;
  const clear = sim.world.zone?.gen.clear;
  if (!hf || !clear) return;
  for (let a = -HALF - 1; a <= HALF + 1; a += hf.cell / 2)
    for (let b = -HALF - 1; b <= HALF + 1; b += hf.cell / 2) {
      const [ox, oz] = toWorld(a, b, sc.rot);
      const i = Math.floor((sc.x + ox - hf.min) / hf.cell);
      const j = Math.floor((sc.z + oz - hf.min) / hf.cell);
      if (i >= 0 && j >= 0 && i < hf.cells && j < hf.cells) clear[j * hf.cells + i] = 1;
    }
}

// ---------- Actions on a cell ----------

export function plant(life: Life, sc: Scarecrow, idx: number, seedItem: string): boolean {
  const def = itemDef(seedItem);
  if (!def.plants) return false;
  if (sc.cells[idx]) return false;
  if (!life.take(seedItem, 1)) {
    life.toast(`No ${def.name} left`, 'bad');
    return false;
  }
  sc.cells[idx] = { crop: def.plants, growth: 0, watered: false, picked: false };
  life.revision++;
  life.notify({ type: 'plant', crop: def.plants });
  return true;
}

export function water(life: Life, p: Plant): boolean {
  if (p.watered || p.growth >= 1) return false;
  if (!life.afford({ labor: FARM.water.labor }, 'water')) return false;
  p.watered = true;
  life.revision++;
  return true;
}

export function harvest(life: Life, sc: Scarecrow, idx: number, y: number): boolean {
  const p = sc.cells[idx];
  if (!p || p.growth < 1) return false;
  const def = cropDef(p.crop);
  if (!def.produce) return false;
  if (!life.hasRoom(def.produce, def.yield[1])) {
    life.toast('Your bag is full', 'bad');
    return false;
  }
  if (!life.afford({ labor: def.harvestLabor }, 'harvest')) return false;
  life.give(def.produce, life.randInt(def.yield[0], def.yield[1]));
  if (def.seedChance > 0 && life.rand() < def.seedChance) life.give(def.seed, 1);
  if (def.regrowSeconds) {
    p.picked = true;
    p.growth = (def.stages - 2) / (def.stages - 1);
  } else sc.cells[idx] = null;
  life.state.stats.harvested++;
  life.revision++;
  const c = cellCentre(sc, idx);
  life.emit({ t: 'harvest', x: c.x, y, z: c.z });
  life.notify({ type: 'harvest', crop: def.id });
  return true;
}

/** Fells a grown tree for what its crop's `chop` gives - with a chance of something rare in it (a log struck by lightning). */
export function fell(life: Life, sc: Scarecrow, idx: number, y: number): boolean {
  const p = sc.cells[idx];
  if (!p) return false;
  const def = cropDef(p.crop);
  const chop = def.chop;
  if (!chop || stageOf(p) < def.stages - 2) return false;
  if (!life.hasRoom(chop.item, chop.yield[1])) {
    life.toast('Your bag is full', 'bad');
    return false;
  }
  if (!life.afford({ labor: chop.labor }, 'fell a tree')) return false;
  const n = life.randInt(chop.yield[0], chop.yield[1]);
  life.give(chop.item, n);
  const c = cellCentre(sc, idx);
  if (chop.rare && life.rand() < chop.rare.chance) findRare(life, chop.rare, c.x, y, c.z);
  sc.cells[idx] = null;
  life.revision++;
  life.emit({ t: 'gather', x: c.x, y, z: c.z, kind: chop.kind });
  // Timber you grow counts for a step like "chop 10 lumber" as much as deadfall does.
  life.notify({ type: 'gather', kind: chop.kind, amount: n });
  return true;
}

/** Something rare found where you felled or gathered: into your bag, with its toast and its effect there. */
export function findRare(life: Life, rare: RareFind, x: number, y: number, z: number): void {
  life.give(rare.item, 1);
  life.toast(rare.toast, 'coin');
  if (rare.effect === 'thunder') life.emit({ t: 'thunder', x, y, z });
}
