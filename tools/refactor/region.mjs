// For a range of main.ts's top-level statements (by line): the top-level names it uses from outside
// (in) and the names it declares that the rest of main.ts uses (out).
//   node tools/refactor/region.mjs <fromLine> <toLine>
import { readFileSync } from 'node:fs';
import { parseSync } from 'oxc-parser';

const [from, to] = process.argv.slice(2).map(Number);
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
const inside = (st) => lineOf(st.start) >= from && lineOf(st.end) <= to;
const topNames = new Map();
for (const st of program.body) for (const n of declared(st)) topNames.set(n, { inRegion: inside(st), import: st.type === 'ImportDeclaration' });

// References to top-level names, by where they occur (crude scope handling: names declared inside
// a function or block that shadow a top-level one are skipped).
const refs = []; // { name, pos }
const skipKeys = new Set(['typeAnnotation', 'returnType', 'typeParameters', 'typeArguments', 'superTypeArguments']);
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
function walk(node, parent, key, shadow, top) {
  if (!node || typeof node.type !== 'string') return;
  if (/^TS/.test(node.type) && !/TSAsExpression|TSNonNullExpression|TSSatisfiesExpression|TSTypeAssertion/.test(node.type)) return;
  const scoped = !top && (/Function/.test(node.type) || node.type === 'BlockStatement' || /^For/.test(node.type) || node.type === 'CatchClause');
  const sh = scoped ? new Set([...shadow, ...locals(node)]) : shadow;
  if (node.type === 'Identifier') {
    const isRef =
      !(parent.type === 'MemberExpression' && key === 'property' && !parent.computed) &&
      !(parent.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand) &&
      !(/MethodDefinition|PropertyDefinition/.test(parent.type) && key === 'key') &&
      !(parent.type === 'VariableDeclarator' && key === 'id') &&
      !(/Function|ClassDeclaration/.test(parent.type) && (key === 'params' || key === 'id')) &&
      !/Labeled|Break|Continue/.test(parent.type) &&
      !(parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier');
    if (isRef && topNames.has(node.name) && !sh.has(node.name)) refs.push({ name: node.name, pos: node.start });
  }
  for (const [k, v] of Object.entries(node)) {
    if (skipKeys.has(k)) continue;
    if (Array.isArray(v)) for (const c of v) walk(c, node, k, sh, false);
    else if (v && typeof v.type === 'string') walk(v, node, k, sh, false);
  }
}
for (const st of program.body) walk(st, program, 'body', new Set(), true);

const inRegion = (pos) => lineOf(pos) >= from && lineOf(pos) <= to;
const ins = new Map();
const outs = new Map();
for (const r of refs) {
  const t = topNames.get(r.name);
  if (inRegion(r.pos) && !t.inRegion) ins.set(r.name, t.import ? 'import' : 'main');
  if (!inRegion(r.pos) && t.inRegion) outs.set(r.name, (outs.get(r.name) ?? 0) + 1);
}
const fromMain = [...ins]
  .filter(([, k]) => k === 'main')
  .map(([n]) => n)
  .sort();
const fromImports = [...ins]
  .filter(([, k]) => k === 'import')
  .map(([n]) => n)
  .sort();
console.log(`lines ${from}-${to}`);
console.log(`in from main (${fromMain.length}):`, fromMain.join(' '));
console.log(`in from imports (${fromImports.length}):`, fromImports.join(' '));
console.log(`out (${outs.size}):`, [...outs].map(([n, c]) => `${n}x${c}`).join(' '));
