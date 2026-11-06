import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { expect, test } from 'vitest';

// Which of src/'s areas (AGENTS.md's layout) may import which. The rules (sim/) are pure: they
// know nothing of drawing, the page, the network or the UI, so the server's engine can stand in for
// them and the tests can run them without a browser; content is data, read by everything; util is
// beneath everything. An import across a line not allowed here fails this test; the few that
// already cross one are listed below with the task that removes them.

/** What each area may not import. Areas not listed (app, dev, bible, main.ts) may import anything. */
const FORBIDDEN: Record<string, string[]> = {
  util: ['*'],
  // The asset manifest and loader: beneath everything that draws, knowing files and not what's in them.
  assets: ['sim', 'content', 'render', 'ui', 'net', 'app', 'input', 'dev', 'bible', '(root:main)'],
  sim: ['render', 'ui', 'net', 'app', 'input', 'dev', 'bible', '(root:main)'],
  // The bridge to the rules (src/engine/): the rules and content beneath it, nothing that draws, talks or shows.
  engine: ['render', 'ui', 'net', 'app', 'input', 'dev', 'bible', '(root:main)'],
  content: ['sim', 'render', 'ui', 'net', 'app', 'input', 'dev', 'bible', '(root:main)'],
  input: ['render', 'ui', 'net', 'app', 'dev', 'bible', '(root:main)'],
  // Drawing and the network don't know each other (R6.0): the network keeps what the server says, the
  // drawing draws what it's handed, and the app hands one to the other.
  render: ['net', 'app', 'dev', 'bible', '(root:main)'],
  net: ['render', 'ui', 'dev', 'bible', '(root:main)'],
  // The windows show what they're handed and ask the app for what they do (R6.0): sign-in, characters,
  // parties and mini-games declare the calls they make, and the app hands them the connection.
  ui: ['net', 'bible', '(root:main)'],
};

/** Imports across a line today, each with what will remove it (.plans/refactor/tracker.md). */
const KNOWN: Record<string, string> = {
  'content/actors.ts -> sim': "R6.0: content's actor kinds and the rules' actor record lean on each other",
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
