import { beforeAll, expect, test } from 'vitest';
import { CROPS, GATHERING } from '../../src/content/farming';
import { CATEGORIES, ITEMS, RECIPES } from '../../src/content/items';
import { LABOR, packDef } from '../../src/content/trade';
import { fell } from '../../src/sim/life/farming';
import { findFocus, runCommand } from '../../src/sim/life/interact';
import { Life } from '../../src/sim/life/life';
import { runRecipe } from '../../src/sim/life/trade';
import { Sim } from '../../src/sim/sim';
import type { World } from '../../src/sim/types';
import { makeZoneWorld } from '../../src/sim/zone/world';

// What items do comes from their data, not from their ids in the rules (src/sim/life, and the
// same in crates/engine/src/life): where a placeable goes and what using it tells you, the rare
// finds in a felled tree or at a gathering spot, where a crafter's pack comes from, how much labor a
// tonic can top you up to, and what each category of item is called.

let world: World;
beforeAll(() => {
  world = makeZoneWorld();
});

function island(): { life: Life; sim: Sim } {
  const sim = new Sim(world, { training: false });
  const life = new Life(world.zone!);
  sim.life = life;
  life.afterReset(sim);
  return { life, sim };
}
const toasts = (life: Life) => life.drainEvents().flatMap((e) => (e.t === 'toast' ? [e.text] : []));

test('a placeable is placed where its data says, and using it says what its hint says', () => {
  const placeables = ITEMS.filter((i) => i.cat === 'placeable');
  expect(placeables.map((i) => i.placeOn).sort()).toEqual(['ground', 'plot', 'slipway']);
  for (const it of placeables) {
    const { life, sim } = island();
    life.give(it.id, 1, true);
    life.drainEvents();
    runCommand(life, sim, { t: 'use', item: it.id });
    expect(toasts(life)).toEqual([it.hint]);
    // Only what is set down on open ground is walked out in front of you, and says what it is.
    expect(life.placing?.item ?? null).toBe(it.placeOn === 'ground' ? it.id : null);
    if (it.placeOn === 'ground') {
      const fields = world.zone!.recipe.farmland;
      sim.player.pos = { x: fields.x, y: world.terrain!.height(fields.x, fields.z), z: fields.z };
      expect(findFocus(life, sim)).toMatchObject({ action: 'placeScarecrow', label: `Place ${it.name} Here`, ok: true });
    }
  }
});

test('a house plot is claimed with whatever item claims one, for the blueprint it names', () => {
  const { life, sim } = island();
  const deed = ITEMS.find((i) => i.placeOn === 'plot')!;
  const plot = world.zone!.recipe.housePlots[0];
  life.give(deed.id, 1, true);
  sim.player.pos = { x: plot.x, y: world.terrain!.height(plot.x, plot.z), z: plot.z + 3 };
  const f = findFocus(life, sim)!;
  expect([f.action, f.label]).toEqual(['claim', `Place ${deed.name}`]);
  runCommand(life, sim, { t: 'interact' });
  expect(life.state.houses.map((h) => h.blueprint)).toEqual([deed.places]);
  expect(life.count(deed.id)).toBe(0);
});

test('a felled tree gives the rare find its crop names, with its toast and its effect', () => {
  const tree = CROPS.find((c) => c.chop?.rare)!;
  const rare = tree.chop!.rare!;
  const { life } = island();
  life.state.scarecrows.push({ id: 7, x: -150, z: -210, rot: 0, cells: [{ crop: tree.id, growth: 1, watered: false, picked: true }] });
  life.state.labor = LABOR.max;
  life.rand = () => 0; // every chance comes up
  expect(fell(life, life.state.scarecrows[0], 0, 2)).toBe(true);
  expect(life.count(rare.item)).toBe(1);
  const events = life.drainEvents();
  expect(events.filter((e) => e.t === 'toast').map((e) => (e as { text: string }).text)).toContain(rare.toast);
  expect(events.some((e) => e.t === 'thunder')).toBe(rare.effect === 'thunder');
  // What it counts as for a quest is its own too.
  expect(events.find((e) => e.t === 'gather')).toMatchObject({ kind: tree.chop!.kind });
});

test('a gathering spot gives the rare find its data names, with its toast', () => {
  const [kind, spot] = Object.entries(GATHERING).find(([, g]) => g.rare)!;
  const { life, sim } = island();
  const i = world.zone!.recipe.nodes.findIndex((n) => n.kind === kind);
  const nd = world.zone!.recipe.nodes[i];
  sim.player.pos = { x: nd.x, y: world.terrain!.height(nd.x, nd.z), z: nd.z + 1.2 };
  sim.player.facing = Math.PI;
  life.rand = () => 0;
  runCommand(life, sim, { t: 'interact' });
  expect(life.count(spot.rare!.item)).toBe(1);
  expect(toasts(life)).toContain(spot.rare!.toast);
});

test("a pack a crafter makes, with no workbench, comes from where the pack says it's made", () => {
  const pack = packDef('lumberBundle');
  RECIPES.push({ id: 'test.crafterPack', bench: 'mara', makes: { pack: pack.id } });
  const { life, sim } = island();
  for (const inp of pack.inputs) life.give(inp.item, inp.n, true);
  life.state.labor = LABOR.max;
  life.state.coins = 1e6;
  sim.player.grounded = true;
  expect(runRecipe(life, sim, 'test.crafterPack')).toBe(true);
  expect(life.state.packs.map((p) => p.origin)).toEqual([pack.origin]);
  RECIPES.pop();
});

test('a tonic, or the developer panel, tops labor up to the most labor there is', () => {
  const tonic = ITEMS.find((i) => i.use?.labor)!;
  const { life, sim } = island();
  life.state.labor = LABOR.max - 1;
  life.give(tonic.id, 1, true);
  runCommand(life, sim, { t: 'use', item: tonic.id });
  expect(life.state.labor).toBe(LABOR.max);
  runCommand(life, sim, { t: 'grant', labor: 5000 });
  expect(life.state.labor).toBe(LABOR.max);
});

test("every item's category is named, as a heading too, and those used say how", () => {
  for (const it of ITEMS) {
    const c = CATEGORIES[it.cat];
    expect(c?.name, `${it.id}: ${it.cat}`).toBeTruthy();
    expect(c.group).toBeTruthy();
  }
  for (const cat of ['seed', 'placeable', 'glider', 'deed', 'mount', 'consumable'] as const) expect(CATEGORIES[cat].verb, cat).toBeTruthy();
});
