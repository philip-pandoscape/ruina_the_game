import { itemDef } from '../../../content/items';
import { isMount, rideable } from '../../../content/vehicles';
import { esc } from '../../../util/html';
import { buttonHtml } from '../../components/button';
import { listHtml, rowHtml } from '../../components/list';
import { slotHtml } from '../../components/slot';
import type { View } from '../../components/window';
import { iconHtml, uiIcon } from '../../theme/icons';
import type { IslandUI } from '../context';

// Rides (V): the vehicles and mounts you own, where each is, and summoning, bringing, calling or
// sending them home.

export function ridesView(ui: IslandUI): View {
  const life = ui.life;
  const owned = life.state.bag.filter((s) => itemDef(s.item).cat === 'deed' || itemDef(s.item).cat === 'mount');
  const p = ui.sim.player;
  const rows = owned
    .map((s) => {
      const def = itemDef(s.item);
      const vid = def.vehicle ?? def.mount!;
      const r = rideable(vid);
      const out = life.land.vehicles.find((v) => v.def === vid);
      const where = out
        ? `${Math.round(Math.hypot(out.x - p.pos.x, out.z - p.pos.z))} m Away${out.cargo.some(Boolean) ? ` · ${out.cargo.filter(Boolean).length} Packs Aboard` : ''}`
        : 'Stabled';
      const stats = isMount(r)
        ? `${r.runSpeed} m/s · ${r.canCarryPack ? 'Carries a Pack' : 'No Packs'}`
        : `${r.maxSpeed} m/s · ${r.cargo.length} Pack Slots · ${r.seats.length} Seats`;
      const go = isMount(r)
        ? buttonHtml('Call (R)', 'mount', { small: true, gold: true })
        : buttonHtml(out ? 'Bring Here' : 'Summon', 'summon', { arg: s.item, small: true, gold: true });
      return rowHtml({
        tip: `item:${s.item}`,
        slot: slotHtml(iconHtml(r.icon)),
        body: `<b>${esc(r.name)}</b><small>${stats}</small><small>${where}</small>`,
        end: go + (out && !isMount(r) ? buttonHtml('Send Home', 'recall', { arg: out.id, small: true }) : ''),
      });
    })
    .join('');
  return {
    title: 'Vehicles & Mounts',
    sub: 'Boats appear at the nearest deep water',
    portrait: uiIcon('wheel'),
    w: 480,
    h: 430,
    body: listHtml(rows || '<p>You own no vehicles yet. Bertram (carts and cars), Captain Ilsa (boats) and Sela (mounts) are in Lanternwick.</p>'),
    handlers: {
      summon: (item) => {
        ui.command({ t: 'summon', item });
        ui.finish();
      },
      recall: (id) => ui.command({ t: 'recall', vehicle: Number(id) }),
      mount: () => {
        ui.command({ t: 'mount' });
        ui.finish();
      },
    },
  };
}
