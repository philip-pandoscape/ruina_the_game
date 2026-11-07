import { expect, test } from 'vitest';
import { QUESTS } from '../../src/content/quests';
import { START_POINTS } from '../../src/content/skills';
import { newLifeState, skillBudget } from '../../src/engine/life';

// What the page works out for itself about getting better in the world: the skill points you have,
// counted from the quests and milestones you've finished (never stored). Points given, what trains
// what, skills levelling up and milestones are the engine's, tested beside it
// (crates/engine/src/life/progress.rs).

test('every quest and milestone gives skill points, and you have what the ones you finished gave', () => {
  for (const q of QUESTS) expect(q.rewards.skillPoints ?? 0, q.id).toBeGreaterThan(0);
  const s = newLifeState({ coins: 0, labor: 0, seed: 0 });
  expect(skillBudget(s)).toBe(START_POINTS);
  const done = QUESTS.slice(0, 3);
  s.quests = { active: [], done: done.map((q) => q.id) };
  expect(skillBudget(s)).toBe(START_POINTS + done.reduce((n, q) => n + (q.rewards.skillPoints ?? 0), 0));
});
