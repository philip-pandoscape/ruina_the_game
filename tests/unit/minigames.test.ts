import { readdirSync } from 'node:fs';
import * as THREE from 'three';
import { expect, test } from 'vitest';
import { MINIGAMES } from '../../src/content/minigames';
import { minigameLayout } from '../../src/engine/minigames';
import { GameTables, type ShownTable } from '../../src/render/open/gameTables';
import { boardOf } from '../../src/ui/minigames/boards';
import type { TableView } from '../../src/ui/minigames/tables';

// A mini-game is its file (content/minigames/<id>.json), its rules (crates/engine/src/minigames/
// games/<id>.rs, found by the engine's build script) and its boards: in the game window
// (src/ui/minigames/boards/<id>.ts) and on the table in the world (src/render/open/gameBoards/
// <id>.ts), each found by the game's id. There is no list of games: these hold the four together,
// and the boards to the board the rules lay out, asked through the engine's WebAssembly. The rules
// themselves are tested in Rust (crates/engine/src/minigames), the game online in
// tests/integration/minigames.spec.ts.

/** Where each game has a module of its own, named after it. */
const MODULES = ['crates/engine/src/minigames/games', 'src/ui/minigames/boards', 'src/render/open/gameBoards'];

/** A table at the origin, for the game at `game` in the bundle. */
const shown = (game: number, board: unknown = null): ShownTable => ({
  id: 100 + game,
  game,
  x: 0,
  y: 0,
  z: 0,
  rot: 0,
  seats: [
    { id: 1, name: 'Ann' },
    { id: 2, name: 'Bea' },
  ],
  board,
});

/** Your own table, in seat 0 and to move, with the game as its rules show it to you. */
const yours = (game: number, state: Record<string, unknown>): TableView => ({
  ...shown(game),
  seats: [
    { id: 1, name: 'Ann', timeouts: 0, away: false },
    { id: 2, name: 'Bea', timeouts: 0, away: false },
  ],
  stake: 0,
  you: 0,
  turnSeconds: MINIGAMES[game].turnSeconds,
  ms: 1000,
  toMove: 0,
  state,
});

test('every game has its rules module and its boards, and every one of those its game', () => {
  const ids = MINIGAMES.map((g) => g.id).sort();
  for (const folder of MODULES) {
    const named = readdirSync(folder)
      .filter((f) => /\.(rs|ts)$/.test(f))
      .map((f) => f.replace(/\.(rs|ts)$/, ''))
      .sort();
    expect(named, folder).toEqual(ids);
  }
});

test('the engine lays out every game’s board, and its boards are found by its id, in the window and on a table', () => {
  const tables = new GameTables(new THREE.Scene());
  MINIGAMES.forEach((g, i) => {
    expect(minigameLayout(i), g.id).toBeTypeOf('object');
    expect(boardOf(g), g.id).toBeTypeOf('function');
    tables.update([shown(i)]);
    expect(tables.group.getObjectByName('gameTableBoard'), g.id).toBeDefined();
  });
  expect(() => minigameLayout(MINIGAMES.length)).toThrow();
});

// Beacons, the first game: its boards draw the board its rules play on.

const BEACONS = MINIGAMES.findIndex((g) => g.id === 'beacons');
interface Layout {
  hexes: Array<{ q: number; r: number; good: number | null }>;
  centre: number;
}

test('Beacons’ window draws every hex its rules lay out, the Old Beacon where they put it, and the row to win from its file', () => {
  const game = MINIGAMES[BEACONS];
  const layout = minigameLayout<Layout>(BEACONS);
  const unlit = layout.hexes.map(() => 0);
  const t = yours(BEACONS, {
    lit: unlit,
    cards: [4, 4],
    harbour: [0, 1, null],
    deck: 20,
    discards: 0,
    turn: 0,
    draws: 0,
    row: [],
    log: [],
    hand: [0, 0, 1, 2],
    legal: [],
  });
  const html = boardOf(game)!(game, BEACONS, () => {}).body(t);
  const hexes = [...html.matchAll(/<g class="hx([^"]*)" data-act="hex" data-arg="(\d+)"/g)];
  expect(hexes.map((m) => Number(m[2]))).toEqual(layout.hexes.map((_, i) => i));
  expect(hexes.filter((m) => m[1].includes('old')).map((m) => Number(m[2]))).toEqual([layout.centre]);
  // The row that wins is the file's: the same game played to five says so.
  const five = { ...game, rules: { ...(game.rules as object), row: 5 } };
  const won: TableView = { ...t, over: { winner: 0, why: 'rules' } };
  expect(boardOf(game)!(five, BEACONS, () => {}).ended(won)).toBe('Five in a row!');
});

test('Beacons’ table in the world has a peg for every lit beacon', () => {
  const layout = minigameLayout<Layout>(BEACONS);
  const lit = layout.hexes.map((_, i) => (i === layout.centre ? 1 : i % 9 === 0 ? 2 : 0));
  const tables = new GameTables(new THREE.Scene());
  tables.update([shown(BEACONS, { lit, row: [] })]);
  expect(tables.list()[0].pieces).toBe(lit.filter(Boolean).length);
  tables.update([shown(BEACONS, { lit: layout.hexes.map(() => 0), row: [] })]);
  expect(tables.list()[0].pieces).toBe(0);
});
