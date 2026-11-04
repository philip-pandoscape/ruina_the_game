import type { Life } from './life';
import type { LifeState } from './state';
import type { Sim } from '../sim';
import type { GameEvent } from '../types';
import { BOOK, levelOf, levelsFrom, sameLevels, START_POINTS } from '../../skills';
import { QUESTS } from '../../content/quests';
import { ABILITIES, MOVEMENT_SKILLS, WEAPONS } from '../../tuning';

// Getting better: the skills you use level up, and the tree grows with what you've done.
//
// Experience. Each hit a weapon lands, each cast of an ability and each use of a movement skill adds
// one to that skill (state.skillXp, kept with your island), and a level comes at each step of the
// curve in tuning.json skills.levels. A level-up is a quest event too, for the milestones that count
// them. server/src/life counts the same things the same way.
//
// Skill points. Everyone starts with START_POINTS, and each quest or milestone you finish adds its
// skillPoints. They're worked out from the quests you've done rather than kept, so they can never
// drift from them, and finishing a quest that gained points later still counts.

/** Which skill in the book (an index into BOOK) an event trains, or -1. */
export function trainedBy(e: GameEvent): number {
  switch (e.type) {
    case 'hit':
      // The weapon that landed it, not whatever is in your hands by then; a blast trains nothing
      // (its cast already did).
      return BOOK.findIndex((b) => b.kind === 'weapon' && b.index === e.weapon);
    case 'cast':
      return BOOK.findIndex((b) => b.kind === 'ability' && b.index === e.ability);
    case 'action':
      return BOOK.findIndex((b) => b.kind === 'movement' && b.index === e.id);
    default:
      return -1;
  }
}

export const bookName = (b: number): string => {
  const s = BOOK[b];
  if (!s) return '';
  if (s.kind === 'weapon') return capital(WEAPONS[s.index]?.name ?? s.id);
  if (s.kind === 'ability') return ABILITIES[s.index]?.name ?? s.id;
  return MOVEMENT_SKILLS[s.index]?.name ?? s.id;
};
const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** Adds experience to one skill; a level-up says so and counts for milestones. */
export function train(life: Life, b: number, amount = 1): void {
  const s = BOOK[b];
  if (!s) return;
  const xp = (life.state.skillXp ??= {});
  const before = levelOf(xp[s.id] ?? 0);
  xp[s.id] = (xp[s.id] ?? 0) + amount;
  const after = levelOf(xp[s.id]);
  if (after > before) {
    life.toast(`${bookName(b)} reached level ${after}`, 'good');
    life.notify({ type: 'skillLevel', amount: after - before });
    life.revision++;
  }
}

/** What the sim reports goes to the skill behind it, and a creature you finish off to the quests. */
export function observe(life: Life, e: GameEvent): void {
  const b = trainedBy(e);
  if (b >= 0) train(life, b);
  if (e.type === 'actorDie') life.notify({ type: 'defeat', kind: e.kind });
}

/** Keeps the sim's levels (which change what your skills do) in step with the island's experience. */
export function syncLevels(life: Life, sim: Sim): void {
  const now = levelsFrom(life.state.skillXp);
  if (!sameLevels(now, sim.levels)) sim.levels = now;
}

/** Skill points the quests and milestones you've finished have given you. */
export function pointsEarned(state: Pick<LifeState, 'quests'>): number {
  let n = 0;
  for (const q of QUESTS) if (q.rewards.skillPoints && state.quests.done.includes(q.id)) n += q.rewards.skillPoints;
  return n;
}

/** How many skill points you may have in the tree in the open world. */
export const skillBudget = (state: Pick<LifeState, 'quests'>): number => START_POINTS + pointsEarned(state);
