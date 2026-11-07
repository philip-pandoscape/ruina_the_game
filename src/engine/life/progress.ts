import type { LifeState } from './state';
import { START_POINTS } from '../../content/skills';
import { QUESTS } from '../../content/quests';

// Getting better: the skills you use level up, and the tree grows with what you've done.
//
// Experience. Each hit a weapon lands, each cast of an ability and each use of a movement skill adds
// one to that skill (state.skillXp, kept with your island), and a level comes at each step of the
// curve in tuning.json skills.levels. A level-up is a quest event too, for the milestones that count
// them. The engine counts them (crates/engine/src/life/progress.rs).
//
// Skill points. Everyone starts with START_POINTS, and each quest or milestone you finish adds its
// skillPoints. They're worked out from the quests you've done rather than kept, so they can never
// drift from them, and finishing a quest that gained points later still counts.

/** Skill points the quests and milestones you've finished have given you. */
export function pointsEarned(state: Pick<LifeState, 'quests'>): number {
  let n = 0;
  for (const q of QUESTS) if (q.rewards.skillPoints && state.quests.done.includes(q.id)) n += q.rewards.skillPoints;
  return n;
}

/** How many skill points you may have in the tree in the open world. */
export const skillBudget = (state: Pick<LifeState, 'quests'>): number => START_POINTS + pointsEarned(state);
