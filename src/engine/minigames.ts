// The mini-games' rules for the board views (crates/engine-wasm/src/minigames.rs): the same rules
// modules the server plays the games by, asked through the engine's WebAssembly how a game's board
// is laid out and what a player may do now, so the browser keeps no copy of them and a board offers
// just what the server would take. A game is named by its place in shared/minigames.json, as it
// goes on the wire; what comes back is in the game's own terms, which its board views know
// (src/ui/minigames/boards/, src/render/open/gameBoards/).
import { answer, wasm, withText } from './wasm';

interface Calls {
  minigame_layout(game: number): number;
  minigame_options(game: number, p: number, n: number): number;
  minigame_deal(game: number, seed: number, turns: number): number;
}
const calls = () => wasm() as unknown as Calls;

const layouts = new Map<number, unknown>();

/** The board of the game at `game` in the bundle, as its rules lay it out (Beacons: each hex's place and good, and the Old Beacon). Asked once. */
export function minigameLayout<Layout>(game: number): Layout {
  if (!layouts.has(game)) {
    const n = calls().minigame_layout(game);
    if (!n) throw new Error(`the engine has no mini-game ${game}`);
    layouts.set(game, answer<Layout>(n));
  }
  return layouts.get(game) as Layout;
}

/** What a player at a table asks the game's rules (crates/engine/src/minigames/mod.rs `Asking`). */
export interface Asking {
  /** Their seat. */
  you: number;
  /** Whose move it is at the table: null once the game is over, however it ended. */
  toMove: number | null;
  /** The game as the server shows it to them (the table's `state`). */
  view: unknown;
  /** What they've picked so far, in the game's own terms (Beacons: places in the hand). */
  picked: unknown;
}

/**
 * What the player asking may do now in the game at `game` in the bundle, in the game's own terms
 * (Beacons: whether to play or draw, what each card can do, what the picked cards light, where to
 * draw from): the checks the server makes of their moves, asked of what they see.
 */
export function minigameOptions<Options>(game: number, asking: Asking): Options {
  const n = withText(JSON.stringify(asking), (p, len) => calls().minigame_options(game, p, len));
  if (!n) throw new Error(`mini-game ${game} can't answer that: ${JSON.stringify(asking).slice(0, 200)}`);
  return answer<Options>(n);
}

/** A game dealt and played on by its own rules (`minigameDeal`), in the game's own terms. */
export interface DealtGame<View> {
  /** Whose move it is: null once it's over. */
  toMove: number | null;
  /** Null while it goes on; else who won (null: a draw). */
  result: { winner: number | null } | null;
  /** The game as each seat sees it (the table's `state` for that seat). */
  views: [View, View];
  /** What everyone sees of it (the table's `board`). */
  board: unknown;
}

/**
 * The game at `game` in the bundle dealt from `seed` and played on for `turns` turns by the server's
 * own moves (as for a player out of time), or to its end: a made-up table for the developer pages
 * (src/dev/ui/), which needs no game of its own named.
 */
export function minigameDeal<View>(game: number, seed: number, turns: number): DealtGame<View> {
  const n = calls().minigame_deal(game, seed, turns);
  if (!n) throw new Error(`the engine has no mini-game ${game}`);
  return answer<DealtGame<View>>(n);
}
