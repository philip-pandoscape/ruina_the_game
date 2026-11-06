// Run as: node tools/refactor/prune-imports.mjs <files>
// Removes the imports tsc reports as unused (TS6133, TS6192, TS6196) from the files given.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const files = process.argv.slice(2);
let out = '';
try {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', '.'], { encoding: 'utf8', maxBuffer: 1 << 26 });
} catch (e) {
  out = `${e.stdout ?? ''}`;
}
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n');
  const wholeLines = new Set();
  const names = new Map(); // line -> names
  for (const m of out.matchAll(/^([^(\n]+)\((\d+),(\d+)\): error (TS6133|TS6192|TS6196): (.*)$/gm)) {
    if (m[1].replace(/\\/g, '/') !== f) continue;
    const line = Number(m[2]) - 1;
    if (m[4] === 'TS6192') wholeLines.add(line);
    else {
      const name = /'([^']+)'/.exec(m[5])?.[1];
      if (name) names.set(line, [...(names.get(line) ?? []), name]);
    }
  }
  // An import spanning several lines: find its statement's first and last line.
  const statement = (i) => {
    let a = i;
    while (a > 0 && !lines[a].startsWith('import ')) a--;
    let b = i;
    while (!/;\s*$/.test(lines[b])) b++;
    return [a, b];
  };
  const drop = new Set();
  const rewrite = new Map();
  for (const i of wholeLines) {
    const [a, b] = statement(i);
    for (let k = a; k <= b; k++) drop.add(k);
  }
  for (const [i, ns] of names) {
    const [a, b] = statement(i);
    if (drop.has(a)) continue;
    const textStmt = rewrite.get(a) ?? lines.slice(a, b + 1).join('\n');
    if (!textStmt.startsWith('import ')) continue; // not an import: a real unused local, left for a person
    let t = textStmt;
    for (const n of ns)
      t = t
        .replace(new RegExp(`(\\{|,)\\s*(type\\s+)?${n}\\s*(?=,|\\})`), '$1')
        .replace(/\{\s*,/, '{')
        .replace(/,\s*,/, ',')
        .replace(/,\s*\}/, ' }');
    if (/\{\s*\}/.test(t) && !/^import \w+,/.test(t)) {
      for (let k = a; k <= b; k++) drop.add(k);
      continue;
    }
    rewrite.set(a, t);
    for (let k = a + 1; k <= b; k++) drop.add(k);
  }
  const result = [];
  lines.forEach((l, i) => {
    if (rewrite.has(i)) result.push(rewrite.get(i));
    else if (!drop.has(i)) result.push(l);
  });
  writeFileSync(f, result.join('\n'));
  console.log(f, 'imports dropped', wholeLines.size, 'specifiers', [...names.values()].flat().length);
}
