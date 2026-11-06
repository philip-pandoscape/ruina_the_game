// One time (the refactor's R7.4): splits shared/*.json into content/, a folder per kind and a file
// per thing, with a template per bundle (content/<bundle>.json) that tools/content/contentc.mjs
// follows to build shared/ again. Run it on a tree where content/ doesn't exist yet.
//
//   node tools/content/split.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SHARED = 'shared';
const CONTENT = 'content';
if (existsSync(CONTENT)) throw new Error('content/ is there already: the split is done');

const read = (p) => JSON.parse(readFileSync(join(SHARED, p), 'utf8'));
const write = (p, v) => {
  const f = join(CONTENT, p);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);
};

/** A list of things into a folder, a file each, and the marker that brings them back. */
function things(list, folder, id = 'id') {
  const order = [];
  for (const t of list) {
    const name = String(t[id]);
    if (order.includes(name)) throw new Error(`${folder}: ${name} twice`);
    order.push(name);
    write(`${folder}/${name}.json`, t);
  }
  write(`${folder}/_order.json`, order);
  return id === 'id' ? { $things: folder } : { $things: folder, id };
}
/** A map of things (keyed by id) into a folder, a file each. */
function map(obj, folder) {
  const order = Object.keys(obj);
  for (const [k, v] of Object.entries(obj)) write(`${folder}/${k}.json`, v);
  write(`${folder}/_order.json`, order);
  return { $things: folder, as: 'map' };
}
/** A part of a thing in a file of its own. */
function part(value, path) {
  write(path, value);
  return { $file: path };
}
/** A bundle's template: its keys in their order, with the markers above where the things go. */
function template(file, src, plan) {
  const out = {};
  for (const [k, v] of Object.entries(src)) out[k] = plan[k] ? plan[k](v) : v;
  write(file, out);
}

template('actors.json', read('actors.json'), { kinds: (v) => things(v, 'actors'), ladders: (v) => things(v, 'ladders') });
template('behaviours.json', read('behaviours.json'), { behaviours: (v) => things(v, 'behaviours') });
template('buildings.json', read('buildings.json'), { furniture: (v) => map(v, 'furniture'), plans: (v) => things(v, 'buildings') });
template('farming.json', read('farming.json'), {
  climates: (v) => map(v, 'climates'),
  crops: (v) => things(v, 'crops'),
  gathering: (v) => map(v, 'gathering'),
  animals: (v) => things(v, 'animals'),
});
template('housing.json', read('housing.json'), { blueprints: (v) => things(v, 'blueprints') });
template('items.json', read('items.json'), {
  items: (v) => things(v, 'items'),
  vendors: (v) => things(v, 'vendors', 'npc'),
  recipes: (v) => things(v, 'recipes'),
});
template('minigames.json', read('minigames.json'), { games: (v) => things(v, 'minigames') });
template('quests.json', read('quests.json'), { quests: (v) => things(v, 'quests') });
template('shipyard.json', read('shipyard.json'), { designs: (v) => things(v, 'ship-designs') });
template('structures.json', read('structures.json'), { structures: (v) => things(v, 'structures'), props: (v) => things(v, 'props') });
template('trade.json', read('trade.json'), { packs: (v) => things(v, 'packs'), places: (v) => things(v, 'markets') });
template('traversal.json', read('traversal.json'), {});
template('tuning.json', read('tuning.json'), {
  weapons: (v) => things(v, 'weapons', 'name'),
  abilities: (v) => things(v, 'abilities'),
  stats: (v) => things(v, 'stats'),
  movementSkills: (v) => things(v, 'movement-skills'),
});
template('vehicles.json', read('vehicles.json'), {
  vehicles: (v) => things(v, 'vehicles'),
  mounts: (v) => things(v, 'mounts'),
  gliders: (v) => things(v, 'gliders'),
});
// A creature: its kind, its attacks and its brain, a file each in its own folder.
template('creatures/goblin.json', read('creatures/goblin.json'), {
  kinds: (v) => part(v, 'creatures/goblin/kinds.json'),
  attacks: (v) => part(v, 'creatures/goblin/attacks.json'),
  behaviours: (v) => part(v, 'creatures/goblin/brain.json'),
});
for (const d of ['goblinsDread', 'yard', 'battlefield']) template(`dungeons/${d}.json`, read(`dungeons/${d}.json`), {});
// The island: its recipe, with what's placed on it in files of their own.
const zone = read('zones/emberholm.json');
const zonePlan = {};
for (const k of ['places', 'structures', 'props', 'npcs', 'workbenches', 'outposts', 'housePlots', 'nodes', 'updrafts', 'dungeons', 'forests', 'shipyards']) {
  if (k in zone) zonePlan[k] = (v) => part(v, `zones/emberholm/${k}.json`);
}
template('zones/emberholm.json', zone, zonePlan);
console.log('split into content/');
