// What the mini-game windows show of a table and a challenge, and what they ask of the world
// connection. The app hands them the connection (src/net/worldLink.ts), which they don't import.

/** Your own table as you may see it: the clock, and the game as the rules show it to you. */
export interface TableView {
  id: number;
  game: string;
  /** Its middle on the ground, and the way from seat 0 to seat 1 (x = sin, z = cos). */
  x: number;
  y: number;
  z: number;
  rot: number;
  /** Seat 0 was challenged and moves first. */
  seats: Array<{ id: number; name: string; timeouts: number; away: boolean }>;
  /** Each player's stake (copper). */
  stake: number;
  /** Beacons: who lit each hex (0 nobody, 1 seat 0, 2 seat 1) and the winning row. */
  board: { lit: number[]; row: number[] };
  /** Once the game is over: who won (null: nobody) and why. */
  over?: { winner: number | null; why: 'rules' | 'conceded' | 'timeouts' | 'away' | 'aborted' };
  /** Your seat. */
  you: number;
  turnSeconds: number;
  /** What was left on the clock of the player to move when this was sent. */
  ms: number;
  toMove: number | null;
  /** The game's own state (Beacons: beacons.ts BeaconsState). */
  state: Record<string, unknown>;
}

/** A challenge as the server tells it to both players. */
export interface ChallengeView {
  from: number;
  fromName: string;
  to: number;
  toName: string;
  game: string;
  /** Each player's stake (copper). */
  stake: number;
  /** Time left to answer when this was sent. */
  ms: number;
}

/** Your challenge out, and one waiting for your answer. */
export interface Challenges {
  sent: ChallengeView | null;
  waiting: ChallengeView | null;
}

/** What the mini-game windows read of the world connection and ask of it. */
export interface TableLink {
  /** Your table (null: none) and your challenges, and when each came (performance.now()). */
  readonly table: TableView | null;
  readonly tableHeard: number;
  readonly challenges: Challenges;
  readonly challengesHeard: number;
  onTable: ((t: TableView | null) => void) | null;
  onChallenges: ((c: Challenges) => void) | null;
  challenge(to: number, game: string, stake: number, seed?: number): boolean;
  withdraw(): boolean;
  answer(from: number, accept: boolean): boolean;
  move(table: number, m: Record<string, unknown>): boolean;
  concede(table: number): boolean;
}
