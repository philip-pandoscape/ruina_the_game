import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { OPTION_DOCS, readOptions } from '../../src/app/options';

// The game page's address options (src/app/options.ts): every one it reads is documented, and every
// documented one does something.

const nameOf = (doc: string) => doc.split('=')[0];

test('every option the page reads is in the list', () => {
  const src = readFileSync('src/app/options.ts', 'utf8');
  const read = new Set([...src.matchAll(/q\.(?:get|has)\('([a-z]+)'\)/g)].map((m) => m[1]));
  const documented = new Set(OPTION_DOCS.filter((o) => !o.readBy).map((o) => nameOf(o.name)));
  expect([...read].filter((n) => !documented.has(n))).toEqual([]);
  expect([...documented].filter((n) => !read.has(n))).toEqual([]);
});

test('the options read elsewhere are read there', () => {
  for (const o of OPTION_DOCS.filter((x) => x.readBy)) {
    expect(readFileSync(o.readBy!, 'utf8'), o.name).toContain(`get('${nameOf(o.name)}')`);
  }
});

test('every listed option changes what the page reads', () => {
  const plain = JSON.stringify(readOptions(''));
  // Some only mean something beside another (goblins in the yard, the island kept with world&test).
  const beside: Record<string, string> = { goblins: 'yard&', load: 'test&world&', team: 'server=ws://x&', play: 'server=ws://x&', world: 'test&' };
  for (const o of OPTION_DOCS) {
    const name = nameOf(o.name);
    const value = o.name.includes('=') ? o.name.split('=')[1].split('|')[0] : '';
    const base = beside[name] ?? '';
    const before = JSON.stringify(readOptions(`?${base}`));
    const after = JSON.stringify(readOptions(`?${base}${name}${value ? `=${value}` : ''}`));
    if (o.readBy) continue;
    expect(after, name).not.toEqual(base ? before : plain);
  }
});
