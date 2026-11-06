import { adminListHtml, openDevPage } from '../../admin/adminMenu';
import { buttonHtml } from '../../components/button';
import type { View } from '../../components/window';
import type { IslandUI } from '../context';

/** The Admin window, for admins only: Developer Tools, then every developer zone and page (src/ui/admin/adminMenu.ts). */
export function adminView(ui: IslandUI): View {
  return {
    title: 'Admin',
    sub: 'For admins only. A zone takes you there; a page opens in a new tab.',
    w: 600,
    h: 640,
    body:
      `<div class="lui-admin"><div class="h">In the World</div><div class="adm-row">${buttonHtml('Developer Tools', 'devtools', { small: true })}` +
      `<span class="adm-about">Gifts, island time, teleports, starting the island over and bug reports. <b>\`</b> opens it too.</span></div>` +
      `${adminListHtml(!!ui.app.onEnterZone)}</div>`,
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
