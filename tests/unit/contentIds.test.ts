import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { contentIds, type Hit, rustStrings, scan, tsStrings } from '../../tools/content/ids.mjs';

// No content id in code (.plans/refactor R9.12). The code knows kinds of thing and what each kind
// can do; the content (content/, built into shared/) names the things. A string in the code that is
// the id of one item, person, place, quest, vehicle or creature ties the code to that one thing, so
// the next of its kind would need code too. tools/content/ids.mjs finds every one (a string literal
// or a table's key, in src/ and in crates/ outside its tests; `node tools/content/ids.mjs` lists
// them), and this fails on any that ALLOWED doesn't explain. Most of what it allows waits for a
// later task of the refactor, named in its reason; an allowance that allows nothing fails too, so
// each comes off the list when its task lands.

/** What may name content in code, and why: the ids it names (all, if none), in the files it names (a path, or a folder ending in /; all, if none). */
interface Allowance {
  why: string;
  files?: string[];
  ids?: string[];
}

/**
 * The bodies the content names: every look's (a building's, a prop's, a crop's, a pack's, an
 * animal's, a ride's) and every creature's species.
 */
function bodies(): string[] {
  const found = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== 'object') return;
    const o = v as { look?: { body?: unknown }; species?: unknown };
    if (typeof o.look?.body === 'string') found.add(o.look.body);
    if (typeof o.species === 'string') found.add(o.species);
    Object.values(v).forEach(visit);
  };
  for (const b of ['structures', 'farming', 'trade', 'vehicles', 'actors', 'creatures']) visit(JSON.parse(readFileSync(`shared/${b}.json`, 'utf8')));
  return [...found];
}

const ALLOWED: Allowance[] = [
  {
    why: "words of the code's own that some content shares: harvest (an objective, an event and its effect), heal (a brain's act, a hit's marker), home (where a brain runs to, where you wake), block (a guard, and CSS), stone (a wall of the village kit, a gathering's effect, a colour), herbs and wheels (effects), pine (the island's wild pines)",
    ids: ['harvest', 'heal', 'home', 'block', 'stone', 'herbs', 'wheels', 'pine'],
  },
  { why: 'a word the bug reporter leaves out of what you said', files: ['src/app/bugs/reporter.ts'], ids: ['well'] },
  {
    why: "the wire's kinds of record (crates/wire, src/net/wire): a meteor in flight is a kind of thing on the wire, whatever ability called it down",
    files: ['crates/wire/src/', 'src/net/wire/'],
    ids: ['meteor'],
  },
  { why: 'written by npm run icons from tools/icons/catalog.mjs: the items that have pictures of their own, by id', files: ['src/ui/theme/icons.gen.ts'] },
  {
    why: "the bodies the game is drawn with, each named for what it draws: a thing's look names its body (src/content/looks.ts), a creature's species its skeleton, and the code finds the body by that name",
    files: ['src/render/models/', 'src/render/creatures/'],
    ids: bodies(),
  },
  {
    why: "weapons, abilities and movement skills are code until they are data (R9.5): the close-up bodies' moves and films (src/render/detail/, the animation session's), the hero's weapons (the attachments named for them, the crowd's sword and the cast it shows), the default build (the browser's and the engine's), the slide every build has, and what a skill's tooltip says",
    files: [
      'src/render/detail/',
      'src/render/character.ts',
      'src/render/creatures/heroBody.ts',
      'src/content/tuning.ts',
      'crates/engine/src/tuning.rs',
      'crates/engine/src/player.rs',
      'src/input/input.ts',
      'src/ui/skills/',
    ],
  },
  {
    why: "the step src/main.ts runs, until it's data: the slide's dust (R9.5)",
    files: ['src/app/step.ts'],
    ids: ['slide'],
  },
  {
    why: 'the training dummy is drawn by a body of its own (src/render/dummy.ts), with its health bar and the shake when it breaks, found by its kind: the crowd draws what has a species, and the dummy has none',
    files: ['src/main.ts', 'src/app/drawing.ts'],
    ids: ['dummy'],
  },
  {
    why: "the offline training yard's own layout, its dummy and slimes, until the yard is an instance played offline (R10.11)",
    files: ['crates/engine/src/yard.rs'],
    ids: ['slime', 'dummy'],
  },
  {
    why: "the developer tools: the content library's subjects and films, the developer panel's gifts, the URL options and the test API's fixtures (the yard's dummy, Goblin's Dread's portal), the offline yard (R10.4)",
    files: ['src/dev/library/', 'src/ui/life/windows/dev.ts', 'src/app/options.ts', 'src/app/testApi.ts', 'src/render/scene.ts'],
  },
  { why: 'the bible explains the game with particular things as its examples, and its completeness test holds it to the content', files: ['src/bible/'] },
];

const allows = (a: Allowance, h: Hit) =>
  (!a.files || a.files.some((f) => (f.endsWith('/') ? h.file.startsWith(f) : h.file === f))) && (!a.ids || a.ids.includes(h.id));

test('no content id appears in code, but for the reasons allowed', () => {
  const ids = contentIds();
  expect(ids.size).toBeGreaterThan(150);
  const found = scan('.', ids);
  const loose = found.filter((h) => !ALLOWED.some((a) => allows(a, h)));
  expect(
    loose.map((h) => `${h.file}:${h.line} "${h.id}" (${ids.get(h.id)!.join(', ')})`),
    "content named in code: read what you need from the thing's data, or say in ALLOWED why it can't be yet",
  ).toEqual([]);
  // An allowance that allows nothing any more comes off the list.
  expect(ALLOWED.filter((a) => !found.some((h) => allows(a, h))).map((a) => a.why)).toEqual([]);
});

test('the scan finds ids in strings and tables, not in comments or tests', () => {
  const want = (s: string) => s === 'scarecrow' || s === 'hollis';
  // biome-ignore lint/suspicious/noTemplateCurlyInString: TypeScript source for the scan, a template with something in it among it.
  const ts = tsStrings('a.ts', "// 'hollis'\nconst a = { hollis: 1 };\nif (x === 'scarecrow') f(`scarecrow`, `${y}scarecrow`, 'scarecrow2');\n", want);
  expect(ts.map((h) => `${h.line} ${h.id}`)).toEqual(['2 hollis', '3 scarecrow', '3 scarecrow']);
  const rs = rustStrings(
    'a.rs',
    'fn a() { let q = \'"\'; f("scarecrow"); } // "hollis"\n/* "hollis" */\n#[cfg(test)]\nmod tests {\n  fn t() { g("hollis"); }\n}\nfn b<\'a>(s: &\'a str) { h("hollis"); }\n',
    want,
  );
  expect(rs.map((h) => `${h.line} ${h.id}`)).toEqual(['1 scarecrow', '7 hollis']);
});
