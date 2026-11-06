import { beforeAll, expect, test } from 'vitest';
import { type QuestMarker, QUESTS, questDef } from '../../src/content/quests';
import { LABOR } from '../../src/content/trade';
import { type IslandRead, type LifeState, newLifeState } from '../../src/engine/island';
import type { SimRead } from '../../src/engine/rules';
import { makeZoneWorld, type ZoneData } from '../../src/engine/zone';
import { questGoal } from '../../src/ui/life/hud/goal';

// Where a quest leads you (src/ui/life/hud/goal.ts): to what an objective names (the person, the
// place, the trading post, the bench that makes the pack, your plot, house, ship or vehicle), and
// otherwise to where its quest's data marks (an objective's `marker`, content/quests/), so no place
// is named in the UI's code. The goal reads the island and where you stand, so each case is an
// island's state as the rules keep it.

let zone: ZoneData;
beforeAll(() => {
  zone = makeZoneWorld().zone!;
});

/** The goal with only `quest` taken, at `step`, nothing of it done yet, after `setup`, standing at the spawn. */
function goalAt(quest: string, step: number, setup: (s: LifeState) => void = () => {}) {
  const state = newLifeState({ coins: 200, labor: LABOR.start, seed: zone.recipe.seed });
  setup(state);
  const objectives = questDef(quest).steps[step]?.objectives ?? [];
  state.quests.active = [{ id: quest, step, counts: objectives.map(() => 0) }];
  const life: IslandRead = { zone, state, count: (item) => state.bag.reduce((n, s) => (s.item === item ? n + s.n : n), 0) };
  // The goal reads where you stand, and nothing else of you.
  const spawn = zone.recipe.spawn;
  const sim = { player: { pos: { x: spawn.x, y: 0, z: spawn.z } } } as unknown as SimRead;
  return questGoal(life, sim);
}

const recipe = () => zone.recipe;
const place = (id: string) => recipe().places.find((p) => p.id === id)!;

test("every marker names one spot on the island, and the rules don't read it", () => {
  const markers: QuestMarker[] = QUESTS.flatMap((q) => q.steps.flatMap((s) => s.objectives.flatMap((o) => (o.marker ? [o.marker] : []))));
  expect(markers.length).toBeGreaterThan(5);
  const r = recipe();
  const spots = { place: r.places, outpost: r.outposts, workbench: r.workbenches, shipyard: r.shipyards } as const;
  for (const m of markers) {
    const named = (['place', 'outpost', 'workbench', 'shipyard'] as const).filter((k) => m[k]);
    expect(named, JSON.stringify(m)).toHaveLength(1);
    const there = spots[named[0]].some((s) => s.id === m[named[0]]);
    expect(there, JSON.stringify(m)).toBe(true);
  }
});

test('an objective with nowhere of its own leads where its quest marks, called as the quest says', () => {
  // Setting a scarecrow: the farmland the quest names.
  const fields = place('barleybrook');
  expect(goalAt('patch', 0)).toEqual({ x: fields.x, z: fields.z, label: fields.name });
  // The first flight: back to the village.
  const village = place('lanternwick');
  expect(goalAt('firstFlight', 0)).toEqual({ x: village.x, z: village.z, label: village.name });
  // A boat is called at the docks, which the quest calls The Docks.
  const docks = place('docks');
  expect(goalAt('saltSail', 0)).toEqual({ x: docks.x, z: docks.z, label: 'The Docks' });
  // A cart is called anywhere: no marker, nowhere in particular.
  expect(goalAt('wheels', 0)?.label).not.toBe('The Docks');
});

test('what the world shows comes before the marker: the seller of blueprints, then the plots', () => {
  const quill = recipe().npcs.find((n) => n.id === 'quill')!;
  expect(goalAt('home', 0)).toEqual({ x: quill.x, z: quill.z, label: quill.name });
  const rise = place('hearthside');
  expect(goalAt('home', 0, (s) => s.bag.push({ item: 'blueprint.cottage', n: 1 }))).toEqual({ x: rise.x, z: rise.z, label: rise.name });
});

test('a contract leads to the post it was taken at, and with none taken to the post the quest marks', () => {
  const post = (id: string) => recipe().outposts.find((o) => o.id === id)!;
  expect(goalAt('contracts', 0)).toEqual({ x: post('westwatch').x, z: post('westwatch').z, label: 'Westwatch Trading Post' });
  const taken = goalAt('contracts', 0, (s) => {
    const k = { id: 1, outpost: 'gullrock', pack: 'harvestCrate', count: 1, delivered: 0, bonusCoins: 10, bonusSeals: 1, expires: 9e9 };
    s.contracts = { active: [k], offered: [], nextRefresh: 0 };
  });
  expect(taken).toEqual({ x: post('gullrock').x, z: post('gullrock').z, label: 'Gullrock Exchange' });
});

test('a ship is laid, built and launched at the slipway the quest marks', () => {
  const slip = recipe().shipyards[0];
  for (const step of [0, 1, 2]) expect(goalAt('shipwright', step)).toEqual({ x: slip.x, z: slip.z, label: slip.name });
});
