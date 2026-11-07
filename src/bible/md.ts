// The bible's prose: a little Markdown, written in md`` templates with the game's numbers put in
// where the text has a ${placeholder}. No number is ever typed into prose by hand: the completeness
// test (tests/unit/bible.test.ts) reads the literal text of every page and fails on a digit outside
// a `code span` or a $$ formula $$, so a number can only come from the content, the tuning or the
// rules, and changes when they do.
//
//   ## Heading, ### Smaller heading           (each gets an anchor; the page lists its ## headings)
//   - a list item, 1. a numbered one           (a line that follows an item carries it on)
//   | a | table | row |, with |---| under the head row
//   > a note set apart from the text
//   $$ on a line of its own, then the lines of a formula, then $$ again
//   **bold**, *italic*, `code`, [[systems/combat]] or [[items/seed.barley|barley seeds]] for a page
//   of the bible, [text](https://…) for anywhere else

import { esc } from '../util/html';

/** HTML to put in as it is: a value already formatted, a link, a table. */
export class Html {
  constructor(
    readonly html: string,
    /** A block (a table, a figure) stands on its own rather than inside a paragraph. */
    readonly block = false,
  ) {}
  toString(): string {
    return this.html;
  }
}

export const raw = (html: string): Html => new Html(html);
export const blockHtml = (html: string): Html => new Html(html, true);

/** What a placeholder can hold: HTML as it is, text (escaped), a number (formatted), or nothing. */
export type Value = Html | string | number | null | undefined;

const MARK = '\u0000';
const STASH = '\u0001';

/** A number as prose shows it: thousands grouped, at most `digits` decimals, no trailing zeros. */
export function plainNumber(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return String(n);
  const s = Math.abs(n).toLocaleString('en-GB', { maximumFractionDigits: digits });
  return n < 0 && s !== '0' ? `−${s}` : s;
}

export function valueHtml(v: Value): string {
  if (v instanceof Html) return v.html;
  if (typeof v === 'number') return `<span class="v">${plainNumber(v)}</span>`;
  return esc(v ?? '');
}

// ---------- links between pages ----------

type Linker = (path: string, label: string | null) => string;

/** How a link to another page is drawn; the site sets it once it knows every page (site.ts). */
let linker: Linker = (path, label) => esc(label ?? path);
export function setLinker(fn: Linker): void {
  linker = fn;
}

/** A link to a page of the bible: `items/seed.barley`, `systems/combat`, or with an anchor after a third slash. */
export const link = (path: string, label?: string | null): Html => raw(linker(path, label ?? null));

// ---------- listening to the prose, for the completeness test ----------

let heard: string[] | null = null;

/** Starts or stops keeping the literal text of every md`` rendered from now on; returns what was kept. */
export function listenToProse(on: boolean): string[] {
  const kept = heard ?? [];
  heard = on ? [] : null;
  return kept;
}

/**
 * The parts of prose that may hold digits: `code`, $$ formulas $$, a numbered list's own numbers,
 * the address in a link. Whatever is left must have none.
 */
export function proseWithoutCode(text: string): string {
  return text
    .replace(/\$\$[\s\S]*?(\$\$|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^\s*\d+\.\s/gm, ' ')
    .replace(/\[\[[^\]|]*\|?/g, ' ')
    .replace(/\]\([^)\s]*\)/g, ' ');
}

// ---------- the renderer ----------

/** Prose with the game's numbers in it. */
export function md(strings: TemplateStringsArray, ...values: Value[]): Html {
  if (heard) heard.push(strings.join(' '));
  let text = strings[0];
  for (let i = 0; i < values.length; i++) text += MARK + i + MARK + strings[i + 1];
  return blockHtml(render(text, values));
}

/** A piece of a sentence, to put inside other prose or a table: bold, links and values, no paragraphs. */
export function phrase(strings: TemplateStringsArray, ...values: Value[]): Html {
  if (heard) heard.push(strings.join(' '));
  let text = strings[0];
  for (let i = 0; i < values.length; i++) text += MARK + i + MARK + strings[i + 1];
  return raw(inline(text, values));
}

/**
 * Prose from a file (the notes on things, src/bible/notes/): the same Markdown, no placeholders.
 * `authored` is false for text the content holds (an item's description), whose numbers are the
 * content's own.
 */
export function mdText(text: string, authored = true): Html {
  if (heard && authored) heard.push(text);
  return blockHtml(render(text, []));
}

/** A heading's anchor: its words, lower case, joined by dashes. */
export const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z]+;/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '');

function render(text: string, values: Value[]): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  let rows: string[][] | null = null;
  let quote: string[] | null = null;
  let formula: string[] | null = null;
  const line = (s: string) => inline(s, values);

  const flush = () => {
    if (para.length) {
      const body = para.join(' ');
      // A paragraph that is a single block placeholder (a table, a figure) stands on its own.
      const only = new RegExp(`^${MARK}(\\d+)${MARK}$`).exec(body);
      const v = only ? values[+only[1]] : undefined;
      out.push(v instanceof Html && v.block ? v.html : `<p>${line(body)}</p>`);
      para = [];
    }
    if (list) {
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${line(i)}</li>`).join('')}</${list.tag}>`);
      list = null;
    }
    if (rows) {
      out.push(table(rows, line));
      rows = null;
    }
    if (quote) {
      out.push(`<aside class="note">${quote.map((q) => `<p>${line(q)}</p>`).join('')}</aside>`);
      quote = null;
    }
  };

  for (const rawLine of text.split('\n')) {
    const l = rawLine.trim();
    if (formula) {
      if (l === '$$') {
        out.push(`<div class="formula">${formula.map((f) => `<div>${line(f)}</div>`).join('')}</div>`);
        formula = null;
      } else if (l) formula.push(l);
      continue;
    }
    if (l === '$$') {
      flush();
      formula = [];
      continue;
    }
    if (!l) {
      flush();
      continue;
    }
    const h = /^(#{2,4})\s+(.*)$/.exec(l);
    if (h) {
      flush();
      const n = h[1].length;
      const inner = line(h[2]);
      out.push(`<h${n} id="${slug(inner)}">${inner}</h${n}>`);
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(l);
    const ol = /^\d+\.\s+(.*)$/.exec(l);
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol';
      if (para.length || rows || quote || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push((ul ?? ol)![1]);
      continue;
    }
    if (l.startsWith('|')) {
      if (!rows) flush();
      rows ??= [];
      rows.push(
        l
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim()),
      );
      continue;
    }
    if (l.startsWith('>')) {
      if (!quote) flush();
      quote ??= [];
      quote.push(l.replace(/^>\s?/, ''));
      continue;
    }
    if (list) {
      list.items[list.items.length - 1] += ' ' + l;
      continue;
    }
    if (rows || quote) flush();
    para.push(l);
  }
  if (formula) out.push(`<div class="formula">${(formula as string[]).map((f) => `<div>${line(f)}</div>`).join('')}</div>`);
  flush();
  return out.join('\n');
}

function table(rows: string[][], line: (s: string) => string): string {
  const sep = rows.findIndex((r) => r.every((c) => /^:?-+:?$/.test(c)));
  const head = sep > 0 ? rows.slice(0, sep) : [];
  const body = sep >= 0 ? rows.slice(sep + 1) : rows;
  // A cell of nothing but values and figures lines up on the right.
  const num = (c: string) => c.includes(MARK) && /^[\s\d.,%×+−-]*$/.test(c.split(MARK).join(''));
  return (
    '<div class="table"><table>' +
    (head.length ? `<thead>${head.map((r) => `<tr>${r.map((c) => `<th>${line(c)}</th>`).join('')}</tr>`).join('')}</thead>` : '') +
    `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td${num(c) ? ' class="n"' : ''}>${line(c)}</td>`).join('')}</tr>`).join('')}</tbody>` +
    '</table></div>'
  );
}

/** Bold, italic, code, links and the values, in a line of prose. */
function inline(text: string, values: Value[]): string {
  const stash: string[] = [];
  const keep = (html: string) => STASH + (stash.push(html) - 1) + STASH;
  let h = esc(text);
  h = h.replace(/`([^`]+)`/g, (_, c: string) => keep(`<code>${c}</code>`));
  h = h.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, path: string, label: string | undefined) =>
    keep(linker(path.trim(), label === undefined ? null : unescapeHtml(label.trim()))),
  );
  h = h.replace(/\[([^\]]+)\]\((https?:[^)\s]+|\/[^)\s]*)\)/g, (_, t: string, url: string) => keep(`<a href="${url}" target="_blank" rel="noopener">${t}</a>`));
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\w)/g, '$1<i>$2</i>');
  h = h.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_, i: string) => valueHtml(values[+i]));
  return h.replace(new RegExp(`${STASH}(\\d+)${STASH}`, 'g'), (_, i: string) => inlineValues(stash[+i], values));
}

/** Values inside a code span or a link's label. */
const inlineValues = (html: string, values: Value[]): string => html.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_, i: string) => valueHtml(values[+i]));

/** A link label arrives escaped; the linker escapes it again. */
const unescapeHtml = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
