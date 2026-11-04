import type { Life } from './life';
import type { Sim } from '../sim';
import type { Pack, Vehicle } from './state';
import { DEMAND, FRESHNESS, packDef, route, formatCoins, placeName } from '../../content/trade';
import { itemDef, recipe as recipeDef, vendorFor, type RecipeDef } from '../../content/items';
import { groundAt } from '../zone/colliders';
import { contractDelivered } from './contracts';

// Pack running. A pack is made at a workbench from local goods and labor, rides on your back
// (slowly - no sprint, no double jump, no glider) or in a vehicle's cargo, and is sold at a
// trading post somewhere else. Farther routes pay more; each sale lowers that post's demand for
// that pack, which recovers with time; a fresh pack earns a bonus that sours the longer it sits.

// ---------- Prices ----------

const demandKey = (outpost: string, pack: string) => `${outpost}:${pack}`;

export function demandAt(life: Life, outpost: string, pack: string): number {
  return life.state.demand[demandKey(outpost, pack)] ?? DEMAND.start;
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
export function quote(life: Life, pack: Pack, outpost: string): Quote | null {
  const def = packDef(pack.def);
  if ((def as { kind?: string }).kind === 'material') return null;
  const r = route(pack.origin, outpost);
  if (!r) return null;
  const demand = demandAt(life, outpost, pack.def);
  const fresh = freshness(life.state.clock - pack.made);
  return { coins: Math.round(def.base * r.factor * demand * fresh), seals: r.seals, demand, fresh, factor: r.factor };
}

export function stepTrade(life: Life, dt: number): void {
  const d = life.state.demand;
  for (const k of Object.keys(d)) d[k] = Math.min(DEMAND.max, d[k] + (DEMAND.recoverPerMinute * dt) / 60);
}

/** Recovers demand over a long stretch (time away). */
export function recoverDemand(life: Life, seconds: number): void {
  stepTrade(life, seconds);
}

// ---------- Where packs are ----------

export const packById = (life: Life, id: number): Pack | undefined => life.state.packs.find((p) => p.id === id);
export const carried = (life: Life, sim: Sim): Pack | undefined => (sim.player.pack ? packById(life, sim.player.pack) : undefined);

function removePack(life: Life, id: number): void {
  const i = life.state.packs.findIndex((p) => p.id === id);
  if (i >= 0) life.state.packs.splice(i, 1);
  life.revision++;
}

export function makePack(life: Life, def: string, origin: string): Pack {
  const p: Pack = { id: life.nextId(), def, made: life.state.clock, origin, at: 'back', x: 0, y: 0, z: 0, rot: 0, vehicle: 0, slot: 0 };
  life.state.packs.push(p);
  life.revision++;
  return p;
}

// ---------- Crafting ----------

/** Makes a pack at a workbench (bench is the workbench id; place is where that bench is). */
export function craftPack(life: Life, sim: Sim, r: RecipeDef, place: string): boolean {
  const def = packDef(r.makes.pack!);
  if (sim.player.pack) {
    life.toast('Your back is already full - set that pack down first (X)', 'bad');
    return false;
  }
  if (sim.player.mode !== 'normal' || !sim.player.grounded) {
    life.toast('Stand still at the bench to work', 'bad');
    return false;
  }
  for (const inp of def.inputs) {
    if (life.count(inp.item) < inp.n) {
      life.toast(`Needs ${inp.n} ${itemDef(inp.item).name} (you have ${life.count(inp.item)})`, 'bad');
      return false;
    }
  }
  if (!life.afford({ coins: def.fee, labor: def.labor }, `pack a ${def.name}`)) return false;
  for (const inp of def.inputs) life.take(inp.item, inp.n);
  const pack = makePack(life, def.id, place);
  sim.player.pack = pack.id;
  life.toast(`${def.icon} ${def.name} packed - it's on your back`, 'good');
  life.notify({ type: 'craftPack', pack: def.id });
  return true;
}

/** An item recipe: a crafter or a workbench turns materials and coin into something for the bag. */
export function craftItem(life: Life, r: RecipeDef): boolean {
  const item = r.makes.item!;
  const n = r.makes.n ?? 1;
  for (const inp of r.inputs ?? []) {
    if (life.count(inp.item) < inp.n) {
      life.toast(`Needs ${inp.n} ${itemDef(inp.item).name} (you have ${life.count(inp.item)})`, 'bad');
      return false;
    }
  }
  if (!life.hasRoom(item, n)) {
    life.toast('Your bag is full', 'bad');
    return false;
  }
  if (!life.afford({ coins: r.coins ?? 0, labor: r.labor ?? 0 }, `make ${itemDef(item).name}`)) return false;
  life.takeAll(r.inputs);
  life.give(item, n);
  life.notify({ type: 'craft', item });
  return true;
}

export function runRecipe(life: Life, sim: Sim, id: string): boolean {
  const r = recipeDef(id);
  if (!r) return false;
  if (r.makes.pack) {
    const bench = life.zone.recipe.workbenches.find((b) => b.id === r.bench);
    return craftPack(life, sim, r, bench?.place ?? 'lanternwick');
  }
  return craftItem(life, r);
}

// ---------- Carrying ----------

export function dropPack(life: Life, sim: Sim): boolean {
  const p = sim.player;
  const pack = carried(life, sim);
  if (!pack) return false;
  if (p.mode === 'ride' || p.mode === 'swim') {
    life.toast('You cannot set a pack down here', 'bad');
    return false;
  }
  const hf = sim.world.terrain!;
  const x = p.pos.x + Math.sin(p.facing) * 0.9;
  const z = p.pos.z + Math.cos(p.facing) * 0.9;
  pack.at = 'ground';
  pack.x = x;
  pack.z = z;
  pack.y = groundAt(hf, sim.world.index, x, z, p.pos.y + 0.3, 0.6);
  pack.rot = p.facing;
  p.pack = 0;
  life.revision++;
  return true;
}

export function pickUp(life: Life, sim: Sim, pack: Pack): boolean {
  if (sim.player.pack) {
    life.toast('You are already carrying a pack', 'bad');
    return false;
  }
  if (sim.player.mode === 'glide') return false;
  pack.at = 'back';
  pack.vehicle = 0;
  sim.player.pack = pack.id;
  life.revision++;
  return true;
}

export function loadPack(life: Life, sim: Sim, v: Vehicle, slot: number): boolean {
  const pack = carried(life, sim);
  if (!pack || v.cargo[slot]) return false;
  pack.at = 'cargo';
  pack.vehicle = v.id;
  pack.slot = slot;
  v.cargo[slot] = pack.id;
  sim.player.pack = 0;
  life.revision++;
  life.notify({ type: 'load' });
  return true;
}

export function unloadPack(life: Life, sim: Sim, v: Vehicle, slot: number): boolean {
  if (sim.player.pack) {
    life.toast('Your back is already full', 'bad');
    return false;
  }
  const id = v.cargo[slot];
  const pack = id ? packById(life, id) : undefined;
  if (!pack) return false;
  v.cargo[slot] = 0;
  pack.at = 'back';
  pack.vehicle = 0;
  sim.player.pack = pack.id;
  life.revision++;
  return true;
}

// ---------- Selling ----------

export function sellPack(life: Life, sim: Sim, outpost: string): boolean {
  const pack = carried(life, sim);
  if (!pack) return false;
  const q = quote(life, pack, outpost);
  const def = packDef(pack.def);
  if (!q) {
    life.toast(pack.origin === outpost ? `${placeName(outpost)} makes these itself - sell it somewhere else` : `${placeName(outpost)} does not buy ${def.name}`, 'bad');
    return false;
  }
  life.state.coins += q.coins;
  life.state.seals += q.seals;
  life.state.stats.delivered++;
  life.state.stats.earned += q.coins;
  const key = demandKey(outpost, pack.def);
  life.state.demand[key] = Math.max(DEMAND.min, demandAt(life, outpost, pack.def) - DEMAND.dropPerSale);
  sim.player.pack = 0;
  removePack(life, pack.id);
  life.emit({ t: 'sold', pack: def.id, coins: q.coins, seals: q.seals, demand: q.demand, fresh: q.fresh, outpost });
  life.toast(`Sold ${def.name}: ${formatCoins(q.coins)}${q.seals ? ` + ${q.seals} seal${q.seals > 1 ? 's' : ''}` : ''}`, 'coin');
  life.notify({ type: 'deliver', outpost, pack: def.id });
  contractDelivered(life, outpost, def.id);
  return true;
}

/** A material pack is used up by a building site. */
export function consumeCarried(life: Life, sim: Sim): void {
  const pack = carried(life, sim);
  if (!pack) return;
  sim.player.pack = 0;
  removePack(life, pack.id);
}

// ---------- Shops ----------

export function buy(life: Life, npc: string, item: string, n: number): boolean {
  const v = vendorFor(npc);
  const offer = v?.sells.find((s) => s.item === item);
  if (!v || !offer || n <= 0) return false;
  if (!life.hasRoom(item, n)) {
    life.toast('Your bag is full', 'bad');
    return false;
  }
  const def = itemDef(item);
  if (!life.afford({ coins: offer.price * n, seals: (offer.seals ?? 0) * n }, `buy ${def.name}`)) return false;
  life.give(item, n);
  life.notify({ type: 'buy', item });
  return true;
}

export function sell(life: Life, npc: string, item: string, n: number): boolean {
  const v = vendorFor(npc);
  if (!v || !v.buys.includes(item) || n <= 0) return false;
  const have = life.count(item);
  const amount = Math.min(n, have);
  if (!amount) return false;
  const price = Math.max(1, Math.round(itemDef(item).value * v.buyRate));
  life.take(item, amount);
  life.state.coins += price * amount;
  life.toast(`Sold ${amount} ${itemDef(item).name} for ${formatCoins(price * amount)}`, 'coin');
  life.notify({ type: 'sell', item });
  return true;
}
