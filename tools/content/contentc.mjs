// contentc: builds the game's content bundles, shared/*.json (what the browser imports and the server
// reads), from content/: a folder per kind with a file per thing, and a template per bundle
// (content/<path>.json for shared/<path>.json) whose markers bring the things in:
//
//   {"$things": "<folder>"}               every content/<folder>/<id>.json, in its _order.json's order,
//                                         as a list; each thing names itself by "id" (or by the field
//                                         the marker names: {"$things": "vendors", "id": "npc"})
//   {"$things": "<folder>", "as": "map"}  the same, as an object keyed by the files' names
//   {"$file": "<path>"}                   content/<path> as it is: a thing in several files
//
// It checks what a person editing content gets wrong: a thing missing from its folder's _order.json
// or listed there with no file, a file named other than its thing's id, the same id twice, a
// reference to something that doesn't exist (REFS below), a file in content/ no bundle takes.
//
//   node tools/content/contentc.mjs           builds shared/
//   node tools/content/contentc.mjs --check   checks, and that shared/ is what content/ builds (CI)
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const CONTENT = 'content';
const SHARED = 'shared';
export class ContentError extends Error {}

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    throw new ContentError(`${f}: ${e.message}`);
  }
};
/** Every file under `root`, by its path from there. */
const walk = (root, d = root, out = []) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(root, p, out);
    else out.push(relative(root, p).replace(/\\/g, '/'));
  }
  return out;
};

/** The templates: content/*.json and content/zones/*.json, as under shared/. */
function templates(root) {
  const out = [];
  for (const e of readdirSync(root)) if (e.endsWith('.json')) out.push(e);
  for (const d of ['zones']) {
    const dir = join(root, d);
    if (existsSync(dir)) for (const e of readdirSync(dir)) if (e.endsWith('.json')) out.push(`${d}/${e}`);
  }
  return out.sort();
}

/** Builds every bundle from `root`: { bundles: Map<path, value>, used: Set<content files> }. */
export function build(root = CONTENT) {
  const errors = [];
  const used = new Set();
  const bundles = new Map();
  const expand = (v, where) => {
    if (Array.isArray(v)) return v.map((x, i) => expand(x, `${where}[${i}]`));
    if (!v || typeof v !== 'object') return v;
    if (typeof v.$file === 'string') {
      const p = v.$file;
      if (!existsSync(join(root, p))) {
        errors.push(`${where}: ${p} isn't there`);
        return null;
      }
      used.add(p);
      return expand(readJson(join(root, p)), p);
    }
    if (typeof v.$things === 'string') return thingsOf(v, where);
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = expand(x, `${where}.${k}`);
    return out;
  };
  const thingsOf = (m, where) => {
    const folder = m.$things;
    const dir = join(root, folder);
    if (!existsSync(dir)) {
      errors.push(`${where}: content/${folder}/ isn't there`);
      return [];
    }
    const orderFile = `${folder}/_order.json`;
    const order = existsSync(join(root, orderFile)) ? readJson(join(root, orderFile)) : null;
    if (!Array.isArray(order)) {
      errors.push(`${orderFile}: there must be one, listing the ${folder} in their order`);
      return [];
    }
    used.add(orderFile);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .map((f) => f.slice(0, -5));
    for (const f of files) if (!order.includes(f)) errors.push(`content/${folder}/${f}.json: not in ${orderFile}, so no bundle has it`);
    const seen = new Set();
    const list = [];
    for (const id of order) {
      if (seen.has(id)) errors.push(`${orderFile}: ${id} twice`);
      seen.add(id);
      const p = `${folder}/${id}.json`;
      if (!existsSync(join(root, p))) {
        errors.push(`${orderFile}: lists ${id}, but there's no content/${p}`);
        continue;
      }
      used.add(p);
      const thing = expand(readJson(join(root, p)), p);
      errors.push(...fits(thing, schemaOf(root, folder), `content/${p}`));
      if (m.as !== 'map') {
        const key = m.id ?? 'id';
        if (String(thing?.[key]) !== id) errors.push(`content/${p}: its ${key} is ${JSON.stringify(thing?.[key])}, but the file is named ${id}`);
      }
      list.push([id, thing]);
    }
    return m.as === 'map' ? Object.fromEntries(list) : list.map(([, t]) => t);
  };
  for (const t of templates(root)) {
    used.add(t);
    const bundle = expand(readJson(join(root, t)), t);
    // Whoever opens the bundle reads first where it comes from.
    if (bundle && typeof bundle.comment === 'string')
      bundle.comment = `Built from content/${t} by tools/content/contentc.mjs (npm run content): edit there, not here. ${bundle.comment}`;
    bundles.set(t, bundle);
  }
  // The schemas, and the templates a new thing is copied from (content/_templates/), are no bundle's.
  for (const f of walk(root)) if (!used.has(f) && !/^_(schemas|templates)\//.test(f) && !f.endsWith('.md')) errors.push(`content/${f}: no bundle takes it`);
  errors.push(...references(bundles));
  if (errors.length) throw new ContentError(errors.join('\n'));
  return bundles;
}

// ---------- Schemas ----------

const schemas = new Map();
/** A kind's schema (content/_schemas/<kind>.schema.json, written by tools/content/schemas.mjs), if it has one. */
function schemaOf(root, folder) {
  const key = `${root}|${folder}`;
  if (!schemas.has(key)) {
    const f = join(root, '_schemas', `${folder}.schema.json`);
    schemas.set(key, existsSync(f) ? readJson(f) : null);
  }
  return schemas.get(key);
}
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? 'number' : typeof v);

/** What's wrong with a thing against its kind's schema: unknown fields, missing ones, wrong types. */
function fits(thing, schema, where) {
  if (!schema || !thing || typeof thing !== 'object') return [];
  const out = [];
  for (const [k, v] of Object.entries(thing)) {
    const p = schema.properties?.[k];
    if (!p) {
      out.push(`${where}: ${JSON.stringify(k)} isn't a field of ${schema.title} (they have ${Object.keys(schema.properties ?? {}).join(', ')})`);
      continue;
    }
    const allowed = Array.isArray(p.type) ? p.type : [p.type];
    if (!allowed.includes(typeOf(v))) out.push(`${where}: ${k} is a ${typeOf(v)}, where ${schema.title} have a ${allowed.join(' or ')}`);
  }
  for (const k of schema.required ?? []) if (!(k in thing)) out.push(`${where}: no ${k}, which every one of ${schema.title} has`);
  return out;
}

// ---------- References ----------

/** The ids of each kind of thing, as the bundles hold them. */
function ids(b) {
  const list = (bundle, key, id = 'id') => new Set((b.get(bundle)?.[key] ?? []).map((x) => x[id]));
  const zone = b.get('zones/emberholm.json') ?? {};
  const inZone = (key) => new Set((zone[key] ?? []).map((x) => x.id));
  return {
    item: list('items.json', 'items'),
    category: new Set(Object.keys(b.get('items.json')?.categories ?? {})),
    // The rules' ways of placing a thing and of showing a rare find (src/engine/life/interact.ts, farming.ts).
    placement: new Set(['ground', 'plot', 'slipway']),
    effect: new Set(['thunder']),
    blueprint: list('housing.json', 'blueprints'),
    shipDesign: list('shipyard.json', 'designs'),
    npc: inZone('npcs'),
    workbench: inZone('workbenches'),
    place: inZone('places'),
    outpost: inZone('outposts'),
    shipyard: inZone('shipyards'),
    pack: list('trade.json', 'packs'),
    market: list('trade.json', 'places'),
    crop: list('farming.json', 'crops'),
    animal: list('farming.json', 'animals'),
    behaviour: new Set([
      ...list('behaviours.json', 'behaviours'),
      ...(b.get('creatures.json')?.creatures ?? []).flatMap((c) => (c.behaviours ?? []).map((x) => x.id)),
    ]),
    quest: list('quests.json', 'quests'),
    structure: list('structures.json', 'structures'),
    dungeon: list('dungeons.json', 'dungeons'),
  };
}

/** Which keys, in which bundles, name which kind of thing. */
const REFS = [
  { bundles: /^(items|quests|trade|farming|housing|shipyard|vehicles)\.json$/, key: 'item', kind: 'item' },
  { bundles: /^items\.json$/, key: 'npc', kind: 'npc' },
  // An item's category, and for a placeable what it places and where.
  { bundles: /^items\.json$/, key: 'cat', kind: 'category' },
  { bundles: /^items\.json$/, key: 'places', kind: ['blueprint', 'shipDesign', 'structure'] },
  { bundles: /^items\.json$/, key: 'placeOn', kind: 'placement' },
  // What a rare find looks like where it's found.
  { bundles: /^farming\.json$/, key: 'effect', kind: 'effect' },
  { bundles: /^quests\.json$/, key: 'giver', kind: 'npc' },
  { bundles: /^quests\.json$/, key: 'turnIn', kind: 'npc' },
  // An objective's person, place or trading post, and where its marker points (a place, a trading
  // post, a workbench or a slipway).
  { bundles: /^quests\.json$/, key: 'npc', kind: 'npc' },
  { bundles: /^quests\.json$/, key: 'place', kind: 'place' },
  { bundles: /^quests\.json$/, key: 'outpost', kind: 'outpost' },
  { bundles: /^quests\.json$/, key: 'workbench', kind: 'workbench' },
  { bundles: /^quests\.json$/, key: 'shipyard', kind: 'shipyard' },
  // A townsperson's place and the workbench they stand at; a workbench's place; a trading post's trader.
  { bundles: /^zones\/.*$/, key: 'place', kind: 'place' },
  { bundles: /^zones\/.*$/, key: 'bench', kind: 'workbench' },
  { bundles: /^zones\/.*$/, key: 'npc', kind: 'npc' },
  { bundles: /^(quests|items)\.json$/, key: 'pack', kind: 'pack' },
  // A workbench, or a townsperson who takes the work on (commissions).
  { bundles: /^items\.json$/, key: 'bench', kind: ['workbench', 'npc'] },
  { bundles: /^trade\.json$/, key: 'from', kind: 'market' },
  { bundles: /^trade\.json$/, key: 'to', kind: 'market' },
  { bundles: /^(actors|creatures)\.json$/, key: 'brain', kind: 'behaviour' },
  { bundles: /^zones\/.*$/, key: 'dungeon', kind: 'dungeon' },
];

function references(bundles) {
  const known = ids(bundles);
  const errors = [];
  for (const [path, value] of bundles) {
    const rules = REFS.filter((r) => r.bundles.test(path));
    if (!rules.length) continue;
    const visit = (v, where) => {
      if (Array.isArray(v)) return v.forEach((x, i) => visit(x, `${where}[${i}]`));
      if (!v || typeof v !== 'object') return;
      for (const [k, x] of Object.entries(v)) {
        for (const r of rules) {
          // An empty name names nothing (a milestone has no giver).
          if (k !== r.key || typeof x !== 'string' || x === '') continue;
          const kinds = Array.isArray(r.kind) ? r.kind : [r.kind];
          if (!kinds.some((kind) => known[kind].has(x))) errors.push(`${where}.${k}: there's no ${kinds.join(' or ')} ${JSON.stringify(x)}`);
        }
        visit(x, `${where}.${k}`);
      }
    };
    visit(value, path.replace(/\.json$/, ''));
  }
  return errors;
}

// ---------- Writing ----------

const text = (v) => `${JSON.stringify(v, null, 2)}\n`;

/** Bundles whose shared/ file isn't what content/ builds. */
export function stale(bundles) {
  return [...bundles].filter(([p, v]) => !existsSync(join(SHARED, p)) || readFileSync(join(SHARED, p), 'utf8') !== text(v)).map(([p]) => p);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  try {
    const bundles = build();
    if (check) {
      const old = stale(bundles);
      if (old.length) {
        console.error(`shared/ is behind content/: ${old.join(', ')}\nBuild it: npm run content`);
        process.exit(1);
      }
      console.log(`content: ${bundles.size} bundles, all as built`);
    } else {
      for (const [p, v] of bundles) writeFileSync(join(SHARED, p), text(v));
      console.log(`content: ${bundles.size} bundles built into shared/`);
    }
  } catch (e) {
    if (!(e instanceof ContentError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}
