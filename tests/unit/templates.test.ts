import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { build } from '../../tools/content/contentc.mjs';

// content/_templates/: a thing of each kind to copy for a new one (docs/content.md says where each
// goes and what to change), with ids that say what they stand for (newPerson, newItem...). Each fits
// its kind (the same schema contentc holds content to), every kind a person adds as data has one,
// and copied in together they build, every reference found, so a copy needs only its own values.

const T = 'content/_templates';
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

/** Each template's kind: the folder it is copied into. */
const FOLDER: Record<string, string> = {
  npc: 'npcs',
  vendor: 'vendors',
  item: 'items',
  recipe: 'recipes',
  quest: 'quests',
  crop: 'crops',
  animal: 'animals',
  gathering: 'gathering',
  pack: 'packs',
  market: 'markets',
  climate: 'climates',
  vehicle: 'vehicles',
  mount: 'mounts',
  glider: 'gliders',
  'ship-design': 'ship-designs',
  blueprint: 'blueprints',
  structure: 'structures',
  prop: 'props',
  building: 'buildings',
  furniture: 'furniture',
  actor: 'actors',
  ladder: 'ladders',
  behaviour: 'behaviours',
  creature: 'creatures',
  dungeon: 'dungeons',
};

/** Kinds with no template, and why: a new one of them needs code today. */
const NO_TEMPLATE: Record<string, string> = {
  weapons: 'R9.5: a weapon is moves, a model and an icon in code too',
  abilities: 'R9.5: an ability is an effect, an icon and a cause on the wire in code too',
  'movement-skills': 'R9.5: a movement skill is a pose in code too',
  stats: 'a stat is a number the rules read by its name: a new one is new code',
  minigames: 'a mini-game is its rules module and its board views besides its file (docs/content.md)',
};

/** The items other templates name besides newItem, as a person adds them with theirs (docs/content.md). */
const COMPANIONS: Record<string, Record<string, unknown>> = {
  'animal.newAnimal': { name: 'New Young', cat: 'seed', raises: 'newAnimal', stack: 10 },
};

/** The things in `folder` that a file holds by its name rather than an id (an object keyed by file). */
const BY_NAME: Record<string, string> = { furniture: 'newFurniture', gathering: 'newNode', climates: 'newClimate' };

const templates = () => readdirSync(T).filter((f) => f.endsWith('.json'));
/** A template as its bundle would hold it: its parts in files of their own read in (a creature's, from _templates/creature/). */
const expanded = (t: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(t).map(([k, v]) => [k, v && typeof v === 'object' && '$file' in v ? read(join(T, 'creature', String(v.$file).split('/').pop()!)) : v]),
  );
const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

test('every template fits its kind', () => {
  const wrong: string[] = [];
  for (const f of templates()) {
    const kind = f.replace(/\.json$/, '');
    const folder = FOLDER[kind];
    if (!folder) {
      wrong.push(`${T}/${f}: no kind (FOLDER)`);
      continue;
    }
    const schema = read(`content/_schemas/${folder}.schema.json`);
    const t = expanded(read(join(T, f)));
    for (const [k, v] of Object.entries(t)) {
      const p = schema.properties[k];
      if (!p) wrong.push(`${f}: ${k} isn't a field of ${folder}`);
      else if (![p.type].flat().includes(typeOf(v))) wrong.push(`${f}: ${k} is a ${typeOf(v)}, not a ${p.type}`);
    }
    for (const k of schema.required) if (!(k in t)) wrong.push(`${f}: no ${k}, which every one of ${folder} has`);
  }
  // An entry for each of the island's lists, with the fields its entries have.
  const zone = (list: string) => read(`content/zones/emberholm/${list}.json`) as Array<Record<string, unknown>>;
  for (const f of readdirSync(join(T, 'zone'))) {
    const list = zone(f.replace(/\.json$/, ''));
    const t = read(join(T, 'zone', f));
    const fields = new Set(list.flatMap((x) => Object.keys(x)));
    for (const k of Object.keys(t)) if (!fields.has(k)) wrong.push(`zone/${f}: ${k} isn't a field of its entries`);
    for (const k of fields) if (list.every((x) => k in x) && !(k in t)) wrong.push(`zone/${f}: no ${k}, which every entry has`);
  }
  expect(wrong).toEqual([]);
});

test('every kind a person adds as data has a template', () => {
  const kinds = readdirSync('content/_schemas').map((f) => f.replace(/\.schema\.json$/, ''));
  const covered = new Set(Object.values(FOLDER));
  expect(kinds.filter((k) => !covered.has(k) && !NO_TEMPLATE[k])).toEqual([]);
  expect(Object.keys(FOLDER).filter((k) => !existsSync(join(T, `${k}.json`)))).toEqual([]);
});

const copies: string[] = [];
afterAll(() => {
  for (const c of copies) rmSync(c, { recursive: true, force: true });
});

test('copied in together, the templates build: every reference they make is found', () => {
  const root = mkdtempSync(join(tmpdir(), 'ruina-templates-'));
  copies.push(root);
  cpSync('content', root, { recursive: true });
  const add = (folder: string, name: string, thing: unknown) => {
    writeFileSync(join(root, folder, `${name}.json`), JSON.stringify(thing));
    const order = join(root, folder, '_order.json');
    writeFileSync(order, JSON.stringify([...read(order), name]));
  };
  for (const f of templates()) {
    const kind = f.replace(/\.json$/, '');
    const folder = FOLDER[kind];
    const t = read(join(T, f));
    add(folder, BY_NAME[folder] ?? (folder === 'vendors' ? t.npc : t.id), t);
  }
  // The items the other templates name, each a copy of the item template.
  const item = read(join(T, 'item.json'));
  for (const [id, own] of Object.entries(COMPANIONS)) add('items', id, { ...item, id, ...own });
  mkdirSync(join(root, 'creatures/newCreature'), { recursive: true });
  for (const part of readdirSync(join(T, 'creature'))) cpSync(join(T, 'creature', part), join(root, 'creatures/newCreature', part));
  for (const f of readdirSync(join(T, 'zone'))) {
    const p = join(root, 'zones/emberholm', f);
    writeFileSync(p, JSON.stringify([...read(p), read(join(T, 'zone', f))]));
  }
  const bundles = build(root);
  expect((bundles.get('zones/emberholm.json') as { npcs: Array<{ id: string }> }).npcs.some((n) => n.id === 'newPerson')).toBe(true);
  expect((bundles.get('creatures.json') as { creatures: Array<{ id: string }> }).creatures.map((c) => c.id)).toContain('newCreature');
});
