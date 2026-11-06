// Writes content/_schemas/<kind>.schema.json for each kind of thing (each folder a bundle takes
// things from), from the things there now: the fields they have, which every one has, and the
// types each takes. contentc holds every thing to its kind's schema (no unknown field, none
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
  for (const d of ['creatures', 'zones']) for (const f of readdirSync(join(root, d)).filter((x) => x.endsWith('.json'))) tops.push(`${d}/${f}`);
  for (const t of tops) look(JSON.parse(readFileSync(join(root, t), 'utf8')));
  return [...found].sort();
}

/** A schema inferred from the things in `folder`. */
export function infer(folder, root = CONTENT) {
  const dir = join(root, folder);
  const things = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const types = new Map();
  for (const t of things) for (const [k, v] of Object.entries(t)) types.set(k, new Set([...(types.get(k) ?? []), typeOf(v)]));
  const required = [...types.keys()].filter((k) => things.every((t) => k in t));
  const properties = Object.fromEntries([...types].map(([k, ts]) => [k, { type: ts.size === 1 ? [...ts][0] : [...ts].sort() }]));
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', title: folder, type: 'object', properties, required, additionalProperties: false };
}

if (process.argv[1]?.endsWith('schemas.mjs')) {
  mkdirSync(join(CONTENT, '_schemas'), { recursive: true });
  for (const k of kinds()) writeFileSync(join(CONTENT, '_schemas', `${k}.schema.json`), `${JSON.stringify(infer(k), null, 2)}\n`);
  console.log(`schemas for ${kinds().length} kinds in content/_schemas/`);
}
