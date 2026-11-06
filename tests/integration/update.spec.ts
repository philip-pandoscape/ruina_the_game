import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { GameServer, ownServerMissing, viteFor } from '../support/ownServer';
import { serverBuilt } from '../support/testServer';

// Updating the game while people play. When the server stops (a deploy: Railway stops the old
// server once the new one is up), every browser hears it's being updated, freezes its world under a
// screen that says so, and once the new server is up carries on where it was; a page that's out of
// date by then reloads straight back into the world. A connection that just drops freezes the same
// way. (crates/server/src/play/socket.rs stop_world, src/net/worldLink.ts, src/main.ts.)
//
// So that it can stop and start the server, this file runs its own game server, and its own Vite
// forwarding to it, on ports of its own (tests/support/ownServer.ts). It needs a database:
// RUINA_DATABASE_URL (or DATABASE_URL). Without one it's skipped.

const server = new GameServer(7786);
let vite: { base: string; close(): Promise<void> } | null = null;
/** Where this file's own Vite serves the game. */
let BASE = '';

// Tagged @alone: it stops and starts the server under pages that are playing, so it runs after the
// other files, one test at a time (playwright.config.ts).
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  if (ownServerMissing(serverBuilt)) return;
  test.setTimeout(240_000);
  await server.start();
  vite = await viteFor(server, 5290, 'node_modules/.vite-update-test');
  BASE = vite.base;
  // A Vite of its own compiles the whole game for its first page, which takes most of a minute on
  // a busy machine: here, rather than in the first test's time.
  const warm = await browser.newPage();
  await warm.goto(`${BASE}/?bugs=0`, { timeout: 180_000 });
  await warm.close();
});

test.afterAll(async () => {
  server.kill();
  await vite?.close();
});

test.beforeEach(() => {
  const missing = ownServerMissing(serverBuilt);
  test.skip(!!missing, missing ?? '');
});

const fresh = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(0, 20);

const game = <T>(page: Page, fn: (g: any) => T) => page.evaluate(`(${fn.toString()})(window.__game)`) as Promise<T>;

/** In the world, connected, with the island in. `after`: more ticks than this heard (a reconnect). */
async function playing(page: Page, after = 3): Promise<void> {
  await page.waitForFunction(
    (n) => {
      const o = window.__game?.online?.();
      return window.__game?.ready === true && o?.status === 'online' && !o.frozen && o.ticks > n && o.lifeLoaded;
    },
    after,
    { timeout: 90_000 },
  );
}

/** Whether the world stands still: no rules steps and no inputs sent, over `ms`. */
async function standsStill(page: Page, ms = 1000): Promise<boolean> {
  const before = await game(page, (g) => ({ frame: g.state().frame, seq: g.online().seq }));
  await page.waitForTimeout(ms);
  const after = await game(page, (g) => ({ frame: g.state().frame, seq: g.online().seq }));
  return before.frame === after.frame && before.seq === after.seq;
}

test('a server update freezes the world and says so, and play carries on where it was on the new server', { tag: '@alone' }, async ({ page }) => {
  await page.goto(`${BASE}/?as=${fresh('upd')}&bugs=0`);
  await playing(page);
  const who = await game(page, (g) => g.online().character);
  const start = await game(page, (g) => g.life().coins);
  await game(page, (g) => g.lifeCommand({ t: 'grant', coins: 300 }));
  await expect.poll(() => game(page, (g) => g.life().coins), { timeout: 30_000 }).toBe(start + 300);
  await page.evaluate(() => ((window as any).__samePage = true));

  // The server stops as a deploy stops it.
  expect((await page.request.post(`${BASE}/api/dev/stop`)).ok()).toBe(true);
  const notice = page.getByRole('heading', { name: 'Ruina Is Being Updated' });
  await expect(notice).toBeVisible();
  await expect(page.getByText("Hold tight: you'll be right back where you were.")).toBeVisible();
  expect(await game(page, (g) => g.online().status)).toBe('updating');
  await server.exited();
  expect(await standsStill(page)).toBe(true);
  expect(await game(page, (g) => g.online().frozen)).toBe(true);

  // The new server: back by itself, on the same page, with the island as it was.
  const heard = await game(page, (g) => g.online().ticks);
  await server.start();
  await playing(page, heard + 3);
  await expect(notice).toBeHidden();
  expect(await page.evaluate(() => (window as any).__samePage)).toBe(true);
  expect(await game(page, (g) => g.online().character)).toEqual(who);
  expect(await game(page, (g) => g.life().coins)).toBe(start + 300);
  expect(await standsStill(page, 600)).toBe(false);
});

test("a server update while you're in a dungeon brings you back outside its door, the cave put away", { tag: '@alone' }, async ({ page }) => {
  // A restarted server has no copies of dungeons: it saved your island as standing outside the door.
  const door = JSON.parse(readFileSync('shared/zones/emberholm.json', 'utf8')).dungeons.find((d: { id: string }) => d.id === 'goblinsDread');
  await page.goto(`${BASE}/?as=${fresh('dun')}&bugs=0`);
  await playing(page);
  await page.evaluate(([x, z, f]) => window.__game.teleport(x, z, f), [door.outside.x, door.outside.z, door.outside.facing]);
  await expect
    .poll(
      async () => {
        const p = await game(page, (g) => g.state().player.pos);
        return Math.hypot(p.x - door.outside.x, p.z - door.outside.z);
      },
      { timeout: 30_000 },
    )
    .toBeLessThan(1);
  await game(page, (g) => g.throughPortal(true));
  await expect.poll(() => game(page, (g) => g.dungeon().inside), { timeout: 30_000 }).toBe('goblinsDread');

  expect((await page.request.post(`${BASE}/api/dev/stop`)).ok()).toBe(true);
  await server.exited();
  const heard = await game(page, (g) => g.online().ticks);
  await server.start();
  await playing(page, heard + 3);
  expect(await game(page, (g) => g.space().kind)).toBe('channel');
  expect(await game(page, (g) => g.dungeon().inside)).toBe(null);
  await expect
    .poll(
      async () => {
        const p = await game(page, (g) => g.state().player.pos);
        return Math.hypot(p.x - door.outside.x, p.z - door.outside.z);
      },
      { timeout: 30_000 },
    )
    .toBeLessThan(2);
});

test('a dropped connection freezes the world, and play comes back by itself', { tag: '@alone' }, async ({ page }) => {
  await page.goto(`${BASE}/?as=${fresh('drop')}&bugs=0`);
  await playing(page);

  server.kill();
  await server.exited();
  const notice = page.getByRole('heading', { name: 'Connection Lost' });
  await expect(notice).toBeVisible();
  await expect(page.getByText('Reconnecting…')).toBeVisible();
  expect(await game(page, (g) => g.online().status)).toBe('reconnecting');
  expect(await standsStill(page)).toBe(true);

  const heard = await game(page, (g) => g.online().ticks);
  await server.start();
  await playing(page, heard + 3);
  await expect(notice).toBeHidden();
  expect(await standsStill(page, 600)).toBe(false);
});

test('a page that is out of date reloads, and goes straight back into the world as the same character', { tag: '@alone' }, async ({ page }) => {
  await page.goto(`${BASE}/?as=${fresh('new')}&bugs=0`);
  await playing(page);
  const who = await game(page, (g) => g.online().character);
  let loads = 0;
  page.on('load', () => loads++);
  // From now on the page says it's another build of the game, as a deploy's page would.
  await page.route(
    (url) => url.pathname === '/',
    async (route) => {
      if (route.request().resourceType() !== 'fetch') return route.continue();
      const res = await route.fetch();
      // The page's module script (src/app/boot.ts in development) named as another build would name it.
      const next = (await res.text()).replace(/(<script type="module"[^>]* src="[^"?]+)"/, '$1?build=next"');
      await route.fulfill({ response: res, body: next });
    },
  );

  expect((await page.request.post(`${BASE}/api/dev/stop`)).ok()).toBe(true);
  await server.exited();
  await server.start();
  await page.waitForFunction(() => window.__game?.online?.()?.status === 'online', null, { timeout: 90_000 });
  await playing(page);
  expect(loads).toBe(1);
  // Straight back in, without the intro or the character select screen.
  expect(await game(page, (g) => g.online().character)).toEqual(who);
  expect(await page.evaluate(() => document.documentElement.classList.contains('splash-quick'))).toBe(true);
  // It doesn't reload again for a build it already reloaded for.
  await page.waitForTimeout(1500);
  expect(loads).toBe(1);
});
