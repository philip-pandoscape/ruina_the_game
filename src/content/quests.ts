import data from '../../shared/quests.json' with { type: 'json' };

// The starter questline (shared/quests.json).

export interface Objective {
  type: string;
  n?: number;
  npc?: string;
  place?: string;
  r?: number;
  minY?: number;
  crop?: string;
  pack?: string;
  outpost?: string;
  vehicle?: string;
  seconds?: number;
}

export interface QuestStep {
  text: string;
  objectives: Objective[];
}

export interface QuestRewards {
  coins?: number;
  seals?: number;
  labor?: number;
  items?: Array<{ item: string; n: number }>;
  equipGlider?: string;
}

export interface QuestDef {
  id: string;
  name: string;
  giver: string;
  after: string[];
  /** Starts by itself as soon as it is available, without talking to anyone. */
  auto?: boolean;
  intro: string;
  steps: QuestStep[];
  turnIn?: string;
  outro: string;
  rewards: QuestRewards;
  /** Handed to you when you accept it. */
  startItems?: Array<{ item: string; n: number }>;
}

export const QUESTS = data.quests as unknown as QuestDef[];

export function questDef(id: string): QuestDef {
  const q = QUESTS.find((x) => x.id === id);
  if (!q) throw new Error(`unknown quest "${id}"`);
  return q;
}

/** How many of an objective are needed (1 for one-off objectives like talking to someone). */
export const objectiveTarget = (o: Objective): number => (o.type === 'glide' ? (o.seconds ?? 10) : (o.n ?? 1));
