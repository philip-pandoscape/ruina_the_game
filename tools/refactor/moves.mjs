// Moves files and folders and rewrites every reference to them, so a move commit changes nothing but
// where things are. The refactor's moves (.plans/refactor) all go through it, and each is logged in
// .plans/refactor/moves.tsv, so the same moves can be replayed on any other branch.
//
//   node tools/refactor/moves.mjs moves.tsv          move what the list says, rewrite, log
//   node tools/refactor/moves.mjs moves.tsv --dry    say what would move and which files would change
//   node tools/refactor/moves.mjs .plans/refactor/moves.tsv --replay   replay the whole log on a branch
//
// A moves list has one move a line: `old<TAB>new`, files or folders, from the repository's root.
// References rewritten: TypeScript/JavaScript imports, exports, dynamic imports, import.meta.glob
// patterns and new URL(..., import.meta.url); CSS url(); Rust include_str!/include_bytes!; root paths
// in HTML src/href; and repo paths written out in full anywhere (docs, tests' path strings, the design
// bible, skills). The plan's own folder keeps the old names: it describes the moves.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { contextFor, isTextFile, parseMoves, rewriteFile } from './moves-lib.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const replay = args.includes('--replay');
const listFile = args.find((a) => !a.startsWith('--'));
if (!listFile) {
  console.error('usage: node tools/refactor/moves.mjs <moves.tsv> [--dry] [--replay]');
  process.exit(2);
}

const LOG = '.plans/refactor/moves.tsv';
const KEEP_OLD_NAMES = ['.plans/refactor/'];

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 });
const root = git('rev-parse', '--show-toplevel').trim();
const listText = readFileSync(path.resolve(listFile), 'utf8');
process.chdir(root);

const files = new Set(git('ls-files', '-z').split('\0').filter(Boolean));
let moves = parseMoves(listText);
if (replay) {
  // On another branch some moves may already be done, or name files that branch never had.
  moves = moves.filter(({ from }) => files.has(from) || [...files].some((f) => f.startsWith(`${from}/`)));
}
const ctx = contextFor(moves, files);

for (const [from, to] of ctx.map) {
  if (files.has(to) && !ctx.map.has(to)) throw new Error(`can't move ${from}: ${to} is already there`);
}

// Rewrite every text against the layout before the moves, then move, then write the new text.
const rewritten = new Map();
for (const f of files) {
  if (!isTextFile(f) || KEEP_OLD_NAMES.some((p) => f.startsWith(p))) continue;
  if (!existsSync(f)) continue;
  const text = readFileSync(f, 'utf8');
  const out = rewriteFile(text, f, ctx);
  if (out !== text) rewritten.set(f, out);
}

console.log(`${ctx.map.size} file${ctx.map.size === 1 ? '' : 's'} to move, ${rewritten.size} to rewrite`);
if (dry) {
  for (const [from, to] of ctx.map) console.log(`  move     ${from} -> ${to}`);
  for (const f of rewritten.keys()) console.log(`  rewrite  ${f}${ctx.map.has(f) ? ` (at ${ctx.map.get(f)})` : ''}`);
  process.exit(0);
}

const touched = [];
for (const [from, to] of ctx.map) {
  mkdirSync(path.dirname(to), { recursive: true });
  renameSync(from, to);
  touched.push(from, to);
}
for (const [f, text] of rewritten) {
  const at = ctx.map.get(f) ?? f;
  writeFileSync(at, text);
  touched.push(at);
}
// Stage the moves as moves (git sees a rename from the deletion and the addition).
if (touched.length) {
  // In a worktree .git is a file, so the list goes in the system's temp folder.
  const list = path.join(tmpdir(), `moves-pathspec-${process.pid}.txt`);
  writeFileSync(list, [...new Set(touched)].join('\0'));
  git('add', '-A', '--pathspec-from-file', list, '--pathspec-file-nul');
  rmSync(list);
}

if (!replay && path.resolve(listFile) !== path.resolve(LOG)) {
  mkdirSync(path.dirname(LOG), { recursive: true });
  if (!existsSync(LOG)) writeFileSync(LOG, '# Every move the refactor made, in order: old<TAB>new (node tools/refactor/moves.mjs replays them).\n');
  appendFileSync(LOG, moves.map(({ from, to }) => `${from}\t${to}`).join('\n') + '\n');
  git('add', LOG);
}
console.log('moved and staged; check with git status, then commit the moves on their own');
