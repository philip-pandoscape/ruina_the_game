import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { SERVER_EXE, serverBuilt } from './testServer';

// Updating the game while people play. When the server stops (a deploy: Railway stops the old
// server once the new one is up), every browser hears it's being updated, freezes its world under a
// screen that says so, and once the new server is up carries on where it was; a page that's out of
// date by then reloads straight back into the world. A connection that just drops freezes the same
// way. (server/src/world_socket.rs stop_world, src/net/worldLink.ts, src/main.ts.)
//
// So that it can stop and start the server, this file runs its own game server, and its own Vite
// forwarding to it, on ports of its own. It needs a database: RUINA_DATABASE_URL (or DATABASE_URL),
// e.g. the one `npm run up` starts, postgres://ruina:ruina@127.0.0.1:5433/ruina. Without one it's
// skipped.

const DB = process.env.RUINA_DATABASE_URL || process.env.DATABASE_URL || '';
const OFFSET = Number(process.env.TEST_PORT_OFFSET) || 0;
const GAME_PORT = 7786 + OFFSET;
const VITE_PORT = 5290 + OFFSET;
const BASE = `http://localhost:${VITE_PORT}`;

/** The game server, which these tests stop and start again. */
class GameServer {
  private proc: ChildProcess | null = null;
  private exit: Promise<void> = Promise.resolve();

  async start(): Promise<void> {
    const proc = spawn(SERVER_EXE, ['--battle', 'off', '--port', String(GAME_PORT)], {
      env: { ...process.env, DATABASE_URL: DB, DEV_LOGIN: '1', PORT: '' },
      stdio: 'ignore',
    });
    this.proc = proc;
    this.exit = new Promise((resolve) => proc.once('exit', () => resolve()));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const r = await fetch(`http://localhost:${GAME_PORT}/api/health`);
        if (r.ok && (await r.json()).database === true) return;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error('the game server did not start');
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /** Gone at once, with no word to anyone (a crash, or the machine going away). */
  kill(): void {
    this.proc?.kill('SIGKILL');
  }

  /** Resolves once the server process has ended. */
  exited(): Promise<void> {
    return this.exit;
  }
}

const server = new GameServer();
let vite: { close(): Promise<void> } | null = null;

// Tagged @alone: it stops and starts the server under pages that are playing, so it runs after the
// other files, one test at a time (playwright.config.ts).
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  if (!DB || !serverBuilt) return;
  test.setTimeout(240_000);
  await server.start();
  const { createServer } = await import('vite');
  const target = `http://localhost:${GAME_PORT}`;
  const dev = await createServer({
    configFile: false,
    // Quiet: it can't reach the game server while the tests have it stopped, and says so a lot.
    logLevel: 'silent',
    cacheDir: 'node_modules/.vite-update-test',
    server: { port: VITE_PORT, strictPort: true, proxy: { '/api': target, '/ws': { target, ws: true } } },
  });
  await dev.listen();
  vite = dev;
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
  test.skip(!serverBuilt, `needs the server built: cargo build --release --manifest-path server/Cargo.toml`);
  test.skip(!DB, 'needs a database for its own game server: set RUINA_DATABASE_URL (npm run up starts one at postgres://ruina:ruina@127.0.0.1:5433/ruina)');
});

const fresh = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(0, 20);

const game = <T>(page: Page, fn: (g: any) => T) => page.evaluate(`(${fn.toString()})(window.__game)`) as Promise<T>;

/** In the world, connected, with the island in. `after`: more ticks than this heard (a reconnect). */
async function playing(page: Page, after = 3): Promise<void> {
  await page.waitForFunction(
    (n) => {
      const o = (window as any).__game?.online?.();
      return (window as any).__game?.ready === true && o?.status === 'online' && !o.frozen && o.ticks > n && o.lifeLoaded;
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
      await route.fulfill({ response: res, body: (await res.text()).replace('/src/main.ts', '/src/main.ts?build=next') });
    },
  );

  expect((await page.request.post(`${BASE}/api/dev/stop`)).ok()).toBe(true);
  await server.exited();
  await server.start();
  await page.waitForFunction(() => (window as any).__game?.online?.()?.status === 'online', null, { timeout: 90_000 });
  await playing(page);
  expect(loads).toBe(1);
  // Straight back in, without the intro or the character select screen.
  expect(await game(page, (g) => g.online().character)).toEqual(who);
  expect(await page.evaluate(() => document.documentElement.classList.contains('splash-quick'))).toBe(true);
  // It doesn't reload again for a build it already reloaded for.
  await page.waitForTimeout(1500);
  expect(loads).toBe(1);
});
