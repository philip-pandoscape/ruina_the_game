// The bible in the browser (/bible/): the navigation, the page the address names (#/systems/combat,
// #/items/seed.barley), search, and the Development tab for admins. Every page is drawn from the
// game's own content and rules as it is shown (src/bible/site.ts).

import '../ui/theme/theme.css';
import './bible.css';
import { iconHtml } from '../ui/theme/icons';
import { esc } from '../util/html';
import { find, warmSearch } from './search';
import { href, type Page, PAGES, pageAt, resolve, SECTIONS, sectionOf } from './site';
import { startEngine } from '../engine/load';

// The island's pages grow it with the engine (its map, its numbers): loaded before any page is shown.
await startEngine();

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`the bible's page has no ${sel}`);
  return el;
};

const rail = $('#rail');
const view = $('#page');
const crumbs = $('#crumbs');
const pager = $('#pager');
const q = $<HTMLInputElement>('#q');
const hits = $('#hits');

// ---------- the navigation ----------

/** The pages the rail lists: the first section's pages, every system, and each kind's index. */
const listed = (section: string): Page[] => PAGES.filter((p) => p.section === section && !p.parent);

function drawRail(admin: boolean): void {
  rail.innerHTML =
    SECTIONS.map(
      (s) =>
        `<div class="group"><h2>${esc(s.title)}</h2>${listed(s.id)
          .map((p) => `<a href="${href(p.path)}" data-path="${esc(p.path)}">${iconHtml(p.icon ?? '', undefined, 20)}<span>${esc(p.title)}</span></a>`)
          .join('')}</div>`,
    ).join('') +
    (admin
      ? `<div class="group dev" id="development"><h2>Development</h2>` +
        `<a href="/design/" target="_blank" rel="noopener"><span>Tracker</span><small>Admins</small></a>` +
        `<a href="/design/ui.html" target="_blank" rel="noopener"><span>UI Design System</span><small>Admins</small></a></div>`
      : '');
  markRail();
}

function markRail(): void {
  const r = resolve(location.hash.slice(1));
  const at = r ? (r.page.parent ?? r.page.path) : null;
  for (const a of rail.querySelectorAll<HTMLAnchorElement>('a[data-path]')) a.classList.toggle('on', a.dataset.path === at);
  rail.querySelector('a.on')?.scrollIntoView({ block: 'nearest' });
}

// ---------- the page ----------

let shown: Page | null = null;

function show(): void {
  const r = resolve(location.hash.slice(1));
  document.body.classList.remove('rail-open');
  closeHits();
  if (!r) {
    shown = null;
    document.title = 'Not Found · Ruina Bible';
    crumbs.innerHTML = `<a href="#/">Ruina</a>`;
    view.innerHTML = `<header class="head"><h1>Nothing Here</h1></header><p class="lede">There is no page at <code>${esc(location.hash)}</code>. Try searching for it.</p>`;
    pager.innerHTML = '';
    return;
  }
  const { page, anchor } = r;
  if (page !== shown) {
    shown = page;
    draw(page);
    window.scrollTo(0, 0);
  }
  markRail();
  if (anchor) document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
}

function draw(page: Page): void {
  document.title = page.path ? `${page.title} · Ruina Bible` : 'Ruina Bible';
  const parent = page.parent ? pageAt(page.parent) : undefined;
  crumbs.innerHTML = [
    `<a href="#/">Ruina</a>`,
    page.path ? `<span>${esc(sectionOf(page.section).title)}</span>` : '',
    parent ? `<a href="${href(parent.path)}">${esc(parent.title)}</a>` : '',
  ]
    .filter(Boolean)
    .join('<i>›</i>');
  let body: string;
  try {
    body = page.render();
  } catch (e) {
    console.error(`the bible could not draw #/${page.path}:`, e);
    body = `<p class="missing">This page could not be drawn from the game's data: ${esc(String(e))}</p>`;
  }
  const art = page.icon || page.itemId ? `<span class="art">${iconHtml(page.icon ?? '', page.itemId, 56)}</span>` : '';
  view.innerHTML =
    `<header class="head">${art}<div>${page.tag ? `<span class="tag">${esc(page.tag)}</span>` : ''}<h1>${esc(page.title)}</h1></div></header>` +
    (page.parent ? '' : `<p class="lede">${esc(page.summary)}</p>`) +
    body;
  try {
    page.mount?.(view);
  } catch (e) {
    console.error(`the bible could not finish drawing #/${page.path}:`, e);
  }
  drawPager(page);
}

/** The pages before and after this one in its list. */
function drawPager(page: Page): void {
  const list = page.parent ? PAGES.filter((p) => p.parent === page.parent) : listed(page.section);
  const i = list.indexOf(page);
  const prev = i > 0 ? list[i - 1] : null;
  const next = i >= 0 && i < list.length - 1 ? list[i + 1] : null;
  pager.innerHTML =
    (prev ? `<a class="prev" href="${href(prev.path)}"><small>Before</small>${esc(prev.title)}</a>` : '<span></span>') +
    (next ? `<a class="next" href="${href(next.path)}"><small>Next</small>${esc(next.title)}</a>` : '<span></span>');
}

// ---------- search ----------

let picked = 0;
let found: ReturnType<typeof find> = [];

function closeHits(): void {
  hits.hidden = true;
  hits.innerHTML = '';
  found = [];
}

function drawHits(): void {
  const text = q.value.trim();
  if (!text) return closeHits();
  found = find(text);
  picked = 0;
  hits.hidden = false;
  hits.innerHTML = found.length
    ? found
        .map(
          (h, i) =>
            `<a href="${href(h.page.path)}" class="${i === picked ? 'on' : ''}" data-i="${i}">` +
            `<b>${esc(h.page.title)}</b><small>${esc(h.page.tag ?? sectionOf(h.page.section).title)}</small><span>${h.snippet}</span></a>`,
        )
        .join('')
    : `<p class="none">Nothing in the bible matches “${esc(text)}”.</p>`;
}

function pick(i: number): void {
  if (!found.length) return;
  picked = (i + found.length) % found.length;
  hits.querySelectorAll('a').forEach((a, j) => a.classList.toggle('on', j === picked));
  hits.querySelectorAll('a')[picked]?.scrollIntoView({ block: 'nearest' });
}

q.addEventListener('input', drawHits);
q.addEventListener('focus', () => {
  warmSearch();
  if (q.value.trim()) drawHits();
});
q.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') pick(picked + 1);
  else if (e.key === 'ArrowUp') pick(picked - 1);
  else if (e.key === 'Enter' && found[picked]) {
    location.hash = href(found[picked].page.path);
    q.blur();
  } else if (e.key === 'Escape') {
    closeHits();
    q.blur();
  } else return;
  e.preventDefault();
});
hits.addEventListener('mousedown', (e) => e.preventDefault()); // keep the box focused until the link is followed
hits.addEventListener('click', () => {
  q.value = '';
  closeHits();
});
// A click on a result keeps the box focused (above), so leaving the box always means leaving the results.
q.addEventListener('blur', closeHits);
addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (e.key === '/' && !typing) {
    e.preventDefault();
    q.focus();
  }
});

// ---------- small screens ----------

$('#menu').addEventListener('click', () => document.body.classList.toggle('rail-open'));

// ---------- start ----------

/**
 * Whether to show the Development tab: the tracker and the UI design system are admins' pages
 * (the server sends /design/ to admins only), so the bible asks the server who is signed in. With
 * no game server to ask, the development server (npm run dev), which sends those pages to anyone,
 * shows it.
 */
async function isAdmin(): Promise<boolean> {
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin' });
    if (r.status === 401 || r.status === 403) return false;
    if (!r.ok) return import.meta.env.DEV;
    // Signed out, the server answers null.
    const me = (await r.json()) as { admin?: boolean } | null;
    return me?.admin === true;
  } catch {
    return import.meta.env.DEV;
  }
}

drawRail(false);
addEventListener('hashchange', show);
show();
void isAdmin().then((admin) => {
  if (admin) drawRail(true);
  document.documentElement.dataset.admin = String(admin);
});

declare global {
  interface Window {
    /** For the tests (tests/integration/bible.spec.ts): every page's address and title. */
    __bible?: { pages: Array<{ path: string; title: string }> };
  }
}
window.__bible = { pages: PAGES.map((p) => ({ path: p.path, title: p.title })) };
document.documentElement.dataset.ready = 'true';
