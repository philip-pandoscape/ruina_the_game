import { readFileSync } from 'node:fs';
import type * as THREE from 'three';
import { expect, test, vi } from 'vitest';
import { DUNGEONS, type DungeonDef } from '../../src/engine/zone';
import { cavePiles, caveProps, DungeonView } from '../../src/render/open/dungeonView';

// An instance drawn as a cave (src/render/open/dungeonView.ts) is drawn from its dressing, in its
// file (content/instances/<id>.json, docs/world.md): the rock along the walls it names, the back of
// the falls if it has them, the way out, its torches, props, nets, loot and pictures. contentc holds
// a dressing to the instance's own pieces (tests/unit/content.test.ts); these hold it to what the
// cave can draw. Goblin's Dread in the game: tests/integration/dungeon-way-in.spec.ts.

// Its pictures and the torches' glow are painted on canvases, which Node hasn't got: one that takes
// every stroke and keeps nothing.
const anything: unknown = new Proxy(() => {}, { get: () => anything, apply: () => anything, set: () => true });
vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => anything }) });

/** Every dressed instance, and the dungeon a new one is copied from (content/_templates/dungeon.json). */
const dressed: DungeonDef[] = [
  ...Object.values(DUNGEONS).filter((d) => d.dressing),
  JSON.parse(readFileSync('content/_templates/dungeon.json', 'utf8')) as DungeonDef,
];

/** How many of each named part a cave draws. */
function parts(v: DungeonView): Record<string, number> {
  const n: Record<string, number> = {};
  for (const c of v.group.children) n[c.name] = (n[c.name] ?? 0) + 1;
  return n;
}

test('every prop and pile a dressing names is one a cave can draw, and every one it can is in a dressing', () => {
  expect(dressed.map((d) => d.id)).toContain('newDungeon');
  expect(dressed.length).toBeGreaterThan(1);
  const props = new Set(dressed.flatMap((d) => (d.dressing!.props ?? []).map((p) => p.body)));
  const piles = new Set(dressed.flatMap((d) => (d.dressing!.loot ?? []).map((l) => l.pile)));
  expect([...props].filter((p) => !caveProps().includes(p))).toEqual([]);
  expect([...piles].filter((p) => !cavePiles().includes(p))).toEqual([]);
  expect(caveProps().filter((p) => !props.has(p))).toEqual([]);
  expect(cavePiles().filter((p) => !piles.has(p))).toEqual([]);
});

test('a cave is drawn from its dressing: its rock, the falls if it has them, the way out, and all that stands in it', () => {
  for (const def of dressed) {
    const d = def.dressing!;
    const want: Record<string, number> = { 'dungeon-rock': 1, 'exit-arch': 1, 'portal-veil': 1 };
    if (d.falls) Object.assign(want, { 'dungeon-falls': 1, 'dungeon-falls-backing': 1 });
    for (const p of d.props ?? []) want[p.body] = (want[p.body] ?? 0) + 1;
    if (d.nets?.length) want['catch-net'] = d.nets.length;
    if (d.loot?.length) want.loot = 1;
    if (d.torches?.length) want.torch = d.torches.length;
    if (d.drawings?.length) want.drawings = d.drawings.length;
    const v = new DungeonView(def);
    expect(parts(v), def.id).toEqual(want);
    // The way out: in the falls across the hall's south end, or where its file puts it.
    const arch = v.group.getObjectByName('exit-arch')!;
    expect(arch.position.x).toBe(def.exit.x);
    if (!d.falls) expect(arch.position.z).toBe(def.exit.z);
  }
});

test('without the falls, the rock closes the south end of the hall', () => {
  const def = dressed.find((d) => !d.dressing!.falls)!;
  const rock = (falls: boolean) => {
    const d = falls ? { ...def.dressing!, falls: { lights: 2 }, light: { ...def.dressing!.light, falls: def.dressing!.light.exit } } : def.dressing!;
    const v = new DungeonView({ ...def, dressing: d });
    return (v.group.getObjectByName('dungeon-rock') as THREE.Mesh).geometry.getAttribute('position').count;
  };
  expect(rock(false)).toBeGreaterThan(rock(true));
});
