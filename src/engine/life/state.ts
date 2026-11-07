import type { ContractState } from './contracts';

// A character's life: what is theirs alone and goes where they go (money, labor, the bag, quests,
// skills, contracts, what they sold and can buy back). Plain data, the shape of the engine's
// (crates/engine/src/life/state.rs): it saves to JSON as it is. What they've built and planted is
// land (./land.ts), and each trading post's demand and the weather are the world's.

export interface Stack {
  item: string;
  n: number;
}

export interface QuestProgress {
  id: string;
  step: number;
  /** Per objective of the current step. */
  counts: number[];
}

/** Something you sold, which that merchant sells you back at what they paid until you walk off. */
export interface Buyback {
  npc: string;
  item: string;
  n: number;
  /** Coins each, what the merchant paid. */
  price: number;
}

/** The weather where you are, worked out from the world's clock each step: never kept with a life. */
export interface Weather {
  rainUntil: number;
  nextRain: number;
  /** Direction the wind blows toward (radians, 0 = +Z) and its strength 0..1. */
  windDir: number;
  windSpeed: number;
}

export interface LifeState {
  version: number;
  /** Seconds this life has been lived: it runs while you play and catches up the time you were away. */
  clock: number;
  coins: number;
  /**
   * Coins on a table for a mini-game being played online (crates/server/src/play/tables.rs): out of
   * the purse until the game pays out. An island loaded with some still here gets them back.
   */
  staked?: number;
  seals: number;
  labor: number;
  bag: Stack[];
  /** The glider you fly, '' for none. Owning one is having its item. */
  glider: string;
  /** The seed F plants. */
  seed: string;
  /** Vehicles being repaired after breaking up: vehicle id (def) -> world clock when ready. */
  repairs?: Record<string, number>;
  /** Trade contracts offered at the posts and taken on. */
  contracts?: ContractState;
  /** What you sold to merchants and can still buy back from them, oldest first (src/engine/life/trade.ts). */
  buyback?: Buyback[];
  /** Gathering spots resting: the spot's id -> the island's clock when it is back. */
  nodes: Record<string, number>;
  quests: { active: QuestProgress[]; done: string[] };
  /** Experience of each skill in the skill book, by its id (src/engine/life/progress.ts). */
  skillXp: Record<string, number>;
  stats: { delivered: number; earned: number; harvested: number; glideSeconds: number; built: number };
  /** Where you wake after a rest; null for the zone's spawn. */
  home: { x: number; z: number } | null;
  nextId: number;
  rng: number;
}

/** 4: the life alone, its land kept beside it; 3 and before held the land too. */
export const LIFE_VERSION = 4;

export function newLifeState(start: { coins: number; labor: number; seed: number }): LifeState {
  return {
    version: LIFE_VERSION,
    clock: 0,
    coins: start.coins,
    seals: 0,
    labor: start.labor,
    bag: [],
    glider: '',
    seed: '',
    nodes: {},
    quests: { active: [], done: [] },
    skillXp: {},
    stats: { delivered: 0, earned: 0, harvested: 0, glideSeconds: 0, built: 0 },
    home: null,
    nextId: 1,
    rng: start.seed >>> 0 || 1,
  };
}

/** The weather before the first step has worked it out. */
export const initialWeather = (): Weather => ({ rainUntil: 0, nextRain: 240, windDir: 0.9, windSpeed: 0.8 });
