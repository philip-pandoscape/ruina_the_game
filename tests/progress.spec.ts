import { expect, test } from '@playwright/test';
import { Life } from '../src/sim/life/life';
import { complete } from '../src/sim/life/quests';
import { migrateLifeState, type LifeState } from '../src/sim/life/state';
import { pointsEarned, skillBudget, train, trainedBy } from '../src/sim/life/progress';
import { EMBERHOLM, type ZoneData } from '../src/sim/zone/world';
import { generateZone } from '../src/sim/zone/generate';
import { QUESTS } from '../src/content/quests';
import { bookIndex, LEVEL_XP, levelsFrom, START_POINTS } from '../src/skills';
import { SLIDE_SKILL } from '../src/tuning';

// Getting better on the island: skill points from the quests and milestones you finish, and skills
// that level up as you use them (src/sim/life/progress.ts). server/src/life does the same.

let zone: ZoneData;
test.beforeAll(() => {
  zone = { recipe: EMBERHOLM, gen: generateZone(EMBERHOLM) };
});
const fresh = () => new Life(zone);
const toasts = (life: Life) => life.drainEvents().flatMap((e) => (e.t === 'toast' ? [e.text] : []));
const finishLandfall = (life: Life) => {
  life.notify({ type: 'talk', npc: 'hollis' });
  expect(complete(life, 'landfall')).toBe(true);
};

test('every quest and milestone gives skill points, and you have what the ones you finished gave', () => {
  for (const q of QUESTS) expect(q.rewards.skillPoints ?? 0, q.id).toBeGreaterThan(0);
  const life = fresh();
  expect(skillBudget(life.state)).toBe(START_POINTS);
  finishLandfall(life);
  const landfall = QUESTS.find((q) => q.id === 'landfall')!.rewards.skillPoints!;
  expect(pointsEarned(life.state)).toBe(landfall);
  expect(skillBudget(life.state)).toBe(START_POINTS + landfall);
  expect(toasts(life)).toContain(`✔ Landfall complete - ${landfall} skill point${landfall > 1 ? 's' : ''}, 50c, Scarecrow, 8 Sunroot Seeds, 6 Barley Seeds`);
  // Milestones start quietly.
  expect(toasts(life)).toEqual([]);
});

test('points are counted from finished quests, so an island saved before they existed has them too', () => {
  const life = fresh();
  const old = JSON.parse(JSON.stringify(life.state)) as Partial<LifeState>;
  delete old.skillXp; // saved before skills levelled
  old.quests = { active: [], done: ['landfall', 'patch', 'wings'] };
  const s = migrateLifeState(old as LifeState);
  expect(s.skillXp).toEqual({});
  expect(pointsEarned(s)).toBe(['landfall', 'patch', 'wings'].reduce((n, id) => n + QUESTS.find((q) => q.id === id)!.rewards.skillPoints!, 0));
});

test('milestones start by themselves and finish themselves, with nobody to hand them to', () => {
  const life = fresh();
  expect(life.state.quests.active.map((q) => q.id)).not.toContain('slimeHunter');
  finishLandfall(life);
  expect(life.state.quests.active.map((q) => q.id)).toEqual(expect.arrayContaining(['wayfarer', 'slimeHunter', 'practisedHand']));
  toasts(life);
  const before = skillBudget(life.state);
  // Only the creature it names counts.
  life.notify({ type: 'defeat', kind: 'great-slime' });
  expect(life.state.quests.active.find((q) => q.id === 'slimeHunter')!.counts[0]).toBe(0);
  for (let i = 0; i < 15; i++) life.notify({ type: 'defeat', kind: 'slime' });
  expect(life.state.quests.done).toContain('slimeHunter');
  expect(life.state.quests.active.map((q) => q.id)).not.toContain('slimeHunter');
  expect(skillBudget(life.state)).toBe(before + 1);
  expect(toasts(life)).toContain('✔ Milestone: Slime Hunter - 1 skill point');
});

test('skills level up as you use them, say so, and count toward Practised Hand', () => {
  const life = fresh();
  finishLandfall(life);
  toasts(life);
  const sword = bookIndex('sword');
  train(life, sword, LEVEL_XP[1] - 1);
  expect(levelsFrom(life.state.skillXp)[sword]).toBe(1);
  expect(toasts(life)).toEqual([]);
  train(life, sword);
  expect(levelsFrom(life.state.skillXp)[sword]).toBe(2);
  expect(toasts(life)).toEqual(['Sword reached level 2']);
  expect(life.state.quests.active.find((q) => q.id === 'practisedHand')!.counts[0]).toBe(1);
  // Four more levels finish the milestone (a jump of several levels counts them all).
  train(life, sword, LEVEL_XP[5] - life.state.skillXp.sword);
  expect(levelsFrom(life.state.skillXp)[sword]).toBe(6);
  expect(life.state.quests.done).toContain('practisedHand');
});

test('what trains what: hits train the weapon in your hands, casts the ability, uses the movement skill', () => {
  const hit = { type: 'hit', frame: 0, index: 0, damage: 12, x: 0, y: 0, z: 0, dirX: 0, dirZ: 1 } as const;
  expect(trainedBy(hit, 0)).toBe(bookIndex('sword'));
  expect(trainedBy(hit, 1)).toBe(bookIndex('club'));
  expect(trainedBy({ type: 'cast', frame: 0, ability: 1, x: 0, z: 0, casterX: 0, casterZ: 0 }, 0)).toBe(bookIndex('meteor'));
  expect(trainedBy({ type: 'action', frame: 0, id: SLIDE_SKILL, x: 0, y: 0, z: 0 }, 0)).toBe(bookIndex('slide'));
  expect(trainedBy({ type: 'jump', frame: 0, x: 0, y: 0, z: 0 }, 0)).toBe(-1);
});
