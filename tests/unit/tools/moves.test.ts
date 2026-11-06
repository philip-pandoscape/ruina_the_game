import { describe, expect, test } from 'vitest';
import {
  contextFor,
  expandMoves,
  folderPlace,
  parseMoves,
  reglob,
  respecify,
  rewriteFile,
  rewriteRepoPaths,
} from '../../../tools/refactor/moves-lib.mjs';

// The refactor's moves script (tools/refactor/moves.mjs) moves files and rewrites every reference to
// them. These check the rewriting on a small made-up repository.

const files = new Set([
  'src/main.ts',
  'src/sim/life.ts',
  'src/sim/zone/world.ts',
  'src/ui/index.ts',
  'src/ui/hud.ts',
  'src/render/models/glb.ts',
  'src/render/assets/models/hero.glb',
  'src/render/assets/models/sword.glb',
  'src/ui/theme/theme.css',
  'src/ui/theme/fonts/pagella.woff2',
  'shared/items.json',
  'server/src/content.rs',
  'index.html',
  'tests/progress.spec.ts',
  'tests/testServer.ts',
  'AGENTS.md',
]);

describe('reading a moves list', () => {
  test('one move a line, tab-separated, comments and trailing slashes ignored', () => {
    expect(parseMoves('# a comment\nsrc/sim/\tsrc/engine/\n\ntests/a.ts\ttests/unit/a.ts\r\n')).toEqual([
      { from: 'src/sim', to: 'src/engine' },
      { from: 'tests/a.ts', to: 'tests/unit/a.ts' },
    ]);
  });

  test('a folder move takes every file under it; a move of nothing is an error', () => {
    const map = expandMoves([{ from: 'src/sim', to: 'src/engine' }], files);
    expect(map.get('src/sim/life.ts')).toBe('src/engine/life.ts');
    expect(map.get('src/sim/zone/world.ts')).toBe('src/engine/zone/world.ts');
    expect(map.has('src/main.ts')).toBe(false);
    expect(() => expandMoves([{ from: 'src/nothing', to: 'x' }], files)).toThrow(/nothing to move/);
  });
});

describe('imports', () => {
  const exists = (f: string) => files.has(f);

  test('an import of a moved file points at its new place, written as it was written', () => {
    const map = new Map([['src/sim/life.ts', 'src/engine/life.ts']]);
    expect(respecify('src/main.ts', 'src/main.ts', './sim/life', map, exists)).toBe('./engine/life');
    expect(respecify('src/main.ts', 'src/main.ts', './sim/life.ts', map, exists)).toBe('./engine/life.ts');
  });

  test('a moved file keeps reaching what stayed', () => {
    const map = new Map([['tests/progress.spec.ts', 'tests/unit/progress.test.ts']]);
    expect(respecify('tests/progress.spec.ts', 'tests/unit/progress.test.ts', '../src/sim/life', map, exists)).toBe('../../src/sim/life');
    expect(respecify('tests/progress.spec.ts', 'tests/unit/progress.test.ts', './testServer', map, exists)).toBe('../testServer');
  });

  test('both moving, a folder named for its index, and a query on the end', () => {
    const map = expandMoves(
      [
        { from: 'src/ui', to: 'src/view' },
        { from: 'tests/progress.spec.ts', to: 'tests/unit/progress.test.ts' },
      ],
      files,
    );
    expect(respecify('src/main.ts', 'src/main.ts', './ui', map, exists)).toBe('./view');
    expect(respecify('tests/progress.spec.ts', 'tests/unit/progress.test.ts', '../src/ui/hud', map, exists)).toBe('../../src/view/hud');
    const glb = new Map([['src/render/assets/models/hero.glb', 'src/assets/hero.glb']]);
    expect(respecify('src/render/models/glb.ts', 'src/render/models/glb.ts', '../assets/models/hero.glb?url', glb, exists)).toBe('../../assets/hero.glb?url');
  });

  test('a specifier that names nothing known is left as it is', () => {
    expect(respecify('src/main.ts', 'src/elsewhere/main.ts', './generated/thing', new Map(), exists)).toBe('./generated/thing');
  });

  test('import.meta.glob follows its folder, or the file that wrote it', () => {
    const moves = [{ from: 'src/render/assets', to: 'src/assets' }];
    const map = expandMoves(moves, files);
    expect(reglob('src/render/models/glb.ts', 'src/render/models/glb.ts', '../assets/models/*.glb', moves, map, files)).toBe('../../assets/models/*.glb');
    const moved = new Map([['src/render/models/glb.ts', 'src/render/glb.ts']]);
    expect(reglob('src/render/models/glb.ts', 'src/render/glb.ts', '../assets/models/*.glb', [], moved, files)).toBe('./assets/models/*.glb');
  });

  test('folders whose files all moved to one place count as moved', () => {
    const map = new Map([
      ['src/render/assets/models/hero.glb', 'src/assets/models/hero.glb'],
      ['src/render/assets/models/sword.glb', 'src/assets/models/sword.glb'],
    ]);
    expect(folderPlace('src/render/assets/models', [], map, files)).toBe('src/assets/models');
  });
});

describe('whole files', () => {
  test('a script: every kind of import, a glob and a URL', () => {
    const ctx = contextFor([{ from: 'src/sim', to: 'src/engine' }, { from: 'src/render/assets', to: 'src/assets' }], files);
    const text = [
      "import { Life } from './sim/life';",
      "import type { World } from './sim/zone/world.ts';",
      "export * from './sim/life';",
      "import './ui/theme/theme.css';",
      "const z = await import('./sim/zone/world');",
      "const all = import.meta.glob('./render/assets/models/*.glb', { eager: true });",
      "const u = new URL('./render/assets/models/hero.glb', import.meta.url);",
      "import * as THREE from 'three';",
    ].join('\n');
    expect(rewriteFile(text, 'src/main.ts', ctx)).toBe(
      [
        "import { Life } from './engine/life';",
        "import type { World } from './engine/zone/world.ts';",
        "export * from './engine/life';",
        "import './ui/theme/theme.css';",
        "const z = await import('./engine/zone/world');",
        "const all = import.meta.glob('./assets/models/*.glb', { eager: true });",
        "const u = new URL('./assets/models/hero.glb', import.meta.url);",
        "import * as THREE from 'three';",
      ].join('\n'),
    );
  });

  test('Rust includes, CSS urls and HTML root paths', () => {
    const ctx = contextFor([{ from: 'shared', to: 'content' }, { from: 'src/ui/theme/fonts', to: 'src/assets/fonts' }, { from: 'src/main.ts', to: 'src/app/main.ts' }], files);
    expect(rewriteFile('const ITEMS: &str = include_str!("../../shared/items.json");', 'server/src/content.rs', ctx)).toBe(
      'const ITEMS: &str = include_str!("../../content/items.json");',
    );
    expect(rewriteFile("@font-face { src: url('./fonts/pagella.woff2') format('woff2'); }", 'src/ui/theme/theme.css', ctx)).toBe(
      "@font-face { src: url('../../assets/fonts/pagella.woff2') format('woff2'); }",
    );
    expect(rewriteFile('<script type="module" src="/src/main.ts"></script>', 'index.html', ctx)).toBe('<script type="module" src="/src/app/main.ts"></script>');
  });

  test('repo paths written out in docs and strings, as whole words only', () => {
    const ctx = contextFor([{ from: 'src/sim', to: 'src/engine' }, { from: 'tests/testServer.ts', to: 'tests/support/testServer.ts' }], files);
    const doc = 'The rules (`src/sim/life.ts`, all of `src/sim/`, src/sim) and `tests/testServer.ts`; not ../src/sim/life.ts, not src/simple.ts.';
    expect(rewriteRepoPaths(doc, ctx)).toBe(
      'The rules (`src/engine/life.ts`, all of `src/engine/`, src/engine) and `tests/support/testServer.ts`; not ../src/sim/life.ts, not src/simple.ts.',
    );
  });
});
