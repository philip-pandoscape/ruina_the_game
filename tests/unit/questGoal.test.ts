import { beforeAll, expect, test } from 'vitest';
import { type QuestMarker, QUESTS, questDef } from '../../src/content/quests';
import { Life } from '../../src/sim/life/life';
import { Sim } from '../../src/sim/sim';
import type { World } from '../../src/sim/types';
import { makeZoneWorld } from '../../src/sim/zone/world';
import { questGoal } from '../../src/ui/life/hud/goal';

// Where a quest leads you (src/ui/life/hud/goal.ts): to what an objective names (the person, the
// place, the trading post, the bench that makes the pack, your plot, house, ship or vehicle), and
// otherwise to where its quest's data marks (an objective's `marker`, content/quests/), so no place
// is named in the UI's code.

let world: World;
beforeAll(() => {
  world = makeZoneWorld();
});

/** The goal with only `quest` taken, at `step`, nothing of it done yet, after `setup`. */
function goalAt(quest: string, step: number, setup: (life: Life) => void = () => {}) {
  const life = new Life(world.zone!);
  setup(life);
  const objectives = questDef(quest).steps[step]?.objectives ?? [];
  life.state.quests.active = [{ id: quest, step, counts: objectives.map(() => 0) }];
  return questGoal(life, new Sim(world, { training: false }));
}

const recipe = () => world.zone!.recipe;
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
  expect(goalAt('home', 0, (l) => l.give('blueprint.cottage', 1))).toEqual({ x: rise.x, z: rise.z, label: rise.name });
});

test('a contract leads to the post it was taken at, and with none taken to the post the quest marks', () => {
  const post = (id: string) => recipe().outposts.find((o) => o.id === id)!;
  expect(goalAt('contracts', 0)).toEqual({ x: post('westwatch').x, z: post('westwatch').z, label: 'Westwatch Trading Post' });
  const taken = goalAt('contracts', 0, (l) => {
    const k = { id: 1, outpost: 'gullrock', pack: 'harvestCrate', count: 1, delivered: 0, bonusCoins: 10, bonusSeals: 1, expires: 9e9 };
    l.state.contracts = { active: [k], offered: [], nextRefresh: 0 };
  });
  expect(taken).toEqual({ x: post('gullrock').x, z: post('gullrock').z, label: 'Gullrock Exchange' });
});

test('a ship is laid, built and launched at the slipway the quest marks', () => {
  const slip = recipe().shipyards[0];
  for (const step of [0, 1, 2]) expect(goalAt('shipwright', step)).toEqual({ x: slip.x, z: slip.z, label: slip.name });
});
