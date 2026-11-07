// Writes content/_schemas/<kind>.schema.json for each kind of thing (each folder a bundle takes
// things from), from the things there now: the fields they have, which every one has, and the
// types each takes; and of a thing's look and a cave's dressing (src/content/looks.ts), the fields
// they have and their types. contentc holds every thing to its kind's schema (no unknown field, none
// missing, the right types), and an editor can too (content/AGENTS.md says how). Run it again after
// adding a field on purpose, and look at what changed before committing.
//
//   node tools/content/schemas.mjs
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTENT = 'content';
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? 'number' : typeof v);

/** The folders bundles take things from, found in the templates' markers. */
export function kinds(root = CONTENT) {
  const found = new Set();
  const look = (v) => {
    if (Array.isArray(v)) return v.forEach(look);
    if (!v || typeof v !== 'object') return;
    if (typeof v.$things === 'string') found.add(v.$things);
    Object.values(v).forEach(look);
  };
  const tops = readdirSync(root).filter((f) => f.endsWith('.json'));
  for (const d of ['regions']) for (const f of readdirSync(join(root, d)).filter((x) => x.endsWith('.json'))) tops.push(`${d}/${f}`);
  for (const t of tops) look(JSON.parse(readFileSync(join(root, t), 'utf8')));
  return [...found].sort();
}

/** A part of a thing as its bundle has it: one in a file of its own ({"$file": path}, a creature's kinds) read in. */
const part = (v, root) => (v && typeof v === 'object' && typeof v.$file === 'string' ? JSON.parse(readFileSync(join(root, v.$file), 'utf8')) : v);
const withParts = (thing, root) => Object.fromEntries(Object.entries(thing).map(([k, v]) => [k, part(v, root)]));

/** Fields with fields of their own, held to the schema as a thing's are (none of theirs required). */
const NESTED = ['look', 'dressing'];
/** Fields a thing may always leave out, though every one there is has it: without a look, a thing is drawn with its kind's plain body. */
const OPTIONAL = ['look'];

/** The fields the values have, and the types each takes. */
function fieldsOf(values) {
  const types = new Map();
  for (const t of values) for (const [k, v] of Object.entries(t)) types.set(k, new Set([...(types.get(k) ?? []), typeOf(v)]));
  return Object.fromEntries([...types].map(([k, ts]) => [k, { type: ts.size === 1 ? [...ts][0] : [...ts].sort() }]));
}

/** A schema inferred from the things in `folder`. */
export function infer(folder, root = CONTENT) {
  const dir = join(root, folder);
  const things = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => withParts(JSON.parse(readFileSync(join(dir, f), 'utf8')), root));
  const properties = fieldsOf(things);
  const required = Object.keys(properties).filter((k) => !OPTIONAL.includes(k) && things.every((t) => k in t));
  for (const k of NESTED) {
    const values = things.map((t) => t[k]).filter((v) => typeOf(v) === 'object');
    if (values.length) Object.assign(properties[k], { properties: fieldsOf(values), additionalProperties: false });
  }
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', title: folder, type: 'object', properties, required, additionalProperties: false };
}

if (process.argv[1]?.endsWith('schemas.mjs')) {
  mkdirSync(join(CONTENT, '_schemas'), { recursive: true });
  for (const k of kinds()) writeFileSync(join(CONTENT, '_schemas', `${k}.schema.json`), `${JSON.stringify(infer(k), null, 2)}\n`);
  console.log(`schemas for ${kinds().length} kinds in content/_schemas/`);
}
