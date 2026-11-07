// Searching the bible: every page's title, summary and text, read the first time someone searches.

import { esc } from '../util/html';
import { type Page, PAGES, pageText } from './site';

interface Doc {
  page: Page;
  title: string;
  summary: string;
  keys: string;
  /** The page's own search words, each whole: one asked for exactly ranks it with a title's. */
  words: Set<string>;
  text: string;
}

let docs: Doc[] | null = null;

function index(): Doc[] {
  docs ??= PAGES.map((page) => ({
    page,
    title: page.title.toLowerCase(),
    summary: page.summary.toLowerCase(),
    keys: page.keywords.join(' ').toLowerCase(),
    words: new Set(page.keywords.map((k) => k.toLowerCase())),
    text: pageText(page),
  }));
  return docs;
}

export interface Hit {
  page: Page;
  /** A little of the text round the first word found, the words marked, as HTML. */
  snippet: string;
}

const startsWord = (hay: string, term: string): boolean => new RegExp(`(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(hay);

/** Starts searching ahead of the first query: the index is made from every page's text. */
export const warmSearch = (): void => void index();

/** The pages that have every word of `query`, best first. */
export function find(query: string, limit = 12): Hit[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!terms.length) return [];
  const scored: Array<{ doc: Doc; score: number }> = [];
  for (const doc of index()) {
    const lower = doc.text.toLowerCase();
    let score = 0;
    let all = true;
    for (const t of terms) {
      let s = 0;
      if (startsWord(doc.title, t)) s += 12;
      else if (doc.title.includes(t)) s += 6;
      if (doc.words.has(t)) s += 10;
      else if (startsWord(doc.keys, t)) s += 5;
      if (startsWord(doc.summary, t)) s += 3;
      if (startsWord(lower, t)) s += 1 + Math.min(3, lower.split(t).length - 1) * 0.2;
      else if (lower.includes(t)) s += 0.5;
      if (!s) {
        all = false;
        break;
      }
      score += s;
    }
    if (!all) continue;
    if (doc.title === query.toLowerCase().trim()) score += 20;
    // Systems explain; entries list. A tie goes to the explanation, then to the shorter title.
    if (doc.page.section === 'systems') score += 1;
    scored.push({ doc, score });
  }
  scored.sort((a, b) => b.score - a.score || a.doc.title.length - b.doc.title.length);
  return scored.slice(0, limit).map(({ doc }) => ({ page: doc.page, snippet: snippet(doc.text, terms) }));
}

function snippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), text.length);
  const from = Math.max(0, at - 50);
  const piece = (from ? '…' : '') + text.slice(from, from + 140) + (from + 140 < text.length ? '…' : '');
  const words = new RegExp(terms.map((t) => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  return esc(piece).replace(words, (m) => `<mark>${m}</mark>`);
}
