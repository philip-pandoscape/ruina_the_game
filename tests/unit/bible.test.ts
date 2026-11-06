import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import type { KindDef } from '../../src/bible/kit';
import { listenToProse, proseWithoutCode } from '../../src/bible/md';
import { allNotes } from '../../src/bible/notes';
import { find } from '../../src/bible/search';
import { deadLinks, PAGES, pageAt, SECTIONS } from '../../src/bible/site';
import { SYSTEMS } from '../../src/bible/systems';
import { KINDS } from '../../src/bible/things';
import { isTitleCase } from '../../src/ui/theme/text';

// The bible (/bible/, src/bible/) is complete: every system of the game has its page, every rules
// file is explained by one, every key of every content file is drawn on by a system or a kind of
// thing, and every thing has its entry and an explanation. Content or rules added without their
// place in the bible fail here, with what to write and where. The page in a browser:
// tests/integration/bible.spec.ts.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, '/');

function files(dir: string, ext: string): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    const p = join(abs, name);
    if (statSync(p).isDirectory()) out.push(...files(rel(p), ext));
    else if (name.endsWith(ext)) out.push(rel(p));
  }
  return out;
}

/** The systems the game has, each of which must have its page (.plans/refactor, R12.3). */
const REQUIRED_SYSTEMS = [
  'moving',
  'swimming-gliding',
  'combat',
  'skills',
  'creatures',
  'farming',
  'livestock',
  'trade',
  'contracts',
  'housing',
  'vehicles',
  'quests',
  'weather',
  'world',
  'parties',
  'minigames',
  'economy',
];

/** Where the rules live: every file here is a system's, and its page says so in `rules`. */
const RULES = [
  ...files('src/sim', '.ts'),
  'src/content/skills.ts',
  'src/content/build.ts',
  ...files('crates/engine/src', '.rs'),
  ...files('crates/server/src/play', '.rs'),
  'crates/server/src/combat.rs',
];

/** Rules files no player meets, by name: the bots that fill the developer zones (.plans/refactor, Phase 10), and the checks the tests run the rules through. */
const PLUMBING_NAMES: Array<[RegExp, string]> = [
  [/^crates\/.*\/bots\.rs$/, 'bots for the developer zones, which no player meets yet'],
  [/^crates\/engine\/src\/checks\//, 'the rules run through the conformance checks’ scenarios, for the tests'],
];

/** Rules files that hold no rule a player meets, with why. */
const PLUMBING: Record<string, string> = {
  'src/sim/math.ts': 'angles and lengths, used by every system',
  'src/sim/types.ts': 'the shapes of the rules’ state',
  'src/sim/zone/types.ts': 'the shape of a zone recipe',
  'crates/engine/src/lib.rs': 'the engine crate’s table of contents',
  'crates/engine/src/jsmath.rs': 'the browser’s maths, to the bit, so both sides agree',
  'crates/engine/src/rng.rs': 'the seeded random numbers both sides share',
  'crates/engine/src/content.rs': 'reads the content files for the engine',
  'crates/engine/src/creatures.rs': 'lists the creature files in the browser’s order',
  'crates/engine/src/life/content.rs': 'reads the island’s content files for the engine',
  'crates/server/src/play/mod.rs': 'runs a channel: the rules above, fed from players’ inputs',
  'crates/server/src/play/socket.rs': 'a player’s connection to the server',
  'crates/server/src/play/channels.rs': 'who is in which channel',
  // The developer zones, which only admins enter: no player reads about them.
  'src/sim/yard.ts': 'the training yard’s and the battlefield’s grounds, developer zones',
  'src/sim/training.ts': 'the training yard’s stand-in for the server, a developer zone',
  'crates/engine/src/world.rs': 'the battlefield’s ground, a developer zone',
};

/** Keys of the content files that hold nothing a player meets, with why. */
const NOT_EXPLAINED: Record<string, string> = {
  'shared/buildings.json#furniture': 'the furniture catalogue: each building’s entry lists its pieces',
};

const claimed = (path: string, claims: string[]) => claims.some((c) => path === c || (c.endsWith('/') && path.startsWith(c)));

test('every system of the game has its page, written', () => {
  const ids = SYSTEMS.map((s) => s.id);
  expect(ids, 'a page per system').toEqual(expect.arrayContaining(REQUIRED_SYSTEMS));
  for (const s of SYSTEMS) {
    const text = pageAt(`systems/${s.id}`)!.render();
    expect(text, `systems/${s.id} is still a stub`).not.toContain('still being written');
    expect(text.replace(/<[^>]+>/g, '').length, `systems/${s.id} says enough`).toBeGreaterThan(1500);
  }
});

test('every rules file is explained by a system page, and every file a page names exists', () => {
  const claims = SYSTEMS.flatMap((s) => s.rules);
  const unclaimed = RULES.filter((f) => !claimed(f, claims) && !PLUMBING[f] && !PLUMBING_NAMES.some(([name]) => name.test(f)));
  expect(unclaimed, 'rules no system page explains: add them to a page’s `rules` (src/bible/systems/), or to PLUMBING here if no player meets them').toEqual(
    [],
  );
  const missing = [...claims, ...Object.keys(PLUMBING)].filter((f) => !existsSync(join(ROOT, f)));
  expect(missing, 'rules files named that are gone').toEqual([]);
});

test('every key of every content file is drawn on by a system or a kind of thing', () => {
  const keys: string[] = [];
  for (const f of files('shared', '.json')) {
    const data = JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as Record<string, unknown>;
    // A file in a folder of its own kind (zones, dungeons, creatures) stands for all of them.
    const name = /^shared\/[^/]+\//.test(f) ? f.replace(/[^/]+\.json$/, '*.json') : f;
    for (const k of Object.keys(data)) if (k !== 'comment') keys.push(`${name}#${k}`);
  }
  const claims = [...SYSTEMS.flatMap((s) => s.content), ...KINDS.flatMap((k) => k.sources), ...Object.keys(NOT_EXPLAINED)];
  const covered = (key: string) => claims.some((c) => c === key || (!c.includes('#') && key.startsWith(`${c}#`)));
  const unclaimed = [...new Set(keys)].filter((k) => !covered(k));
  expect(unclaimed, 'content no page draws on: name it in a system’s `content` or a kind’s `sources` (src/bible/)').toEqual([]);
  const stale = claims.filter((c) => (c.includes('#') ? !keys.includes(c) : !keys.some((k) => k.startsWith(`${c}#`))));
  expect(stale, 'content named that is gone').toEqual([]);
});

test('every thing has its entry and an explanation', () => {
  const holes: string[] = [];
  for (const k of KINDS as ReadonlyArray<KindDef<any>>) {
    expect(pageAt(k.id), `${k.id} has an index`).toBeTruthy();
    for (const t of k.all()) {
      const id = k.key(t);
      if (!pageAt(`${k.id}/${id}`)) holes.push(`${k.id}/${id}: no entry`);
      const words = k
        .explain(t)
        ?.html.replace(/<[^>]+>/g, '')
        .trim();
      if (!words) holes.push(`${k.id}/${id}: no explanation; write one under "## ${id}" in src/bible/notes/${k.id}.md`);
    }
  }
  expect(holes).toEqual([]);
});

test('every note is about a thing that exists', () => {
  const orphans: string[] = [];
  for (const [kindId, notes] of allNotes()) {
    const k = KINDS.find((x) => x.id === kindId);
    if (!k) {
      orphans.push(`src/bible/notes/${kindId}.md: no kind of thing is called ${kindId}`);
      continue;
    }
    const ids = new Set(k.all().map((t) => k.key(t)));
    for (const id of notes.keys()) if (!ids.has(id)) orphans.push(`src/bible/notes/${kindId}.md: no ${k.noun.toLowerCase()} "${id}"`);
  }
  expect(orphans).toEqual([]);
});

test('every page draws from the game data, its links lead somewhere, and no number is typed into its prose', () => {
  const broken: string[] = [];
  const typed: string[] = [];
  for (const p of PAGES) {
    listenToProse(true);
    let html = '';
    try {
      html = p.render();
    } catch (e) {
      broken.push(`#/${p.path}: ${String(e)}`);
    }
    const prose = listenToProse(false);
    const text = html.replace(/<[^>]+>/g, ' ');
    if (/\bundefined\b|\bNaN\b|\[object |Infinity/.test(text))
      broken.push(`#/${p.path}: ${/.{0,50}(undefined|NaN|\[object |Infinity).{0,30}/.exec(text)?.[0]}`);
    for (const t of prose) {
      const digits = /.{0,30}\d.{0,30}/.exec(proseWithoutCode(t).replace(/\s+/g, ' '));
      if (digits) typed.push(`#/${p.path}: “${digits[0].trim()}”`);
    }
  }
  expect(broken, 'pages that could not be drawn').toEqual([]);
  expect(deadLinks(), 'links to pages that do not exist').toEqual([]);
  expect([...new Set(typed)], 'numbers typed into prose: take them from the content or the rules (src/bible/format.ts)').toEqual([]);
});

test('titles and headings are in Title Case, summaries are sentences', () => {
  const wrong: string[] = [];
  const own = PAGES.filter((p) => !p.parent);
  for (const s of SECTIONS) if (!isTitleCase(s.title)) wrong.push(`section ${s.title}`);
  for (const p of own) {
    if (!isTitleCase(p.title)) wrong.push(`#/${p.path} title “${p.title}”`);
    if (!/^[\p{Lu}\d]/u.test(p.summary) || !/[.!?]$/.test(p.summary)) wrong.push(`#/${p.path} summary “${p.summary}”`);
  }
  for (const p of PAGES) {
    for (const m of p.render().matchAll(/<(h[2-4]|th)[^>]*>([\s\S]*?)<\/\1>/g)) {
      const words = m[2]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .trim();
      if (words && !isTitleCase(words)) wrong.push(`#/${p.path} <${m[1]}> “${words}”`);
    }
  }
  expect([...new Set(wrong)]).toEqual([]);
});

test('search finds a thing by its name, and a system by what it covers', () => {
  expect(find('barley').map((h) => h.page.path)).toContain('crops/barley');
  expect(
    find('glider')
      .slice(0, 5)
      .map((h) => h.page.path),
  ).toContain('systems/swimming-gliding');
  expect(find('zzzz-no-such-thing')).toEqual([]);
});
