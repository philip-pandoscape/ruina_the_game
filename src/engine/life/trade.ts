import type { Pack } from './land';
import { DEMAND, FRESHNESS, packDef, route } from '../../content/trade';
import type { LifeRead } from './life';
import type { SimRead } from '../shapes';

// Pack running, as the page reads it. A pack is made at a workbench from local goods and labor,
// rides on your back (slowly - no sprint, no double jump, no glider) or in a vehicle's cargo, and is
// sold at a trading post somewhere else. Farther routes pay more; each sale lowers that post's
// demand for that pack, which recovers with time; a fresh pack earns a bonus that sours the longer
// it sits. The engine runs the trade (crates/engine/src/life/trade.rs); these price a pack and find
// one for the page.

// ---------- Prices ----------

/** What `outpost` pays for `pack` against its base price right now: the world's demand there, recovering by the land's clock since it last moved (crates/engine/src/life/market.rs). */
export function demandAt(life: LifeRead, outpost: string, pack: string): number {
  const d = life.market[`${outpost}:${pack}`];
  return d ? Math.min(DEMAND.max, d.value + (DEMAND.recoverPerMinute * Math.max(0, life.now - d.at)) / 60) : DEMAND.start;
}

/** Freshness multiplier for a pack of this age (seconds). */
export function freshness(age: number): number {
  const top = 1 + FRESHNESS.bonus;
  const bottom = 1 + FRESHNESS.penalty;
  if (age <= FRESHNESS.bonusSeconds) return top;
  if (age >= FRESHNESS.staleSeconds) return bottom;
  const k = (age - FRESHNESS.bonusSeconds) / (FRESHNESS.staleSeconds - FRESHNESS.bonusSeconds);
  return top + (bottom - top) * k;
}

export interface Quote {
  coins: number;
  seals: number;
  demand: number;
  fresh: number;
  factor: number;
}

/** What a trading post would pay for a pack right now, or null if it will not buy it. */
export function quote(life: LifeRead, pack: Pack, outpost: string): Quote | null {
  const def = packDef(pack.def);
  if ((def as { kind?: string }).kind === 'material') return null;
  const r = route(pack.origin, outpost);
  if (!r) return null;
  const demand = demandAt(life, outpost, pack.def);
  const fresh = freshness(life.state.clock - pack.made);
  return { coins: Math.round(def.base * r.factor * demand * fresh), seals: r.seals, demand, fresh, factor: r.factor };
}

// ---------- Where packs are ----------

export const packById = (life: LifeRead, id: number): Pack | undefined => life.land.packs.find((p) => p.id === id);
export const carried = (life: LifeRead, sim: SimRead): Pack | undefined => (sim.player.pack ? packById(life, sim.player.pack) : undefined);

// ---------- Buyback ----------
// A merchant holds what you sold them, at what they paid, until you walk off: sell the wrong stack
// and you can have it back, but a stall is no place to keep things.

/** How far from a merchant you can go before they stop holding what you sold them. */
export const BUYBACK_RANGE = 12;
