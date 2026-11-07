import { BAG_SLOTS, CATEGORIES, itemDef, vendorFor } from '../../../content/items';
import { packDef } from '../../../content/trade';
import { carried } from '../../../engine/life';
import { gridHtml, slotHtml } from '../../components/slot';
import { DockedWindow, frameHtml } from '../../components/window';
import { type MenuEntry, openMenu } from '../../theme/contextMenu';
import { iconHtml, money, uiIcon, withIcons } from '../../theme/icons';
import type { IslandUI } from '../context';

// The bag, docked on the right: a grid of what you carry, the pack on your back, your money and
// labor. An item answers a click (picked out), a double-click (its main thing) and a right-click
// (everything you can do with it here); beside a merchant or your chest, selling or storing it
// comes first.

export class BagWindow {
  readonly win: DockedWindow;
  /** The slot picked out, -1 for none. */
  private sel = -1;

  /** `close` is what its close button does. */
  constructor(
    private ui: IslandUI,
    close: () => void,
  ) {
    this.win = new DockedWindow('lui-bag', 'right', close);
  }

  get el(): HTMLDivElement {
    return this.win.el;
  }

  render(): void {
    const life = this.ui.life;
    const s = life.state;
    const cells: string[] = [];
    for (let i = 0; i < BAG_SLOTS; i++) {
      const st = s.bag[i];
      if (!st) {
        cells.push(slotHtml('', { cls: 'sm empty' }));
        continue;
      }
      const def = itemDef(st.item);
      cells.push(
        slotHtml(iconHtml(def.icon, st.item), {
          cls: `sm${this.sel === i ? ' sel' : ''}`,
          n: st.n > 1 ? st.n : undefined,
          act: 'sel',
          arg: i,
          tip: `item:${st.item}`,
        }),
      );
    }
    const pk = carried(life, this.ui.sim);
    this.win.el.style.width = '452px';
    this.win.fill(
      frameHtml(
        {
          title: 'Bag',
          sub: `${s.bag.length} / ${BAG_SLOTS}`,
          body: `${gridHtml(cells)}${pk ? `<div class="note" style="margin-top:8px">On Your Back: ${withIcons(`${packDef(pk.def).icon} ${packDef(pk.def).name}`, 14)}</div>` : ''}`,
          foot: `<span>${money(s.coins)}&nbsp; ${uiIcon('seal', 18)} <b>${s.seals}</b></span><span>${uiIcon('labor', 18)} <b>${Math.floor(s.labor)}</b> Labor</span>`,
        },
        { closeKey: 'I', bodyStyle: 'overflow:hidden' },
      ),
      {
        // A click picks an item out; a double-click does its main thing (right-click: everything else).
        sel: (i, e) => {
          if (e?.detail === 2) return this.primary(Number(i));
          this.pick(Number(i));
        },
      },
      { sel: (i, _b, e) => this.menu(Number(i), e.clientX, e.clientY) },
    );
  }

  /** A double-click (or A on a controller): the item in bag slot `i` does its main thing. */
  primary(i: number): void {
    this.actions(i)
      .find((e) => e.primary)
      ?.run?.();
  }

  /** The right-click menu for bag slot `i`, at a point on screen. */
  menu(i: number, x: number, y: number): void {
    const st = this.ui.life.state.bag[i];
    if (!st) return;
    this.pick(i);
    openMenu(x, y, st.n > 1 ? `${itemDef(st.item).name} ×${st.n}` : itemDef(st.item).name, this.actions(i));
  }

  /** Picks out bag slot `i`. */
  private pick(i: number): void {
    this.sel = i;
    for (const c of this.win.el.querySelectorAll('.bag-grid [data-act="sel"]')) c.classList.toggle('sel', c.getAttribute('data-arg') === String(i));
  }

  /**
   * What can be done with the item in bag slot `i` right now, its main action first: using it
   * (placing a scarecrow, equipping a glider...), or selling or storing it while a merchant's or
   * your chest's window is open, which then comes first.
   */
  private actions(i: number): MenuEntry[] {
    const life = this.ui.life;
    const s = life.state;
    const st = s.bag[i];
    if (!st) return [];
    const item = st.item;
    const def = itemDef(item);
    const out: MenuEntry[] = [];
    // Using it, as its category calls that (shared/items.json `categories`), unless it is in use already.
    const verb = CATEGORIES[def.cat]?.verb;
    if (def.cat === 'seed' && s.seed === item) out.push({ label: 'Planting This', disabled: 'F plants this seed already' });
    else if (def.cat === 'glider' && s.glider === def.glider) out.push({ label: 'Equipped', disabled: 'This is the glider you fly' });
    else if (verb) out.push({ label: verb, run: () => this.use(item) });
    const p = this.ui.panel();
    const trade: MenuEntry[] = [];
    if (p?.kind === 'shop') {
      const v = vendorFor(p.id);
      const who = life.zone.recipe.npcs.find((n) => n.id === p.id)?.name.split(' ')[0] ?? 'They';
      if (v?.buys.includes(item)) {
        trade.push({ label: 'Sell One', run: () => this.ui.command({ t: 'sell', npc: p.id, item, n: 1 }) });
        if (st.n > 1) trade.push({ label: 'Sell All', run: () => this.ui.command({ t: 'sell', npc: p.id, item, n: 9999 }) });
      } else trade.push({ label: 'Sell', disabled: `${who} doesn't buy this` });
    } else if (p?.kind === 'storage') {
      trade.push({ label: 'Store in Chest', run: () => this.ui.command({ t: 'store', house: Number(p.id), item, n: life.count(item) }) });
    } else if (def.cat === 'produce' || def.cat === 'material') {
      out.push({ label: 'Sell', disabled: 'Talk to a merchant who buys it' });
    }
    // At a merchant or your chest, that comes first: a double-click sells or stores.
    const all = trade.some((e) => !e.disabled) ? [...trade, ...out] : [...out, ...trade];
    const first = all.find((e) => !e.disabled);
    return all.map((e) => ({ ...e, primary: e === first }));
  }

  private use(item: string): void {
    this.ui.command({ t: 'use', item });
    const cat = itemDef(item).cat;
    // Out of the way of the world: you walk off to place it, or get on what you called.
    if (cat === 'deed' || cat === 'placeable' || cat === 'mount') this.ui.finish(true);
  }
}
