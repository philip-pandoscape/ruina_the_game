// In a module made by tools/refactor/move-region.mjs: the main.ts consts and functions it uses become locals taken
// from g once, at the top of its function (it runs where the region ran, so they're all set by
// then, and TypeScript narrows locals inside closures where it doesn't narrow g.x); main.ts's lets
// stay g.x, read when used.
//   node tools/refactor/localize-consts.mjs <module> <function name>
import { readFileSync, writeFileSync } from 'node:fs';
import { parseSync } from 'oxc-parser';

const [modPath, fnName] = process.argv.slice(2);
const main = readFileSync('src/main.ts', 'utf8');
const { program } = parseSync('src/main.ts', main, { lang: 'ts' });
const constant = new Set();
for (const st of program.body) {
  if (st.type === 'VariableDeclaration' && st.kind === 'const') for (const d of st.declarations) if (d.id.type === 'Identifier') constant.add(d.id.name);
  if (st.type === 'FunctionDeclaration' && st.id) constant.add(st.id.name);
}
let mod = readFileSync(modPath, 'utf8');
const used = new Set([...mod.matchAll(/\bg\.(\w+)\b/g)].map((m) => m[1]));
const locals = [...used].filter((n) => constant.has(n)).sort();
for (const n of locals) mod = mod.replace(new RegExp(`\\b(\\w+: )?g\\.${n}\\b`, 'g'), (all, key) => (key && key === `${n}: ` ? n : `${key ?? ''}${n}`));
const head = `function ${fnName}(g: GameRefs): void {\n`;
if (!mod.includes(head)) throw new Error('function head');
mod = mod.replace(head, `${head}  const { ${locals.join(', ')} } = g;\n`);
writeFileSync(modPath, mod);
console.log(`locals: ${locals.join(' ')}; still through g: ${[...used].filter((n) => !constant.has(n)).join(' ')}`);
