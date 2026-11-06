import { itemDef, vendorFor } from '../../../content/items';
import { esc } from '../../../util/html';
import { buttonHtml } from '../../components/button';
import { slotHtml } from '../../components/slot';
import { tabsHtml } from '../../components/tabs';
import type { View } from '../../components/window';
import { type MenuEntry, openMenu } from '../../theme/contextMenu';
import { iconHtml, money, uiIcon } from '../../theme/icons';
import type { IslandUI, ShopTab } from '../context';

// A merchant's window, with your bag open beside it: what they sell, what of yours they buy, and
// what you sold them that they still hold for you (the buyback, until you walk off). A click buys
// or sells one, a shift-click a handful, a right-click offers both; a double-click in the bag sells.

const TABS = [
  ['buy', 'Buy'],
  ['sell', 'Sell'],
  ['buyback', 'Buyback'],
] as const;

/** Something on a merchant's shelf (.m-item): its slot, its name and its price; one you can't afford greyed out. */
const ware = (act: string, item: string, slot: string, name: string, price: string, cant = false): string =>
  `<div class="m-item${cant ? ' cant' : ''}" data-act="${act}" data-arg="${item}" data-tip="item:${item}"${cant ? ' disabled' : ''}>${slot}<div><div class="nm">${esc(name)}</div><div class="pr">${price}</div></div></div>`;

export function shopView(ui: IslandUI, npcId: string, tab: ShopTab): View {
  const life = ui.life;
  const v = vendorFor(npcId)!;
  const n = life.zone.recipe.npcs.find((x) => x.id === npcId)!;
  const s = life.state;
  let grid = '';
  if (tab === 'buy') {
    grid = v.sells
      .map((o) => {
        const it = itemDef(o.item);
        const can = s.coins >= o.price && s.seals >= (o.seals ?? 0);
        return ware(
          'buy',
          o.item,
          slotHtml(iconHtml(it.icon, o.item)),
          it.name,
          `${money(o.price, 12)}${o.seals ? ` + ${o.seals} ${uiIcon('seal', 14)}` : ''}`,
          !can,
        );
      })
      .join('');
  } else if (tab === 'sell') {
    const have = v.buys.filter((i) => life.count(i) > 0);
    grid = have
      .map((i) => {
        const it = itemDef(i);
        const price = Math.max(1, Math.round(it.value * v.buyRate));
        return ware('sell', i, slotHtml(iconHtml(it.icon, i), { n: life.count(i) }), it.name, `${money(price, 12)} Each`);
      })
      .join('');
    if (!have.length) grid = `<div class="m-empty" style="grid-column:1/-1">Nothing ${esc(n.name.split(' ')[0])} wants in your bag.</div>`;
  } else {
    // What you sold here, held at what it fetched until you walk off (src/engine/life/trade.ts).
    const held = (s.buyback ?? []).filter((b) => b.npc === npcId);
    grid = held
      .map((b) => {
        const it = itemDef(b.item);
        const can = s.coins >= b.price;
        return ware('buyback', b.item, slotHtml(iconHtml(it.icon, b.item), { n: b.n }), it.name, `${money(b.price, 12)} Each`, !can);
      })
      .join('');
    if (!held.length)
      grid = `<div class="m-empty" style="grid-column:1/-1">Nothing to buy back. ${esc(n.name.split(' ')[0])} holds what you sell here until you walk off.</div>`;
  }
  const how = {
    buy: 'Click to buy one, shift-click for five.',
    sell: 'Click to sell one, shift-click to sell them all.',
    buyback: 'Click to buy one back, shift-click for all of it.',
  }[tab];
  const buys = v.buys
    .map((id) => itemDef(id)?.name)
    .filter(Boolean)
    .join(', ');
  const menu = (act: 'buy' | 'sell' | 'buyback') => (item: string, b: HTMLElement, e: MouseEvent) =>
    shopMenu(ui, npcId, act, item, b.hasAttribute('disabled'), e.clientX, e.clientY);
  return {
    title: v.name,
    sub: esc(n.title),
    portrait: ui.face(npcId),
    w: 440,
    h: 500,
    body: `${tabsHtml(TABS, tab)}
        <div class="m-grid${tab === 'sell' ? ' m-sell' : ''}">${grid}</div>
        <div class="m-buys"><b>${esc(n.name.split(' ')[0])} Buys:</b> ${esc(buys)}. ${how}</div>`,
    foot: `<span>${money(s.coins)}&nbsp; ${uiIcon('seal', 18)} <b>${s.seals}</b></span><span style="display:flex;gap:12px">${buttonHtml('Sell All Produce', 'sellall', { small: true })}${buttonHtml('Back', 'back', { small: true })}</span>`,
    handlers: {
      tab: (t) => ui.open({ kind: 'shop', id: npcId, tab: t as ShopTab }),
      buy: (item, e) => ui.command({ t: 'buy', npc: npcId, item, n: e?.shiftKey && itemDef(item).stack > 1 ? 5 : 1 }),
      sell: (item, e) => ui.command({ t: 'sell', npc: npcId, item, n: e?.shiftKey ? 9999 : 1 }),
      buyback: (item, e) => ui.command({ t: 'buyback', npc: npcId, item, n: e?.shiftKey ? 9999 : 1 }),
      sellall: () => {
        for (const i of v.buys) if (life.count(i) > 0 && itemDef(i).cat === 'produce') ui.command({ t: 'sell', npc: npcId, item: i, n: 9999 });
      },
      back: () => ui.open({ kind: 'dialog', id: npcId }),
    },
    menus: { buy: menu('buy'), sell: menu('sell'), buyback: menu('buyback') },
  };
}

/** A merchant's item, right-clicked: buy or sell one, or a handful. */
function shopMenu(ui: IslandUI, npc: string, act: 'buy' | 'sell' | 'buyback', item: string, cant: boolean, x: number, y: number): void {
  const def = itemDef(item);
  const go = (t: 'buy' | 'sell' | 'buyback', n: number) => () => ui.command({ t, npc, item, n });
  const broke = cant ? 'Not enough money' : undefined;
  const entries: MenuEntry[] =
    act === 'buy'
      ? [
          { label: 'Buy One', primary: true, disabled: broke, run: go('buy', 1) },
          ...(def.stack > 1 ? [{ label: 'Buy Five', disabled: broke, run: go('buy', 5) }] : []),
        ]
      : act === 'sell'
        ? [
            { label: 'Sell One', primary: true, run: go('sell', 1) },
            { label: 'Sell All', run: go('sell', 9999) },
          ]
        : [
            { label: 'Buy Back One', primary: true, disabled: broke, run: go('buyback', 1) },
            { label: 'Buy Back All', disabled: broke, run: go('buyback', 9999) },
          ];
  openMenu(x, y, def.name, entries);
}
