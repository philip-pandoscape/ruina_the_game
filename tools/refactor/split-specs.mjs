// After tools/refactor/port-spec.mjs: each test of a ported spec goes to the tier it runs in. The
// ones that pass headless (Vitest's JSON report of tests/unit/rules) stay in tests/unit/rules and
// leave tests/integration; the rest stay in tests/integration and leave tests/unit/rules. A file left
// with no tests is deleted; top-level helpers and imports nothing uses any more are dropped.
//   node tools/refactor/split-specs.mjs <vitest json report> <name>...
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { parseSync } from 'oxc-parser';

const [report, ...names] = process.argv.slice(2);
const results = JSON.parse(readFileSync(report, 'utf8')).testResults;

/** Every test() call in a file (at the top or in describe blocks): its title and span, with the comment lines just above it. */
function tests(file, text) {
  const { program } = parseSync(file, text, { lang: 'ts' });
  const out = [];
  const visit = (body) => {
    for (const st of body) {
      const c = st.type === 'ExpressionStatement' ? st.expression : null;
      if (c?.type !== 'CallExpression') continue;
      const callee = c.callee;
      const isTest = callee.type === 'Identifier' && callee.name === 'test';
      const isDescribe = callee.type === 'MemberExpression' && callee.object.name === 'test' && callee.property.name === 'describe';
      if (isDescribe) {
        const fn = c.arguments.find((a) => /Function/.test(a.type));
        if (fn?.body?.body) visit(fn.body.body);
        continue;
      }
      if (!isTest) continue;
      const a = c.arguments[0];
      const title = a.type === 'Literal' ? a.value : a.type === 'TemplateLiteral' && a.expressions.length === 0 ? a.quasis[0].value.cooked : null;
      if (title === null) throw new Error(`${file}: a test whose title isn't a plain string at ${st.start}`);
      // Back over the comment lines right above it.
      let start = text.lastIndexOf('\n', st.start - 1) + 1;
      for (;;) {
        const prevEnd = start - 1;
        if (prevEnd <= 0) break;
        const prevStart = text.lastIndexOf('\n', prevEnd - 1) + 1;
        const line = text.slice(prevStart, prevEnd).trim();
        if (!/^(\/\/|\/\*|\*)/.test(line)) break;
        start = prevStart;
      }
      let end = st.end;
      if (text[end] === '\n') end++;
      out.push({ title, start, end });
    }
  };
  visit(program.body);
  return out;
}

function drop(file, keep) {
  const text = readFileSync(file, 'utf8');
  const all = tests(file, text);
  const gone = all.filter((t) => !keep(t.title));
  let s = text;
  for (const t of gone.sort((a, b) => b.start - a.start)) {
    s = s.slice(0, t.start) + s.slice(t.end);
  }
  s = s.replace(/\n{3,}/g, '\n\n');
  writeFileSync(file, s);
  return { kept: all.length - gone.length, all: all.length };
}

const touched = [];
for (const name of names) {
  const unit = `tests/unit/rules/${name}.test.ts`;
  const integ = `tests/integration/${name}.spec.ts`;
  const r = results.find((x) => x.name.endsWith(`/rules/${name}.test.ts`));
  if (!r) throw new Error(`no results for ${name}`);
  const passed = new Set(r.assertionResults.filter((a) => a.status === 'passed').map((a) => a.title));
  const u = drop(unit, (t) => passed.has(t));
  const i = drop(integ, (t) => !passed.has(t));
  console.log(`${name}: ${u.kept} headless, ${i.kept} in a page`);
  if (u.kept === 0) unlinkSync(unit);
  else touched.push(unit);
  if (i.kept === 0) unlinkSync(integ);
  else touched.push(integ);
}

// Top-level declarations nothing uses any more, then imports, until none are left.
for (let round = 0; round < 6; round++) {
  let out = '';
  try {
    execSync('npx tsc --noEmit -p .', { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    out = e.stdout;
  }
  let changed = false;
  for (const f of touched) {
    const text = readFileSync(f, 'utf8');
    const lines = new Set();
    for (const m of out.matchAll(/^([^(\n]+)\((\d+),(\d+)\): error TS6133: '([^']+)' is declared but its value is never read\.$/gm)) {
      if (m[1] === f) lines.add(Number(m[2]));
    }
    if (!lines.size) continue;
    const { program } = parseSync(f, text, { lang: 'ts' });
    const lineOf = (pos) => text.slice(0, pos).split('\n').length;
    const spans = [];
    for (const st of program.body) {
      if (st.type === 'ImportDeclaration') continue;
      const d = st.type === 'ExportNamedDeclaration' ? st.declaration : st;
      if (!d || !/VariableDeclaration|FunctionDeclaration|TSTypeAliasDeclaration|TSInterfaceDeclaration/.test(d.type)) continue;
      if (lines.has(lineOf(st.start)) || lines.has(lineOf(d.id?.start ?? d.declarations?.[0]?.id?.start ?? st.start))) {
        let start = text.lastIndexOf('\n', st.start - 1) + 1;
        for (;;) {
          const prevEnd = start - 1;
          if (prevEnd <= 0) break;
          const prevStart = text.lastIndexOf('\n', prevEnd - 1) + 1;
          if (!/^(\/\/|\/\*|\*)/.test(text.slice(prevStart, prevEnd).trim())) break;
          start = prevStart;
        }
        spans.push([start, text[st.end] === '\n' ? st.end + 1 : st.end]);
      }
    }
    if (!spans.length) continue;
    let s = text;
    for (const [a, b] of spans.sort((x, y) => y[0] - x[0])) s = s.slice(0, a) + s.slice(b);
    writeFileSync(f, s.replace(/\n{3,}/g, '\n\n'));
    changed = true;
  }
  execSync(`node tools/refactor/prune-imports.mjs ${touched.join(' ')}`, { stdio: 'inherit' });
  if (!changed) break;
}
