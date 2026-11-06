import { readdirSync } from 'node:fs';
import * as THREE from 'three';
import { expect, test } from 'vitest';
import { MINIGAMES } from '../../src/content/minigames';
import { minigameDeal, minigameLayout } from '../../src/engine/minigames';
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

test('the engine deals every game and plays it on by its own rules, as the UI gallery makes up a table', () => {
  MINIGAMES.forEach((g, i) => {
    const dealt = minigameDeal(i, 3, 0);
    expect({ toMove: dealt.toMove, result: dealt.result, seats: dealt.views.length }, g.id).toEqual({ toMove: 0, result: null, seats: 2 });
    // The table's board and each seat's view are what a board view draws.
    expect(() => boardOf(g)!(g, i, () => {}).body({ ...yours(i, dealt.views[0] as Record<string, unknown>), board: dealt.board }), g.id).not.toThrow();
    const over = minigameDeal(i, 3, 1000);
    expect(over.toMove, g.id).toBeNull();
    expect(over.result, g.id).not.toBeNull();
  });
  expect(() => minigameDeal(MINIGAMES.length, 3, 0)).toThrow();
});

// Beacons, the first game: its boards draw the board its rules play on, and offer what they allow.

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

/** Beacons as the server shows it to you, your turn to play (`state` over it): the board unlit, two of the first good in your hand. */
function playing(state: Record<string, unknown> = {}): TableView {
  const unlit = minigameLayout<Layout>(BEACONS).hexes.map(() => 0);
  return yours(BEACONS, {
    lit: unlit,
    cards: [4, 4],
    harbour: [3, 4, 5],
    deck: 20,
    discards: 2,
    turn: 0,
    draws: 0,
    row: [],
    log: [],
    hand: [0, 0, 1, 2],
    ...state,
  });
}

/** The hexes the window makes glow. */
const glowing = (html: string) => [...html.matchAll(/<g class="hx[^"]*\bcan\b[^"]*" data-act="hex" data-arg="(\d+)"/g)].map((m) => Number(m[1]));

test('Beacons’ window offers what its rules allow, asked of the engine: the hexes a card or a pair lights, the pair, the swap', () => {
  const game = MINIGAMES[BEACONS];
  const layout = minigameLayout<Layout>(BEACONS);
  const sent: Array<Record<string, unknown>> = [];
  const view = boardOf(game)!(game, BEACONS, (m) => sent.push(m));
  const t = playing();
  view.seen(t);
  // One card: the hexes of its good glow, and it can be swapped.
  view.click(t, 'card', '0');
  expect(glowing(view.body(t))).toEqual(layout.hexes.flatMap((h, i) => (h.good === 0 ? [i] : [])));
  expect(view.buttons(t)).not.toContain('disabled');
  // A second of its good makes a pair: every hex glows, the Old Beacon too; a pair isn't a swap.
  view.click(t, 'card', '1');
  expect(view.state()).toEqual({ picked: [0, 1] });
  expect(glowing(view.body(t))).toEqual(layout.hexes.map((_, i) => i));
  expect(view.buttons(t)).toContain('disabled');
  // A card of another good doesn't pair with it: it's picked alone.
  view.click(t, 'card', '2');
  expect(view.state()).toEqual({ picked: [2] });
  // A double-click picks a card with its pair, and a glowing hex lights them.
  view.dblclick(t, 'card', '1');
  expect(view.state()).toEqual({ picked: [1, 0] });
  view.click(t, 'hex', String(layout.centre));
  expect(sent).toEqual([{ k: 'light', cards: [1, 0], hex: layout.centre }]);
});

test('Beacons’ window offers the Harbour’s cards, and the deck while there is a card left to draw, as its rules say', () => {
  const game = MINIGAMES[BEACONS];
  const sent: Array<Record<string, unknown>> = [];
  const view = boardOf(game)!(game, BEACONS, (m) => sent.push(m));
  // Drawing back up with the deck run dry: the discards make a new one.
  const t = playing({ draws: 1, hand: [0, 1, 2], harbour: [3, null, 4], deck: 0, discards: 5 });
  view.seen(t);
  expect(view.body(t)).toMatch(/class="mg-card back take" data-act="deck"/);
  // Nothing left at all: no deck to draw from, nor the Harbour's empty place, nor a card to play.
  const dry = playing({ draws: 1, hand: [0, 1, 2], harbour: [3, null, 4], deck: 0, discards: 0 });
  view.seen(dry);
  expect(view.body(dry)).toMatch(/class="mg-card back" data-act="deck"/);
  view.click(dry, 'deck', '');
  view.click(dry, 'harbour', '1');
  view.click(dry, 'card', '0');
  expect(sent).toEqual([]);
  view.click(dry, 'harbour', '2');
  expect(sent).toEqual([{ k: 'draw', from: 'harbour', i: 2 }]);
});

test('Beacons’ window offers nothing on the other player’s turn, or once the game is over', () => {
  const game = MINIGAMES[BEACONS];
  const sent: Array<Record<string, unknown>> = [];
  const view = boardOf(game)!(game, BEACONS, (m) => sent.push(m));
  const theirs: TableView = { ...playing(), toMove: 1 };
  view.seen(theirs);
  view.click(theirs, 'card', '0');
  expect(view.state()).toEqual({ picked: [] });
  expect(view.hint(theirs)).toBe('Bea is thinking.');
  expect(view.menu(theirs, 'card', '0')?.entries.map((e) => e.disabled)).toEqual(['Wait for your turn', 'Wait for your turn', 'Wait for your turn']);
  const over: TableView = { ...playing(), toMove: null, over: { winner: 1, why: 'conceded' } };
  view.seen(over);
  view.click(over, 'card', '0');
  view.click(over, 'deck', '');
  expect(view.state()).toEqual({ picked: [] });
  expect(sent).toEqual([]);
});
