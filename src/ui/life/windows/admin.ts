import { DUNGEONS } from '../../../sim/zone/dungeon';
import { esc } from '../../../util/html';
import { adminListHtml, openDevPage } from '../../admin/adminMenu';
import { buttonHtml } from '../../components/button';
import type { View } from '../../components/window';
import type { IslandUI } from '../context';

/** The developer zones (content/dungeons/, `developer`): a button each into it, online. */
function zonesHtml(): string {
  const zones = Object.values(DUNGEONS).filter((d) => d.developer);
  const rows = zones.map(
    (d) => `<div class="adm-row">${buttonHtml(esc(d.name), 'zone', { small: true, arg: d.id })}<span class="adm-about">${esc(d.about ?? '')}</span></div>`,
  );
  return `<div class="h">Developer Zones</div>${rows.join('')}`;
}

/** The Admin window, for admins only: Developer Tools, then every developer zone and page (src/ui/admin/adminMenu.ts). */
export function adminView(ui: IslandUI): View {
  return {
    title: 'Admin',
    sub: 'For admins only. The zones and pages open in a new tab.',
    w: 600,
    h: 640,
    body:
      `<div class="lui-admin"><div class="h">In the World</div><div class="adm-row">${buttonHtml('Developer Tools', 'devtools', { small: true })}` +
      `<span class="adm-about">Gifts, island time, teleports, starting the island over and bug reports. <b>\`</b> opens it too.</span></div>` +
      `${ui.app.onEnterZone ? zonesHtml() : ''}${adminListHtml()}</div>`,
    handlers: {
      devtools: () => ui.open({ kind: 'dev' }),
      devpage: (id) => openDevPage(id),
      zone: (id) => {
        ui.app.onEnterZone?.(id);
        ui.finish();
      },
    },
  };
}
