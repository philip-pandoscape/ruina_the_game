import type { Life } from './life';
import type { Plant, Scarecrow } from './state';
import { animalDef } from '../../content/farming';
import { itemDef } from '../../content/items';

// Livestock, raised in plot cells like crops: a chick, lamb or calf grows up only while it is fed,
// and once grown it lays, grows fleece or gives milk again and again - also only while fed. A
// hungry animal simply waits for you; nothing dies of neglect on Emberholm.

export const hungry = (life: Life, p: Plant): boolean => (p.fedUntil ?? 0) <= life.state.clock;
export const grownUp = (p: Plant): boolean => p.growth >= 1;
export const produceReady = (p: Plant): boolean => grownUp(p) && (p.produce ?? 0) >= 1;

/** Advances growth and produce for `seconds`, but only the part of it the animal was fed for. */
export function stepAnimal(life: Life, p: Plant, seconds: number): boolean {
  const def = animalDef(p.crop);
  const fedFor = Math.max(0, Math.min(seconds, (p.fedUntil ?? 0) - (life.state.clock - seconds)));
  if (fedFor <= 0) return false;
  const wasGrown = grownUp(p);
  const wasReady = produceReady(p);
  if (!wasGrown) p.growth = Math.min(1, p.growth + fedFor / def.growSeconds);
  else p.produce = Math.min(1, (p.produce ?? 0) + fedFor / def.produceSeconds);
  return wasGrown !== grownUp(p) || wasReady !== produceReady(p);
}

export function raise(life: Life, sc: Scarecrow, idx: number, item: string): boolean {
  const def = itemDef(item);
  if (!def.raises || sc.cells[idx]) return false;
  if (!life.take(item, 1)) return false;
  // Arrives fed, so it starts growing straight away.
  sc.cells[idx] = { crop: def.raises, growth: 0, watered: false, picked: false, animal: true, fedUntil: life.state.clock + animalDef(def.raises).feedSeconds, produce: 0 };
  life.revision++;
  life.notify({ type: 'raise', crop: def.raises });
  return true;
}

export function feed(life: Life, p: Plant): boolean {
  const def = animalDef(p.crop);
  if (life.count(def.feed) < def.feedN) {
    life.toast(`Needs ${def.feedN} ${itemDef(def.feed).name} to feed (you have ${life.count(def.feed)})`, 'bad');
    return false;
  }
  life.take(def.feed, def.feedN);
  p.fedUntil = Math.max(p.fedUntil ?? 0, life.state.clock) + def.feedSeconds;
  life.revision++;
  return true;
}

export function collect(life: Life, sc: Scarecrow, idx: number, x: number, y: number, z: number): boolean {
  const p = sc.cells[idx];
  if (!p || !produceReady(p)) return false;
  const def = animalDef(p.crop);
  if (!life.hasRoom(def.produce, def.yield[1])) {
    life.toast('Your bag is full', 'bad');
    return false;
  }
  if (!life.afford({ labor: def.collectLabor }, def.verb.toLowerCase())) return false;
  life.give(def.produce, life.randInt(def.yield[0], def.yield[1]));
  p.produce = 0;
  life.state.stats.harvested++;
  life.revision++;
  life.emit({ t: 'harvest', x, y, z });
  life.notify({ type: 'harvest', crop: p.crop });
  return true;
}
