import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { expect, test } from 'vitest';
import { UI_ENTRIES } from '../../src/dev/ui/entries';
import { MADE_UP } from '../../src/dev/ui/states';
import { isTitleCase } from '../../src/ui/theme/text';

// The UI gallery (/dev/ui.html, src/dev/ui/; the content library frames it as #/ui/<window>/<state>):
// every entry it lists is made up, and only those; its names follow the writing rule; and the entries
// are plain data, so the library lists them without bringing in the interface. That each entry is
// made up and drawn without an error is tests/integration/uiGallery.spec.ts.

const keys = UI_ENTRIES.map((e) => `${e.window}/${e.state}`);

/** Where a file's imports lead, as paths from the repository's root. */
const importsOf = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/^import\s[^;]*?from\s+'([^']+)'/gms)].map((m) => normalize(join(dirname(file), m[1])));

test('every entry is made up, and every state made up is an entry', () => {
  expect(new Set(keys).size).toBe(keys.length);
  expect(Object.keys(MADE_UP).sort()).toEqual([...keys].sort());
});

test('each window and state is named in Title Case, and what it shows said in a sentence', () => {
  for (const e of UI_ENTRIES) {
    expect(`${e.window}/${e.state}`).toMatch(/^[a-z-]+\/[a-z-]+$/);
    expect(isTitleCase(e.title), e.title).toBe(true);
    expect(isTitleCase(e.label), e.label).toBe(true);
    expect(e.about, e.about).toMatch(/^[A-Z].*\.$/);
  }
});

test('the entries are plain data, and the library lists them without the interface', () => {
  expect(importsOf('src/dev/ui/entries.ts')).toEqual([]);
  const library = importsOf('src/dev/library/galleries/ui.ts');
  expect(library).toContain(normalize('src/dev/ui/entries'));
  expect(library.filter((p) => p.startsWith(normalize('src/ui/')))).toEqual([]);
});
