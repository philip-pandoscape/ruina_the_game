import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { Build } from '../../src/tuning';
import { onlineReady } from './game';
import { GameServer, ownServerMissing } from './ownServer';
import { serverBuilt } from './testServer';

// Fighting other players on the battlefield (content/dungeons/battlefield.json), the developer zone
// two sides of bots fight across: players on opposite sides, the server deciding every blow. A spec
// that uses it runs a world server of its own (the battlefield is one copy for every admin, so
// specs sharing a server would share it), serving the game built as beta has it; on a development
// server everyone is an admin, so anyone may go in. It needs a database (RUINA_DATABASE_URL), and
// skips without one.

export const ZONE = JSON.parse(readFileSync('content/dungeons/battlefield.json', 'utf8')) as {
  origin: { x: number; y: number; z: number };
};

/** Where each side stands to start: a few metres apart across the arena's south end, as the old battle server's spawns were. */
const SPOT = [
  { x: -2.5, z: -40, facing: Math.PI / 2 },
  { x: 2.5, z: -40, facing: -Math.PI / 2 },
];

export interface Fighter {
  page: Page;
  errors: string[];
}

const fresh = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`.slice(0, 20);

/**
 * Sets up a spec's battlefield: its own server, the built game, and every fighter's window closed
 * after each test. Returns `fighter`, which brings someone into the battlefield. The server's port is
 * `base` plus the worker's place among those running: a spec whose tests are tagged differently
 * (@gpu and not) runs in two workers at once, each with its own server.
 */
export function battlefield(base: number) {
  const port = base + (Number(process.env.TEST_PARALLEL_INDEX) || 0);
  const built = join(tmpdir(), `ruina-battlefield-${port}-${process.pid}`);
  const server = new GameServer(port, { STATIC_DIR: built });
  const contexts: BrowserContext[] = [];

  // One server, so one test at a time.
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async () => {
    if (ownServerMissing(serverBuilt)) return;
    test.setTimeout(240_000);
    const { build } = await import('vite');
    await build({ logLevel: 'warn', build: { outDir: built, emptyOutDir: true } });
    await server.start();
  });
  test.afterAll(() => {
    server.kill();
    rmSync(built, { recursive: true, force: true });
  });
  test.beforeEach(() => {
    const missing = ownServerMissing(serverBuilt);
    test.skip(!!missing, missing ?? '');
  });
  test.afterEach(async () => {
    for (const c of contexts.splice(0)) await c.close();
  });

  /**
   * Someone new, in the battlefield on side `team`, standing at that side's spot facing the other,
   * with build `b` if given (the server confirming it). `lag` plays them as if far away (?lag=ms);
   * `place` false leaves them where the battlefield lets them in (its south end); `bots` keeps the
   * battlefield's bots (otherwise sent away as they come in: only players fight).
   */
  async function fighter(
    browser: Browser,
    team: 0 | 1,
    b?: Build,
    { lag = 0, viewport = { width: 800, height: 450 }, place = true, bots = false } = {},
  ): Promise<Fighter> {
    const context = await browser.newContext({ viewport });
    contexts.push(context);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${server.url}/?as=${fresh(team ? 'red' : 'blue')}&bugs=0${lag ? `&lag=${lag}` : ''}`);
    await onlineReady(page);
    expect(await page.evaluate((t) => window.__game.enterZone('battlefield', t), team)).toBe(true);
    await page.waitForFunction((t) => window.__game.space()?.kind === 'dungeon' && window.__game.net().team === t, team, { timeout: 30_000 });
    // The first one in brings the battlefield's bots; most tests want players only.
    if (!bots) await withoutBots(page);
    const s = SPOT[team];
    if (place) await stand(page, s.x, s.z, s.facing);
    if (b) await useBuild(page, b);
    return { page, errors };
  }

  return { server, fighter };
}

/** Stands someone at (x, z) round the battlefield's origin, facing `facing`, once the server has put them there. */
export async function stand(page: Page, x: number, z: number, facing = 0): Promise<void> {
  const at = { x: ZONE.origin.x + x, z: ZONE.origin.z + z };
  await page.evaluate(([x, z, f]) => window.__game.teleport(x, z, f), [at.x, at.z, facing] as const);
  await page.waitForFunction(
    ([x, z]) => {
      const n = window.__game.net();
      return Math.hypot(n.x - x, n.z - z) < 0.3;
    },
    [at.x, at.z] as const,
    { timeout: 15_000 },
  );
  // Being put there was the server's doing, a correction of its own: count them from here.
  await page.evaluate(() => window.__game.clearCorrections());
}

/** Sends the battlefield's bots away, and waits until they've gone (they come back with the next player into it empty). */
export async function withoutBots(page: Page): Promise<void> {
  expect(await page.evaluate(() => window.__game.sendBots(0))).toBe(true);
  await page.waitForFunction(() => window.__game.bots().length === 0, null, { timeout: 10_000 });
}

/** Uses build `b`, and waits until the server's copy of this fighter uses it too. */
export async function useBuild(page: Page, b: Build): Promise<void> {
  expect(await page.evaluate((b) => window.__game.setBuild(b), b)).toBe(true);
  await confirmed(page, b);
}

/** Waits until the server's copy of this fighter uses build `b`. */
export const confirmed = (page: Page, b: Build) =>
  page.waitForFunction(
    (b) => {
      const n = window.__game.net();
      return String(n.skills) === String(b.skills) && n.weapon === b.weapon && String(n.abilities) === String(b.abilities);
    },
    b,
    { timeout: 10_000 },
  );

export const net = (page: Page) => page.evaluate(() => window.__game.net());
export const script = (page: Page, segments: Array<[number, Record<string, unknown>]>) => page.evaluate((s) => window.__game.scriptInput(s), segments);
export const scriptDone = (page: Page) => page.waitForFunction(() => window.__game.net().scriptLeft === 0, null, { timeout: 30_000 });
/** Waits until this fighter sees `n` other players (bots gone, so players only). */
export const seesPlayers = (page: Page, n: number) => page.waitForFunction((n) => window.__game.net().remotes.length >= n, n, { timeout: 10_000 });
/** Polls something on the page every frame until it's true; false if it never is. */
export const sometime = (page: Page, fn: string, timeout = 4000) =>
  page.waitForFunction(fn, null, { timeout, polling: 'raf' }).then(
    () => true,
    () => false,
  );
