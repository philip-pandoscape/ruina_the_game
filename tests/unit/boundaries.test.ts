import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { expect, test } from 'vitest';

// Which of src/'s areas (AGENTS.md's layout) may import which. The rules are the engine's
// (crates/engine), and the client reaches them only through the bridge (src/engine/), which knows
// nothing of drawing, the page, the network or the UI; content is data, read by everything; util is
// beneath everything. An import across a line not allowed here fails this test; the few that
// already cross one are listed below with the task that removes them.

/** What each area may not import. */
const FORBIDDEN: Record<string, string[]> = {
  util: ['*'],
  // The asset manifest and loader: beneath everything that draws, knowing files and not what's in them.
  assets: ['engine', 'content', 'render', 'ui', 'net', 'app', 'input', 'dev', 'bible', '(root:main)'],
  // The bridge to the rules (src/engine/): content beneath it, nothing that draws, talks or shows.
  engine: ['render', 'ui', 'net', 'app', 'input', 'dev', 'bible', '(root:main)'],
  content: ['engine', 'render', 'ui', 'net', 'app', 'input', 'dev', 'bible', '(root:main)'],
  input: ['render', 'ui', 'net', 'app', 'dev', 'bible', '(root:main)'],
  // Drawing and the network don't know each other (R6.0): the network keeps what the server says, the
  // drawing draws what it's handed, and the app hands one to the other.
  // Drawing doesn't reach into the windows either (R6.0): what a window draws in three.js it hosts
  // (the hero preview), handed what it needs.
  render: ['net', 'ui', 'app', 'dev', 'bible', '(root:main)'],
  net: ['render', 'ui', 'dev', 'bible', '(root:main)'],
  // The windows show what they're handed and ask the app for what they do (R6.0): sign-in, characters,
  // parties and mini-games declare the calls they make, and the app hands them the connection.
  ui: ['net', 'app', 'bible', '(root:main)'],
};

/**
 * The bridge's front doors: what the rest of the client may import from src/engine/. What's behind
 * them (the shapes, the world's ground and roads, a life's and the creatures' read helpers, the
 * session, the WebAssembly) is reached through them, so each names exactly what is used.
 */
const FRONT = ['engine', 'load', 'minigames', 'rules', 'zone', 'life', 'creatures'];

/** Imports across a line today, each with what will remove it (.plans/refactor/tracker.md). */
const KNOWN: Record<string, string> = {};

const files: string[] = [];
(function walk(d: string) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.ts')) files.push(p);
  }
})('src');

const areaOf = (p: string) => {
  const r = relative('src', p).replace(/\\/g, '/');
  return r.includes('/') ? r.split('/')[0] : `(root:${r.replace(/\.ts$/, '')})`;
};

test("no area imports what it mustn't", () => {
  const crossings: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const from = areaOf(f);
    const forbidden = FORBIDDEN[from];
    if (!forbidden) continue;
    for (const m of readFileSync(f, 'utf8').matchAll(/^(?:import|export)\s+(?:type\s+)?[^'"]*?from\s+'(\.[^']+)'/gm)) {
      // The bible reads the rules' source as text, for numbers they don't export (src/bible/source.ts).
      if (m[1].endsWith('?raw')) continue;
      const target = normalize(join(dirname(f), m[1]));
      const to = areaOf(target.endsWith('.ts') ? target : `${target}.ts`);
      if (to === from || !(forbidden.includes('*') || forbidden.includes(to))) continue;
      const key = `${relative('src', f).replace(/\\/g, '/')} -> ${to}`;
      seen.add(key);
      if (!KNOWN[key]) crossings.push(`${key} (${m[1]})`);
    }
  }
  expect(crossings).toEqual([]);
  // A known crossing that's gone comes off the list.
  expect(Object.keys(KNOWN).filter((k) => !seen.has(k))).toEqual([]);
});

test('the rest of the client reaches the rules through the bridge’s front doors', () => {
  const behind: string[] = [];
  for (const f of files) {
    if (areaOf(f) === 'engine') continue;
    for (const m of readFileSync(f, 'utf8').matchAll(/^(?:import|export)\s+(?:type\s+)?[^'"]*?from\s+'(\.[^']+)'/gm)) {
      if (m[1].endsWith('?raw')) continue;
      const target = relative('src', normalize(join(dirname(f), m[1]))).replace(/\\/g, '/');
      if (!target.startsWith('engine/')) continue;
      if (!FRONT.includes(target.slice('engine/'.length).replace(/\.ts$/, ''))) behind.push(`${relative('src', f).replace(/\\/g, '/')} -> ${target}`);
    }
  }
  expect(behind).toEqual([]);
});
