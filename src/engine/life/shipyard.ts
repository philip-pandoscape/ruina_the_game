import type { ShipBuild } from './state';
import { shipDesign } from '../../content/shipyard';
import type { IslandRead } from './life';

// Slipways, where big ships are built the way houses are: a design claims the slip, then each
// stage is finished by hauling its material packs there and putting in the labor. The last stage
// launches her: the slip clears and you hold the deed. The engine builds them
// (crates/engine/src/life/shipyard.rs); these read a slip for the page.

export const shipOn = (life: IslandRead, slip: string): ShipBuild | undefined => life.state.ships.find((s) => s.slip === slip);

export function shipNeeds(b: ShipBuild): Array<{ pack: string; need: number; have: number }> {
  const stage = shipDesign(b.design).stages[b.stage];
  if (!stage) return [];
  return Object.entries(stage.needs).map(([pack, need]) => ({ pack, need, have: b.delivered[pack] ?? 0 }));
}

export const shipStageReady = (b: ShipBuild): boolean => shipNeeds(b).every((n) => n.have >= n.need);
export const shipFinished = (b: ShipBuild): boolean => b.stage >= shipDesign(b.design).stages.length;
