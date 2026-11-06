import type { MiniGameDef } from '../../content/minigames';
import type { MakeBoardView } from './tables';

// Each game's board view: a module in ./boards/ named after its game (content/minigames/<id>.json),
// exporting `board`, found here by name, so a new game needs no list of games added to.

const BOARDS = import.meta.glob<MakeBoardView>('./boards/*.ts', { eager: true, import: 'board' });

/** The board view of `game`, if it has one (every game does: tests/unit/minigames.test.ts). */
export function boardOf(game: MiniGameDef): MakeBoardView | undefined {
  return BOARDS[`./boards/${game.id}.ts`];
}
