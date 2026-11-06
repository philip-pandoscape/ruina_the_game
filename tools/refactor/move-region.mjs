// Moves a range of main.ts's top-level statements (lines from-to, nothing in it used outside) into
// `export function <fn>(g: GameRefs)` in <module>, its uses of main.ts's names becoming g.<name>, and
// main.ts calling it there; the refs object main.ts hands its modules gains what the region needs.
// With <object>, the names the region declares that the rest of main.ts uses are given out: the
// function returns them (a `let` as a getter and setter), main.ts keeps what it returns as
// `const <object>`, and its uses of them become <object>.<name>. `refs` must come before the region.
//   node tools/refactor/move-region.mjs <from> <to> <module path> <function name> "<header comment>" [<object>]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseSync } from 'oxc-parser';

const [fromS, toS, modPath, fnName, header, outObj] = process.argv.slice(2);
const from = Number(fromS);
const to = Number(toS);
const file = 'src/main.ts';
const text = readFileSync(file, 'utf8');
const { program } = parseSync(file, text, { lang: 'ts' });
const lineOf = (pos) => text.slice(0, pos).split('\n').length;

const bind = (p, out) => {
  if (!p) return;
  if (p.type === 'Identifier') out.push(p.name);
  else if (p.type === 'ObjectPattern') for (const q of p.properties) bind(q.type === 'RestElement' ? q.argument : q.value, out);
  else if (p.type === 'ArrayPattern') for (const q of p.elements) bind(q?.type === 'RestElement' ? q.argument : q, out);
  else if (p.type === 'AssignmentPattern') bind(p.left, out);
  else if (p.type === 'RestElement') bind(p.argument, out);
};
const declared = (st) => {
  const out = [];
  if (st.type === 'ExportNamedDeclaration' && st.declaration) st = st.declaration;
  if (st.type === 'VariableDeclaration') for (const d of st.declarations) bind(d.id, out);
  else if ((st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') && st.id) out.push(st.id.name);
  else if (st.type === 'ImportDeclaration') for (const s of st.specifiers) out.push(s.local.name);
  return out;
};
const region = program.body.filter((st) => lineOf(st.start) >= from && lineOf(st.end) <= to);
if (!region.length) throw new Error('no statements in range');
const regionStart = region[0].start;
const regionEnd = region[region.length - 1].end;
const top = new Map();
for (const st of program.body) {
  const isImport = st.type === 'ImportDeclaration';
  const inR = st.start >= regionStart && st.end <= regionEnd;
  for (const n of declared(st)) top.set(n, { import: isImport, inRegion: inR });
}

function locals(node) {
  const out = [];
  if (/Function/.test(node.type)) for (const p of node.params ?? []) bind(p, out);
  if (node.type === 'CatchClause' && node.param) bind(node.param, out);
  if (/^For/.test(node.type)) {
    const init = node.init ?? node.left;
    if (init?.type === 'VariableDeclaration') for (const d of init.declarations) bind(d.id, out);
  }
  const body = node.type === 'BlockStatement' ? node.body : node.body?.type === 'BlockStatement' ? node.body.body : [];
  for (const st of body ?? []) out.push(...declared(st));
  return out;
}
const skipKeys = new Set(['typeAnnotation', 'returnType', 'typeParameters', 'typeArguments', 'superTypeArguments']);
const edits = []; // { s, e, name, short }
const assigned = new Set();
let topAwait = false;
function walk(node, parent, key, shadow, depthFn) {
  if (!node || typeof node.type !== 'string') return;
  if (/^TS/.test(node.type) && !/TSAsExpression|TSNonNullExpression|TSSatisfiesExpression|TSTypeAssertion/.test(node.type)) return;
  const isFn = /Function/.test(node.type);
  const scoped = isFn || node.type === 'BlockStatement' || /^For/.test(node.type) || node.type === 'CatchClause';
  const sh = scoped ? new Set([...shadow, ...locals(node)]) : shadow;
  if (node.type === 'AwaitExpression' && depthFn === 0) topAwait = true;
  if (node.type === 'Identifier') {
    const isRef =
      !(parent.type === 'MemberExpression' && key === 'property' && !parent.computed) &&
      !(parent.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand) &&
      !(/MethodDefinition|PropertyDefinition/.test(parent.type) && key === 'key') &&
      !(parent.type === 'VariableDeclarator' && key === 'id') &&
      !(/Function|ClassDeclaration/.test(parent.type) && (key === 'params' || key === 'id')) &&
      !/Labeled|Break|Continue/.test(parent.type);
    const t = top.get(node.name);
    if (isRef && t && !t.import && !t.inRegion && !sh.has(node.name) && !edits.some((x) => x.s === node.start)) {
      const short = parent.type === 'Property' && parent.shorthand;
      edits.push({ s: node.start, e: node.end, name: node.name, short });
      if ((parent.type === 'AssignmentExpression' && key === 'left') || parent.type === 'UpdateExpression') assigned.add(node.name);
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (skipKeys.has(k)) continue;
    if (Array.isArray(v)) for (const c of v) walk(c, node, k, sh, depthFn + (isFn ? 1 : 0));
    else if (v && typeof v.type === 'string') walk(v, node, k, sh, depthFn + (isFn ? 1 : 0));
  }
}
// Region-level declarations shadow nothing outside, but are locals of the new function.
const regionLocals = new Set(region.flatMap(declared));
for (const st of region) walk(st, { type: 'Program' }, 'body', regionLocals, 0);

// What the rest of main.ts uses of the region's names: given out through <object>.
const outEdits = []; // { s, e, name, short }
const lets = new Set();
for (const st of region) if (st.type === 'VariableDeclaration' && st.kind === 'let') for (const n of declared(st)) lets.add(n);
{
  const walkOut = (node, parent, key, shadow) => {
    if (!node || typeof node.type !== 'string') return;
    if (/^TS/.test(node.type) && !/TSAsExpression|TSNonNullExpression|TSSatisfiesExpression|TSTypeAssertion/.test(node.type)) return;
    const scoped = /Function/.test(node.type) || node.type === 'BlockStatement' || /^For/.test(node.type) || node.type === 'CatchClause';
    const sh = scoped ? new Set([...shadow, ...locals(node)]) : shadow;
    if (node.type === 'Identifier' && regionLocals.has(node.name) && !sh.has(node.name)) {
      const isRef =
        !(parent.type === 'MemberExpression' && key === 'property' && !parent.computed) &&
        !(parent.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand) &&
        !(/MethodDefinition|PropertyDefinition/.test(parent.type) && key === 'key') &&
        !(parent.type === 'VariableDeclarator' && key === 'id') &&
        !(/Function|ClassDeclaration/.test(parent.type) && (key === 'params' || key === 'id')) &&
        !/Labeled|Break|Continue/.test(parent.type);
      if (isRef && !outEdits.some((x) => x.s === node.start))
        outEdits.push({ s: node.start, e: node.end, name: node.name, short: parent.type === 'Property' && parent.shorthand });
    }
    for (const [k, v] of Object.entries(node)) {
      if (skipKeys.has(k)) continue;
      if (Array.isArray(v)) for (const c of v) walkOut(c, node, k, sh);
      else if (v && typeof v.type === 'string') walkOut(v, node, k, sh);
    }
  };
  for (const st of program.body)
    if (!(st.start >= regionStart && st.end <= regionEnd) && st.type !== 'ImportDeclaration') walkOut(st, { type: 'Program' }, 'body', new Set());
}
const given = [...new Set(outEdits.map((x) => x.name))].sort();
if (given.length && !outObj) throw new Error(`the rest of main.ts uses ${given.join(' ')}: name an <object> to give them out through`);
if (outObj && text.indexOf('const refs = {\n') > regionStart) throw new Error('refs must come before the region');

// The region's text, rewritten.
let body = text.slice(regionStart, regionEnd);
for (const { s, e, name, short } of [...edits].sort((a, b) => b.s - a.s)) {
  body = body.slice(0, s - regionStart) + (short ? `${name}: g.${name}` : `g.${name}`) + body.slice(e - regionStart);
}
const indent = body
  .split('\n')
  .map((l) => (l ? `  ${l}` : l))
  .join('\n');

// main.ts's imports, from the new module's folder; pruned afterwards.
const depth = modPath.split('/').length - 2; // src/app/x.ts -> 1
const up = depth === 0 ? './' : '../'.repeat(depth);
const imports = [];
for (const m of text.matchAll(/^import (?!['"])[\s\S]*?from '([^']+)';$/gm)) {
  const spec = m[1];
  const path = spec.startsWith('./') ? `${up}${spec.slice(2)}` : spec.startsWith('../') ? `${up}${spec}` : spec;
  imports.push(m[0].replace(`'${spec}'`, `'${path}'`));
}
const used = [...new Set(edits.map((x) => x.name))].sort();
writeFileSync(
  modPath,
  `${header
    .split('\\n')
    .map((l) => `// ${l}`)
    .join(
      '\n',
    )}\n${imports.join('\n')}\nimport type { GameRefs } from '${up}main';\n\nexport ${topAwait ? 'async ' : ''}function ${fnName}(g: GameRefs)${given.length ? '' : `: ${topAwait ? 'Promise<void>' : 'void'}`} {\n${indent}\n${given.length ? `  return {\n${given.map((n) => (lets.has(n) ? `    get ${n}() {\n      return ${n};\n    },\n    set ${n}(v) {\n      ${n} = v;\n    },` : `    ${n},`)).join('\n')}\n  };\n` : ''}}\n`,
);

// main.ts: the call in the region's place, the refs object widened.
const call = `${given.length ? `const ${outObj} = ` : ''}${topAwait ? 'await ' : ''}${fnName}(refs);`;
let main = text;
const all = [...outEdits.map((x) => ({ ...x, out: true })), { s: regionStart, e: regionEnd, region: true }].sort((a, b) => b.s - a.s);
for (const x of all) main = main.slice(0, x.s) + (x.region ? call : x.short ? `${x.name}: ${outObj}.${x.name}` : `${outObj}.${x.name}`) + main.slice(x.e);
const refsStart = main.indexOf('const refs = {\n');
const refsEnd = main.indexOf('\n};\n', refsStart);
if (refsStart < 0 || refsEnd < 0) throw new Error('no refs object');
const refsBody = main.slice(refsStart, refsEnd);
const have = new Set([...refsBody.matchAll(/^ {2}get (\w+)\(\)/gm)].map((m) => m[1]));
const setters = new Set([...refsBody.matchAll(/^ {2}set (\w+)\(/gm)].map((m) => m[1]));
const add = [];
for (const n of used) {
  if (!have.has(n)) add.push(`  get ${n}() {\n    return ${n};\n  },`);
  if (assigned.has(n) && !setters.has(n)) add.push(`  set ${n}(v) {\n    ${n} = v;\n  },`);
}
main = main.slice(0, refsEnd) + (add.length ? `\n${add.join('\n')}` : '') + main.slice(refsEnd);
const modSpec = `./${modPath.replace(/^src\//, '').replace(/\.ts$/, '')}`;
main = main.replace("import { makeTestApi } from './app/testApi';", `import { makeTestApi } from './app/testApi';\nimport { ${fnName} } from '${modSpec}';`);
writeFileSync(file, main);
console.log(
  `${fnName}: ${region.length} statements, ${used.length} names through refs (${add.length} new getters/setters), assigned: ${[...assigned].join(' ') || 'none'}, await: ${topAwait}${given.length ? `, given out through ${outObj}: ${given.join(' ')}` : ''}`,
);
