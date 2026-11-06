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

const ALLOWED: Allowance[] = [
  {
    why: "words of the code's own that some content shares: harvest (an objective, an event and its effect), heal (a brain's act, a hit's marker), home (where a brain runs to, where you wake), block (a guard, and CSS), stone (a wall of the village kit, a gathering's effect, a colour), herbs and wheels (effects), pine (the island's wild pines)",
    ids: ['harvest', 'heal', 'home', 'block', 'stone', 'herbs', 'wheels', 'pine'],
  },
  { why: 'the bench a focus is at, a field of it', files: ['src/sim/life/interact.ts'], ids: ['bench'] },
  { why: 'a word the bug reporter leaves out of what you said', files: ['src/app/bugs/reporter.ts'], ids: ['well'] },
  { why: 'written by npm run icons from tools/icons/catalog.mjs: the items that have pictures of their own, by id', files: ['src/ui/theme/icons.gen.ts'] },
  {
    why: 'looks are code until they are data (R9.9): a builder, a made model, a body or a colour for each thing by its id, with a plain one for the rest',
    files: [
      'src/render/models/',
      'src/render/open/dressing.ts',
      'src/render/open/life.ts',
      'src/render/actors.ts',
      'src/render/vfx.ts',
      'src/render/creatures/',
    ],
  },
  {
    why: "weapons, abilities and movement skills are code until they are data (R9.5): the close-up bodies' moves and films (src/render/detail/, the animation session's), the default build, the slide every build has, and what a skill's tooltip says",
    files: ['src/render/detail/', 'src/render/character.ts', 'src/content/tuning.ts', 'crates/engine/src/tuning.rs', 'src/input/input.ts', 'src/ui/skills/'],
  },
  {
    why: "src/main.ts, until it is split: the slimes' and the dummy's name plates (R9.9), the slide's dust (R9.5), and the battlefield's option",
    files: ['src/main.ts'],
    ids: ['slimelet', 'great-slime', 'slime-monarch', 'slide', 'battlefield'],
  },
  {
    why: "the island's own slimes and training dummy are spawned by code until spawns are data (R9.3), and ?goblins= puts a band in the yard",
    files: ['src/sim/zone/world.ts', 'src/sim/yard.ts', 'src/main.ts', 'crates/server/src/play/mod.rs'],
    ids: ['slime', 'dummy', 'goblin'],
  },
  { why: "the island's generator special-cases some structures by id until zones are data (R9.10)", files: ['src/sim/zone/generate.ts'] },
  {
    why: 'the mini-games are wired one by one until the table framework reads them from content (R9.11)',
    files: ['src/content/minigames.ts', 'src/ui/minigames/', 'crates/engine/src/minigames/', 'src/app/testApi.ts'],
    ids: ['beacons'],
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
