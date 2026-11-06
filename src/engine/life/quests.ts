import { QUESTS, questDef, type QuestDef } from '../../content/quests';
import type { IslandRead } from './life';

// The quests as the page reads them: offered by NPCs once their prerequisites are done, advanced by
// events the other systems report (planted, harvested, delivered...), handed in for rewards. The
// engine keeps them (crates/engine/src/life/quests.rs).

export const questDone = (life: IslandRead, id: string): boolean => life.state.quests.done.includes(id);
export const questActive = (life: IslandRead, id: string) => life.state.quests.active.find((q) => q.id === id);

/** Offered and not yet taken. */
export function available(life: IslandRead, q: QuestDef): boolean {
  return !questDone(life, q.id) && !questActive(life, q.id) && q.after.every((a) => questDone(life, a));
}

export const isReady = (life: IslandRead, id: string): boolean => {
  const p = questActive(life, id);
  return !!p && p.step >= questDef(id).steps.length;
};

/** Quests this NPC has to give, and quests ready to hand in to them. */
export function questsAt(life: IslandRead, npc: string): { offer: QuestDef[]; turnIn: QuestDef[] } {
  return {
    offer: QUESTS.filter((q) => q.giver === npc && available(life, q) && !q.auto),
    turnIn: QUESTS.filter((q) => !q.milestone && (q.turnIn ?? q.giver) === npc && isReady(life, q.id)),
  };
}
