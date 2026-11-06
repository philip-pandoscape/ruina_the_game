// The mini-games' rules for the board views (crates/engine-wasm/src/minigames.rs): the same rules
// modules the server plays the games by, asked through the engine's WebAssembly how a game's board
// is laid out, so the browser keeps no copy of them. A game is named by its place in
// shared/minigames.json, as it goes on the wire; what comes back is in the game's own terms, which
// its board view knows (src/ui/minigames/boards/, src/render/open/gameBoards/).
import { answer, wasm } from './wasm';

interface Calls {
  minigame_layout(game: number): number;
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
