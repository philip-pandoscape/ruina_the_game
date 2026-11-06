import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import type { Manifest } from '../../tools/assets/manifest';
import { onlineReady } from '../support/game';
import { GameServer, ownServerMissing } from '../support/ownServer';
import { serverBuilt } from '../support/testServer';

// The first download (docs/assets.md): the title screen, sign-in and character select, and nothing
// of the world, held to a budget. The game is built as beta has it and served by a game server of
// this file's own, which compresses as production does (brotli), to a browser with nothing cached;
// every byte that crosses the wire is counted, headers and all. Going in, the rest of the game's code
// and the island's files follow. It needs a database (RUINA_DATABASE_URL); without one it's skipped.

/** What the title screen, sign-in and character select may cost a new player, over the wire. */
const FIRST_DOWNLOAD_BUDGET = 2.4 * 1024 * 1024;
/** What the sign-in screen may cost before anything else is fetched. */
const SIGN_IN_BUDGET = 0.75 * 1024 * 1024;

declare global {
  interface Window {
    /** The loader's state (src/assets/loader.ts), there before the game is. */
    __assets: { pending(): number; arrived(): string[]; loaded(): { wanted: number; done: number } };
  }
}

const fresh = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(0, 20);
const BUILT = join(tmpdir(), `ruina-download-${process.pid}`);
const server = new GameServer(7789, { STATIC_DIR: BUILT });
let manifest: Manifest;

// One server for all of them, so one at a time, in one worker.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  if (ownServerMissing(serverBuilt)) return;
  test.setTimeout(240_000);
  const { build } = await import('vite');
  await build({ logLevel: 'warn', build: { outDir: BUILT, emptyOutDir: true } });
  await server.start();
  manifest = (await (await fetch(`${server.url}/asset-manifest.json`)).json()) as Manifest;
});

test.afterAll(() => {
  server.kill();
  rmSync(BUILT, { recursive: true, force: true });
});

test.beforeEach(() => {
  const missing = ownServerMissing(serverBuilt);
  test.skip(!!missing, missing ?? '');
});

interface Fetched {
  path: string;
  /** Bytes over the wire, headers included. */
  wire: number;
  done: boolean;
}

/** Every request the page makes from now on, with what it cost over the wire. */
async function watch(page: Page): Promise<{ fetched: Map<string, Fetched>; inFlight(): number; cdp: CDPSession }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  const fetched = new Map<string, Fetched>();
  cdp.on('Network.requestWillBeSent', (e) => {
    const url = new URL(e.request.url);
    if (url.protocol.startsWith('http')) fetched.set(e.requestId, { path: url.pathname, wire: 0, done: false });
  });
  cdp.on('Network.loadingFinished', (e) => {
    const f = fetched.get(e.requestId);
    if (f) Object.assign(f, { wire: e.encodedDataLength, done: true });
  });
  cdp.on('Network.loadingFailed', (e) => {
    const f = fetched.get(e.requestId);
    if (f) f.done = true;
  });
  return { fetched, inFlight: () => [...fetched.values()].filter((f) => !f.done).length, cdp };
}

/** Waits until `ready` holds and nothing is on its way, a few frames running. */
async function settled(page: Page, inFlight: () => number, ready: () => boolean | Promise<boolean>): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        return (await ready()) && inFlight() === 0;
      },
      { timeout: 90_000 },
    )
    .toBe(true);
}

const total = (fetched: Map<string, Fetched>) => [...fetched.values()].reduce((s, f) => s + f.wire, 0);
const kb = (b: number) => `${Math.round(b / 1024)} KB`;
/** The asset (by the manifest) each path fetched is, if it's one. */
const assetAt = (path: string) => manifest.assets.find((a) => `/${a.file}` === path);

test('the manifest lists every asset the build holds, each file there with its size, kind and zones', async ({ request }) => {
  expect(manifest.assets.length).toBeGreaterThan(150);
  for (const kind of ['model', 'animation', 'texture', 'icon', 'font'])
    expect(
      manifest.assets.some((a) => a.kind === kind),
      kind,
    ).toBe(true);
  expect(manifest.code.first.length).toBeGreaterThan(0);
  expect(manifest.code.later.some((c) => c.file.endsWith('.js'))).toBe(true);
  for (const a of manifest.assets.filter((x) => x.kind !== 'icon')) {
    const res = await request.get(`${server.url}/${a.file}`, { headers: { 'accept-encoding': 'identity' } });
    expect(res.status(), a.id).toBe(200);
    expect((await res.body()).byteLength, a.id).toBe(a.size);
    expect(res.headers()['cache-control'], a.id).toContain('immutable');
  }
  // The manifest itself is asked about every time, as the pages are.
  expect((await request.get(`${server.url}/asset-manifest.json`)).headers()['cache-control']).toBe('no-cache');
});

test('the title screen and sign-in fetch nothing of the game but their own code and typefaces', async ({ page }) => {
  const { fetched, inFlight } = await watch(page);
  await page.goto(`${server.url}/?bugs=0`);
  await expect(page.locator('input[name=username]')).toBeVisible({ timeout: 60_000 });
  await settled(page, inFlight, () => page.evaluate(() => document.fonts.status === 'loaded' && window.__assets.pending() === 0));
  const bytes = total(fetched);
  console.log(`sign-in: ${fetched.size} requests, ${kb(bytes)} over the wire`);
  const later = new Set(manifest.code.later.map((c) => `/${c.file}`));
  expect([...fetched.values()].filter((f) => later.has(f.path)).map((f) => f.path)).toEqual([]);
  expect([...fetched.values()].filter((f) => assetAt(f.path) && !assetAt(f.path)?.zones.includes('front')).map((f) => f.path)).toEqual([]);
  expect(bytes).toBeLessThan(SIGN_IN_BUDGET);
});

test('the first download (title screen, sign-in and character select) stays within its budget, and the world streams in after it', async ({ page }) => {
  test.setTimeout(180_000);
  expect((await page.request.post(`${server.url}/api/dev-login`, { data: { username: fresh('dl') } })).ok()).toBe(true);
  const { fetched, inFlight } = await watch(page);
  await page.goto(`${server.url}/?bugs=0`);
  await expect(page.getByRole('button', { name: 'Enter World' })).toBeVisible({ timeout: 60_000 });
  // Character select is up when its hero stands there in their made body, with their weapon.
  await settled(page, inFlight, () =>
    page.evaluate(() => document.fonts.status === 'loaded' && window.__assets.pending() === 0 && window.__assets.arrived().includes('models/hero')),
  );
  const first = [...fetched.values()];
  const bytes = total(fetched);
  const by = (pick: (f: Fetched) => boolean) => kb(first.filter(pick).reduce((s, f) => s + f.wire, 0));
  console.log(
    `first download: ${first.length} requests, ${kb(bytes)} over the wire (budget ${kb(FIRST_DOWNLOAD_BUDGET)}): ` +
      `code ${by((f) => /\.(js|css|html)$/.test(f.path) || f.path === '/')}, models ${by((f) => f.path.endsWith('.glb'))}, ` +
      `typefaces ${by((f) => f.path.endsWith('.woff2'))}, pictures ${by((f) => /\.(webp|jpg|png|ktx2)$/.test(f.path))}`,
  );
  // Nothing of the world yet: no island files, none of the game's own code.
  const later = new Set(manifest.code.later.map((c) => `/${c.file}`));
  expect(first.filter((f) => later.has(f.path)).map((f) => f.path)).toEqual([]);
  expect(first.filter((f) => assetAt(f.path) && !assetAt(f.path)?.zones.includes('front')).map((f) => f.path)).toEqual([]);
  expect(bytes, `the first download is ${kb(bytes)}: past its budget of ${kb(FIRST_DOWNLOAD_BUDGET)} (docs/assets.md)`).toBeLessThan(FIRST_DOWNLOAD_BUDGET);

  // Going in, the rest of the game's code comes, then the island's files.
  await page.getByRole('button', { name: 'Enter World' }).click();
  await onlineReady(page, 90_000);
  await page.waitForFunction(() => window.__game.assetsReady === true, null, { timeout: 90_000 });
  const after = [...fetched.values()].slice(first.length);
  expect(after.some((f) => later.has(f.path))).toBe(true);
  const island = after.map((f) => assetAt(f.path)).filter((a) => a?.zones.includes('emberholm'));
  expect(island.length).toBeGreaterThan(20);
  const loaded = await page.evaluate(() => window.__assets.loaded());
  expect(loaded.done).toBe(loaded.wanted);
  console.log(`into the world: ${after.length} more requests, ${kb(after.reduce((s, f) => s + f.wire, 0))} more over the wire`);
});
