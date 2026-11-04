import type { Life } from './life';
import type { Sim } from '../sim';
import type { ShipBuild } from './state';
import { designForItem, shipDesign } from '../../content/shipyard';
import { itemDef } from '../../content/items';
import { packDef } from '../../content/trade';
import { carried, consumeCarried } from './trade';

// Slipways, where big ships are built the way houses are: a design claims the slip, then each
// stage is finished by hauling its material packs there and putting in the labor. The last stage
// launches her: the slip clears and you hold the deed.

export const slipDef = (life: Life, slip: string) => life.zone.recipe.shipyards.find((s) => s.id === slip);
export const shipOn = (life: Life, slip: string): ShipBuild | undefined => life.state.ships.find((s) => s.slip === slip);

export function shipNeeds(b: ShipBuild): Array<{ pack: string; need: number; have: number }> {
  const stage = shipDesign(b.design).stages[b.stage];
  if (!stage) return [];
  return Object.entries(stage.needs).map(([pack, need]) => ({ pack, need, have: b.delivered[pack] ?? 0 }));
}

export const shipStageReady = (b: ShipBuild): boolean => shipNeeds(b).every((n) => n.have >= n.need);
export const shipFinished = (b: ShipBuild): boolean => b.stage >= shipDesign(b.design).stages.length;

export function layKeel(life: Life, slip: string, item: string): boolean {
  if (shipOn(life, slip)) return false;
  const design = designForItem(item);
  if (!design || !life.take(item, 1)) return false;
  life.state.ships.push({ id: life.nextId(), slip, design: design.id, stage: 0, delivered: {} });
  life.revision++;
  life.toast(`📐 The ${design.name}'s keel blocks are down. Haul ${design.stages[0].name.toLowerCase()} materials to the slip.`, 'quest');
  life.notify({ type: 'layKeel' });
  return true;
}

export function deliverShipMaterial(life: Life, sim: Sim, b: ShipBuild): boolean {
  const pack = carried(life, sim);
  if (!pack) return false;
  const want = shipNeeds(b).find((n) => n.pack === pack.def && n.have < n.need);
  if (!want) {
    life.toast(`This stage does not need a ${packDef(pack.def).name}`, 'bad');
    return false;
  }
  b.delivered[pack.def] = want.have + 1;
  consumeCarried(life, sim);
  life.revision++;
  life.toast(`Delivered ${packDef(pack.def).icon} ${packDef(pack.def).name} (${want.have + 1}/${want.need})`, 'good');
  return true;
}

export function buildShipStage(life: Life, b: ShipBuild): boolean {
  const design = shipDesign(b.design);
  const stage = design.stages[b.stage];
  if (!stage || !shipStageReady(b)) return false;
  if (!life.afford({ labor: stage.labor }, `build the ${stage.name.toLowerCase()}`)) return false;
  b.stage++;
  b.delivered = {};
  life.revision++;
  const slip = slipDef(life, b.slip);
  if (slip) life.emit({ t: 'build', house: b.id, stage: b.stage, x: slip.x, z: slip.z });
  life.notify({ type: 'shipStage' });
  if (shipFinished(b)) life.toast(`⚓ The ${design.name} is finished. Launch her from the slipway!`, 'quest');
  else life.toast(`🔨 ${stage.name} done. Next: ${design.stages[b.stage].name}.`, 'good');
  return true;
}

export function launch(life: Life, b: ShipBuild): boolean {
  if (!shipFinished(b)) return false;
  const design = shipDesign(b.design);
  if (!life.hasRoom(design.deed, 1)) {
    life.toast('Make room in your bag for the deed first', 'bad');
    return false;
  }
  life.state.ships = life.state.ships.filter((s) => s.id !== b.id);
  life.give(design.deed, 1, true);
  life.revision++;
  life.toast(`🚢 The ${design.name} is launched! Her deed is in your bag - summon her at deep water.`, 'quest');
  life.notify({ type: 'launch' });
  return true;
}

export const designItemsInBag = (life: Life): string[] => life.state.bag.map((s) => s.item).filter((i) => !!designForItem(i) && itemDef(i).cat === 'placeable');
