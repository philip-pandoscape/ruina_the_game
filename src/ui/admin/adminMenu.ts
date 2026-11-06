import { DEV_PAGES, type DevPage } from '../../dev/pages';
import { DUNGEONS } from '../../sim/zone/dungeon';
import { esc } from '../../util/html';
import { card, el } from '../signIn';
import './admin.css';

// The Admin menu, for admins only (the server says who is one: ADMIN_USERS, or everyone on a
// development server): the developer zones (content/dungeons/, `developer`), which take you there
// in the world, then the developer pages and the design (src/dev/pages.ts), each in a new tab so
// whatever this one is doing carries on. It is a window in the world (the menu bar's Admin button,
// src/ui/life/windows/admin.ts, which adds Developer Tools at its top) and a card over the character
// select screen (the account row's Admin button), where a zone takes the chosen character in.

const SECTIONS: ReadonlyArray<[DevPage['kind'], string]> = [
  ['page', 'Developer Pages'],
  ['design', 'Design'],
];

const NEEDS: Record<NonNullable<DevPage['needs']>, string> = {
  'dev-server': 'Saves on a Dev Server Only',
};

const row = (p: DevPage): string =>
  `<div class="adm-row"><button class="lui-btn small" type="button" data-act="devpage" data-arg="${esc(p.id)}">${esc(p.title)}</button>` +
  `<span class="adm-about">${esc(p.about)}${p.needs ? ` <span class="adm-tag">${NEEDS[p.needs]}</span>` : ''}</span></div>`;

/** The developer zones, from their files: a button each (`data-act="zone"`, the zone's id) and what it's for. */
function zonesHtml(): string {
  const rows = Object.values(DUNGEONS)
    .filter((d) => d.developer)
    .map(
      (d) =>
        `<div class="adm-row"><button class="lui-btn small" type="button" data-act="zone" data-arg="${esc(d.id)}">${esc(d.name)}</button>` +
        `<span class="adm-about">${esc(d.about ?? '')}</span></div>`,
    );
  return `<div class="h">Developer Zones</div>${rows.join('')}`;
}

/**
 * The list: the developer zones (when there's a way into them from here), then a heading for each
 * kind of page and a button for each, with what it's for. Zone buttons carry `data-act="zone"`,
 * page buttons `data-act="devpage"` (for `openDevPage`), each with its id.
 */
export function adminListHtml(zones: boolean): string {
  const pages = SECTIONS.map(
    ([kind, heading]) =>
      `<div class="h">${heading}</div>${DEV_PAGES.filter((p) => p.kind === kind)
        .map(row)
        .join('')}`,
  ).join('');
  return (zones ? zonesHtml() : '') + pages;
}

/** Opens a developer zone or page in a new tab. */
export function openDevPage(id: string): void {
  const p = DEV_PAGES.find((x) => x.id === id);
  if (p) window.open(p.url, '_blank', 'noopener');
}

/**
 * The Admin card (character select): the list and a Close button that calls `close`. A zone's
 * button calls `enterZone` with its id.
 */
export function adminCard(close: () => void, enterZone: (id: string) => void): HTMLDivElement {
  const list = el('div', { className: 'adm-list' });
  list.innerHTML = adminListHtml(true);
  list.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    const id = b?.dataset.arg;
    if (!id) return;
    if (b.dataset.act === 'zone') enterZone(id);
    else if (b.dataset.act === 'devpage') openDevPage(id);
  });
  const done = el('button', { className: 'lui-btn fd-quiet', type: 'button', textContent: 'Close' });
  done.onclick = close;
  const c = card(
    'Admin',
    el('p', { className: 'fd-sub', textContent: 'For admins only. A zone takes the character you have chosen into it; a page opens in a new tab.' }),
    list,
    el('div', { className: 'fd-actions' }, done),
  );
  c.classList.add('adm-card');
  return c;
}
