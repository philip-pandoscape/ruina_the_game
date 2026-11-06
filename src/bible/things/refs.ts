// Links from one thing to another, by the content's own ids, and the little lookups the entries
// share (who sells what, where a place is).

import { ITEMS, RECIPES, type RecipeDef, VENDORS } from '../../content/items';
import { PACKS, packDef } from '../../content/trade';
import { EMBERHOLM, type ZonePlace } from '../../engine/zone';
import { type Html, link, raw } from '../md';
import { coins, listOf } from '../format';
import { icon } from '../kit';

export const ZONE = EMBERHOLM;

/** A link to an item's entry, with its painted icon. */
export function itemLink(id: string, n?: number): Html {
  const it = ITEMS.find((i) => i.id === id);
  const label = it ? it.name : id;
  return raw(`${it ? icon(it.icon, it.id, 20).html : ''}${n !== undefined && n !== 1 ? `<span class="v">${n}</span> ` : ''}${link(`items/${id}`, label).html}`);
}

export const packLink = (id: string, n?: number): Html => {
  const p = PACKS.find((x) => x.id === id);
  return raw(
    `${p ? icon(p.icon, undefined, 20).html : ''}${n !== undefined && n !== 1 ? `<span class="v">${n}</span> ` : ''}${link(`packs/${id}`, p?.name ?? id).html}`,
  );
};

export const npcLink = (id: string): Html => link(`npcs/${id}`, ZONE.npcs.find((n) => n.id === id)?.name ?? id);
export const placeLink = (id: string): Html => link(`places/${id}`, ZONE.places.find((p) => p.id === id)?.name ?? id);

/** Several things as a sentence: 3 Lumber, 2 Stone and 1 Iron Ore. */
export const itemsList = (list: ReadonlyArray<{ item: string; n: number }>): Html =>
  listOf(list.map((i) => raw(`${itemLink(i.item, i.n === 1 ? undefined : i.n).html}`)));

/** The place nearest a point on the island. */
export function nearestPlace(x: number, z: number): ZonePlace {
  let best = ZONE.places[0];
  let d = Infinity;
  for (const p of ZONE.places) {
    const dd = Math.hypot(p.x - x, p.z - z);
    if (dd < d) {
      d = dd;
      best = p;
    }
  }
  return best;
}

/** Where a workbench or an NPC crafter is, as a link. */
export function benchLink(bench: string): Html {
  const wb = ZONE.workbenches.find((b) => b.id === bench) as { id: string; name?: string; place: string } | undefined;
  if (wb) return link(`workbenches/${bench}`, wb.name ?? bench);
  if (ZONE.npcs.some((n) => n.id === bench)) return npcLink(bench);
  return raw(bench);
}

/** What a recipe takes: the pack's own inputs, labor and fee for a pack, the recipe's otherwise. */
export function recipeNeeds(r: RecipeDef): { inputs: Array<{ item: string; n: number }>; labor: number; coins: number } {
  if (r.makes.pack) {
    const p = packDef(r.makes.pack);
    return { inputs: p.inputs, labor: p.labor, coins: p.fee };
  }
  return { inputs: r.inputs ?? [], labor: r.labor ?? 0, coins: r.coins ?? 0 };
}

/** What a recipe makes, as a link. */
export const recipeMakes = (r: RecipeDef): Html => (r.makes.pack ? packLink(r.makes.pack) : itemLink(r.makes.item ?? '', r.makes.n));

/** Every vendor's offer of an item. */
export const offersOf = (item: string) => VENDORS.flatMap((v) => v.sells.filter((s) => s.item === item).map((s) => ({ vendor: v, ...s })));

/** What a vendor pays for an item (the rules: worth × their rate, rounded, at least one copper). */
export const buyPrice = (value: number, rate: number): number => Math.max(1, Math.round(value * rate));

/** The recipes that make an item. */
export const recipesMaking = (item: string): RecipeDef[] => RECIPES.filter((r) => r.makes.item === item);

/** A price with seals, if any. */
export const priceHtml = (copper: number, seals?: number): Html =>
  raw(`${coins(copper).html}${seals ? ` + <span class="v">${seals}</span> ${seals === 1 ? 'Charter Seal' : 'Charter Seals'}` : ''}`);
