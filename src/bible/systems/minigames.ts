// Mini-Games: written from its rules (`rules` below); every number from the content and the rules.

import { CHALLENGE, MINIGAMES, type MiniGameDef, SEAT_COLORS, TABLE } from '../../content/minigames';
import { minigameLayout } from '../../engine/minigames';
import { coins, count, duration, listOf, metres } from '../format';
import { described, join, system, table } from '../kit';
import { type Html, link, md, phrase, raw } from '../md';
import { rustConst, sourceNumber } from '../source';
import tablesSource from '../../../crates/server/src/play/tables.rs?raw';
import beaconsSource from '../../../crates/engine/src/minigames/games/beacons.rs?raw';

/** The numbers the tables' and Beacons' rules keep in their source, read as the page is drawn. */
const rule = () => ({
  showTables: rustConst(tablesSource, 'SHOW_TABLES'),
  rangeSlack: rustConst(tablesSource, 'RANGE_SLACK'),
  acceptRange: rustConst(tablesSource, 'ACCEPT_RANGE'),
  pin: rustConst(tablesSource, 'PIN'),
  seatRise: sourceNumber(tablesSource, /\(sy - y\)\.abs\(\) > (\d+(?:\.\d+)?)/, 'how level the ground under a table must be'),
  /** The server's own move for a player out of time: what a beacon beside your own is worth, and a single card over a pair. */
  besideWorth: sourceNumber(beaconsSource, /\.count\(\) \* (\d+) \+ usize::from\(hex == b\.centre\)/, 'what a beacon beside your own is worth'),
  scoreScale: sourceNumber(beaconsSource, /self\.worth\(seat, h\) \* (\d+) \+ usize::from\(cards\.len\(\) == 1\)/, 'how the server weighs its own moves'),
});

/** A seat's colour, as a dot of it. */
const dot = (seat: number) => raw(`<span style="color:${(SEAT_COLORS[seat] ?? '').replace(/[^#\w]/g, '')}">●</span>`);

/** A colour, as a swatch of it. */
const swatch = (color: string) =>
  raw(`<span style="display:inline-block;width:14px;height:14px;border-radius:3px;vertical-align:-2px;background:${color.replace(/[^#\w]/g, '')}"></span>`);

/** Beacons' own part of its file (content/minigames/beacons.json `rules`), as the page reads it. */
interface BeaconsRules {
  hand: number;
  harbour: number;
  perGood: number;
  row: number;
  goods: Array<{ name: string; icon: string; color: string }>;
  layout: number[];
}

/** The board Beacons' rules lay out (beacons.rs `layout`): its hexes, and which is the Old Beacon. */
interface BeaconsLayout {
  hexes: Array<{ q: number; r: number; good: number | null }>;
  centre: number;
}

/** Beacons' rules, from its file and from its rules module (the board, and how the server plays a turn for you). */
function beacons(g: MiniGameDef, index: number): Html {
  const R = rule();
  const b = g.rules as BeaconsRules;
  const board = minigameLayout<BeaconsLayout>(index);
  const radius = Math.max(...board.hexes.map((h) => Math.max(Math.abs(h.q), Math.abs(h.r), Math.abs(h.q + h.r))));
  const deck = b.goods.length * b.perGood;
  const onBoard = (good: number) => board.hexes.filter((h) => h.good === good).length;
  return join(
    md`
## ${g.name}

${phrase`${link(`minigames/${g.id}`)}`} is played on a board of ${count(board.hexes.length, 'hex', 'hexes')}, a hexagon ${radius} hexes from its middle to its edge. Each hex shows one of ${count(
      b.goods.length,
      'good',
    )} and no two alike are side by side; the hex in the middle is the Old Beacon, which shows none. The deck holds ${count(deck, 'card')}, ${b.perGood} of each good. Each player holds ${count(
      b.hand,
      'card',
    )}, and ${count(b.harbour, 'card')} lie face up as the Harbour.
`,
    table(
      ['Good', 'Colour', 'Hexes', 'Cards'],
      b.goods.map((x, i) => [raw(`${x.icon} ${x.name.replace(/[&<>]/g, '')}`), swatch(x.color), onBoard(i), b.perGood]),
      [2, 3],
    ),
    md`
A turn is one of these:

1. **One card:** light any unlit hex of that card's good with one of your beacons.
2. **Two cards of the same good:** light any unlit hex at all. This is the only way to light the Old Beacon.
3. **A swap:** discard one card and draw one.

Then draw back up: one card for each card you played, each from the Harbour (the deck fills its place at once) or the top of the deck. When the deck runs out, the cards played so far are shuffled into a new one. Then it is the other player's turn.

${count(b.row, 'beacon')} of yours in an unbroken straight row, along any of the board's three directions, wins at once. Every hex lit with no such row is a draw.

When your time runs out, the server plays your turn as well as it can: the best-placed single card, else the best-placed pair, else a swap of your first card, then cards from the deck.

$$
a hex's worth = ${R.besideWorth} × your beacons beside it + 1 for the Old Beacon
the server's choice = the move with the most: worth × ${R.scoreScale} + 1 for a single card
$$
`,
  );
}

/**
 * Each game's own rules, by its id: the page explains the table for every game, and these what is
 * played at it. A game this doesn't know yet is given its blurb.
 */
const GAMES: Record<string, (g: MiniGameDef, index: number) => Html> = { beacons };

export const minigames = system({
  id: 'minigames',
  title: 'Mini-Games',
  summary: 'Challenging another player, the stakes and the pot, the table, and the rules of each game.',
  icon: '🎲',
  keywords: ['game', 'challenge', 'stake', 'pot', 'table', 'beacons', 'wager', 'board', 'cards', 'concede'],
  rules: ['crates/engine/src/minigames/', 'crates/server/src/play/tables.rs'],
  content: ['shared/minigames.json#challenge', 'shared/minigames.json#table', 'shared/minigames.json#colors', 'shared/minigames.json#games'],
  body: () => {
    const R = rule();
    const stakes = CHALLENGE.stakes;
    return join(
      md`
Online, two players can sit down to a game for a pot. Walk up to another player and challenge them, naming the game and the stake; if they accept, both stakes go into the pot, a table appears between you for everyone nearby to see, and you play it out there. The winner takes the pot. There ${MINIGAMES.length === 1 ? 'is' : 'are'} ${count(MINIGAMES.length, 'game')} so far: ${raw(
        MINIGAMES.map((g) => link(`minigames/${g.id}`).html).join(', '),
      )}. The game server plays every game; the windows only show what it says.

## Challenging Someone

Stand within ${metres(CHALLENGE.range)} of another player and press F, when F has nothing else to do there (a merchant's counter or your plot always comes first). Choose the game and the stake. The stakes on offer are ${raw(
        listOf(stakes.map((s) => (s ? coins(s) : 'none'))).html,
      )}: only those you can pay show, and the other player has to be able to match yours.

The server refuses a challenge at once if either of you is riding, in the air, swimming, in the middle of an attack, a cast or a dodge, knocked down, carrying a pack, already at a table, or has an island it can't save just now. It refuses it too if you have a challenge out already, or one waits for your answer; if they are answering another; if they said no to you within the last ${duration(
        CHALLENGE.declineCooldown,
      )}; if they are more than ${metres(CHALLENGE.range + R.rangeSlack)} away; or if you can't pay the stake.

## The Answer

They have ${duration(
        CHALLENGE.inviteSeconds,
      )} to answer, and you can withdraw it until then. No answer in time and it lapses; a no means you can't challenge them again for ${duration(
        CHALLENGE.declineCooldown,
      )}. A yes checks everything again: both of you free, still within ${metres(
        R.acceptRange,
      )} of each other, both able to pay the stake, and room for the table. A challenge that fails these only because something can be put right stays open.

## The Table

The table goes down midway between you, on dry ground, with a seat ${metres(TABLE.seat)} either side of its middle, each on dry ground within ${metres(
        R.seatRise,
      )} of the table's height; with no such spot, find open, level ground. Then:

- Both stakes leave your purses for the pot, which is twice the stake.
- The player who was challenged takes the first seat, and its colour (${dot(0)}), and moves first; the challenger takes the other (${dot(1)}).
- You stay in your seat: pushed more than ${metres(R.pin)} out of it, you are put back. The world's keys wait while you play; Escape, or Concede, asks whether to give the game up.
- Everyone within ${metres(R.showTables)} sees the table and the board on it.

## Turns, Time and Forfeits

Each game gives a turn its own time. When yours runs out, the server plays the rest of your turn for you, and counts it against you: a number of those in a row and you lose (playing a turn yourself starts the count again). If your connection drops, you have ${duration(
        TABLE.awaySeconds,
      )} to come back before you lose; coming back in time stops that clock. Conceding loses at once.
`,
      table(
        ['Game', 'A Turn', 'Out of Time in a Row to Lose', 'Players'],
        MINIGAMES.map((g) => [link(`minigames/${g.id}`), duration(g.turnSeconds), g.timeoutsToForfeit, g.players]),
        [1, 2],
      ),
      md`
## The Pot

The winner takes the pot. A draw gives each stake back, and so does a game called off: when the server stops, every game going on is called off. A stake is held with your island from the moment the game starts, so money is never lost or doubled: an island the server stopped under gets its stake back, and when a game is paid out both players' islands are saved together. The table stays ${duration(
        TABLE.clearSeconds,
      )} with the result on it, then goes, and you are free.

`,
      ...MINIGAMES.map((g, i) => GAMES[g.id]?.(g, i) ?? join(md`## ${g.name}`, described(g.blurb))),
    );
  },
});
