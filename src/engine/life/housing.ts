import type { House } from './state';
import { blueprintDef } from '../../content/housing';
import { toWorld } from '../world/frames';
import type { IslandRead } from './life';

// Houses on the plots at Hearthside Rise. A blueprint claims an empty plot; then the house goes
// up a stage at a time as you haul each stage's material packs to the site - on your back or by
// cart - and put in the labor. Finished, it is yours: a bed that restores labor faster, a chest,
// and a tax bill to keep paid. The engine builds them (crates/engine/src/life/housing.rs); these
// read a plot and a house for the page.

export const DAY = 86400;

/** Where the house stands inside its plot: toward the back, leaving a front yard. */
export const HOUSE_SETBACK = -2.5;

export function plotDef(life: IslandRead, plot: string) {
  return life.zone.recipe.housePlots.find((p) => p.id === plot);
}

/** The house's own position and facing in the world. */
export function housePose(life: IslandRead, h: House): { x: number; z: number; rot: number } {
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
