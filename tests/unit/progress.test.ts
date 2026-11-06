import { expect, test } from 'vitest';
import { QUESTS } from '../../src/content/quests';
import { bookIndex, START_POINTS } from '../../src/content/skills';
import { SLIDE_SKILL } from '../../src/content/tuning';
import { newLifeState, skillBudget, trainedBy } from '../../src/engine/island';

// What the page works out for itself about getting better on the island: the skill points you have,
// counted from the quests and milestones you've finished (never stored), and which skill something
// you did trains (the yard's practice, src/app/yardPractice.ts). Points given, skills levelling up
// and milestones are the engine's, tested beside it (crates/engine/src/life/progress.rs).

test('every quest and milestone gives skill points, and you have what the ones you finished gave', () => {
  for (const q of QUESTS) expect(q.rewards.skillPoints ?? 0, q.id).toBeGreaterThan(0);
  const s = newLifeState({ coins: 0, labor: 0, seed: 0 });
  expect(skillBudget(s)).toBe(START_POINTS);
  const done = QUESTS.slice(0, 3);
  s.quests = { active: [], done: done.map((q) => q.id) };
  expect(skillBudget(s)).toBe(START_POINTS + done.reduce((n, q) => n + (q.rewards.skillPoints ?? 0), 0));
});

test('what trains what: a hit the weapon that landed it, a cast the ability, a use the movement skill', () => {
  const hit = (weapon?: number) => ({ type: 'hit', frame: 0, index: 0, damage: 12, x: 0, y: 0, z: 0, dirX: 0, dirZ: 1, weapon }) as const;
  expect(trainedBy(hit(0))).toBe(bookIndex('sword'));
  expect(trainedBy(hit(1))).toBe(bookIndex('club'));
  expect(trainedBy(hit(3)), 'an arrow: the bow that loosed it').toBe(bookIndex('bow'));
  expect(trainedBy(hit()), 'a blast: its cast already counted').toBe(-1);
  expect(trainedBy({ type: 'cast', frame: 0, ability: 1, x: 0, z: 0, casterX: 0, casterZ: 0 })).toBe(bookIndex('meteor'));
  expect(trainedBy({ type: 'action', frame: 0, id: SLIDE_SKILL, x: 0, y: 0, z: 0 })).toBe(bookIndex('slide'));
  expect(trainedBy({ type: 'jump', frame: 0, x: 0, y: 0, z: 0 })).toBe(-1);
});
