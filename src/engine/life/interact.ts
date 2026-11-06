import { DAY } from './housing';
import type { IslandRead } from './life';

// What pressing F would do, as the page shows it: the engine works out the focus every step from
// what is near you and in front of you (crates/engine/src/life/interact.rs), so the prompt on screen
// is always exactly what the next press will do.

export type FocusAction =
  | 'talk'
  | 'sell'
  | 'craft'
  | 'pickup'
  | 'board'
  | 'ride'
  | 'load'
  | 'unload'
  | 'exit'
  | 'plant'
  | 'water'
  | 'harvest'
  | 'fell'
  | 'gather'
  | 'claim'
  | 'deliver'
  | 'build'
  | 'rest'
  | 'storage'
  | 'tax'
  | 'placeScarecrow'
  | 'keel'
  | 'shipDeliver'
  | 'shipBuild'
  | 'launch'
  | 'feed'
  | 'collect'
  | 'info'
  | 'challenge'
  | 'enterDungeon'
  | 'leaveDungeon';

export interface Focus {
  action: FocusAction;
  key: string;
  label: string;
  detail?: string;
  ok: boolean;
  x: number;
  y: number;
  z: number;
  npc?: string;
  bench?: string;
  pack?: number;
  vehicle?: number;
  /** Riding along: whose vehicle it is (their character). */
  host?: number;
  /** A challenge: the other player (their character). */
  other?: number;
  /** A dungeon's portal: which dungeon (content/dungeons). */
  dungeon?: string;
  slot?: number;
  sc?: number;
  cell?: number;
  node?: number;
  plot?: string;
  house?: number;
  slip?: string;
}

export interface Placement {
  item: string;
  x: number;
  z: number;
  rot: number;
  problem: string | null;
}

export function nodeReady(life: IslandRead, i: number): boolean {
  return (life.state.nodes[i] ?? 0) <= life.state.clock;
}

/** Seconds left on something, as "1m 20s". */
export function shortTime(s: number): string {
  s = Math.max(0, Math.ceil(s));
  if (s >= DAY) return `${Math.floor(s / DAY)}d ${Math.floor((s % DAY) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}
