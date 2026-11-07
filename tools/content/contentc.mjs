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
// reference to something that doesn't exist (REFS below, and what the skill tree names), a file in
// content/ no bundle takes, a made model a look names whose file isn't there, a cave without its
// dressing or one naming walls it hasn't got. And it writes shared/hash.json, a hash of all of
// shared/, which the world's connection compares (hashOf).
//
//   node tools/content/contentc.mjs           builds shared/
//   node tools/content/contentc.mjs --check   checks, and that shared/ is what content/ builds (CI)
import { createHash } from 'node:crypto';
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

/** The templates: content/*.json and content/regions/*.json, as under shared/. */
function templates(root) {
  const out = [];
  for (const e of readdirSync(root)) if (e.endsWith('.json')) out.push(e);
  for (const d of ['regions']) {
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
  errors.push(...references(bundles), ...madeModels(bundles), ...dressings(bundles));
  errors.push(...world(bundles), ...spawns(bundles), ...skillTree(bundles));
  if (errors.length) throw new ContentError(errors.join('\n'));
  bundles.set(HASH, hashOf(bundles));
  return bundles;
}

// ---------- The world ----------

/**
 * What's wrong with where the world puts its regions (content/world.json): each has a recipe, its grid
 * covers exactly its chunks (its terrain's origin at their middle, its size theirs: a region's
 * recipe is written where it stands), its sea is the world's, and no chunk is two regions'. Every
 * region's cell is the same, a whole number to a chunk, so two regions' grids meet vertex for vertex
 * where their ground is blended; the blend is at most half a chunk.
 */
function world(b) {
  const w = b.get('world.json');
  if (!w) return [];
  const out = [];
  if (!(w.blend >= 0 && w.blend <= w.chunk / 2)) out.push(`content/world.json: blend is ${w.blend}, where it's from 0 to half a chunk (${w.chunk / 2})`);
  const taken = new Map();
  // Things in the world found by id (a gathering spot's time to come back is kept by its id): one id,
  // one thing, whichever region it's in.
  const named = new Map();
  const instances = new Set((b.get('instances.json')?.instances ?? []).map((d) => d.id));
  let cell;
  for (const r of w.regions ?? []) {
    const where = `content/world.json: ${r.id}`;
    const zone = b.get(`regions/${r.id}.json`);
    if (!zone) {
      out.push(`${where}: there's no content/regions/${r.id}.json`);
      continue;
    }
    const { x, z, w: cw, d: cd } = r.chunks ?? {};
    for (let i = x; i < x + cw; i++)
      for (let j = z; j < z + cd; j++) {
        const k = `${i},${j}`;
        if (taken.has(k)) out.push(`${where}: chunk (${i}, ${j}) is ${taken.get(k)}'s too`);
        taken.set(k, r.id);
      }
    const t = zone.terrain ?? {};
    const size = t.cells * t.cell;
    const [ox, oz] = t.origin ?? [0, 0];
    const mid = [(x + cw / 2) * w.chunk, (z + cd / 2) * w.chunk];
    if (cw !== cd || size !== cw * w.chunk)
      out.push(`${where}: its grid is ${size} m a side (cells times cell), where its chunks are ${cw * w.chunk} by ${cd * w.chunk} m`);
    if (ox !== mid[0] || oz !== mid[1]) out.push(`${where}: its terrain's origin is (${ox}, ${oz}), where the middle of its chunks is (${mid[0]}, ${mid[1]})`);
    if (t.water !== w.sea?.level) out.push(`${where}: its sea level is ${t.water}, the world's ${w.sea?.level}`);
    for (const list of ['places', 'npcs', 'workbenches', 'outposts', 'housePlots', 'nodes', 'doors', 'shipyards']) {
      for (const [i, thing] of (zone[list] ?? []).entries()) {
        if (typeof thing.id !== 'string' || !thing.id || /^\d+$/.test(thing.id)) {
          out.push(`${where}: ${list}[${i}] has no id (a name, not a number)`);
          continue;
        }
        // A door is named for the instance it opens into.
        if (list === 'doors' && !instances.has(thing.id)) out.push(`${where}: doors ${thing.id} opens into no instance (content/instances/${thing.id}.json)`);
        const key = `${list}:${thing.id}`;
        if (named.has(key)) out.push(`${where}: ${list} ${thing.id} is ${named.get(key)}'s too: an id is one thing in the whole world`);
        named.set(key, r.id);
      }
    }
    cell ??= t.cell;
    if (t.cell !== cell || !Number.isInteger(w.chunk / t.cell))
      out.push(`${where}: its cell is ${t.cell} m, where every region's is ${cell} m, a whole number of them to a ${w.chunk} m chunk`);
  }
  return out;
}

// ---------- Spawns ----------

/**
 * What's wrong with what a region or an instance brings to life where it's played (its `spawns`,
 * crates/engine/src/open/spawns.rs): each names a creature's kind (shared/actors.json, or a
 * creature's kinds) and a spot, and only a group that isn't a band is spread (`r`).
 */
function spawns(b) {
  const kinds = new Set([
    ...(b.get('actors.json')?.kinds ?? []).map((k) => k.id),
    ...(b.get('creatures.json')?.creatures ?? []).flatMap((c) => (c.kinds ?? []).map((k) => k.id)),
  ]);
  const out = [];
  const check = (list, where) => {
    for (const [i, s] of (list ?? []).entries()) {
      const at = `${where}: spawns[${i}]`;
      if (!kinds.has(s.kind)) out.push(`${at}: ${JSON.stringify(s.kind)} is no creature's kind (shared/actors.json, or a creature's kinds)`);
      if (typeof s.x !== 'number' || typeof s.z !== 'number') out.push(`${at}: it has no spot (x, z)`);
      if (s.r !== undefined && (typeof s.r !== 'number' || s.r <= 0)) out.push(`${at}: r is how far a group is spread, more than 0 m`);
      if (s.r !== undefined && s.band) out.push(`${at}: a band stands in a ring round its spot; r spreads a group that isn't one`);
    }
  };
  for (const [path, region] of b) if (path.startsWith('regions/') && !path.slice('regions/'.length).includes('/')) check(region?.spawns, `content/${path}`);
  for (const d of b.get('instances.json')?.instances ?? []) check(d.spawns, `content/instances/${d.id}.json`);
  return out;
}

// ---------- The skill tree ----------

/**
 * What's wrong with what the skill tree names (shared/skilltree.json, laid out by
 * tools/skilltree/gen.mjs and edited there by hand, not built from here): a node grants a weapon, an
 * ability or a movement skill, and a modifier changes a weapon, or an ability or a movement skill,
 * each by its id, which must be the tuning's (the engine and the page find its place in its list from
 * it, so the lists can be in any order).
 */
function skillTree(b) {
  const file = join(SHARED, 'skilltree.json');
  const t = b.get('tuning.json');
  if (!t || !existsSync(file)) return [];
  const has = {
    weapon: new Set((t.weapons ?? []).map((w) => w.name)),
    ability: new Set((t.abilities ?? []).map((a) => a.id)),
    movement: new Set((t.movementSkills ?? []).map((m) => m.id)),
  };
  const out = [];
  for (const n of readJson(file).nodes ?? []) {
    const where = `shared/skilltree.json: ${n.id}`;
    for (const [key, kind] of [
      ['weapon', 'weapon'],
      ['ability', 'ability'],
      ['movement', 'movement skill'],
    ]) {
      const id = n.grants?.[key];
      if (id !== undefined && !has[key].has(id)) out.push(`${where}.grants.${key}: there's no ${kind} ${JSON.stringify(id)}`);
    }
    for (const [i, m] of (n.mods ?? []).entries()) {
      if (m.weapon !== undefined && !has.weapon.has(m.weapon)) out.push(`${where}.mods[${i}].weapon: there's no weapon ${JSON.stringify(m.weapon)}`);
      if (m.skill !== undefined && !has.ability.has(m.skill) && !has.movement.has(m.skill))
        out.push(`${where}.mods[${i}].skill: there's no ability or movement skill ${JSON.stringify(m.skill)}`);
    }
  }
  return out;
}

// ---------- The content's hash ----------

const HASH = 'hash.json';

/**
 * shared/hash.json: a hash of every file under shared/ but itself, the bundles as built and the rest
 * (the skill tree, the order builds were once kept in) as they are there. The server and the page
 * each take it in as they are built; the server says its own in the world's welcome, and a page with
 * another reloads into the new build, as for another protocol (crates/server/src/gate/socket.rs,
 * src/net/worldLink.ts): built from other content, the two would read a place in a bundle's list on
 * the wire as different things.
 */
function hashOf(bundles) {
  const files = new Map([...bundles].map(([p, v]) => [p, text(v)]));
  if (existsSync(SHARED))
    for (const p of walk(SHARED)) if (p.endsWith('.json') && p !== HASH && !files.has(p)) files.set(p, readFileSync(join(SHARED, p), 'utf8'));
  const hash = createHash('sha256');
  for (const p of [...files.keys()].sort()) hash.update(`${p}\0${files.get(p)}\0`);
  return {
    comment:
      "Written by tools/content/contentc.mjs (npm run content): a hash of every file in shared/ but this one. The server sends it in the world's welcome, and a page built from other content reloads into the new build (crates/server/src/gate/socket.rs, src/net/worldLink.ts).",
    content: hash.digest('hex').slice(0, 16),
  };
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

/**
 * What's wrong with a thing against its kind's schema: unknown fields, missing ones, wrong types;
 * and the same of a field the schema gives fields of its own (a look).
 */
function fits(thing, schema, where, title = schema?.title) {
  if (!schema || !thing || typeof thing !== 'object') return [];
  const out = [];
  for (const [k, v] of Object.entries(thing)) {
    const p = schema.properties?.[k];
    if (!p) {
      out.push(`${where}: ${JSON.stringify(k)} isn't a field of ${title} (they have ${Object.keys(schema.properties ?? {}).join(', ')})`);
      continue;
    }
    const allowed = Array.isArray(p.type) ? p.type : [p.type];
    if (!allowed.includes(typeOf(v))) out.push(`${where}: ${k} is a ${typeOf(v)}, where ${title} have a ${allowed.join(' or ')}`);
    else if (p.properties && typeOf(v) === 'object') out.push(...fits(v, p, `${where} ${k}`, `the ${k}s of ${title}`));
  }
  for (const k of schema.required ?? []) if (!(k in thing)) out.push(`${where}: no ${k}, which every one of ${title} has`);
  return out;
}

// ---------- References ----------

/** The ids of each kind of thing, as the bundles hold them. */
function ids(b) {
  const list = (bundle, key, id = 'id') => new Set((b.get(bundle)?.[key] ?? []).map((x) => x[id]));
  // What every region places (content/regions/), whichever it's in.
  const regions = [...b].filter(([path]) => path.startsWith('regions/')).map(([, region]) => region ?? {});
  const inRegions = (key) => new Set(regions.flatMap((region) => (region[key] ?? []).map((x) => x.id)));
  return {
    item: list('items.json', 'items'),
    category: new Set(Object.keys(b.get('items.json')?.categories ?? {})),
    // The rules' ways of placing a thing and of showing a rare find (src/engine/life/interact.ts, farming.ts).
    placement: new Set(['ground', 'plot', 'slipway']),
    effect: new Set(['thunder']),
    blueprint: list('housing.json', 'blueprints'),
    shipDesign: list('shipyard.json', 'designs'),
    npc: inRegions('npcs'),
    workbench: inRegions('workbenches'),
    place: inRegions('places'),
    outpost: inRegions('outposts'),
    shipyard: inRegions('shipyards'),
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
    instance: list('instances.json', 'instances'),
    // A weapon's id is its name.
    weapon: list('tuning.json', 'weapons', 'name'),
    ability: list('tuning.json', 'abilities'),
    movementSkill: list('tuning.json', 'movementSkills'),
  };
}

/** Which keys, in which bundles, name which kind of thing. */
const REFS = [
  { bundles: /^(items|quests|trade|farming|housing|shipyard|vehicles)\.json$/, key: 'item', kind: 'item' },
  { bundles: /^items\.json$/, key: 'npc', kind: 'npc' },
  // An item's category, and for a placeable what it places and where.
  { bundles: /^items\.json$/, key: 'cat', kind: 'category' },
  { bundles: /^items\.json$/, key: 'places', kind: ['blueprint', 'shipDesign', 'structure'] },
  // What marks out an unclaimed house plot.
  { bundles: /^housing\.json$/, key: 'plotMarker', kind: 'structure' },
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
  { bundles: /^regions\/.*$/, key: 'place', kind: 'place' },
  { bundles: /^regions\/.*$/, key: 'bench', kind: 'workbench' },
  { bundles: /^regions\/.*$/, key: 'npc', kind: 'npc' },
  { bundles: /^(quests|items)\.json$/, key: 'pack', kind: 'pack' },
  // A workbench, or a townsperson who takes the work on (commissions).
  { bundles: /^items\.json$/, key: 'bench', kind: ['workbench', 'npc'] },
  { bundles: /^trade\.json$/, key: 'from', kind: 'market' },
  { bundles: /^trade\.json$/, key: 'to', kind: 'market' },
  { bundles: /^(actors|creatures)\.json$/, key: 'brain', kind: 'behaviour' },
  // What a skill's level adds: the weapon it changes, or the ability or movement skill.
  { bundles: /^tuning\.json$/, key: 'weapon', kind: 'weapon' },
  { bundles: /^tuning\.json$/, key: 'skill', kind: ['ability', 'movementSkill'] },
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

// ---------- Made models ----------

/** Where the made models' files are, and the fields a made model has (src/content/looks.ts MadeModel). */
const MODELS = 'src/render/assets/models';
const MODEL_FIELDS = { files: 'array', tints: 'array', w: 'number', h: 'number', d: 'number', yaw: 'number', sink: 'number', keep: 'array' };

/** What's wrong with the made models looks name: a field a made model doesn't have, a file that isn't there. */
function madeModels(bundles) {
  const errors = [];
  const visit = (v, where) => {
    if (Array.isArray(v)) return v.forEach((x, i) => visit(x, `${where}[${i}]`));
    if (!v || typeof v !== 'object') return;
    if (typeOf(v.look) === 'object' && v.look.model !== undefined) errors.push(...madeModel(v.look.model, `${where}.look.model`));
    for (const [k, x] of Object.entries(v)) visit(x, `${where}.${k}`);
  };
  for (const [path, value] of bundles) visit(value, path.replace(/\.json$/, ''));
  return errors;
}

/** What's wrong with one made model. */
function madeModel(m, where) {
  if (typeOf(m) !== 'object') return [`${where}: a made model is an object: its files, and how it is fitted`];
  const out = [];
  for (const [k, v] of Object.entries(m)) {
    const want = MODEL_FIELDS[k];
    if (!want) out.push(`${where}: ${JSON.stringify(k)} isn't a field of a made model (they have ${Object.keys(MODEL_FIELDS).join(', ')})`);
    else if (typeOf(v) !== want) out.push(`${where}: ${k} is a ${typeOf(v)}, where a made model has a ${want}`);
  }
  if (!Array.isArray(m.files) || !m.files.length) out.push(`${where}: no files`);
  else for (const f of m.files) if (!existsSync(join(MODELS, `${f}.glb`))) out.push(`${where}: there's no ${MODELS}/${f}.glb`);
  if (Array.isArray(m.tints) && m.tints.length !== m.files?.length) out.push(`${where}: a tint for each of its files`);
  return out;
}

// ---------- A cave's dressing ----------

/**
 * What's wrong with the instances' dressings (src/content/looks.ts CaveDressing, docs/world.md): a
 * cave without one or an arena with one (an arena isn't dressed), walls or a piece to stand on that
 * aren't the instance's own, no light for its torches or the falls.
 */
function dressings(bundles) {
  const errors = [];
  for (const d of bundles.get('instances.json')?.instances ?? []) {
    const where = `content/instances/${d.id}.json`;
    const dress = d.dressing;
    if ((d.style ?? 'cave') !== 'cave') {
      if (dress !== undefined) errors.push(`${where}: an ${d.style} isn't dressed: only a cave is drawn from its dressing`);
      continue;
    }
    if (typeOf(dress) !== 'object') {
      errors.push(`${where}: a cave has its dressing, what it looks like inside (docs/world.md, Dressing a Cave)`);
      continue;
    }
    const boxes = new Set((d.boxes ?? []).map((b) => b.id));
    const pieces = new Set([...boxes, ...(d.decks ?? []).map((p) => p.id)]);
    const walls = (part, sides) => {
      if (typeOf(dress[part]) !== 'object') return errors.push(`${where}: its dressing has no ${part}`);
      for (const side of sides)
        if (!boxes.has(dress[part][side]))
          errors.push(`${where}: dressing.${part}.${side} is ${JSON.stringify(dress[part][side])}, which isn't one of its boxes`);
    };
    walls('hall', ['west', 'east', 'south', 'north']);
    if (dress.tunnel !== undefined) walls('tunnel', ['west', 'east', 'end']);
    for (const [i, p] of (dress.props ?? []).entries())
      if (!pieces.has(p?.on)) errors.push(`${where}: dressing.props[${i}] stands on ${JSON.stringify(p?.on)}, which isn't one of its boxes or decks`);
    const light = dress.light;
    if (typeOf(light) !== 'object' || !light.fill || !light.exit) errors.push(`${where}: its dressing's light has a fill and the way out's lamp (exit)`);
    else {
      if (dress.torches?.length && !light.torch) errors.push(`${where}: its dressing has torches, but no light for them (light.torch)`);
      if (dress.falls !== undefined && !light.falls) errors.push(`${where}: its dressing has falls, but no light for them (light.falls)`);
    }
  }
  return errors;
}

// ---------- Writing ----------

const text = (v) => `${JSON.stringify(v, null, 2)}\n`;

/** Bundles whose shared/ file isn't what content/ builds. */
export function stale(bundles) {
  return [...bundles].filter(([p, v]) => !existsSync(join(SHARED, p)) || readFileSync(join(SHARED, p), 'utf8') !== text(v)).map(([p]) => p);
}

/** Writes the bundles that changed into shared/: their paths. */
export function write(bundles) {
  const changed = stale(bundles);
  for (const p of changed) writeFileSync(join(SHARED, p), text(bundles.get(p)));
  return changed;
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
      write(bundles);
      console.log(`content: ${bundles.size} bundles built into shared/`);
    }
  } catch (e) {
    if (!(e instanceof ContentError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}
