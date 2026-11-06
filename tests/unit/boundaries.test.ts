import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { expect, test } from 'vitest';

// Which of src/'s areas (AGENTS.md's layout) may import which. The rules (sim/) are pure: they
// know nothing of drawing, the page, the network or the UI, so the server's engine can stand in for
// them and the tests can run them without a browser; content is data, read by everything; util is
// beneath everything. An import across a line not allowed here fails this test; the few that
// already cross one are listed below with the task that removes them.

/** What each area may not import. Areas not listed (app, library, dev, bible, main.ts) may import anything. */
const FORBIDDEN: Record<string, string[]> = {
  util: ['*'],
  // The asset manifest and loader: beneath everything that draws, knowing files and not what's in them.
  assets: ['sim', 'content', 'render', 'ui', 'net', 'app', 'input', 'library', 'dev', 'bible', 'crowd', 'species', 'creatures', '(root:main)'],
  sim: ['render', 'ui', 'net', 'app', 'input', 'library', 'dev', 'bible', 'crowd', 'species', 'creatures', '(root:main)'],
  content: ['sim', 'species', 'render', 'ui', 'net', 'app', 'input', 'library', 'dev', 'bible', 'crowd', 'creatures', '(root:main)'],
  input: ['render', 'ui', 'net', 'app', 'library', 'dev', 'bible', '(root:main)'],
  render: ['app', 'library', 'dev', 'bible', '(root:main)'],
  net: ['ui', 'library', 'dev', 'bible', '(root:main)'],
  ui: ['library', 'bible', '(root:main)'],
  species: ['ui', 'net', 'app', 'library', 'dev', 'bible', '(root:main)'],
  creatures: ['ui', 'net', 'app', 'library', 'dev', 'bible', '(root:main)'],
  crowd: ['ui', 'net', 'app', 'library', 'dev', 'bible', '(root:main)'],
};

/** Imports across a line today, each with what will remove it (.plans/refactor/tracker.md). */
const KNOWN: Record<string, string> = {
  'content/actors.ts -> sim': "R6.0: content's actor kinds and the rules' actor record lean on each other",
  'content/creatures/hero.ts -> species': "R6.0: the hero's content builds a three.js body",
};

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
