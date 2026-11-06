// Every page of the bible, in the order the navigation lists them: what Ruina is, the systems, the
// world and the things in it. Pages are made when this module loads, from the content as it is;
// each is drawn when it is shown, so its numbers are always the game's.

import { esc } from '../util/html';
import { ABOUT } from './about';
import type { KindDef, SectionId, SystemDef } from './kit';
import { type Html, setLinker, slug } from './md';
import { iconHtml } from '../ui/theme/icons';
import { SYSTEMS } from './systems';
import { KINDS } from './things';

export interface Section {
  id: SectionId;
  title: string;
  summary: string;
}

export const SECTIONS: readonly Section[] = [
  { id: 'ruina', title: 'Ruina', summary: 'What the game is, how to play it, and how to read this book.' },
  { id: 'systems', title: 'Systems', summary: 'How each part of the game works, exactly: its rules, formulas and numbers.' },
  { id: 'world', title: 'The World', summary: 'The island, its places, its people and the creatures that live there.' },
  { id: 'things', title: 'Things', summary: 'Everything you can hold, grow, ride, learn or do, each with its numbers.' },
];

export interface Page {
  /** Its address after #/: '' for the front page, systems/combat, items, items/seed.barley. */
  path: string;
  title: string;
  section: SectionId;
  /** One sentence. */
  summary: string;
  icon?: string;
  itemId?: string;
  keywords: string[];
  /** The page it belongs under (an entry's kind), for the trail at the top. */
  parent?: string;
  /** What it is, shown beside the title: System, Item, Crop. */
  tag?: string;
  system?: SystemDef;
  kind?: KindDef<unknown>;
  /** The page's own HTML, without its title. */
  render: () => string;
  /** Draws what needs the page (a map) once its HTML is in place, in the browser only. */
  mount?: (root: HTMLElement) => void;
}

type AnyKind = KindDef<any>;

const pages: Page[] = [];
const byPath = new Map<string, Page>();
const add = (p: Page) => {
  if (byPath.has(p.path)) throw new Error(`the bible has two pages at #/${p.path}`);
  pages.push(p);
  byPath.set(p.path, p);
};

for (const a of ABOUT)
  add({
    path: a.id === 'overview' ? '' : `ruina/${a.id}`,
    title: a.title,
    section: 'ruina',
    summary: a.summary,
    icon: a.icon,
    keywords: a.keywords ?? [],
    render: () => a.body().html,
    mount: a.mount,
  });

for (const s of SYSTEMS)
  add({
    path: `systems/${s.id}`,
    title: s.title,
    section: 'systems',
    summary: s.summary,
    icon: s.icon,
    keywords: s.keywords ?? [],
    tag: 'System',
    system: s,
    render: () => systemHtml(s),
    mount: s.mount,
  });

for (const k of KINDS as AnyKind[]) {
  add({
    path: k.id,
    title: k.title,
    section: k.section,
    summary: k.summary,
    icon: k.icon,
    keywords: [],
    kind: k,
    render: () => indexHtml(k),
  });
  for (const t of k.all())
    add({
      path: `${k.id}/${k.key(t)}`,
      title: k.name(t),
      section: k.section,
      summary: k.line(t),
      icon: k.iconOf?.(t),
      itemId: k.itemId?.(t),
      keywords: [k.key(t), k.noun],
      parent: k.id,
      tag: k.noun,
      kind: k,
      render: () => entryHtml(k, t),
      mount: k.mount ? (root) => k.mount!(t, root) : undefined,
    });
}

export const PAGES: readonly Page[] = pages;

/** The page at a path, if there is one. */
export const pageAt = (path: string): Page | undefined => byPath.get(path);

/** A path as the address bar has it: the page, and an anchor on it after a further slash. */
export function resolve(path: string): { page: Page; anchor: string | null } | null {
  const clean = path.replace(/^#?\/?/, '').replace(/\/$/, '');
  const exact = byPath.get(clean);
  if (exact) return { page: exact, anchor: null };
  const cut = clean.lastIndexOf('/');
  if (cut < 0) return null;
  const page = byPath.get(clean.slice(0, cut));
  return page ? { page, anchor: decodeURIComponent(clean.slice(cut + 1)) } : null;
}

export const href = (path: string): string => `#/${path}`;

// ---------- links ----------

const dead = new Set<string>();

/** Links to pages that don't exist, found while drawing pages: the completeness test wants none. */
export const deadLinks = (): string[] => [...dead];

setLinker((path, label) => {
  const r = resolve(path);
  if (!r) {
    dead.add(path);
    return `<span class="dead" title="No page at ${esc(path)}">${esc(label ?? path)}</span>`;
  }
  return `<a href="${href(path)}">${esc(label ?? r.page.title)}</a>`;
});

// ---------- drawing pages ----------

export const sectionOf = (id: SectionId): Section => SECTIONS.find((s) => s.id === id)!;

/** The ## headings of a page's HTML, for its list of contents. */
export function headings(html: string): Array<{ id: string; text: string }> {
  return [...html.matchAll(/<h2 id="([^"]*)">([\s\S]*?)<\/h2>/g)].map((m) => ({ id: m[1], text: m[2].replace(/<[^>]+>/g, '') }));
}

function systemHtml(s: SystemDef): string {
  const body = s.body().html;
  const toc = headings(body);
  return (
    (toc.length > 2
      ? `<nav class="toc" aria-label="On this page"><b>On This Page</b>${toc.map((h) => `<a href="${href(`systems/${s.id}/${h.id}`)}">${h.text}</a>`).join('')}</nav>`
      : '') +
    body +
    `<footer class="sources"><b>Written from</b> ${s.rules.map((r) => `<code>${esc(r)}</code>`).join(' ')}${
      s.content.length ? `<br><b>Numbers from</b> ${s.content.map((c) => `<code>${esc(c)}</code>`).join(' ')}` : ''
    }</footer>`
  );
}

function indexHtml(k: AnyKind): string {
  const all = k.all();
  const groups = new Map<string, unknown[]>();
  for (const t of all) {
    const g = k.group?.(t) ?? '';
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  const cols = k.columns ?? [];
  const tableOf = (things: unknown[]) =>
    '<div class="table"><table><thead><tr><th>' +
    esc(k.noun) +
    '</th>' +
    cols.map(([h]) => `<th>${esc(h)}</th>`).join('') +
    '</tr></thead><tbody>' +
    things
      .map(
        (t) =>
          `<tr><td class="name"><a href="${href(`${k.id}/${k.key(t)}`)}">${iconHtml(k.iconOf?.(t) ?? '', k.itemId?.(t), 22)}<span>${esc(k.name(t))}</span></a></td>` +
          cols.map(([, f]) => `<td>${cell(f(t))}</td>`).join('') +
          '</tr>',
      )
      .join('') +
    '</tbody></table></div>';
  return (
    `<p class="count">${all.length} ${esc(all.length === 1 ? k.noun.toLowerCase() : k.title.toLowerCase())}.</p>` +
    [...groups.entries()].map(([g, things]) => (g ? `<h2 id="${slug(g)}">${esc(g)}</h2>` : '') + tableOf(things)).join('') +
    systemsLine(k)
  );
}

const cell = (v: unknown): string => (v && typeof v === 'object' && 'html' in v ? (v as Html).html : esc(v ?? ''));

function systemsLine(k: AnyKind): string {
  const links = k.systems.map((id) => {
    const p = byPath.get(`systems/${id}`);
    if (!p) dead.add(`systems/${id}`);
    return p ? `<a href="${href(p.path)}">${esc(p.title)}</a>` : esc(id);
  });
  return links.length ? `<p class="how">How they work: ${links.join(', ')}.</p>` : '';
}

function entryHtml(k: AnyKind, t: unknown): string {
  const explained = k.explain(t);
  const facts = k.facts?.(t) ?? [];
  const factsHtml = facts.filter(([, v]) => v !== null && v !== undefined && v !== '');
  const body = k.body?.(t);
  return (
    '<div class="entry">' +
    `<div class="explain">${explained ? explained.html : '<p class="missing">No one has written about this yet.</p>'}</div>` +
    (factsHtml.length ? `<dl class="facts">${factsHtml.map(([label, v]) => `<dt>${esc(label)}</dt><dd>${cell(v)}</dd>`).join('')}</dl>` : '') +
    '</div>' +
    (body ? body.html : '') +
    systemsLine(k)
  );
}

/** A page as text, for searching it. */
export const pageText = (p: Page): string =>
  p
    .render()
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
