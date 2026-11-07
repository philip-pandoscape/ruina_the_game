import type { ContractState } from './contracts';

// Everything the open-world systems remember: money, labor, your bag, every trade pack in the
// world, summoned vehicles, farms, houses, demand at the trading posts, quests and weather. Plain
// data, the shape of the engine's (crates/engine/src/life/state.rs): it saves to JSON as it is, and
// the server keeps exactly this for each player's island.

export interface Stack {
  item: string;
  n: number;
}

/** A trade or material pack. It is never in the bag: it is on a back, on the ground, or in cargo. */
export interface Pack {
  id: number;
  def: string;
  /** World clock when it was made, for freshness. */
  made: number;
  origin: string;
  at: 'back' | 'ground' | 'cargo';
  x: number;
  y: number;
  z: number;
  rot: number;
  vehicle: number;
  slot: number;
}

export interface Vehicle {
  id: number;
  def: string;
  x: number;
  y: number;
  z: number;
  heading: number;
  vx: number;
  vy: number;
  vz: number;
  /** Forward speed along the heading (signed), kept for the HUD and the models. */
  speed: number;
  steer: number;
  throttle: number;
  /** Boats: how much sail is set, 0..1 (W raises it, S lowers it). */
  sail: number;
  grounded: boolean;
  pitch: number;
  roll: number;
  hp: number;
  /** A pack id per cargo slot, 0 where empty. */
  cargo: number[];
  /** Whether you are in it (always the driver's seat for now). */
  ridden: boolean;
  /** Mounts: in deep water. */
  swimming: boolean;
  /** Boats: told you about the rough water already. */
  stormWarned?: boolean;
}

export interface Plant {
  crop: string;
  /** 0..1 along the crop's growth; 1 is ripe. */
  growth: number;
  watered: boolean;
  /** Trees only: fruit picked at least once (they regrow from the last stage). */
  picked: boolean;
  /** Livestock: an animal rather than a plant (`crop` is then the animal's id). */
  animal?: boolean;
  /** Livestock: world clock until which it is fed. */
  fedUntil?: number;
  /** Livestock: progress toward the next eggs, wool or milk, 0..1. */
  produce?: number;
}

export interface Scarecrow {
  id: number;
  x: number;
  z: number;
  rot: number;
  /** One per cell, row-major from the back-left; null where nothing is planted. */
  cells: Array<Plant | null>;
}

export interface House {
  id: number;
  plot: string;
  blueprint: string;
  /** Stages finished, 0..stages.length (complete). */
  stage: number;
  /** Material packs delivered toward the current stage. */
  delivered: Record<string, number>;
  storage: Stack[];
  /** World clock up to which property tax is paid. */
  taxPaidUntil: number;
}

/** A ship on a slipway, part built. */
export interface ShipBuild {
  id: number;
  slip: string;
  design: string;
  /** Stages finished, 0..stages.length (ready to launch). */
  stage: number;
  delivered: Record<string, number>;
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

export interface Weather {
  rainUntil: number;
  nextRain: number;
  /** Direction the wind blows toward (radians, 0 = +Z) and its strength 0..1. */
  windDir: number;
  windSpeed: number;
}

export interface LifeState {
  version: number;
  /** World seconds since this save began. Keeps running (at a rate) while you are away. */
  clock: number;
  coins: number;
  /**
   * Coins on a table for a mini-game being played online (crates/server/src/sim/tables.rs): out of
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
  packs: Pack[];
  vehicles: Vehicle[];
  scarecrows: Scarecrow[];
  houses: House[];
  ships: ShipBuild[];
  /** Vehicles being repaired after breaking up: vehicle id (def) -> world clock when ready. */
  repairs?: Record<string, number>;
  /** Trade contracts offered at the posts and taken on. */
  contracts?: ContractState;
  /** What you sold to merchants and can still buy back from them, oldest first (src/engine/life/trade.ts). */
  buyback?: Buyback[];
  /** Demand multiplier per `${outpost}:${pack}`. */
  demand: Record<string, number>;
  /** Gathering spots resting: the spot's id -> the island's clock when it is back. */
  nodes: Record<string, number>;
  quests: { active: QuestProgress[]; done: string[] };
  /** Experience of each skill in the skill book, by its id (src/engine/life/progress.ts). */
  skillXp: Record<string, number>;
  weather: Weather;
  stats: { delivered: number; earned: number; harvested: number; glideSeconds: number; built: number };
  /** Where you wake after a rest; null for the zone's spawn. */
  home: { x: number; z: number } | null;
  nextId: number;
  rng: number;
}

export const LIFE_VERSION = 3;

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
    packs: [],
    vehicles: [],
    scarecrows: [],
    houses: [],
    ships: [],
    demand: {},
    nodes: {},
    quests: { active: [], done: [] },
    skillXp: {},
    weather: { rainUntil: 0, nextRain: 240, windDir: 0.9, windSpeed: 0.8 },
    stats: { delivered: 0, earned: 0, harvested: 0, glideSeconds: 0, built: 0 },
    home: null,
    nextId: 1,
    rng: start.seed >>> 0 || 1,
  };
}
