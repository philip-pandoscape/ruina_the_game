// Finds content ids in the game's code: every string literal (and template with nothing in it), and
// every object literal's key, in src/**/*.ts, and every string literal in crates/*/src/**/*.rs
// outside comments and #[cfg(test)] items, that is the id of a thing in the content (shared/*.json,
// built from content/). tests/unit/contentIds.test.ts holds the code to a short list of reasons for
// the ones still there (.plans/refactor R9.12).
//
//   node tools/content/ids.mjs            every content id in code, file:line by file:line
//   node tools/content/ids.mjs --by-file  how many in each file
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSync } from 'oxc-parser';

/**
 * The ids checked, by id, with the kinds of thing each names: what a person adds as content. Not
 * checked: the island's terrain features (the generator's own recipe), furniture (the village kit's
 * pieces, named for what they are: bed, chest, table), skill-tree nodes (written by
 * tools/skilltree/gen.mjs; a weapon's or a skill's node is its own id, checked as one), stats and
 * item categories (names of what the rules do: a new one is new code), climates and gathering kinds
 * (what crops and quests are matched by).
 */
export function contentIds(root = '.') {
  const bundle = (f) => JSON.parse(readFileSync(join(root, 'shared', f), 'utf8'));
  const ids = (list) => (list ?? []).map((x) => x.id);
  const items = bundle('items.json');
  const zone = bundle('zones/emberholm.json');
  const trade = bundle('trade.json');
  const farming = bundle('farming.json');
  const vehicles = bundle('vehicles.json');
  const structures = bundle('structures.json');
  const tuning = bundle('tuning.json');
  const creatures = bundle('creatures.json').creatures;
  const kinds = {
    item: ids(items.items),
    recipe: ids(items.recipes),
    quest: ids(bundle('quests.json').quests),
    npc: ids(zone.npcs),
    place: [...ids(zone.places), ...ids(trade.places)],
    workbench: ids(zone.workbenches),
    'house plot': ids(zone.housePlots),
    slipway: ids(zone.shipyards),
    pack: ids(trade.packs),
    crop: ids(farming.crops),
    animal: ids(farming.animals),
    vehicle: [...ids(vehicles.vehicles), ...ids(vehicles.mounts), ...ids(vehicles.gliders)],
    structure: [...ids(structures.structures), ...ids(structures.props)],
    building: ids(bundle('buildings.json').plans),
    blueprint: ids(bundle('housing.json').blueprints),
    'ship design': ids(bundle('shipyard.json').designs),
    creature: [...ids(bundle('actors.json').kinds), ...creatures.flatMap((c) => ids(c.kinds))],
    brain: [...ids(bundle('behaviours.json').behaviours), ...creatures.flatMap((c) => ids(c.behaviours))],
    dungeon: ids(bundle('dungeons.json').dungeons),
    weapon: ids(tuning.weapons),
    ability: ids(tuning.abilities),
    'movement skill': ids(tuning.movementSkills),
    'mini-game': ids(bundle('minigames.json').games),
  };
  const out = new Map();
  for (const [kind, list] of Object.entries(kinds)) for (const id of list) out.set(id, [...new Set([...(out.get(id) ?? []), kind])]);
  return out;
}

/** Every string literal (and template with nothing in it) and every object literal's key in TypeScript. */
export function tsStrings(file, text, want, out = []) {
  const { program } = parseSync(file, text, { lang: 'ts' });
  const lineOf = (pos) => text.slice(0, pos).split('\n').length;
  const add = (s, pos) => {
    if (typeof s === 'string' && want(s)) out.push({ file, line: lineOf(pos), id: s });
  };
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === 'Literal') add(n.value, n.start);
    else if (n.type === 'TemplateLiteral' && n.expressions.length === 0) add(n.quasis[0]?.value?.cooked, n.start);
    else if (n.type === 'Property' && !n.computed && n.key?.type === 'Identifier') add(n.key.name, n.key.start);
    for (const [k, v] of Object.entries(n)) if (k !== 'type' && v && typeof v === 'object') walk(v);
  };
  walk(program);
  return out;
}

/** Every string literal in Rust, outside comments and the items marked #[cfg(test)]. */
export function rustStrings(file, text, want, out = []) {
  let line = 1;
  let i = 0;
  const n = text.length;
  const skipString = () => {
    for (i++; i < n && text[i] !== '"'; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '\n') line++;
    }
  };
  // The item after a #[cfg(test)]: to its first `;`, or the end of its first `{ }`.
  const skipItem = () => {
    let depth = 0;
    for (; i < n; i++) {
      const c = text[i];
      if (c === '\n') line++;
      else if (c === '"') skipString();
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return;
      else if (c === ';' && depth === 0) return;
    }
  };
  for (; i < n; i++) {
    const c = text[i];
    if (c === '\n') line++;
    else if (c === '/' && text[i + 1] === '/') while (i < n && text[i + 1] !== '\n') i++;
    else if (c === '/' && text[i + 1] === '*') {
      for (i += 2; i < n && !(text[i] === '*' && text[i + 1] === '/'); i++) if (text[i] === '\n') line++;
      i++;
    } else if (text.startsWith('#[cfg(test)]', i)) {
      i += '#[cfg(test)]'.length;
      skipItem();
    } else if (c === "'" && text[i + 1] === '\\') {
      // An escaped char literal ('\n', '\'', '\u{1F600}').
      i = text.indexOf("'", i + 3);
    } else if (c === "'" && text[i + 2] === "'") {
      // A char literal ('"'), not a lifetime ('a).
      i += 2;
    } else if (c === '"') {
      const start = i;
      const at = line;
      skipString();
      const s = text.slice(start + 1, i);
      if (want(s)) out.push({ file, line: at, id: s });
    }
  }
  return out;
}

function files(root, dir, ext) {
  const out = [];
  for (const name of readdirSync(join(root, dir))) {
    const p = join(dir, name);
    if (statSync(join(root, p)).isDirectory()) out.push(...files(root, p, ext));
    else if (name.endsWith(ext)) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}

/** Every content id in the game's code: { file, line, id }. */
export function scan(root = '.', ids = contentIds(root)) {
  const out = [];
  const want = (s) => ids.has(s);
  for (const f of files(root, 'src', '.ts')) tsStrings(f, readFileSync(join(root, f), 'utf8'), want, out);
  for (const crate of readdirSync(join(root, 'crates')))
    for (const f of files(root, `crates/${crate}/src`, '.rs')) rustStrings(f, readFileSync(join(root, f), 'utf8'), want, out);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ids = contentIds();
  const found = scan('.', ids);
  if (process.argv.includes('--by-file')) {
    const by = new Map();
    for (const h of found) by.set(h.file, (by.get(h.file) ?? 0) + 1);
    for (const [f, k] of [...by].sort((a, b) => b[1] - a[1])) console.log(`${String(k).padStart(4)} ${f}`);
  } else for (const h of found) console.log(`${h.file}:${h.line}\t${h.id}\t${ids.get(h.id).join(', ')}`);
  console.log(`${found.length} content ids in ${new Set(found.map((h) => h.file)).size} files`);
}
