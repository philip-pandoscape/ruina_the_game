import type { Stack } from './state';

// Land: what's built and planted in the world, and what's left standing in it (houses, farms, ships
// on the slipways, packs, vehicles), the shape of the engine's (crates/engine/src/life/land.rs). It
// is the world's, kept by where each piece stands and the same in every channel; while you play,
// your own is lent to your life and changed by its rules. Its times are on the land's clock (the
// world's online, your life's offline: LifeRead.now).

/** A trade or material pack. It is never in the bag: it is on a back, on the ground, or in cargo. */
export interface Pack {
  id: number;
  def: string;
  /** The land's clock when it was made, for freshness. */
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
  /** Livestock: the land's clock until which it is fed. */
  fedUntil?: number;
  /** Livestock: progress toward the next eggs, wool or milk, 0..1. */
  produce?: number;
}

/** A farm: a scarecrow and the plot of cells beside it. */
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
  /** The land's clock up to which property tax is paid. */
  taxPaidUntil: number;
  /** Online, its plot's claim isn't the registry's yet: nothing is built until it is. */
  pending?: boolean;
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

/** One character's land: everything of theirs that stands in the world. */
export interface Land {
  houses: House[];
  scarecrows: Scarecrow[];
  ships: ShipBuild[];
  packs: Pack[];
  vehicles: Vehicle[];
}

export function newLand(): Land {
  return { houses: [], scarecrows: [], ships: [], packs: [], vehicles: [] };
}

/** Each trading post's demand for each pack as it stood at a moment on the land's clock, by `${outpost}:${pack}` (crates/engine/src/life/market.rs). */
export type Market = Record<string, { value: number; at: number }>;
