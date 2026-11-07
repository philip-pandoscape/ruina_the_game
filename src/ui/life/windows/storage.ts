import { blueprintDef } from '../../../content/housing';
import { itemDef } from '../../../content/items';
import { isComplete } from '../../../engine/life';
import { esc } from '../../../util/html';
import { buttonHtml } from '../../components/button';
import { listHtml, rowHtml } from '../../components/list';
import { slotHtml } from '../../components/slot';
import type { View } from '../../components/window';
import { iconHtml } from '../../theme/icons';
import type { LifeContext } from '../context';

// The storage chest in your house: your bag beside what's in the chest, to store or take.

export function storageView(ui: LifeContext, houseId: number): View {
  const life = ui.life;
  const h = life.land.houses.find((x) => x.id === houseId);
  if (!h || !isComplete(h)) return { title: 'Storage Chest', w: 420, body: '<p>Gone.</p>' };
  const bp = blueprintDef(h.blueprint);
  const list = (stacks: Array<{ item: string; n: number }>, act: string) =>
    stacks
      .map((st) =>
        rowHtml({
          tip: `item:${st.item}`,
          slot: slotHtml(iconHtml(itemDef(st.item).icon, st.item), { n: st.n }),
          body: `<b>${esc(itemDef(st.item).name)}</b>`,
          end: buttonHtml(act === 'store' ? 'Store' : 'Take', act, { arg: st.item, small: true }),
        }),
      )
      .join('') || '<p class="muted">Empty</p>';
  return {
    title: 'Storage Chest',
    sub: `${h.storage.length}/${bp.perks.storageSlots} Kinds Stored`,
    w: 620,
    h: 520,
    body: `<div class="lui-cols"><div><div class="h">Your Bag</div>${listHtml(list(life.state.bag, 'store'))}</div><div><div class="h">Chest</div>${listHtml(list(h.storage, 'take'))}</div></div>`,
    handlers: {
      store: (item) => ui.command({ t: 'store', house: houseId, item, n: life.count(item) }),
      take: (item) => ui.command({ t: 'take', house: houseId, item, n: 9999 }),
    },
  };
}
