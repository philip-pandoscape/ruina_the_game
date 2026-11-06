import { cropDef, CLIMATES } from '../../content/farming';
import { itemDef, vendorFor } from '../../content/items';
import { packDef, placeName } from '../../content/trade';
import { shortTime } from '../../sim/life/interact';
import { esc } from '../../util/html';
import { WEAPON_NAMES } from '../icons';
import { money } from '../theme/icons';
import type { IslandUI } from './context';

// The island's tooltips (src/ui/theme/tooltip.ts): what an item, a trade pack, an empty slot or
// your weapon is, for anything in the HUD or a window whose data-tip is item:, pack:, slot: or
// weapon: followed by its id.

const CAT: Record<string, string> = {
  seed: 'Seed',
  produce: 'Produce',
  material: 'Material',
  consumable: 'Consumable',
  placeable: 'Placeable',
  glider: 'Glider',
  deed: 'Vehicle Deed',
  mount: 'Mount',
};

/** The tooltip for a data-tip, or null when it isn't one of the island's. */
export function islandTip(ui: IslandUI, tip: string): string | null {
  const i = tip.indexOf(':');
  const kind = tip.slice(0, i);
  const id = tip.slice(i + 1);
  if (kind === 'item') {
    let it: ReturnType<typeof itemDef>;
    try {
      it = itemDef(id);
    } catch {
      return null;
    }
    if (!it) return null;
    let extra = '';
    if (it.plants) {
      try {
        const c = cropDef(it.plants);
        extra = `<p class="g">${CLIMATES[c.climate]?.name ?? c.climate} crop · ripens in ~${shortTime(c.growSeconds * (c.climate === ui.life.zone.recipe.climate ? 1 : 1 / 0.7))} here · yields ${c.yield[0]}-${c.yield[1]}</p>`;
      } catch {
        extra = '';
      }
    }
    // At a merchant's, what they'd pay for it.
    const p = ui.panel();
    const v = p && p.kind === 'shop' ? vendorFor(p.id) : null;
    const n = v && p && 'id' in p ? ui.life.zone.recipe.npcs.find((x) => x.id === p.id) : null;
    const sells =
      v && v.buys.includes(id)
        ? `<div class="row"><span class="muted">${esc(n?.name.split(' ')[0] ?? 'They')} Pays</span>${money(Math.max(1, Math.round(it.value * v.buyRate)), 12)}</div>`
        : it.value
          ? `<div class="row"><span class="muted">Worth</span>${money(it.value, 12)}</div>`
          : '';
    return `<h5>${esc(it.name)}</h5><div class="ty">${CAT[it.cat] ?? it.cat}${it.stack > 1 ? ` · Stacks to ${it.stack}` : ''}</div><p>${esc(it.desc)}</p>${extra}${sells ? `<hr>${sells}` : ''}`;
  }
  if (kind === 'pack') {
    try {
      const pk = packDef(id);
      if (pk.kind === 'material')
        return `<h5>${esc(pk.name)}</h5><div class="ty">Building Material</div><p>Made at ${esc(placeName(pk.origin))}. Haul it to a building site: your house, or a ship on the slipway.</p>`;
      return `<h5>${esc(pk.name)}</h5><div class="ty">Trade Pack</div><p>Made at ${esc(placeName(pk.origin))}. Carry it to another town's trader to sell.</p>`;
    } catch {
      return null;
    }
  }
  if (kind === 'slot') return `<h5>${esc(id)}</h5><div class="ty">Empty</div><p>There's nothing to wear here yet.</p>`;
  if (kind === 'weapon')
    return `<h5>${esc(WEAPON_NAMES[Number(id)] ?? '')}</h5><div class="ty">Main Hand</div><p>Change your weapon in the skill book (T).</p>`;
  return null;
}
