import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { onlineReady } from '../support/game';
import { GameServer, ownServerMissing } from '../support/ownServer';
import { serverBuilt } from '../support/testServer';

// Admins (docs/admin.md): the Admin menu shows for the accounts ADMIN_USERS names and for nobody
// else, and the server keeps the developer pages and commands from players. Every other online spec
// plays on a development server where everyone is an admin, so this file runs a game server of its
// own with ADMIN_USERS set (tests/support/ownServer.ts), serving the game built as it is for beta:
// the game, the developer pages in /dev/ and the design in /design/, so its guard is asked about
// the real pages. It needs a database (RUINA_DATABASE_URL); without one it's skipped.

const fresh = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(0, 20);
const ADMIN = fresh('boss');
const BUILT = join(tmpdir(), `ruina-admin-${process.pid}`);
const server = new GameServer(7787, { ADMIN_USERS: ADMIN, STATIC_DIR: BUILT });

// One server for all of them, so one at a time, in one worker (none is tagged @gpu or @alone, which
// would put it in a worker of its own, starting a second server on the same port).
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  if (ownServerMissing(serverBuilt)) return;
  test.setTimeout(240_000);
  // The game as beta has it (a second or two), served by the server itself.
  const { build } = await import('vite');
  await build({ logLevel: 'warn', build: { outDir: BUILT, emptyOutDir: true } });
  await server.start();
});

test.afterAll(() => {
  server.kill();
  rmSync(BUILT, { recursive: true, force: true });
});

test.beforeEach(() => {
  const missing = ownServerMissing(serverBuilt);
  test.skip(!!missing, missing ?? '');
});

/** Signed in as `name` (made if new, with a character named after it), on the character select screen. */
async function atCharacterSelect(page: Page, name: string): Promise<void> {
  expect((await page.request.post(`${server.url}/api/dev-login`, { data: { username: name } })).ok()).toBe(true);
  await page.goto(`${server.url}/?bugs=0`);
  await expect(page.locator('.cs-account').getByRole('button', { name: 'Sign Out' })).toBeVisible({ timeout: 60_000 });
}

/** Into the world with the character chosen. */
async function enterWorld(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Enter World' }).click();
  await onlineReady(page);
}

const coins = (page: Page) => page.evaluate(() => window.__game.life().coins);
const panel = (page: Page) => page.evaluate(() => window.__game.lifePanel());

/** The status of a request to the game server, with this page's sign-in. */
const status = async (page: Page, path: string, method: 'get' | 'post' = 'get') => (await page.request[method](`${server.url}${path}`)).status();

test('a player sees no Admin menu, and the server keeps the developer pages and commands from them', async ({ page }) => {
  await atCharacterSelect(page, fresh('plr'));
  await expect(page.locator('.cs-account').getByRole('button', { name: 'Admin' })).toHaveCount(0);

  await enterWorld(page);
  await expect(page.locator('#hud-menu [data-press="settings"]')).toBeVisible();
  await expect(page.locator('#hud-menu [data-press="admin"]')).toHaveCount(0);
  for (const key of ['dev', 'admin'] as const) {
    await page.evaluate((k) => window.__game.pressLife(k), key);
    expect(await panel(page)).toBeNull();
  }

  // The server ignores their developer commands: a second and a half of its ticks later, nothing.
  const before = await coins(page);
  await page.evaluate(() => window.__game.lifeCommand({ t: 'grant', coins: 300 }));
  const ticks = await page.evaluate(() => window.__game.online()!.ticks);
  await page.waitForFunction((t) => window.__game.online()!.ticks > t + 30, ticks);
  expect(await coins(page)).toBe(before);

  // Its developer pages aren't there for them, nor is stopping it; the game's own files are.
  expect(await status(page, '/')).toBe(200);
  expect(await status(page, '/dev/library.html')).toBe(404);
  expect(await status(page, '/design/')).toBe(404);
  expect(await status(page, '/api/dev/stop', 'post')).toBe(403);
});

test('an admin has the Admin menu on character select and in the world, and it opens Developer Tools', async ({ page }) => {
  await atCharacterSelect(page, ADMIN);
  await page.locator('.cs-account').getByRole('button', { name: 'Admin' }).click();
  const card = page.locator('.adm-card');
  await expect(card.getByRole('heading', { name: 'Admin' })).toBeVisible();
  for (const name of ['The Yard', 'The Battlefield', 'The Goblin Camp', 'Content Library', 'Design Bible', 'Ruina Bible'])
    await expect(card.getByRole('button', { name, exact: true })).toBeVisible();
  // A page opens in a tab of its own.
  const [tab] = await Promise.all([page.context().waitForEvent('page'), card.getByRole('button', { name: 'UI Design System' }).click()]);
  await tab.waitForURL('**/design/ui.html');
  await tab.close();
  await card.getByRole('button', { name: 'Close' }).click();
  await expect(card).toHaveCount(0);

  await enterWorld(page);
  await page.locator('#hud-menu [data-press="admin"]').click();
  expect(await panel(page)).toBe('admin');
  await expect(page.locator('.mw').getByRole('button', { name: 'Content Library' })).toBeVisible();
  // The developer zones, a button each, from the world.
  await expect(page.locator('.mw').getByRole('button', { name: 'The Battlefield', exact: true }).first()).toBeVisible();
  await page.locator('.mw').getByRole('button', { name: 'Developer Tools' }).click();
  expect(await panel(page)).toBe('dev');

  // The server takes their developer commands, and has their pages.
  const before = await coins(page);
  await page.evaluate(() => window.__game.lifeCommand({ t: 'grant', coins: 300 }));
  await expect.poll(() => coins(page), { timeout: 30_000 }).toBe(before + 300);
  expect(await status(page, '/dev/library.html')).toBe(200);
  expect(await status(page, '/design/')).toBe(200);
});

test('an admin goes into the battlefield from the world, finds its bots and an arena, and comes out at its door; a player is kept out', async ({
  page,
  browser,
}) => {
  const zone = JSON.parse(readFileSync('content/instances/battlefield.json', 'utf8'));
  const space = (p: Page) => p.evaluate(() => window.__game.space());

  // A player asks and nothing happens: the server keeps them where they are.
  const other = await browser.newContext();
  const player = await other.newPage();
  await atCharacterSelect(player, fresh('plr'));
  await enterWorld(player);
  expect(await player.evaluate(() => window.__game.enterZone('battlefield'))).toBe(true);
  const ticks = await player.evaluate(() => window.__game.online()!.ticks);
  await player.waitForFunction((t) => window.__game.online()!.ticks > t + 20, ticks);
  expect((await space(player))?.kind).toBe('channel');
  await other.close();

  await atCharacterSelect(page, ADMIN);
  await enterWorld(page);
  expect(await page.evaluate(() => window.__game.enterZone('battlefield'))).toBe(true);
  await expect.poll(async () => (await space(page))?.kind, { timeout: 30_000 }).toBe('dungeon');
  expect(await space(page)).toMatchObject({ kind: 'dungeon', dungeon: 'battlefield' });
  // Both sides' bots, and the arena drawn round you under the sky.
  await expect.poll(() => page.evaluate(() => window.__game.bots().length), { timeout: 30_000 }).toBeGreaterThanOrEqual(30);
  expect(await page.evaluate(() => window.__game.dungeon().drawn)).toBe('battlefield');

  // Out through its way out, at its door on the island.
  await page.evaluate(([x, z]) => window.__game.teleport(x, z), [zone.exit.x, zone.exit.z] as const);
  await expect
    .poll(() => page.evaluate(() => window.__game.throughPortal(false, 'battlefield') && window.__game.space()?.kind), { timeout: 30_000 })
    .toBe('channel');
  // Where the server puts you comes a moment after it says where you are.
  const fromDoor = async () => {
    const at = await page.evaluate(() => window.__game.state().player.pos);
    return Math.hypot(at.x - zone.door.outside.x, at.z - zone.door.outside.z);
  };
  await expect.poll(fromDoor, { timeout: 10_000 }).toBeLessThan(5);
});

test('an admin in the yard finds its dummy and slimes standing on its floor, and the dummy takes their blows', async ({ page }) => {
  const zone = JSON.parse(readFileSync('content/instances/yard.json', 'utf8'));
  const at = (sp: { x: number; z: number }) => ({ x: sp.x, z: sp.z });

  // Straight in from the character select screen: the Admin card's zone takes the chosen character
  // into the world and on into the yard.
  await atCharacterSelect(page, ADMIN);
  await page.locator('.cs-account').getByRole('button', { name: 'Admin' }).click();
  await page.locator('.adm-card').getByRole('button', { name: 'The Yard', exact: true }).click();
  await onlineReady(page);
  await expect.poll(() => page.evaluate(() => window.__game.space()), { timeout: 30_000 }).toMatchObject({ kind: 'dungeon', dungeon: 'yard' });

  // What its file brings, each where the file puts it, the server standing them on its floor (their
  // heights come over the ground under them, which in the yard is its floor).
  const spawned = (kind: string) => page.evaluate((k) => window.__game.shownActors().filter((a) => a.kindId === k), kind);
  await expect
    .poll(async () => (await spawned('slime')).length, { timeout: 30_000 })
    .toBe(zone.spawns.filter((sp: { kind: string }) => sp.kind === 'slime').length);
  const [dummy] = await spawned('dummy');
  const post = at(zone.spawns.find((sp: { kind: string }) => sp.kind === 'dummy'));
  expect(Math.hypot(dummy.x - post.x, dummy.z - post.z)).toBeLessThan(0.1);
  expect(Math.abs(dummy.y)).toBeLessThan(0.5);
  // Drawn there too, on the floor and not on the island far below.
  await expect.poll(() => page.evaluate(() => window.__game.drawnDummy()?.y ?? null), { timeout: 10_000 }).toBeCloseTo(0, 0);
  expect(await page.evaluate(([x, z]) => window.__game.ground(x, z), [post.x, post.z] as const)).toBeCloseTo(0, 1);

  // Up to it and swinging: the server, measuring from the floor, lets the blows land.
  await page.evaluate(([x, z]) => window.__game.teleport(x, z), [post.x, post.z - 1.2] as const);
  await page.waitForFunction(
    ([x, z]) => Math.hypot(window.__game.state().player.pos.x - x, window.__game.state().player.pos.z - z) < 0.5,
    [post.x, post.z - 1.2] as const,
    {
      timeout: 30_000,
    },
  );
  const hp = await page.evaluate(
    async ([id, x, z]) => {
      const g = window.__game;
      for (let i = 0; i < 600; i++) {
        const t = g.shownActors().find((a) => a.id === id);
        if (t && (t.hp < 1 || t.deadFrame >= 0)) return t.hp;
        const me = g.state().player.pos;
        g.scriptInput([[1, { attackPressed: i % 20 === 0, aimX: x - me.x, aimZ: z - me.z }]]);
        await new Promise((r) => requestAnimationFrame(r));
      }
      return 1;
    },
    [dummy.id, post.x, post.z] as const,
  );
  expect(hp).toBeLessThan(1);
});

test('an admin goes into the goblin camp from the Admin window and finds its war-band round the fire', async ({ page }) => {
  const zone = JSON.parse(readFileSync('content/instances/goblinCamp.json', 'utf8'));
  const band = zone.spawns.find((sp: { kind: string }) => sp.kind === 'goblin');
  await atCharacterSelect(page, ADMIN);
  await enterWorld(page);
  // Back in the yard the last test left them in (its copy is kept): the camp takes them straight out of it.
  await expect.poll(() => page.evaluate(() => window.__game.space()), { timeout: 10_000 }).toMatchObject({ kind: 'dungeon', dungeon: 'yard' });
  await page.locator('#hud-menu [data-press="admin"]').click();
  await page.locator('.mw').getByRole('button', { name: 'The Goblin Camp', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__game.space()), { timeout: 30_000 }).toMatchObject({ kind: 'dungeon', dungeon: 'goblinCamp' });
  expect(await page.evaluate(() => window.__game.dungeon().drawn)).toBe('goblinCamp');
  // The whole band, round the spot its file gives, on the camp's floor.
  const goblins = () => page.evaluate(() => window.__game.shownActors().filter((a) => a.kindId === 'goblin'));
  await expect.poll(async () => (await goblins()).length, { timeout: 30_000 }).toBe(band.count);
  for (const g of await goblins()) {
    expect(Math.hypot(g.x - band.x, g.z - band.z)).toBeLessThan(8);
    expect(Math.abs(g.y)).toBeLessThan(0.5);
  }
});
