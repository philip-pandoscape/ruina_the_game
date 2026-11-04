import type { Life } from './life';
import type { Sim } from '../sim';
import type { House } from './state';
import { blueprintDef } from '../../content/housing';
import { structureDef } from '../../content/structures';
import { packDef, formatCoins } from '../../content/trade';
import { carried, consumeCarried } from './trade';
import { rect, toWorld } from '../zone/generate';

// Houses on the plots at Hearthside Rise. A blueprint claims an empty plot; then the house goes
// up a stage at a time as you haul each stage's material packs to the site - on your back or by
// cart - and put in the labor. Finished, it is yours: a bed that restores labor faster, a chest,
// and a tax bill to keep paid.

export const DAY = 86400;

/** Where the house stands inside its plot: toward the back, leaving a front yard. */
export const HOUSE_SETBACK = -2.5;

export function plotDef(life: Life, plot: string) {
  return life.zone.recipe.housePlots.find((p) => p.id === plot);
}

export function houseOn(life: Life, plot: string): House | undefined {
  return life.state.houses.find((h) => h.plot === plot);
}

/** The house's own position and facing in the world. */
export function housePose(life: Life, h: House): { x: number; z: number; rot: number } {
  const p = plotDef(life, h.plot)!;
  const [ox, oz] = toWorld(0, HOUSE_SETBACK, p.rot);
  return { x: p.x + ox, z: p.z + oz, rot: p.rot };
}

export const isComplete = (h: House): boolean => h.stage >= blueprintDef(h.blueprint).stages.length;

/** What the current stage still needs, pack by pack. */
export function stillNeeds(h: House): Array<{ pack: string; need: number; have: number }> {
  const bp = blueprintDef(h.blueprint);
  const stage = bp.stages[h.stage];
  if (!stage) return [];
  return Object.entries(stage.needs).map(([pack, need]) => ({ pack, need, have: h.delivered[pack] ?? 0 }));
}

export const stageReady = (h: House): boolean => stillNeeds(h).every((n) => n.have >= n.need);

export function placeHouse(life: Life, sim: Sim, plot: string, item: string): boolean {
  if (houseOn(life, plot)) return false;
  if (life.state.houses.length >= 1) {
    life.toast('One house per settler on Emberholm (for now)', 'bad');
    return false;
  }
  const bpId = item.replace('blueprint.', '');
  const bp = blueprintDef(bpId);
  if (!life.take(item, 1)) return false;
  const h: House = { id: life.nextId(), plot, blueprint: bp.id, stage: 0, delivered: {}, storage: [], taxPaidUntil: life.state.clock + bp.graceDays * DAY };
  life.state.houses.push(h);
  addHouseColliders(life, sim, h);
  life.revision++;
  life.toast(`📜 Plot claimed! Haul the ${bp.stages[0].name.toLowerCase()} materials here to begin.`, 'quest');
  life.notify({ type: 'placeHouse' });
  return true;
}

/** Hands the pack on your back to the site, if this stage wants it. */
export function deliverMaterial(life: Life, sim: Sim, h: House): boolean {
  const pack = carried(life, sim);
  if (!pack) return false;
  const want = stillNeeds(h).find((n) => n.pack === pack.def && n.have < n.need);
  if (!want) {
    life.toast(`The ${blueprintDef(h.blueprint).stages[h.stage]?.name.toLowerCase() ?? 'house'} does not need a ${packDef(pack.def).name}`, 'bad');
    return false;
  }
  h.delivered[pack.def] = want.have + 1;
  consumeCarried(life, sim);
  life.revision++;
  life.toast(`Delivered ${packDef(pack.def).icon} ${packDef(pack.def).name} (${want.have + 1}/${want.need})`, 'good');
  return true;
}

export function buildStage(life: Life, sim: Sim, h: House): boolean {
  const bp = blueprintDef(h.blueprint);
  const stage = bp.stages[h.stage];
  if (!stage || !stageReady(h)) return false;
  if (!life.afford({ labor: stage.labor }, `build the ${stage.name.toLowerCase()}`)) return false;
  h.stage++;
  h.delivered = {};
  life.state.stats.built++;
  addHouseColliders(life, sim, h);
  life.revision++;
  const pose = housePose(life, h);
  life.emit({ t: 'build', house: h.id, stage: h.stage, x: pose.x, z: pose.z });
  life.notify({ type: 'buildStage' });
  if (isComplete(h)) life.toast(`🏡 Your ${bp.name.toLowerCase()} is finished. Welcome home.`, 'quest');
  else life.toast(`🔨 ${stage.name} done. Next: ${bp.stages[h.stage].name}.`, 'good');
  return true;
}

const added = new WeakMap<Sim, Set<string>>();

/**
 * The house's solid parts, as far as it has been built: the floor from the foundation up, the
 * walls (with their doorway) once they are raised. Safe to call again; each piece is added once.
 */
export function addHouseColliders(life: Life, sim: Sim, h: House): void {
  const idx = sim.world.index;
  const hf = sim.world.terrain;
  if (!idx || !hf) return;
  let done = added.get(sim);
  if (!done) added.set(sim, (done = new Set()));
  const def = structureDef(blueprintDef(h.blueprint).structure);
  const pose = housePose(life, h);
  const y = hf.height(pose.x, pose.z);
  if (!done.has(`${h.id}:ground`)) {
    done.add(`${h.id}:ground`);
    const clear = sim.world.zone?.gen.clear;
    if (clear) {
      for (let a = -def.w / 2 - 1; a <= def.w / 2 + 1; a += hf.cell / 2)
        for (let b = -def.d / 2 - 1; b <= def.d / 2 + 1; b += hf.cell / 2) {
          const [ox, oz] = toWorld(a, b, pose.rot);
          const i = Math.floor((pose.x + ox - hf.min) / hf.cell);
          const j = Math.floor((pose.z + oz - hf.min) / hf.cell);
          if (i >= 0 && j >= 0 && i < hf.cells && j < hf.cells) clear[j * hf.cells + i] = 1;
        }
    }
  }
  if (h.stage >= 1 && !done.has(`${h.id}:floor`)) {
    done.add(`${h.id}:floor`);
    idx.addDeck(rect(pose.x, pose.z, def.w / 2, def.d / 2, pose.rot, y + (def.floor ?? 0.25)));
  }
  if (h.stage >= 3 && !done.has(`${h.id}:walls`)) {
    done.add(`${h.id}:walls`);
    const t = def.wall ?? 0.3;
    const hw = def.w / 2;
    const hd = def.d / 2;
    const door = (def.door ?? 1.4) / 2;
    const top = y + def.h;
    const add = (lx: number, lz: number, w: number, d: number) => {
      const [ox, oz] = toWorld(lx, lz, pose.rot);
      idx.addBox(rect(pose.x + ox, pose.z + oz, w / 2, d / 2, pose.rot, top));
    };
    add(0, -hd + t / 2, def.w, t);
    add(hw - t / 2, 0, t, def.d);
    add(-hw + t / 2, 0, t, def.d);
    const seg = hw - door;
    add(door + seg / 2, hd - t / 2, seg, t);
    add(-door - seg / 2, hd - t / 2, seg, t);
  }
}

/** A point inside the house (bed, chest) in world space. */
export function interiorPoint(life: Life, h: House, what: 'bed' | 'chest'): { x: number; z: number } {
  const def = structureDef(blueprintDef(h.blueprint).structure);
  const p = def.interior?.[what] ?? { x: 0, z: 0 };
  const pose = housePose(life, h);
  const [ox, oz] = toWorld(p.x, p.z, pose.rot);
  return { x: pose.x + ox, z: pose.z + oz };
}

export function taxDue(life: Life, h: House): { owed: number; dueIn: number } {
  const bp = blueprintDef(h.blueprint);
  const dueIn = h.taxPaidUntil - life.state.clock;
  return { owed: bp.taxPerDay * 7, dueIn };
}

export function payTax(life: Life, h: House): boolean {
  const bp = blueprintDef(h.blueprint);
  const week = bp.taxPerDay * 7;
  if (!life.afford({ coins: week }, 'pay the property tax')) return false;
  h.taxPaidUntil = Math.max(h.taxPaidUntil, life.state.clock) + 7 * DAY;
  life.toast(`Paid a week's property tax: ${formatCoins(week)}`, 'coin');
  return true;
}

export function stepHousing(_life: Life): void {
  // Taxes accrue by the clock; nothing needs doing per frame yet. Demolition of neglected houses
  // is designed (see the design doc) but deliberately not switched on in the single-player isle.
}
