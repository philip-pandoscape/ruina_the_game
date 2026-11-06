import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// Every path the docs name is there (the refactor's R13.4): AGENTS.md and the other guides for
// agents, docs/, the skills, the README, and the files each feature lists in the design tracker
// (design/status.json). A file moved or deleted without its docs following fails here, naming
// where it's mentioned. Globs and placeholders (`content/items/*.json`, `<id>`) aren't checked.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, '/');

/**
 * The folders a path in the docs can start with: the repository's own, and `server/`, where the
 * server was before crates/ (so any mention of it is out of date).
 */
const TOPS = [
  'src/',
  'crates/',
  'content/',
  'shared/',
  'tests/',
  'tools/',
  'docs/',
  'design/',
  'dev/',
  'bible/',
  'public/',
  '.plans/',
  '.claude/',
  '.github/',
  'server/',
];

function markdown(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const p = join(ROOT, dir, name);
    if (['node_modules', 'target', 'scratch', 'dist', 'test-results', '.git'].includes(name)) continue;
    // Agents' worktrees: each a checkout of its own, with its own docs, checked there.
    if (rel(p) === '.claude/worktrees') continue;
    if (statSync(p).isDirectory()) markdown(rel(p), out);
    else if (name === 'AGENTS.md' || name === 'SKILL.md' || (dir === 'docs' && name.endsWith('.md'))) out.push(rel(p));
  }
  return out;
}

/** The repository paths a document names in backticks, with the line each is on. */
function namedPaths(text: string): Array<{ path: string; line: number }> {
  const out: Array<{ path: string; line: number }> = [];
  text.split('\n').forEach((l, i) => {
    for (const m of l.matchAll(/`([^`\s]+)`/g)) {
      let p = m[1].replace(/[.,;:)]+$/, '');
      // A line or symbol after the file (`main.rs:42`, `file.ts#name`) is about the file.
      p = p.replace(/:\d+(-\d+)?$/, '').replace(/#.*$/, '');
      if (!TOPS.some((t) => p.startsWith(t))) continue;
      if (/[*<>{}|]|\.\.\./.test(p)) continue;
      out.push({ path: p, line: i + 1 });
    }
  });
  return out;
}

test('every path the guides, docs and skills name is there', () => {
  const docs = [...markdown('.'), 'README.md', 'CREDITS.md'].filter((f) => existsSync(join(ROOT, f)));
  const missing: string[] = [];
  for (const f of docs) {
    for (const { path, line } of namedPaths(readFileSync(join(ROOT, f), 'utf8'))) {
      if (!existsSync(join(ROOT, path))) missing.push(`${f}:${line} names ${path}`);
    }
  }
  expect(missing, 'paths named in the docs that are not there: update the doc (or the path)').toEqual([]);
});

test('every file a feature lists in the design tracker is there', () => {
  const status = JSON.parse(readFileSync(join(ROOT, 'design/status.json'), 'utf8')) as { features: Array<{ title: string; files?: string[] }> };
  const missing = status.features.flatMap((f) =>
    (f.files ?? []).filter((p) => !/[*<>{}]/.test(p) && !existsSync(join(ROOT, p))).map((p) => `${f.title}: ${p}`),
  );
  expect(missing, 'files in design/status.json features that are not there: point them at where the code is now').toEqual([]);
});
