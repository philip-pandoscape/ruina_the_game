// The logic behind tools/refactor/moves.mjs: given which files move where, rewrite every reference
// to them so the code, the tests and the docs still point at the same things. Pure functions over
// strings and repo paths (forward slashes, from the repo root), tested in tests/unit/tools/moves.test.ts.

import path from 'node:path/posix';

/** What an extension-less import can stand for, in the order the bundler tries them. */
export const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.json'];

/** The files whose text can name other files: everything else is left alone. */
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.html',
  '.css',
  '.md',
  '.yml',
  '.yaml',
  '.toml',
  '.rs',
  '.txt',
  '.tsv',
]);
const TEXT_NAMES = new Set(['Dockerfile', '.dockerignore', '.gitignore', '.gitattributes']);

export function isTextFile(file) {
  const base = path.basename(file);
  return TEXT_NAMES.has(base) || TEXT_EXTENSIONS.has(path.extname(file));
}

/**
 * Reads a moves list: one move a line, `old<TAB>new` (files or folders, repo-relative), `#` comments
 * and blank lines ignored.
 */
export function parseMoves(text) {
  const moves = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [from, to] = line.split('\t').map((s) => s.trim().replace(/\\/g, '/').replace(/\/+$/, ''));
    if (!from || !to) throw new Error(`a move needs "old<TAB>new": ${raw}`);
    moves.push({ from, to });
  }
  return moves;
}

/**
 * Turns moves (of files or whole folders) into one old-to-new path for every file that moves,
 * given the repository's files. A folder move takes everything under it.
 */
export function expandMoves(moves, files) {
  const map = new Map();
  for (const { from, to } of moves) {
    if (files.has(from)) {
      map.set(from, to);
      continue;
    }
    const prefix = `${from}/`;
    let any = false;
    for (const f of files) {
      if (f.startsWith(prefix)) {
        map.set(f, `${to}/${f.slice(prefix.length)}`);
        any = true;
      }
    }
    if (!any) throw new Error(`nothing to move at ${from}`);
  }
  return map;
}

/** Where a file ends up: its new path if it moves, else where it is. */
const placeOf = (file, map) => map.get(file) ?? file;

/** A relative path from one folder to a file or folder, written as an import would write it. */
function relativeFrom(dir, target) {
  let rel = path.relative(dir, target);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

/**
 * Resolves a relative specifier written in `fromFile` the way the bundler does: as written, then
 * with each script extension, then as a folder's index. Returns the repo path and how it was
 * written ('exact', 'extension' added, or 'index' of a folder), or null if it names nothing known.
 */
export function resolveSpecifier(fromFile, specPath, exists) {
  const base = path.normalize(path.join(path.dirname(fromFile), specPath));
  if (exists(base)) return { file: base, form: 'exact' };
  for (const ext of SCRIPT_EXTENSIONS) if (exists(base + ext)) return { file: base + ext, form: 'extension', ext };
  for (const ext of SCRIPT_EXTENSIONS) if (exists(`${base}/index${ext}`)) return { file: `${base}/index${ext}`, form: 'index', ext };
  return null;
}

/**
 * The specifier `fromFile` (now at `fromNew`) should write for what it wrote as `spec`, after the
 * moves. Keeps the way it was written: with or without the extension, or naming a folder for its
 * index; keeps any `?query`. Returns the spec unchanged if it names nothing known.
 */
export function respecify(fromFile, fromNew, spec, map, exists) {
  const q = spec.indexOf('?');
  const specPath = q < 0 ? spec : spec.slice(0, q);
  const query = q < 0 ? '' : spec.slice(q);
  const hit = resolveSpecifier(fromFile, specPath, exists);
  if (!hit) return spec;
  const target = placeOf(hit.file, map);
  if (target === hit.file && fromNew === fromFile) return spec;
  const dir = path.dirname(fromNew);
  let written;
  if (hit.form === 'exact') written = relativeFrom(dir, target);
  else if (hit.form === 'extension') {
    written = target.endsWith(hit.ext) ? relativeFrom(dir, target.slice(0, -hit.ext.length)) : relativeFrom(dir, target);
  } else {
    const name = `index${hit.ext}`;
    written = path.basename(target) === name ? relativeFrom(dir, path.dirname(target)) : relativeFrom(dir, target);
  }
  // Keep the "./" or "../" style the bundler needs, and a trailing slash if the original had one.
  return written + query;
}

/**
 * Where a folder ends up: the destination of a folder move that covers it, or of every file under
 * it if they all moved to one place, else where it is.
 */
export function folderPlace(dir, moves, map, files) {
  for (const { from, to } of moves) {
    if (dir === from) return to;
    if (dir.startsWith(`${from}/`)) return `${to}/${dir.slice(from.length + 1)}`;
  }
  const prefix = `${dir}/`;
  let place = null;
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    const to = placeOf(f, map);
    const rest = f.slice(prefix.length);
    if (!to.endsWith(`/${rest}`)) return dir;
    const there = to.slice(0, -(rest.length + 1));
    if (place === null) place = there;
    else if (place !== there) return dir;
  }
  return place ?? dir;
}

/** An `import.meta.glob` pattern written in `fromFile`, after the moves (its folder may have moved). */
export function reglob(fromFile, fromNew, pattern, moves, map, files) {
  const star = pattern.search(/[*{[]/);
  const fixed = star < 0 ? pattern : pattern.slice(0, star);
  const slash = fixed.lastIndexOf('/');
  const dirPart = slash < 0 ? '.' : fixed.slice(0, slash);
  const rest = slash < 0 ? pattern : pattern.slice(slash + 1);
  const dirOld = path.normalize(path.join(path.dirname(fromFile), dirPart));
  const dirNew = folderPlace(dirOld, moves, map, files);
  if (dirNew === dirOld && fromNew === fromFile) return pattern;
  return `${relativeFrom(path.dirname(fromNew), dirNew)}/${rest}`;
}

// Where scripts name other files: import/export ... from, side-effect imports, dynamic import(),
// require(), new URL(..., import.meta.url). Only relative specifiers ('./', '../') are rewritten.
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]*)\2/g;
const URL_SPECIFIER = /(\bnew\s+URL\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]*)\2(\s*,\s*import\.meta\.url)/g;
// new URL(`../shared/${file}`, import.meta.url): the fixed part before the first ${...} is a folder.
const URL_TEMPLATE = /(\bnew\s+URL\s*\(\s*`)(\.{1,2}\/(?:[^`$\n]*\/)?)(\$\{[^`\n]*`\s*,\s*import\.meta\.url)/g;
const GLOB_CALL = /import\.meta\.glob(?:<[^>]*>)?\s*\(\s*(\[[^\]]*\]|(['"])[^'"\n]*\2)/g;
const GLOB_STRING = /(['"])(\.{1,2}\/[^'"\n]*)\1/g;
// Rust includes, CSS urls, and root paths in HTML attributes.
const RUST_INCLUDE = /(\binclude_(?:str|bytes)!\s*\(\s*)"(\.{1,2}\/[^"\n]*)"/g;
const CSS_URL = /(\burl\(\s*)(['"]?)(\.{1,2}\/[^'")\n]+)\2(\s*\))/g;
const HTML_ROOT = /(\b(?:src|href)\s*=\s*)(['"])(\/[^'"\n]*)\2/g;

/** Rewrites the relative specifiers in a script (TypeScript or JavaScript) for the moves. */
export function rewriteScript(text, fromFile, fromNew, ctx) {
  const { map, exists, moves, files } = ctx;
  let out = text.replace(GLOB_CALL, (call) =>
    call.replace(GLOB_STRING, (s, quote, pattern) => `${quote}${reglob(fromFile, fromNew, pattern, moves, map, files)}${quote}`),
  );
  out = out.replace(SPECIFIER, (m, lead, quote, spec) => `${lead}${quote}${respecify(fromFile, fromNew, spec, map, exists)}${quote}`);
  out = out.replace(URL_SPECIFIER, (m, lead, quote, spec, tail) => `${lead}${quote}${respecify(fromFile, fromNew, spec, map, exists)}${quote}${tail}`);
  out = out.replace(URL_TEMPLATE, (m, lead, dirSpec, tail) => `${lead}${refolder(fromFile, fromNew, dirSpec, moves, map, files)}${tail}`);
  return out;
}

/** A folder written relative to `fromFile` (ending in '/'), after the moves: the folder may have moved, or the file. */
export function refolder(fromFile, fromNew, dirSpec, moves, map, files) {
  const dirOld = path.normalize(path.join(path.dirname(fromFile), dirSpec));
  const clean = dirOld === '.' || dirOld === './' ? '' : dirOld.replace(/\/$/, '');
  const dirNew = clean === '' ? '' : folderPlace(clean, moves, map, files);
  if (dirNew === clean && fromNew === fromFile) return dirSpec;
  const rel = path.relative(path.dirname(fromNew), dirNew === '' ? '.' : dirNew) || '.';
  return `${rel.startsWith('.') ? rel : `./${rel}`}/`;
}

/** Rewrites `include_str!`/`include_bytes!` paths in Rust (relative to the .rs file). */
export function rewriteRust(text, fromFile, fromNew, ctx) {
  return text.replace(RUST_INCLUDE, (m, lead, spec) => `${lead}"${respecify(fromFile, fromNew, spec, ctx.map, ctx.exists)}"`);
}

/** Rewrites relative `url(...)` in CSS. */
export function rewriteCss(text, fromFile, fromNew, ctx) {
  return text.replace(CSS_URL, (m, lead, quote, spec, tail) => `${lead}${quote}${respecify(fromFile, fromNew, spec, ctx.map, ctx.exists)}${quote}${tail}`);
}

/** Rewrites root paths (`/src/main.ts`) in HTML `src` and `href` attributes. */
export function rewriteHtmlRoots(text, ctx) {
  return text.replace(HTML_ROOT, (m, lead, quote, abs) => {
    const q = abs.indexOf('?');
    const file = (q < 0 ? abs : abs.slice(0, q)).slice(1);
    const query = q < 0 ? '' : abs.slice(q);
    const to = ctx.map.get(file);
    return to ? `${lead}${quote}/${to}${query}${quote}` : m;
  });
}

/**
 * Rewrites repo paths written out in full (`src/render/detail/humanoid.ts`, `server/src/`) in any
 * text: docs, tests' path strings, the design bible, the skills. A path counts only as a whole word:
 * not inside a longer path (`../src/x.ts` is a specifier, handled above) or name.
 */
export function rewriteRepoPaths(text, ctx) {
  const { pathReplacements } = ctx;
  if (!pathReplacements.length) return text;
  return text.replace(ctx.pathPattern, (m) => pathReplacements.find(([from]) => from === m)?.[1] ?? m);
}

/** The replacements for repo paths written out: every moved file, and every moved folder (as `dir/` and `dir`). */
export function pathReplacementsFor(moves, map) {
  const pairs = new Map();
  for (const [from, to] of map) pairs.set(from, to);
  for (const { from, to } of moves) {
    if (map.has(from)) continue;
    pairs.set(`${from}/`, `${to}/`);
    pairs.set(from, to);
  }
  // Longest first, so a file inside a moved folder takes its own entry.
  const list = [...pairs].sort((a, b) => b[0].length - a[0].length);
  const escaped = list.map(([from]) => from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = escaped.length ? new RegExp(`(?<![A-Za-z0-9_./-])(?:${escaped.join('|')})(?![A-Za-z0-9_\\-]|\\.[A-Za-z0-9])`, 'g') : /$^/;
  return { pathReplacements: list, pathPattern: pattern };
}

/** Everything one file's text needs after the moves, by the kind of file it is. */
export function rewriteFile(text, fromFile, ctx) {
  const fromNew = placeOf(fromFile, ctx.map);
  const ext = path.extname(fromFile);
  let out = text;
  if (['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs'].includes(ext)) out = rewriteScript(out, fromFile, fromNew, ctx);
  if (ext === '.html') {
    out = rewriteScript(out, fromFile, fromNew, ctx);
    out = rewriteHtmlRoots(out, ctx);
  }
  if (ext === '.rs') out = rewriteRust(out, fromFile, fromNew, ctx);
  if (ext === '.css') out = rewriteCss(out, fromFile, fromNew, ctx);
  out = rewriteRepoPaths(out, ctx);
  return out;
}

/** The context the rewrites share, from the moves and the repository's files. */
export function contextFor(moves, files) {
  const map = expandMoves(moves, files);
  return { map, moves, files, exists: (f) => files.has(f), ...pathReplacementsFor(moves, map) };
}
