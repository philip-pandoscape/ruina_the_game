import type { Life } from './life';
import { CONTRACTS, PACKS, packDef, route, formatCoins, placeName } from '../../content/trade';

// Trade contracts: each trading post posts a couple of requests for specific packs ("three Flax
// Bales within 25 minutes"). Take one on, fill it before it runs out, and the post pays bonus
// Charter Seals and coin on top of each pack's normal price. Pack running with a goal.

export interface Contract {
  id: number;
  outpost: string;
  pack: string;
  count: number;
  delivered: number;
  bonusCoins: number;
  bonusSeals: number;
  /** World clock when it lapses (offered ones lapse too, and are replaced). */
  expires: number;
}

export interface ContractState {
  offered: Contract[];
  active: Contract[];
  nextRefresh: number;
}

export const newContracts = (): ContractState => ({ offered: [], active: [], nextRefresh: 0 });

/** Packs a trading post will buy (any trade pack with a route to it). */
function wanted(outpost: string): string[] {
  return PACKS.filter((p) => (p as { kind?: string }).kind !== 'material' && route(p.origin, outpost)).map((p) => p.id);
}

export function stepContracts(life: Life): void {
  const c = (life.state.contracts ??= newContracts());
  const now = life.state.clock;
  const lapsed = c.active.filter((k) => k.expires <= now);
  for (const k of lapsed) life.toast(`Contract lapsed: ${k.count} × ${packDef(k.pack).name} for ${placeName(k.outpost)}`, 'bad');
  c.active = c.active.filter((k) => k.expires > now);
  c.offered = c.offered.filter((k) => k.expires > now);
  if (now < c.nextRefresh) return;
  c.nextRefresh = now + CONTRACTS.refreshSeconds;
  for (const o of life.zone.recipe.outposts) {
    const options = wanted(o.id);
    while (c.offered.filter((k) => k.outpost === o.id).length < CONTRACTS.perOutpost && options.length) {
      const pack = options[Math.floor(life.rand() * options.length)];
      const count = life.randInt(CONTRACTS.count[0], CONTRACTS.count[1]);
      const def = packDef(pack);
      const r = route(def.origin, o.id)!;
      c.offered.push({
        id: life.nextId(),
        outpost: o.id,
        pack,
        count,
        delivered: 0,
        bonusCoins: Math.round(def.base * r.factor * CONTRACTS.coinBonus * count),
        bonusSeals: Math.max(1, Math.round(CONTRACTS.sealsPerPack * count * r.factor)),
        expires: now + CONTRACTS.durationSeconds + CONTRACTS.refreshSeconds,
      });
    }
  }
}

export function acceptContract(life: Life, id: number): boolean {
  const c = (life.state.contracts ??= newContracts());
  const k = c.offered.find((x) => x.id === id);
  if (!k) return false;
  if (c.active.length >= CONTRACTS.maxActive) {
    life.toast(`You can hold ${CONTRACTS.maxActive} contracts at a time`, 'bad');
    return false;
  }
  c.offered = c.offered.filter((x) => x.id !== id);
  k.expires = life.state.clock + CONTRACTS.durationSeconds;
  c.active.push(k);
  life.toast(`Contract taken: ${k.count} × ${packDef(k.pack).name} to ${placeName(k.outpost)}`, 'quest');
  return true;
}

/** A pack was just sold at an outpost: count it toward a matching contract. */
export function contractDelivered(life: Life, outpost: string, pack: string): void {
  const c = life.state.contracts;
  if (!c) return;
  const k = c.active.find((x) => x.outpost === outpost && x.pack === pack && x.delivered < x.count);
  if (!k) return;
  k.delivered++;
  if (k.delivered < k.count) {
    life.toast(`Contract: ${k.delivered}/${k.count} ${packDef(pack).name}`, 'quest');
    return;
  }
  life.state.coins += k.bonusCoins;
  life.state.seals += k.bonusSeals;
  c.active = c.active.filter((x) => x.id !== k.id);
  life.toast(`✔ Contract filled! Bonus ${formatCoins(k.bonusCoins)} + ${k.bonusSeals} seal${k.bonusSeals > 1 ? 's' : ''}`, 'coin');
  life.notify({ type: 'contract', outpost });
}
