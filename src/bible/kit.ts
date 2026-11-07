// What the bible's pages are made of: a system page (src/bible/systems/), a kind of thing with an
// entry for each piece of content (src/bible/things/), and the builders they draw tables and fact
// boxes with. Pages import from here, md.ts and format.ts; site.ts gathers them all.

import { esc } from '../util/html';
import { iconHtml } from '../ui/theme/icons';
import { blockHtml, type Html, mdText, raw, type Value, valueHtml } from './md';
import { noteFor } from './notes';

export type SectionId = 'ruina' | 'systems' | 'world' | 'things';

/** A page about how part of the game works, written from its rules. */
export interface SystemDef {
  /** Its address: #/systems/<id>. */
  id: string;
  /** Title Case. */
  title: string;
  /** One sentence: what it covers. */
  summary: string;
  icon?: string;
  /**
   * The rules it explains, as paths from the repository's root: files or folders, in TypeScript and
   * Rust. Every rules file must be claimed by a system (tests/unit/bible.test.ts), so a new system
   * can't arrive without its page.
   */
  rules: string[];
  /**
   * The content and tuning it explains, as `file#key` (`shared/tuning.json#jump`). Every key of every
   * content file must be claimed by a system or a kind of thing.
   */
  content: string[];
  /** Words people might search for that the page may not use. */
  keywords?: string[];
  body: () => Html;
  /** Draws what needs the page (a map, a calculator) once its HTML is in place, in the browser only. */
  mount?: (root: HTMLElement) => void;
}

/** A kind of thing in the game (items, crops, creatures...): an index page and an entry for each. */
export interface KindDef<T> {
  /** Its address: #/<id> for the index, #/<id>/<thing's id> for an entry. */
  id: string;
  section: 'world' | 'things';
  /** Title Case, plural: Items, Crops. */
  title: string;
  /** What one of them is called: Item, Crop. */
  noun: string;
  summary: string;
  icon?: string;
  /** The content files and keys it draws its things from, as `file#key`. */
  sources: string[];
  /** The systems that explain how its things work. */
  systems: string[];
  all: () => readonly T[];
  key: (t: T) => string;
  name: (t: T) => string;
  /** An emoji the game paints an icon for. */
  iconOf?: (t: T) => string | undefined;
  /** The game's item id, for an item with a picture of its own. */
  itemId?: (t: T) => string | undefined;
  /** A heading to list it under on the index page. */
  group?: (t: T) => string;
  /** One line about it, for lists and search: a sentence. */
  line: (t: T) => string;
  /**
   * What it is and what it's for, in words: its own description in the content where it has one,
   * a note in src/bible/notes/<kind>.md otherwise, or words made from its data. Null is a hole the
   * completeness test reports.
   */
  explain: (t: T) => Html | null;
  /** Its numbers, in a box beside the explanation. */
  facts?: (t: T) => Array<[string, Value]>;
  /** The rest of its entry: tables, what it's made from, where it's used. */
  body?: (t: T) => Html | null;
  /** Draws what needs the page (a map) once the entry's HTML is in place, in the browser only. */
  mount?: (t: T, root: HTMLElement) => void;
  /** Columns for the index page's table, after the name. */
  columns?: Array<[string, (t: T) => Value]>;
}

/** A page of its own in the first section (what Ruina is, the controls, how to read the numbers). */
export interface AboutDef {
  id: string;
  title: string;
  summary: string;
  icon?: string;
  keywords?: string[];
  body: () => Html;
  mount?: (root: HTMLElement) => void;
}

export const system = (def: SystemDef): SystemDef => def;
export const kind = <T>(def: KindDef<T>): KindDef<T> => def;
export const about = (def: AboutDef): AboutDef => def;

// ---------- builders ----------

/** A table: a Title Case heading per column, a row per thing. Columns named in `numeric` line up right. */
export function table(head: string[], rows: Value[][], numeric: number[] = []): Html {
  const cls = (i: number) => (numeric.includes(i) ? ' class="n"' : '');
  return blockHtml(
    '<div class="table"><table><thead><tr>' +
      head.map((h, i) => `<th${cls(i)}>${esc(h)}</th>`).join('') +
      '</tr></thead><tbody>' +
      rows.map((r) => '<tr>' + r.map((c, i) => `<td${cls(i)}>${valueHtml(c)}</td>`).join('') + '</tr>').join('') +
      '</tbody></table></div>',
  );
}

/** A figure (a chart, a map) with a caption under it. */
export const figure = (inner: string, caption: Html | string): Html =>
  blockHtml(`<figure>${inner}<figcaption>${caption instanceof Object ? caption.html : esc(caption)}</figcaption></figure>`);

/** Html pieces one after another. */
export const join = (...parts: Array<Html | null | undefined | false>): Html =>
  blockHtml(
    parts
      .filter((p): p is Html => !!p)
      .map((p) => p.html)
      .join('\n'),
  );

/** A painted icon for an emoji (or an item's own picture), at `px`. */
export const icon = (emoji: string | undefined, itemId?: string, px = 24): Html => raw(emoji ? iconHtml(emoji, itemId, px) : '');

/** The note on a thing (src/bible/notes/<kind>.md, under ## <id>), as prose, or null if it has none. */
export function note(kindId: string, id: string): Html | null {
  const text = noteFor(kindId, id);
  return text ? mdText(text) : null;
}

/** A description from the content, as prose, or null when it is missing or empty. It is the content's own text, so its numbers are too. */
export const described = (text: string | undefined | null): Html | null => (text?.trim() ? mdText(text.trim(), false) : null);
