import type { MiniGameDef } from '../../content/minigames';
import type { MenuEntry } from '../theme/contextMenu';

// What the mini-game windows show of a table and a challenge, what they ask of the world connection
// (the app hands them the connection, src/net/worldLink.ts, which they don't import), and what a
// game's board view (src/ui/minigames/boards/<game>.ts) gives the game window.

/** Your own table as you may see it: the clock, and the game as the rules show it to you. */
export interface TableView {
  id: number;
  /** The game: its place in shared/minigames.json (MINIGAMES). */
  game: number;
  /** Its middle on the ground, and the way from seat 0 to seat 1 (x = sin, z = cos). */
  x: number;
  y: number;
  z: number;
  rot: number;
  /** Seat 0 was challenged and moves first. */
  seats: Array<{ id: number; name: string; timeouts: number; away: boolean }>;
  /** Each player's stake (copper). */
  stake: number;
  /** The board as anyone may see it, in the game's own terms. */
  board: unknown;
  /** Once the game is over: who won (null: nobody) and why. */
  over?: { winner: number | null; why: 'rules' | 'conceded' | 'timeouts' | 'away' | 'aborted' };
  /** Your seat. */
  you: number;
  turnSeconds: number;
  /** What was left on the clock of the player to move when this was sent. */
  ms: number;
  toMove: number | null;
  /** The game as its rules show it to you, in the game's own terms (its board view's to read). */
  state: Record<string, unknown>;
}

/** A challenge as the server tells it to both players. */
export interface ChallengeView {
  from: number;
  fromName: string;
  to: number;
  toName: string;
  /** The game: its place in shared/minigames.json (MINIGAMES). */
  game: number;
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
  /** Challenges `to` to the game `game` names (its id). */
  challenge(to: number, game: string, stake: number, seed?: number): boolean;
  withdraw(): boolean;
  answer(from: number, accept: boolean): boolean;
  move(table: number, m: Record<string, unknown>): boolean;
  concede(table: number): boolean;
}

/** A menu a board offers on a right-click: its title and what can be done. */
export interface BoardMenu {
  title: string;
  entries: MenuEntry[];
}

/**
 * A game's board in the game window, between the players' seats and the window's foot: the board
 * view of its game (src/ui/minigames/boards/<game>.ts, found by the game's id). The window draws the
 * seats, the clock, how the game ended and Concede; the board view everything of the game's own, from
 * the table as the server sent it, and sends what the player chooses as moves in the game's terms.
 * What it draws answers clicks through `data-act` and `data-arg`, and asks for tooltips with
 * `data-tip="mg:<key>"`.
 */
export interface BoardView {
  /** A new view of the table came: whatever the player had picked that no longer makes sense goes. */
  seen(t: TableView): void;
  /** What the window must draw again for, besides a new view of the table (the cards picked). */
  readonly key: string;
  /** What to do now, in a sentence or two (HTML). */
  hint(t: TableView): string;
  /** The board, and whatever else of the game the window shows (HTML). */
  body(t: TableView): string;
  /** What happened last (HTML). */
  log(t: TableView): string;
  /** The game's own buttons in the window's foot, before Concede (HTML). */
  buttons(t: TableView): string;
  /** How the rules ended the game (`over.why` is "rules"), in a sentence, as the player in seat `t.you` reads it. */
  ended(t: TableView): string;
  /** A click on something of the board's. */
  click(t: TableView, act: string, arg: string): void;
  /** A double-click: the main action of what was double-clicked. */
  dblclick(t: TableView, act: string, arg: string): void;
  /** A right-click: what can be done with what was clicked, or null for nothing. */
  menu(t: TableView, act: string, arg: string): BoardMenu | null;
  /** The tooltip for `data-tip="mg:<key>"`, or null. */
  tip(key: string): string | null;
  /** For tests: what the board holds (Beacons: the cards picked). */
  state(): Record<string, unknown>;
}

/** Makes a game's board view: the game, its place in the bundle (to ask its rules through the engine), and how to send a move. */
export type MakeBoardView = (game: MiniGameDef, index: number, send: (m: Record<string, unknown>) => void) => BoardView;
