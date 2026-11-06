import { DEV_PAGES, devPageUrl, type DevPage } from '../../dev/pages';
import { esc } from '../../util/html';
import { card, el } from '../signIn';
import { uiRoot } from '../theme/scale';
import './admin.css';

// The Admin menu: every developer zone and page (src/dev/pages.ts), for admins only (the server
// says who is one: ADMIN_USERS, or everyone on a development server). It is a window in the world
// (the menu bar's Admin button, src/ui/life/lifeUI.ts, which adds Developer Tools at its top) and a
// card over the character select screen (the account row's Admin button) and the yard or the
// battlefield (a button in the corner). Each zone and page opens in a new tab, so whatever this
// one is doing carries on.

const SECTIONS: ReadonlyArray<[DevPage['kind'], string]> = [
  ['zone', 'Developer Zones'],
  ['page', 'Developer Pages'],
  ['design', 'Design'],
];

const NEEDS: Record<NonNullable<DevPage['needs']>, string> = {
  'dev-server': 'Saves on a Dev Server Only',
  battlefield: "Needs the Server's Battlefield",
};

const row = (p: DevPage): string =>
  `<div class="adm-row"><button class="lui-btn small" type="button" data-act="devpage" data-arg="${esc(p.id)}">${esc(p.title)}</button>` +
  `<span class="adm-about">${esc(p.about)}${p.needs ? ` <span class="adm-tag">${NEEDS[p.needs]}</span>` : ''}</span></div>`;

/**
 * The list: a heading for each kind and a button for each zone and page, with what it's for. The
 * buttons carry `data-act="devpage"` and the page's id, for `openDevPage`.
 */
export function adminListHtml(): string {
  return SECTIONS.map(([kind, heading]) => `<div class="h">${heading}</div>${DEV_PAGES.filter((p) => p.kind === kind).map(row).join('')}`).join('');
}

/** Opens a developer zone or page in a new tab. */
export function openDevPage(id: string): void {
  const p = DEV_PAGES.find((x) => x.id === id);
  if (p) window.open(devPageUrl(p), '_blank', 'noopener');
}

/** The Admin card: the list and a Close button that calls `close`. */
export function adminCard(close: () => void): HTMLDivElement {
  const list = el('div', { className: 'adm-list' });
  list.innerHTML = adminListHtml();
  list.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act="devpage"]');
    if (b?.dataset.arg) openDevPage(b.dataset.arg);
  });
  const done = el('button', { className: 'lui-btn fd-quiet', type: 'button', textContent: 'Close' });
  done.onclick = close;
  const c = card('Admin', el('p', { className: 'fd-sub', textContent: 'Developer zones and pages, for admins only. Each opens in a new tab.' }), list, el('div', { className: 'fd-actions' }, done));
  c.classList.add('adm-card');
  return c;
}

/** The yard's and the battlefield's way to the menu: an Admin button in the corner, for admins. */
export function addAdminButton(): HTMLButtonElement {
  const b = el('button', { id: 'hud-admin', className: 'lui-btn small', type: 'button', textContent: 'Admin' });
  b.onclick = () => showAdminCard();
  uiRoot().append(b);
  return b;
}

/**
 * The Admin card over the game (the yard, the battlefield), until Close, Escape or a click beside
 * it. Returns a function that closes it.
 */
export function showAdminCard(): () => void {
  const modal = el('div', { className: 'fd-modal adm-modal' });
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };
  const close = () => {
    modal.remove();
    removeEventListener('keydown', onKey, true);
  };
  modal.append(adminCard(close));
  modal.addEventListener('mousedown', (e) => {
    if (e.target === modal) close();
  });
  addEventListener('keydown', onKey, true);
  uiRoot().append(modal);
  if (document.pointerLockElement) document.exitPointerLock();
  return close;
}
