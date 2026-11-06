import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { build, stale } from '../../tools/content/contentc.mjs';

// The content (content/, a file per thing) builds into the bundles the game reads (shared/), and a
// mistake in it is caught with a message that says where: tools/content/contentc.mjs.

test('the content builds, and shared/ is what it builds', () => {
  const bundles = build();
  expect(bundles.size).toBeGreaterThan(15);
  expect(stale(bundles), 'run npm run content').toEqual([]);
});

const copies: string[] = [];
afterAll(() => {
  for (const c of copies) rmSync(c, { recursive: true, force: true });
});

/** A copy of content/ with one file changed by `edit`, built: the error it gives, or '' if none. */
function broken(file: string, edit: (j: any) => unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'ruina-content-'));
  copies.push(root);
  cpSync('content', root, { recursive: true });
  const p = join(root, file);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  writeFileSync(p, JSON.stringify(edit(j) ?? j));
  try {
    build(root);
    return '';
  } catch (e) {
    return String((e as Error).message);
  }
}

test('a field the kind has no such thing as fails', () => {
  expect(
    broken('items/sunroot.json', (j) => {
      j.colour = 'gold';
    }),
  ).toContain('content/items/sunroot.json: "colour" isn\'t a field of items');
});

test('a field every one of its kind has, missing, fails', () => {
  expect(
    broken('items/sunroot.json', (j) => {
      delete j.name;
    }),
  ).toContain('content/items/sunroot.json: no name, which every one of items has');
});

test('a field of the wrong type fails', () => {
  expect(
    broken('weapons/sword.json', (j) => {
      j.combo = 'swing';
    }),
  ).toContain('content/weapons/sword.json: combo is a string, where weapons have a array');
});

test("a reference to something that isn't there fails", () => {
  const message = broken('vendors/mara.json', (j) => {
    j.sells[0].item = 'moonbeam';
  });
  expect(message).toContain('there\'s no item "moonbeam"');
  expect(
    broken('recipes/pack.harvestCrate.json', (j) => {
      j.bench = 'nowhereBench';
    }),
  ).toContain('there\'s no workbench or npc "nowhereBench"');
});

test("a thing left out of its folder's order, or named for another, fails", () => {
  expect(broken('quests/_order.json', (list) => (list as string[]).slice(1))).toMatch(/content\/quests\/.+\.json: not in quests\/_order\.json/);
  expect(
    broken('items/sunroot.json', (j) => {
      j.id = 'moonroot';
    }),
  ).toContain('content/items/sunroot.json: its id is "moonroot", but the file is named sunroot');
});

test('a region the world puts where its grid is not, or on another region, fails', () => {
  // Its grid must cover exactly its chunks: Emberholm's is 6 x 6 round the origin.
  expect(
    broken('world.json', (w) => {
      w.regions[0].chunks.x = -2;
    }),
  ).toContain("emberholm: its terrain's origin is (0, 0), where the middle of its chunks is (256, 0)");
  expect(
    broken('world.json', (w) => {
      w.regions[0].chunks.w = 5;
    }),
  ).toContain('its grid is 1536 m a side');
  expect(
    broken('world.json', (w) => {
      w.regions.push({ id: 'emberholm', chunks: { x: 2, z: 2, w: 6, d: 6 } });
    }),
  ).toContain("chunk (2, 2) is emberholm's too");
  expect(
    broken('world.json', (w) => {
      w.regions[0].id = 'nowhere';
    }),
  ).toContain("there's no content/zones/nowhere.json");
});
