import { itemDef, recipe as recipeDef, recipesAt } from '../../../content/items';
import { packDef, placeName, route } from '../../../content/trade';
import { demandAt, freshness } from '../../../engine/life';
import { esc } from '../../../util/html';
import { buttonHtml } from '../../components/button';
import { listHtml, rowHtml } from '../../components/list';
import { slotHtml } from '../../components/slot';
import type { View } from '../../components/window';
import { iconHtml, money, uiIcon } from '../../theme/icons';
import type { LifeContext } from '../context';

// A workbench, or someone's workshop: what can be made there, what each takes (what you have of it
// in green, what you lack in red), where a trade pack sells and for how much. Packing one closes
// the window, as you have somewhere to carry it.

export function craftView(ui: LifeContext, benchOrNpc: string): View {
  const life = ui.life;
  const bench = life.zone.recipe.workbenches.find((b) => b.id === benchOrNpc);
  const npc = life.zone.recipe.npcs.find((x) => x.id === benchOrNpc);
  const recipes = recipesAt(benchOrNpc);
  const title = bench ? ((bench as { name?: string }).name ?? 'Workbench') : `${npc?.name ?? ''}'s Workshop`;
  const rows = recipes
    .map((r) => {
      const pack = r.makes.pack ? packDef(r.makes.pack) : null;
      const item = r.makes.item ? itemDef(r.makes.item) : null;
      const inputs = pack ? pack.inputs : (r.inputs ?? []);
      const coins = pack ? pack.fee : (r.coins ?? 0);
      const labor = pack ? pack.labor : (r.labor ?? 0);
      const have = inputs.every((i) => life.count(i.item) >= i.n) && life.state.coins >= coins && life.state.labor >= labor;
      const need = inputs
        .map((i) => `<span class="${life.count(i.item) >= i.n ? 'have' : 'lack'}">${life.count(i.item)}/${i.n} ${esc(itemDef(i.item).name)}</span>`)
        .join(' · ');
      let sells = '';
      if (pack && (pack as { kind?: string }).kind !== 'material') {
        const quotes = life.zone.recipe.outposts
          .map((o) => {
            const rt = route(pack.origin, o.id);
            if (!rt) return '';
            return `${esc(placeName(o.id))} ~${money(Math.round(pack.base * rt.factor * demandAt(life, o.id, pack.id) * freshness(0)), 11)}`;
          })
          .filter(Boolean);
        sells = `<small>Sells at ${quotes.join(' · ')}</small>`;
      } else if (pack) sells = '<small>Building material: haul it to a house site</small>';
      const name = pack?.name ?? item?.name ?? r.id;
      const icon = pack ? iconHtml(pack.icon) : item ? iconHtml(item.icon, r.makes.item) : uiIcon('craft', 32);
      // Short of a raw material: where it comes from (its description says).
      const short = inputs.find((i) => life.count(i.item) < i.n && itemDef(i.item).cat === 'material');
      const desc = (item?.desc ? `<small>${esc(item.desc)}</small>` : '') + (short ? `<small>${esc(itemDef(short.item).desc)}</small>` : '');
      return rowHtml({
        tip: item ? `item:${r.makes.item}` : pack ? `pack:${pack.id}` : undefined,
        slot: slotHtml(icon),
        body: `<b>${esc(name)}</b><small>${need}${coins ? ` · ${money(coins, 11)}` : ''}${labor ? ` · ${labor} Labor` : ''}</small>${sells}${desc}`,
        end: buttonHtml(pack ? 'Pack It' : 'Make', 'make', { arg: r.id, small: true, gold: have, disabled: !have }),
      });
    })
    .join('');
  const backLine = ui.sim.player.pack ? '<p style="color:var(--bad)">Your back is full: set your pack down (X) before packing another.</p>' : '';
  return {
    title,
    sub: npc ? esc(npc.title) : '',
    portrait: npc ? ui.face(benchOrNpc) : uiIcon('craft'),
    w: 520,
    h: 520,
    body: backLine + listHtml(rows),
    foot: `<span>${money(life.state.coins)}&nbsp; ${uiIcon('labor', 18)} <b>${Math.floor(life.state.labor)}</b> Labor</span>${buttonHtml('Close', 'close')}`,
    handlers: {
      make: (id) => {
        ui.command({ t: 'craft', recipe: id });
        if (recipeDef(id)?.makes.pack) setTimeout(() => ui.finish(), 60);
      },
    },
  };
}
