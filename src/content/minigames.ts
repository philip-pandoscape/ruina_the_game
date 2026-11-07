import data from '../../shared/minigames.json' with { type: 'json' };

// Mini-games two players play at a table thrown down between them, for a pot (shared/minigames.json,
// built from content/minigames/). This is what every game has; a game's own part (`rules`) is its
// rules module's (crates/engine/src/minigames/games/<id>.rs) and its board view's
// (src/ui/minigames/boards/<id>.ts), which name no game here. The game server plays them; the
// browser shows what it sends and sends what you choose.

export interface MiniGameDef {
  id: string;
  name: string;
  icon: string;
  blurb: string;
  players: string;
  turnSeconds: number;
  timeoutsToForfeit: number;
  /** The game's own part, in its own terms, for its rules module and board view. */
  rules: unknown;
}

/** How close you have to be to challenge someone (m), how long they have to answer (s), and the stakes on offer (copper; 0 is No Stake). */
export const CHALLENGE: { range: number; inviteSeconds: number; declineCooldown: number; stakes: number[] } = data.challenge;
/** How far each player sits from a table's middle (m), and how long a finished game's table stays (s). */
export const TABLE: { seat: number; awaySeconds: number; clearSeconds: number } = data.table;
/** Each seat's colour: seat 0 (who was challenged, and moves first), then seat 1. */
export const SEAT_COLORS: readonly string[] = data.colors;
/** Every game, in content/minigames/_order.json's order: a game goes on the wire as its place here. */
export const MINIGAMES: readonly MiniGameDef[] = data.games;

export function minigame(id: string): MiniGameDef | undefined {
  return MINIGAMES.find((g) => g.id === id);
}

/** The stakes you can offer with `coins` in your purse. */
export function stakesFor(coins: number): number[] {
  return CHALLENGE.stakes.filter((s) => s <= coins);
}
