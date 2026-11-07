// Copies a rules spec from tests/integration to tests/unit/rules, to run headless in Vitest
// (tests/support/headless.ts): the same test bodies, Vitest's expect, the headless page.
//   node tools/refactor/port-spec.mjs <name>          (tests/integration/<name>.spec.ts)
import { readFileSync, writeFileSync } from 'node:fs';

const name = process.argv[2];
let s = readFileSync(`tests/integration/${name}.spec.ts`, 'utf8');
s = s.replace(/^import \{([^}]*)\} from '@playwright\/test';\n/m, (_all, specs) => {
  const names = specs
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const fromVitest = names.filter((n) => n === 'expect');
  const fromHeadless = names.filter((n) => n !== 'expect');
  return `${fromVitest.length ? `import { ${fromVitest.join(', ')} } from 'vitest';\n` : ''}${fromHeadless.length ? `import { ${fromHeadless.join(', ')} } from '../../support/headless';\n` : ''}`;
});
s = s.replace(/from '\.\.\/support\/game';/g, "from '../../support/headless';");
s = s.replace(/from '\.\.\/\.\.\/src\//g, "from '../../../src/");
s = s.replace(/from '\.\.\/support\//g, "from '../../support/");
s = s.replace(/^test\.describe\.configure\([^)]*\);\n/gm, '');
s = s.replace(/^\/\/ Its tests share nothing, so they spread across the workers \(playwright\.config\.ts\)\.\n/m, '');
writeFileSync(`tests/unit/rules/${name}.test.ts`, s);
console.log(`tests/unit/rules/${name}.test.ts`);
