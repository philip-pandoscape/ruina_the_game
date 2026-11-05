import data from '../../shared/minigames.json' with { type: 'json' };

// Mini-games two players play at a table thrown down between them, for a pot (shared/minigames.json).
// The game server plays them (server/src/minigames); the browser shows what it sends and sends
// what you choose (src/ui/minigames/), so there are no rules here, only what the screen needs.

export interface GoodDef {
  id: string;
  name: string;
  icon: string;
  color: string;
}

export interface MiniGameDef {
  id: string;
  name: string;
  icon: string;
  blurb: string;
  players: string;
  turnSeconds: number;
  timeoutsToForfeit: number;
  hand: number;
  harbour: number;
  row: number;
  goods: GoodDef[];
  layout: number[];
}

/** How close you have to be to challenge someone (m), how long they have to answer (s), and the stakes on offer (copper; 0 is No Stake). */
export const CHALLENGE: { range: number; inviteSeconds: number; declineCooldown: number; stakes: number[] } = data.challenge;
/** How far each player sits from a table's middle (m), and how long a finished game's table stays (s). */
export const TABLE: { seat: number; awaySeconds: number; clearSeconds: number } = data.table;
/** Each seat's colour: seat 0 (who was challenged, and moves first), then seat 1. */
export const SEAT_COLORS: readonly string[] = data.colors;
export const MINIGAMES: readonly MiniGameDef[] = data.games;

export function minigame(id: string): MiniGameDef | undefined {
  return MINIGAMES.find((g) => g.id === id);
}

/** The stakes you can offer with `coins` in your purse. */
export function stakesFor(coins: number): number[] {
  return CHALLENGE.stakes.filter((s) => s <= coins);
}

// ---------- Beacons' board ----------

export const BEACONS = minigame('beacons')!;

/** One hex of the board: axial coordinates and the good it shows (-1 for the Old Beacon). */
export interface Hex {
  q: number;
  r: number;
  good: number;
}

/** The board's hexes in the server's order: row by row from the top, q rising along each row. */
export const HEXES: readonly Hex[] = (() => {
  const out: Hex[] = [];
  const R = 3;
  for (let r = -R; r <= R; r++) for (let q = Math.max(-R, -R - r); q <= Math.min(R, R - r); q++) out.push({ q, r, good: BEACONS.layout[out.length] ?? -1 });
  return out;
})();

/** The Old Beacon, in the middle: only a pair lights it. */
export const OLD_BEACON = HEXES.findIndex((h) => h.q === 0 && h.r === 0);

/** Where a hex's middle is on a board drawn with hexes `size` from middle to corner, pointy side up. */
export function hexCentre(h: Hex, size: number): { x: number; y: number } {
  return { x: size * Math.sqrt(3) * (h.q + h.r / 2), y: size * 1.5 * h.r };
}
