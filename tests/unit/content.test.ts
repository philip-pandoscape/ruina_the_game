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

test("a look's field its kind's looks don't have, or a made model whose file isn't there, fails", () => {
  expect(
    broken('structures/well.json', (j) => {
      j.look.colour = 'moss';
    }),
  ).toContain('content/structures/well.json look: "colour" isn\'t a field of the looks of structures');
  expect(
    broken('structures/well.json', (j) => {
      j.look.model.files = ['moonwell'];
    }),
  ).toMatch(/structures\.structures\[\d+\]\.look\.model: there's no src\/render\/assets\/models\/moonwell\.glb/);
});

test("a cave without its dressing, or a dressing naming walls or pieces the instance hasn't got, fails", () => {
  const dread = 'instances/goblinsDread.json';
  expect(
    broken(dread, (j) => {
      delete j.dressing;
    }),
  ).toContain('content/instances/goblinsDread.json: a cave has its dressing');
  expect(
    broken(dread, (j) => {
      j.dressing.hall.north = 'nowhereWall';
    }),
  ).toContain('dressing.hall.north is "nowhereWall", which isn\'t one of its boxes');
  expect(
    broken(dread, (j) => {
      j.dressing.props[0].on = 'nowhereDeck';
    }),
  ).toContain('dressing.props[0] stands on "nowhereDeck", which isn\'t one of its boxes or decks');
  expect(
    broken(dread, (j) => {
      delete j.dressing.light.torch;
    }),
  ).toContain('its dressing has torches, but no light for them');
  expect(
    broken(dread, (j) => {
      j.dressing.moss = true;
    }),
  ).toContain('content/instances/goblinsDread.json dressing: "moss" isn\'t a field of the dressings of instances');
  expect(
    broken('instances/yard.json', (j) => {
      j.dressing = { hall: {} };
    }),
  ).toContain("content/instances/yard.json: an arena isn't dressed");
});

test('a weapon, an ability or a movement skill named by an id there is no such thing of fails, in the levels and in the skill tree', () => {
  // The levels name the weapon a level changes by id, and the ability or movement skill.
  expect(
    broken('tuning.json', (j) => {
      j.skills.levels.per.sword[0].weapon = 'trident';
    }),
  ).toContain('tuning.skills.levels.per.sword[0].weapon: there\'s no weapon "trident"');
  // The skill tree (shared/skilltree.json) names them by id too: a weapon or an ability it names
  // that the content no longer has, in what a node grants and in what a modifier changes.
  const bowGone = broken('weapons/bow.json', (j) => {
    j.name = 'longbow';
  });
  expect(bowGone).toContain('shared/skilltree.json: bow.grants.weapon: there\'s no weapon "bow"');
  expect(bowGone).toContain('shared/skilltree.json: rapidFire.mods[0].weapon: there\'s no weapon "bow"');
  const meteorGone = broken('abilities/meteor.json', (j) => {
    j.id = 'fireball';
  });
  expect(meteorGone).toContain('shared/skilltree.json: meteor.grants.ability: there\'s no ability "meteor"');
  expect(meteorGone).toMatch(/shared\/skilltree\.json: .+\.mods\[\d+\]\.skill: there's no ability or movement skill "meteor"/);
  expect(
    broken('movement-skills/block.json', (j) => {
      j.id = 'parry';
    }),
  ).toContain('shared/skilltree.json: block.grants.movement: there\'s no movement skill "block"');
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
  ).toContain("there's no content/regions/nowhere.json");
  expect(
    broken('world.json', (w) => {
      w.blend = 200;
    }),
  ).toContain("blend is 200, where it's from 0 to half a chunk");
});

test('what a region or an instance brings to life names a creature and a spot, and only a group that is no band is spread', () => {
  expect(
    broken('regions/emberholm.json', (r) => {
      r.spawns[0].kind = 'dragon';
    }),
  ).toContain('content/regions/emberholm.json: spawns[0]: "dragon" is no creature\'s kind');
  expect(
    broken('instances/goblinCamp.json', (d) => {
      d.spawns[0].r = 8;
    }),
  ).toContain('content/instances/goblinCamp.json: spawns[0]: a band stands in a ring round its spot');
  expect(
    broken('regions/emberholm.json', (r) => {
      r.spawns[0].r = 0;
    }),
  ).toContain('spawns[0]: r is how far a group is spread, more than 0 m');
  expect(
    broken('instances/yard.json', (d) => {
      delete d.spawns[0].z;
    }),
  ).toContain('content/instances/yard.json: spawns[0]: it has no spot (x, z)');
});

test('every gathering spot has an id, and an id is one thing in the whole world', () => {
  expect(
    broken('regions/emberholm/nodes.json', (nodes) => {
      delete nodes[0].id;
    }),
  ).toContain('emberholm: nodes[0] has no id');
  expect(
    broken('regions/emberholm/nodes.json', (nodes) => {
      nodes[1].id = nodes[0].id;
    }),
  ).toMatch(/emberholm: nodes \S+ is emberholm's too/);
});
