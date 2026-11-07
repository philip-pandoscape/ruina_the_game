import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { MINIGAMES } from '../../src/content/minigames';
import { minigameLayout, minigameOptions } from '../../src/engine/minigames';
import { useEngine } from '../../src/engine/wasm';
import { isTitleCase } from '../../src/ui/theme/text';
import { onlineReady as waitOnline } from '../support/game';

// Mini-games online (src/ui/minigames, crates/server/src/sim/tables.rs): walk up to another player,
// challenge them with F, they accept, both stakes go into the pot and a table is thrown down
// between them that everyone in the channel sees; they play Beacons there and the winner takes the
// pot. A refusal leaves both purses alone, and conceding hands the pot over. These play the real
// game against the real server with developer sign-in (`npm run up`, or RUINA_SERVER=...), and are
// skipped without one. The rules themselves are tested in Rust (crates/engine/src/minigames).
//
// The game steps only as fast as it draws, and CI draws in software, so waits on the server's
// answers are generous; the game itself is played through the test hooks a move at a time.

const SERVER = process.env.RUINA_SERVER ?? 'http://localhost:7777';
const SHOTS = 'screenshots';

/** Beacons: its place in the bundle, and its board as its rules lay it out (beacons.rs `layout`), asked of the engine's WebAssembly as the page asks it (`npm run engine` builds it, as Playwright's web server does). */
const BEACONS = MINIGAMES.findIndex((g) => g.id === 'beacons');
let HEXES: Array<{ q: number; r: number; good: number | null }> = [];

let serverUp = false;
test.beforeAll(async () => {
  useEngine(new WebAssembly.Instance(new WebAssembly.Module(readFileSync('target/wasm32-unknown-unknown/release/ruina_engine_wasm.wasm')), {}).exports);
  HEXES = minigameLayout<{ hexes: typeof HEXES }>(BEACONS).hexes;
  try {
    const r = await fetch(`${SERVER}/api/health`);
    serverUp = r.ok && (await r.json()).database === true;
  } catch {
    serverUp = false;
  }
});
test.beforeEach(() => test.skip(!serverUp, `needs the game server with a database at ${SERVER} (npm run up)`));

/** Windows a test opened for players of its own, closed after it: a game left running in one weighs on every test after. */
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of opened.splice(0)) await c.close().catch(() => {});
});

/** A name nobody has used yet. */
const fresh = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(0, 20);

/** Runs `fn` in the page with the game's test API (window.__game). */
const game = <T>(page: Page, fn: (g: any) => T) => page.evaluate(`(${fn.toString()})(window.__game)`) as Promise<T>;

interface Player {
  page: Page;
  name: string;
  id: number;
}

/**
 * `n` new players who share a channel. A new character lives in the first channel with room, so if
 * one fills a channel up the next starts another: then the ones before are let go and it starts again.
 */
async function together(browser: Browser, prefixes: string[]): Promise<Player[]> {
  const join = async (prefix: string) => {
    const context = await browser.newContext();
    opened.push(context);
    const page = await context.newPage();
    const name = fresh(prefix);
    await page.goto(`/?as=${name}&bugs=0`);
    await waitOnline(page);
    // A turn long enough for a browser drawing in software, as CI's does (the server only allows it in development).
    await game(page, (g) => g.setChallengeTurn(600));
    const o = await game(page, (g) => g.online());
    return { page, name, id: o.character.id as number, channel: o.channel as number };
  };
  for (let tries = 0; tries < 3; tries++) {
    const all = [];
    for (const p of prefixes) {
      const next = await join(p);
      if (all.length && next.channel !== all[0].channel) {
        for (const x of all) await x.page.context().close();
        all.length = 0;
      }
      all.push(next);
    }
    if (all.length === prefixes.length) return all;
  }
  throw new Error('could not get the players into one channel');
}

const mg = (p: Player) => game(p.page, (g) => g.minigames());
const coins = (p: Player) => game(p.page, (g) => g.life().coins as number);

/** Stands `a` and `b` 2.4 m apart on the plaza by the spawn, facing each other (and anyone else a few metres off, looking on). */
async function standTogether(players: Player[]): Promise<{ x: number; z: number }> {
  const zone = await game(players[0].page, (g) => g.zone());
  const at = { x: zone.spawn.x + 6, z: zone.spawn.z + 2 };
  const spots: Array<[number, number, number]> = [
    [at.x - 1.2, at.z, Math.PI / 2],
    [at.x + 1.2, at.z, -Math.PI / 2],
    [at.x, at.z + 5, Math.PI],
  ];
  for (let i = 0; i < players.length; i++) {
    await players[i].page.bringToFront();
    await players[i].page.evaluate(([x, z, f]) => window.__game.teleport(x, z, f), spots[i]);
  }
  return at;
}

/** Every label in the mini-game windows that isn't in Title Case (players' names are as they chose them). */
async function untitled(page: Page, names: string[]): Promise<string[]> {
  const labels = await page.evaluate(() => {
    const sel = [
      '.mg-win .lui-btn',
      '.mg-win .mw-bar',
      '.mg-win .h',
      '.mg-win .mg-stake',
      '.mg-win .lui-row .body b',
      '.mg-win .mg-seat > span',
      '.mg-win .mg-result .big',
      '.mg-win .mg-clock small',
    ].join(',');
    return [...document.querySelectorAll<HTMLElement>(sel)]
      .filter((e) => e.offsetParent !== null)
      .map((e) => {
        const c = e.cloneNode(true) as HTMLElement;
        c.querySelectorAll('small, .mny, img, svg').forEach((x) => x.remove());
        return c.textContent!.replace(/\s+/g, ' ').trim();
      })
      .filter(Boolean);
  });
  return labels.filter((l) => !isTitleCase(names.reduce((s, n) => s.split(n).join('Name'), l)));
}

/** A hex's six neighbours on Beacons' board. */
function near(i: number): number[] {
  const dirs = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
  ];
  return dirs.map(([dq, dr]) => HEXES.findIndex((h) => h.q === HEXES[i].q + dq && h.r === HEXES[i].r + dr)).filter((x) => x >= 0);
}

/** Every way the player at table `t` could light a hex, as their window finds them (from the engine): the hexes each card, and each pair of cards, lights. */
function lights(t: TableSeen): Array<{ cards: number[]; hexes: number[] }> {
  const n = t.state.hand?.length ?? 0;
  const picks: number[][] = [];
  for (let a = 0; a < n; a++) picks.push([a]);
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) picks.push([a, b]);
  const offered = (cards: number[]) => minigameOptions<{ hexes: number[] }>(BEACONS, { you: t.you, toMove: t.toMove, view: t.state, picked: cards }).hexes;
  return picks.map((cards) => ({ cards, hexes: offered(cards) })).filter((l) => l.hexes.length);
}

/** Your table as the page last heard it, as much as the moves below read. */
interface TableSeen {
  you: number;
  toMove: number | null;
  over?: unknown;
  state: { lit: number[]; draws: number; harbour: Array<number | null>; hand?: number[] };
}

/**
 * A move by `p` in the game at their table, if it's their turn and the game has moved on since
 * `last` (what they saw when they last moved). The winner works on `row`, taking the Harbour cards
 * it needs; the other plays well away from it, never beside their own beacons (so never four in a
 * row by chance). Returns what they saw when they moved, 'wait', or 'over'. The game is read as the
 * page last heard it from the server, so this works with the page in the background too.
 */
async function move(p: Player, role: 'win' | 'lose', row: number[], last: string): Promise<string> {
  const t = (await game(p.page, (g) => g.minigames()?.table)) as TableSeen | null;
  if (!t || t.over) return 'over';
  const s = t.state;
  const key = `${t.toMove}:${s.draws}:${s.lit.join('')}:${(s.hand ?? []).join('')}`;
  if (t.toMove !== t.you || key === last) return 'wait';
  const want = row.filter((h) => s.lit[h] === 0);
  let m: Record<string, unknown> | null = null;
  if (s.draws > 0) {
    const i = role === 'win' ? s.harbour.findIndex((x) => x !== null && want.some((h) => HEXES[h].good === x)) : -1;
    m = i >= 0 ? { k: 'draw', from: 'harbour', i } : { k: 'draw', from: 'deck' };
  } else if (role === 'win') {
    for (const l of lights(t).sort((a, b) => a.cards.length - b.cards.length)) {
      const h = l.hexes.find((x) => want.includes(x));
      if (h !== undefined) {
        m = { k: 'light', cards: l.cards, hex: h };
        break;
      }
    }
  } else {
    let best = Infinity;
    for (const l of lights(t)) {
      for (const h of l.hexes) {
        if (row.includes(h)) continue;
        const score = near(h).filter((n) => s.lit[n] === t.you + 1).length * 10 + l.cards.length;
        if (score < best) {
          best = score;
          m = { k: 'light', cards: l.cards, hex: h };
        }
      }
    }
  }
  await p.page.evaluate((m) => window.__game.tableMove(m), m ?? { k: 'swap', card: 0 });
  return key;
}

// Three game windows at once: a browser drawing in software (CI's) can't keep up with them.
test('a challenge accepted puts both stakes in the pot, throws a table down for everyone to see, and the winner takes the pot @gpu', async ({ browser }) => {
  test.setTimeout(process.env.CI ? 360_000 : 180_000);
  const [ann, bea, cal] = await together(browser, ['ann', 'bea', 'cal']);
  const errors: string[] = [];
  for (const p of [ann, bea]) p.page.on('pageerror', (e) => errors.push(`${p.name}: ${e}`));
  const at = await standTogether([ann, bea, cal]);
  expect(await coins(ann)).toBe(200);

  // Ann faces Bea: F offers to challenge her, and opens the challenge window.
  await ann.page.bringToFront();
  await expect.poll(() => game(ann.page, (g) => g.life().focus?.label), { timeout: 60_000 }).toBe(`Challenge ${bea.name}`);
  await ann.page.evaluate(() => window.__game.pressLife('interact'));
  const challenge = ann.page.locator('#mg-challenge');
  await expect(challenge).toBeVisible();
  // The stakes on offer are the ones Ann can cover: No Stake up to 1 silver, of her 2.
  await expect(challenge.locator('.mg-stake')).toHaveCount(5);
  await challenge.locator('.mg-stake[data-arg="50"]').click();
  await expect(challenge.locator('.mg-stake.sel')).toHaveAttribute('data-arg', '50');
  expect(await untitled(ann.page, [ann.name, bea.name])).toEqual([]);
  await ann.page.screenshot({ path: `${SHOTS}/minigames-01-challenge.png` });
  await challenge.locator('[data-act="send"]').click();
  await expect(challenge).toContainText(`Waiting for ${bea.name}`, { timeout: 60_000 });

  // Bea is asked, with the game and the stake, and accepts.
  await bea.page.bringToFront();
  const invite = bea.page.locator('#mg-invite');
  await expect(invite).toBeVisible({ timeout: 60_000 });
  await expect(invite).toContainText(`${ann.name} challenges you to Beacons`);
  expect(await untitled(bea.page, [ann.name, bea.name])).toEqual([]);
  await bea.page.screenshot({ path: `${SHOTS}/minigames-02-invite.png` });
  await invite.locator('[data-act="accept"]').click();

  // Both stakes are in the pot, and both are at the table: Bea (challenged) in seat 0, moving first.
  await expect.poll(async () => (await mg(bea))?.table?.you, { timeout: 60_000 }).toBe(0);
  await expect.poll(async () => (await mg(ann))?.table?.you, { timeout: 60_000 }).toBe(1);
  await expect.poll(() => coins(bea), { timeout: 60_000 }).toBe(150);
  await expect.poll(() => coins(ann), { timeout: 60_000 }).toBe(150);
  await expect(bea.page.locator('#mg-game')).toBeVisible();
  expect(await untitled(bea.page, [ann.name, bea.name])).toEqual([]);
  // Docked at the left, clear of the hotbar.
  const clear = await bea.page.evaluate(() => {
    const w = document.querySelector('#mg-game')!.getBoundingClientRect();
    const bar = document.querySelector('#abilities')!.getBoundingClientRect();
    return w.right <= bar.left || w.bottom <= bar.top;
  });
  expect(clear, 'the game window clear of the hotbar').toBe(true);

  // Everyone in the channel sees the table, Cal too, a few metres off.
  for (const p of [ann, bea, cal]) {
    await p.page.bringToFront();
    await expect
      .poll(async () => (await game(p.page, (g) => g.gameTables())).map((t: { seats: string[] }) => t.seats.join(' & ')), { timeout: 60_000 })
      .toEqual([`${bea.name} & ${ann.name}`]);
  }
  const table = (await game(cal.page, (g) => g.gameTables()))[0];
  expect(Math.hypot(table.x - at.x, table.z - at.z)).toBeLessThan(0.5);

  // At the table Ann stays put, whatever she presses.
  await ann.page.bringToFront();
  const seat = (await game(ann.page, (g) => g.state().player.pos)) as { x: number; z: number };
  await ann.page.evaluate(() => window.__game.scriptInput([[90, { moveX: 0, moveZ: 1, stickY: 1 }]]));
  await expect.poll(() => game(ann.page, (g) => g.net().scriptLeft), { timeout: 60_000 }).toBe(0);
  const after = (await game(ann.page, (g) => g.state().player.pos)) as { x: number; z: number };
  expect(Math.hypot(after.x - seat.x, after.z - seat.z), 'still in her seat').toBeLessThan(0.3);

  // Bea's first move through the window: a card, a glowing hex, then a card from the deck.
  await bea.page.bringToFront();
  const board = bea.page.locator('#mg-game');
  await board.locator('.mg-card[data-act="card"]').first().click();
  // Not on the row Ann is about to work on (below).
  const row = [-3, -2, -1, 0].map((q) => HEXES.findIndex((h) => h.q === q && h.r === 1));
  const glowing = await board.locator('.hx.can').evaluateAll((list) => list.map((e) => Number((e as HTMLElement).dataset.arg)));
  const first = glowing.find((h) => !row.includes(h));
  expect(first).toBeDefined();
  await board.locator(`.hx.can[data-arg="${first}"]`).click();
  await expect.poll(async () => (await mg(bea))?.table?.state?.draws, { timeout: 60_000 }).toBe(1);
  await board.locator('.mg-card.back').click();
  await expect.poll(async () => (await mg(bea))?.table?.toMove, { timeout: 60_000 }).toBe(1);

  // Then on to the end: Ann works on a row of four on the board's lower half, Bea plays well away.
  // Each moves when their own page says it's their turn.
  const last = new Map<Player, string>();
  let shot = false;
  const end = Date.now() + (process.env.CI ? 240_000 : 120_000);
  for (let over = false; !over; ) {
    expect(Date.now(), 'the game went on too long').toBeLessThan(end);
    let moved = false;
    for (const p of [bea, ann]) {
      const seen = await move(p, p === ann ? 'win' : 'lose', row, last.get(p) ?? '');
      if (seen === 'over') over = true;
      else if (seen !== 'wait') {
        last.set(p, seen);
        moved = true;
      }
    }
    if (!moved && !over) await ann.page.waitForTimeout(40);
    const lit = ((await mg(ann))?.table?.state?.lit ?? []).filter(Boolean).length;
    if (!shot && !over && lit >= 6) {
      // Mid-game: Ann's window, and the table as Cal sees it.
      shot = true;
      await ann.page.bringToFront();
      await ann.page.evaluate(() => window.__game.render());
      await ann.page.screenshot({ path: `${SHOTS}/minigames-03-game.png` });
      await cal.page.bringToFront();
      await cal.page.evaluate(() => window.__game.setCamera({ yaw: Math.PI, pitch: 0.4, distance: 3 }));
      await cal.page.evaluate(() => window.__game.render());
      await cal.page.screenshot({ path: `${SHOTS}/minigames-04-table.png` });
      expect((await game(cal.page, (g) => g.gameTables()))[0].pieces).toBeGreaterThanOrEqual(5);
    }
  }

  // Ann made her row: she takes the pot, and both see how it ended while the table stands (a few
  // seconds), each in their own window: a page in the background hears it late, so Bea's comes front.
  await expect.poll(async () => (await mg(ann))?.table?.over?.winner, { timeout: 60_000 }).toBe(1);
  await expect(ann.page.locator('#mg-game .mg-result')).toContainText('You Won');
  expect(await untitled(ann.page, [ann.name, bea.name])).toEqual([]);
  await bea.page.bringToFront();
  await expect.poll(async () => (await mg(bea))?.table?.over?.why, { timeout: 60_000 }).toBe('rules');
  await expect.poll(() => coins(ann), { timeout: 60_000 }).toBe(250);
  await expect.poll(() => coins(bea), { timeout: 60_000 }).toBe(150);

  // The table goes a few seconds later, for everyone, and the players are free again.
  await cal.page.bringToFront();
  await expect.poll(() => game(cal.page, (g) => g.gameTables().length), { timeout: 60_000 }).toBe(0);
  await expect.poll(async () => (await mg(ann))?.seated, { timeout: 60_000 }).toBe(false);
  expect(errors).toEqual([]);
});

test('a declined challenge leaves both purses alone, and conceding hands the pot over', async ({ browser }) => {
  test.setTimeout(process.env.CI ? 300_000 : 150_000);
  const [ann, bea] = await together(browser, ['ann', 'bea']);
  await standTogether([ann, bea]);

  // Bea says no: nothing moves, and Ann hears so.
  await ann.page.bringToFront();
  await expect.poll(() => game(ann.page, (g) => g.life().focus?.action), { timeout: 60_000 }).toBe('challenge');
  await ann.page.evaluate((id) => window.__game.challenge(id, 100), bea.id);
  await bea.page.bringToFront();
  const invite = bea.page.locator('#mg-invite');
  await expect(invite).toBeVisible({ timeout: 60_000 });
  await invite.locator('[data-act="decline"]').click();
  await expect(invite).toBeHidden({ timeout: 60_000 });
  await ann.page.bringToFront();
  await expect(ann.page.locator('#lui-toasts')).toContainText(`${bea.name} declined your challenge.`, { timeout: 60_000 });
  expect(await coins(ann)).toBe(200);
  expect(await coins(bea)).toBe(200);
  expect((await mg(ann))?.table).toBeNull();

  // Bea challenges Ann instead, who takes it; then Bea thinks better of it: Escape asks, and she concedes.
  await bea.page.bringToFront();
  await bea.page.evaluate((id) => window.__game.challenge(id, 25), ann.id);
  await ann.page.bringToFront();
  await expect(ann.page.locator('#mg-invite')).toBeVisible({ timeout: 60_000 });
  await ann.page.evaluate(() => window.__game.answerChallenge(true));
  await bea.page.bringToFront();
  await expect(bea.page.locator('#mg-game')).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => coins(bea), { timeout: 60_000 }).toBe(175);
  await bea.page.evaluate(() => window.__game.pressLife('escape'));
  const foot = bea.page.locator('#mg-game .mw-foot');
  await expect(foot).toContainText(`Concede the game? ${ann.name} takes the pot.`);
  await foot.locator('[data-act="concede"]').click();
  await expect.poll(async () => (await mg(bea))?.table?.over?.why, { timeout: 60_000 }).toBe('conceded');
  await expect(bea.page.locator('#mg-game .mg-result')).toContainText(`${ann.name} Won`);
  await expect.poll(() => coins(bea), { timeout: 60_000 }).toBe(175);
  await ann.page.bringToFront();
  await expect.poll(() => coins(ann), { timeout: 60_000 }).toBe(225);
});
