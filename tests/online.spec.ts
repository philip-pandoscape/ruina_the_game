import { expect, test, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Emberholm on the game server: signing in, choosing among several characters (each with an island
// of its own), the server playing your island and keeping it in Postgres between visits, starting
// over, one window per character, and sharing a channel. These play the real game against the real
// server, so they need it running with developer sign-in: `npm run up` (Docker). Without it they're
// skipped. (Updates and dropped connections are in tests/update.spec.ts, with a server of its own.)
//
// The game steps (and sends its inputs) only as fast as it draws, and CI draws the island in
// software at a few frames a second, so waits on the server's answers are generous.

const SERVER = process.env.RUINA_SERVER ?? 'http://localhost:7777';
const PASSWORD = 'lantern-light-42';

let serverUp = false;
test.beforeAll(async () => {
  try {
    const r = await fetch(`${SERVER}/api/health`);
    serverUp = r.ok && (await r.json()).database === true;
  } catch {
    serverUp = false;
  }
});
test.beforeEach(() => test.skip(!serverUp, `needs the game server with a database at ${SERVER} (npm run up)`));

/** A name nobody has used yet (names are 3 to 20 letters, digits, - and _). */
const fresh = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(0, 20);

/** Runs `fn` in the page with the game's test API (window.__game). `fn` can't use anything from here. */
const game = <T>(page: Page, fn: (g: any) => T) => page.evaluate(`(${fn.toString()})(window.__game)`) as Promise<T>;

/** Waits until the server connection is up and the server has started sending the island. */
async function waitOnline(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const o = (window as any).__game?.online?.();
    return (window as any).__game?.ready === true && o?.status === 'online' && o.ticks > 3 && o.lifeLoaded;
  }, null, { timeout: 60_000 });
}

/** Waits until the server has written the island to the database again (it does every 5 s). */
async function saveAndWait(page: Page): Promise<void> {
  const before = await game(page, (g) => g.online().lastSaved);
  await expect.poll(() => game(page, (g) => g.online().lastSaved), { timeout: 20_000 }).toBeGreaterThan(before);
}

test('a new player makes an account, and their island is kept on the server between visits', async ({ page }) => {
  const name = fresh('new');
  await page.goto('/?bugs=0');
  await page.getByRole('button', { name: 'Create Account' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create Account' }).click();
  // Their first character is named after the account, waiting on the character select screen.
  await expect(page.locator('.cs-row.sel')).toContainText(name);
  await page.getByRole('button', { name: 'Enter World' }).click();
  await waitOnline(page);
  expect(await game(page, (g) => g.online().account)).toBe(name);
  expect(await game(page, (g) => g.online().character.name)).toBe(name);
  await expect(page.locator('#ruina-badge')).toContainText(name);

  // Earn something and go somewhere (both decided by the server), then come back later.
  const start = await game(page, (g) => g.life().coins);
  await game(page, (g) => g.lifeCommand({ t: 'grant', coins: 4321 }));
  await expect.poll(() => game(page, (g) => g.life().coins), { timeout: 30_000 }).toBe(start + 4321);
  await game(page, (g) => g.teleport(142, -200));
  await expect.poll(async () => {
    const p = await game(page, (g) => g.state().player.pos);
    return Math.hypot(p.x - 142, p.z + 200);
  }, { timeout: 30_000 }).toBeLessThan(2);
  await saveAndWait(page);

  await page.reload();
  await waitOnline(page);
  expect(await game(page, (g) => g.life().coins)).toBe(start + 4321);
  const p = await game(page, (g) => g.state().player.pos);
  expect(Math.hypot(p.x - 142, p.z + 200)).toBeLessThan(2);
});

test('the server decides where you are: a browser that moves itself is put back', async ({ page }) => {
  await page.goto(`/?as=${fresh('stray')}&bugs=0`);
  await waitOnline(page);
  const before = await game(page, (g) => g.state().player.pos);
  // Jump the browser's own copy across the island, as a modified browser might.
  await game(page, (g) => {
    const p = g.state().player.pos;
    g.reset({ x: p.x + 60, z: p.z + 60 });
  });
  await expect
    .poll(async () => {
      const p = await game(page, (g) => g.state().player.pos);
      return Math.hypot(p.x - before.x, p.z - before.z);
    }, { timeout: 30_000 })
    .toBeLessThan(2);
});

test('walking, sprinting and jumping online, the browser predicts what the server decides', async ({ page }) => {
  await page.goto(`/?as=${fresh('walk')}&bugs=0`);
  await waitOnline(page);
  await game(page, (g) =>
    g.scriptInput([
      [90, { moveZ: 1 }],
      [60, { moveX: 1, sprintHeld: true }],
      [1, { moveX: 1, jumpPressed: true, jumpHeld: true }],
      [40, { moveX: 1, jumpHeld: true }],
      [1, { moveX: 1, jumpPressed: true, jumpHeld: true }],
      [50, { moveX: 1 }],
      [60, {}],
    ]),
  );
  await expect.poll(() => game(page, (g) => g.net().scriptLeft), { timeout: 120_000 }).toBe(0);
  // Every input answered, and the answers matched the prediction.
  await expect.poll(() => game(page, (g) => g.online().seq - g.online().ack), { timeout: 30_000 }).toBeLessThan(12);
  const o = await game(page, (g) => g.online());
  expect(o.maxCorrection, `${o.corrections} corrections`).toBeLessThan(0.05);
});

test('a wrong password is refused, and the right one signs in', async ({ page, request }) => {
  const name = fresh('back');
  expect((await request.post('/api/register', { data: { username: name, password: PASSWORD } })).ok()).toBe(true);

  await page.goto('/?bugs=0');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByText('Wrong name or password.')).toBeVisible();

  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.getByRole('button', { name: 'Enter World' }).click();
  await waitOnline(page);
  expect(await game(page, (g) => g.online().account)).toBe(name);
});

test('names are unique regardless of case', async ({ request }) => {
  const name = fresh('Same');
  expect((await request.post('/api/register', { data: { username: name, password: PASSWORD } })).ok()).toBe(true);
  const again = await request.post('/api/register', { data: { username: name.toLowerCase(), password: PASSWORD } });
  expect(again.status()).toBe(409);
  expect((await again.json()).error).toBe('That name is taken.');
});

test('starting over throws the island away on the server too', async ({ page }) => {
  const name = fresh('over');
  await page.goto(`/?as=${name}&bugs=0`);
  await waitOnline(page);
  const start = await game(page, (g) => g.life().coins);
  await game(page, (g) => g.lifeCommand({ t: 'grant', coins: 500 }));
  await expect.poll(() => game(page, (g) => g.life().coins), { timeout: 30_000 }).toBe(start + 500);
  await saveAndWait(page);

  await page.goto(`/?as=${name}&fresh&bugs=0`);
  await waitOnline(page);
  expect(await game(page, (g) => g.life().coins)).toBe(start);
  // Gone for good, not just for that one visit.
  await page.goto(`/?as=${name}&bugs=0`);
  await waitOnline(page);
  expect(await game(page, (g) => g.life().coins)).toBe(start);
});

test('a second window takes the character over, and the first stops', async ({ page }) => {
  const name = fresh('twice');
  await page.goto(`/?as=${name}&bugs=0`);
  await waitOnline(page);

  // A new tab of the same browser: signed in already, it shows the character select screen.
  const second = await page.context().newPage();
  await second.goto('/?bugs=0');
  await second.getByRole('button', { name: 'Enter World' }).click();
  await waitOnline(second);

  await expect(page.getByRole('heading', { name: 'Playing in Another Window' })).toBeVisible();
  expect(await game(page, (g) => g.online().status)).toBe('kicked');
  // The window that took over saves; the one it replaced can't any more.
  await saveAndWait(second);
});

test('signing out goes back to the sign-in screen, and stays signed out', async ({ page }) => {
  await page.goto(`/?as=${fresh('leave')}&bugs=0`);
  await waitOnline(page);
  await page.locator('#ruina-badge').getByRole('button', { name: 'Sign Out' }).click();
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  await page.goto('/?bugs=0');
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  expect(await page.evaluate(() => fetch('/api/me').then((r) => r.json()))).toBeNull();
});

/** Whether the open world lets this page in (`query`: e.g. ?character=7). */
const worldLetsIn = (page: Page, query = '') =>
  page.evaluate(
    (q) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://${location.host}/ws/world${q}`);
        ws.onmessage = () => {
          ws.close();
          resolve('welcomed');
        };
        ws.onclose = () => resolve('refused');
      }),
    query,
  );

test('the badge sits at the bottom right under the menu buttons, clear of their labels and the stats line', async ({ page }) => {
  await page.goto(`/?as=${fresh('badge')}&bugs=0`);
  await waitOnline(page);
  // The title screen fades out a few frames after the island arrives: slow where frames are drawn
  // in software (CI).
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 30_000 });
  for (const [width, height] of [
    [1280, 720],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const box = (e: Element) => {
        const b = e.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
      };
      return {
        badge: box(document.getElementById('ruina-badge')!),
        menu: box(document.getElementById('hud-menu')!),
        others: [...document.querySelectorAll('#hud-menu .lbl, #hud-menu .hud-mbtn, #stats, #hint, #abilities')].map(box),
      };
    });
    const overlaps = (a: typeof r.badge, b: typeof r.badge) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    expect(r.others.filter((o) => overlaps(r.badge, o)), `${width}x${height}`).toEqual([]);
    // Under the menu, lined up with its right edge, on screen.
    expect(r.badge.top).toBeGreaterThan(r.menu.bottom);
    expect(Math.abs(r.badge.right - r.menu.right)).toBeLessThan(2);
    expect(r.badge.bottom).toBeLessThanOrEqual(height);
  }
});

test('the open world needs a signed-in player', async ({ page }) => {
  await page.goto('/?yard&bugs=0');
  expect(await worldLetsIn(page)).toBe('refused');
});

// ---------- Characters ----------

test('an account holds several characters, each with an island of its own', async ({ page }) => {
  const name = fresh('many');
  await page.goto(`/?as=${name}&bugs=0`);
  await waitOnline(page);
  const first = await game(page, (g) => g.online().character);
  expect(first.name).toBe(name);
  const start = await game(page, (g) => g.life().coins);
  await game(page, (g) => g.lifeCommand({ t: 'grant', coins: 777 }));
  await expect.poll(() => game(page, (g) => g.life().coins), { timeout: 30_000 }).toBe(start + 777);
  await saveAndWait(page);
  // Not while they're in the world.
  const busy = await page.request.delete(`/api/characters/${first.id}`, { data: { name } });
  expect(busy.status()).toBe(409);

  // Back to the character select screen (the badge's Characters), and a second character.
  await page.locator('#ruina-badge').getByRole('button', { name: 'Characters' }).click();
  await expect(page.getByRole('button', { name: 'Enter World' })).toBeVisible();
  await expect(page.locator('.cs-row.sel')).toContainText(name);
  const second = fresh('alt');
  await page.getByRole('button', { name: 'Create Character' }).click();
  await page.locator('.fd-modal').getByLabel('Name').fill(second);
  await page.locator('.fd-modal').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.cs-row.sel')).toContainText(second);
  await expect(page.locator('.cs-row[data-id]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Enter World' }).click();
  await waitOnline(page);
  expect(await game(page, (g) => g.online().character.name)).toBe(second);
  // A fresh island of their own: none of the first one's coins.
  expect(await game(page, (g) => g.life().coins)).toBe(start);
  await expect(page.locator('#ruina-badge')).toContainText(second);

  // The screen remembers who was chosen last; double-clicking the first goes back to their island.
  await page.locator('#ruina-badge').getByRole('button', { name: 'Characters' }).click();
  await expect(page.locator('.cs-row.sel')).toContainText(second);
  await page.locator('.cs-row', { hasText: name }).dblclick();
  await waitOnline(page);
  expect(await game(page, (g) => g.online().character)).toEqual(first);
  expect(await game(page, (g) => g.life().coins)).toBe(start + 777);
});

test('names are unique across the server whatever the case, and an account holds six characters', async ({ request }) => {
  const name = fresh('cap');
  expect((await request.post('/api/dev-login', { data: { username: name } })).ok()).toBe(true);
  // The account's first character has its name, whatever the case.
  const clash = await request.post('/api/characters', { data: { name: name.toUpperCase() } });
  expect(clash.status()).toBe(409);
  expect((await clash.json()).error).toBe('That name is taken.');
  expect((await request.post('/api/characters', { data: { name: 'no spaces' } })).status()).toBe(400);
  for (let i = 1; i < 6; i++) expect((await request.post('/api/characters', { data: { name: fresh(`c${i}`) } })).status()).toBe(201);
  const full = await request.post('/api/characters', { data: { name: fresh('c6') } });
  expect(full.status()).toBe(409);
  expect((await full.json()).error).toContain('at most 6');
  const list = await (await request.get('/api/characters')).json();
  expect(list.max).toBe(6);
  expect(list.characters).toHaveLength(6);
  // Nor can a new account take a character's name.
  const taken = await request.post('/api/register', { data: { username: list.characters[3].name.toLowerCase(), password: PASSWORD } });
  expect(taken.status()).toBe(409);
});

test('deleting a character takes their name typed, and only your own characters can be deleted or played', async ({ page, request }) => {
  const name = fresh('del');
  expect((await page.request.post('/api/dev-login', { data: { username: name } })).ok()).toBe(true);
  const other = fresh('gone');
  expect((await page.request.post('/api/characters', { data: { name: other } })).status()).toBe(201);
  await page.goto('/?bugs=0');
  await page.locator('.cs-row', { hasText: other }).click();
  await page.getByRole('button', { name: 'Delete Character' }).click();
  const dialog = page.locator('.fd-modal');
  const forever = dialog.getByRole('button', { name: 'Delete Forever' });
  await expect(forever).toBeDisabled();
  await dialog.getByLabel('Name').fill(name);
  await expect(forever).toBeDisabled();
  await dialog.getByLabel('Name').fill(other.toLowerCase());
  await forever.click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.cs-row[data-id]')).toHaveCount(1);
  await expect(page.locator('.cs-row.sel')).toContainText(name);

  // Someone else's character: not yours to delete, nor to play.
  const stranger = fresh('them');
  expect((await request.post('/api/dev-login', { data: { username: stranger } })).ok()).toBe(true);
  const theirs = (await (await request.get('/api/characters')).json()).characters[0];
  expect((await page.request.delete(`/api/characters/${theirs.id}`, { data: { name: stranger } })).status()).toBe(404);
  expect(await worldLetsIn(page, `?character=${theirs.id}`)).toBe('refused');
  const mine = (await (await page.request.get('/api/characters')).json()).characters[0];
  expect(await worldLetsIn(page, `?character=${mine.id}`)).toBe('welcomed');
});

// ---------- Sharing Emberholm ----------

/**
 * Two new players who share a channel. A new character lives in the first channel with room, so if
 * the first one took the last place in theirs, the second starts the next channel: then the second
 * stays, and the next new player joins them there.
 */
async function pair(browser: Browser): Promise<{ a: Page; b: Page; nameA: string; nameB: string }> {
  const player = async (prefix: string) => {
    const page = await (await browser.newContext()).newPage();
    const name = fresh(prefix);
    await page.goto(`/?as=${name}&bugs=0`);
    await waitOnline(page);
    return { page, name, channel: await game(page, (g) => g.online().channel) };
  };
  let first = await player('ann');
  for (let tries = 0; tries < 3; tries++) {
    const second = await player('bea');
    if (second.channel === first.channel) return { a: first.page, b: second.page, nameA: first.name, nameB: second.name };
    await first.page.context().close();
    first = second;
  }
  throw new Error('could not get two players into one channel');
}

const seen = (page: Page, name: string) =>
  page.evaluate((n) => (window as any).__game.peers().find((p: { name: string }) => p.name === n) ?? null, name);

test('players in the same channel see each other, wherever they go', async ({ browser }) => {
  const { a, b, nameA, nameB } = await pair(browser);
  await expect.poll(async () => (await seen(b, nameA))?.online, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await seen(a, nameB))?.online, { timeout: 30_000 }).toBe(true);

  // Ann heads up to Hearthside Rise; Bea watches her arrive.
  await a.bringToFront();
  await a.evaluate(() => (window as any).__game.teleport(142, -200));
  await b.bringToFront();
  await expect.poll(async () => {
    const p = await seen(b, nameA);
    return p ? Math.hypot(p.x - 142, p.z + 200) : Infinity;
  }, { timeout: 30_000 }).toBeLessThan(3);

  // When she leaves, she's gone from Bea's island too.
  await a.context().close();
  await expect.poll(async () => (await seen(b, nameA))?.online, { timeout: 30_000 }).toBe(false);
});

test("a neighbour's house is drawn on your island, and their plot can't be taken", async ({ browser }) => {
  const { a, b, nameA } = await pair(browser);
  const claims = await game(a, (g) => g.online().claims);
  const zone = await game(a, (g) => g.zone());
  const plot = zone.housePlots.find((p: { id: string }) => !claims[p.id]);
  test.skip(!plot, 'every plot in this channel is taken (a long-lived development database)');
  const site = [plot.x, plot.z + 5, plot.rot + Math.PI];

  // Ann claims the plot. (A window has to be in front for its game to run at full speed.)
  await a.bringToFront();
  await a.evaluate(() => (window as any).__game.lifeCommand({ t: 'grant', item: 'blueprint.cottage', n: 1 }));
  await a.evaluate(([x, z, f]) => (window as any).__game.teleport(x, z, f), site);
  await expect.poll(() => game(a, (g) => g.life().focus?.action), { timeout: 45_000 }).toBe('claim');
  await a.evaluate(() => (window as any).__game.lifeCommand({ t: 'interact' }));
  await expect.poll(() => game(a, (g) => g.life().houses.length), { timeout: 45_000 }).toBe(1);

  // Bea sees the building site, and the plot is Ann's.
  await b.bringToFront();
  await expect.poll(async () => (await seen(b, nameA))?.houses, { timeout: 30_000 }).toBe(1);
  await expect.poll(() => b.evaluate((id) => (window as any).__game.online().claims[id], plot.id), { timeout: 30_000 }).toBe(nameA);
  await b.evaluate(() => (window as any).__game.lifeCommand({ t: 'grant', item: 'blueprint.cottage', n: 1 }));
  await b.evaluate(([x, z, f]) => (window as any).__game.teleport(x, z, f), site);
  await expect.poll(() => game(b, (g) => g.life().focus?.label), { timeout: 45_000 }).toBe(`${nameA}'s Plot`);
});

test('a friend rides along in your cart wherever you drive it, and bumps into it parked', async ({ browser }) => {
  const { a, b, nameA } = await pair(browser);
  const ann = await game(a, (g) => g.online().character.id);
  // Ann brings her farm cart out on the west road.
  await a.bringToFront();
  await a.evaluate(() => (window as any).__game.lifeCommand({ t: 'grant', item: 'deed.farmCart', n: 1 }));
  await a.evaluate(() => (window as any).__game.teleport(150, -210, Math.PI / 2 + 0.25));
  await expect.poll(() => game(a, (g) => g.life().bag.some((s: { item: string }) => s.item === 'deed.farmCart')), { timeout: 30_000 }).toBe(true);
  await a.evaluate(() => (window as any).__game.lifeCommand({ t: 'summon', item: 'deed.farmCart' }));
  await expect.poll(() => game(a, (g) => g.life().vehicles.length), { timeout: 30_000 }).toBe(1);
  const cart = await game(a, (g) => g.life().vehicles[0]);
  /** A point beside a vehicle, given in its own frame (+x its left, +z ahead), out in the world. */
  const beside = (v: { x: number; z: number; heading: number }, lx: number, lz: number, turn: number) => [v.x + lx * Math.cos(v.heading) + lz * Math.sin(v.heading), v.z - lx * Math.sin(v.heading) + lz * Math.cos(v.heading), v.heading + turn];

  // Bea walks up to its passenger side: the prompt offers her a ride, and F puts her in.
  await b.bringToFront();
  await b.evaluate(([x, z, f]) => (window as any).__game.teleport(x, z, f), beside(cart, -1.7, 0.95, Math.PI / 2));
  await expect.poll(() => game(b, (g) => g.life().focus?.label), { timeout: 30_000 }).toBe(`Ride with ${nameA}`);
  await b.evaluate(() => (window as any).__game.pressLife('interact'));
  const seated = () => game(b, (g) => `${g.state().player.mode}:${g.state().player.host}:${g.state().player.seat}`);
  await expect.poll(seated, { timeout: 30_000 }).toBe(`ride:${ann}:1`);

  // Ann climbs into the driver's seat and drives off up the road.
  await a.bringToFront();
  await a.evaluate(([x, z, f]) => (window as any).__game.teleport(x, z, f), beside(cart, 1.7, 0.95, -Math.PI / 2));
  await expect.poll(() => game(a, (g) => g.life().focus?.action), { timeout: 30_000 }).toBe('board');
  await a.evaluate(() => (window as any).__game.pressLife('interact'));
  await expect.poll(() => game(a, (g) => g.state().player.mode), { timeout: 30_000 }).toBe('ride');
  await a.evaluate(() => (window as any).__game.scriptInput([[150, { stickY: 1 }], [90, { jumpHeld: true }]]));
  await expect.poll(() => game(a, (g) => g.net().scriptLeft), { timeout: 60_000 }).toBe(0);
  const moved = await game(a, (g) => g.life().vehicles[0]);
  expect(Math.hypot(moved.x - cart.x, moved.z - cart.z), 'Ann drove her cart up the road').toBeGreaterThan(6);

  // Bea went with her, in the seat beside Ann's; F gets her out, on her feet beside the cart.
  await b.bringToFront();
  await expect.poll(async () => {
    const p = (await game(b, (g) => g.state().player)) as { pos: { x: number; z: number } };
    return Math.hypot(p.pos.x - moved.x, p.pos.z - moved.z);
  }, { timeout: 30_000 }).toBeLessThan(1.6);
  expect(await seated()).toBe(`ride:${ann}:1`);
  await b.evaluate(() => (window as any).__game.pressLife('interact'));
  await expect.poll(seated, { timeout: 30_000 }).toBe('normal:0:0');

  // Parked, Ann's cart is as solid to Bea as her own would be: walking into its side, she stops at it.
  await a.bringToFront();
  await a.evaluate(() => (window as any).__game.pressLife('interact'));
  await expect.poll(() => game(a, (g) => g.state().player.mode), { timeout: 30_000 }).toBe('normal');
  const parked = await game(a, (g) => g.life().vehicles[0]);
  await b.bringToFront();
  const [sx, sz] = beside(parked, -3.4, 0, 0);
  await b.evaluate(([x, z, f]) => (window as any).__game.teleport(x, z, f), [sx, sz, parked.heading - Math.PI / 2]);
  const dir = [parked.x - sx, parked.z - sz].map((c) => c / 3.4);
  await b.evaluate(([x, z]) => (window as any).__game.scriptInput([[150, { moveX: x, moveZ: z }]]), dir);
  await expect.poll(() => game(b, (g) => g.net().scriptLeft), { timeout: 60_000 }).toBe(0);
  const bea = (await game(b, (g) => g.state().player)) as { pos: { x: number; z: number } };
  expect(Math.hypot(bea.pos.x - parked.x, bea.pos.z - parked.z), 'stopped against the side of the cart').toBeGreaterThan(1.3);
});

test('far from the server, a pack comes out of the cart at once and getting in does not sink the cart', async ({ page }) => {
  // 120 ms each way, about what the deployed server is from a long way off.
  await page.goto(`/?as=${fresh('far')}&bugs=0&lag=120`);
  await waitOnline(page);
  for (const [item, n] of [['deed.farmCart', 1], ['sunroot', 12], ['barley', 8]] as const) await page.evaluate(([i, k]) => (window as any).__game.lifeCommand({ t: 'grant', item: i, n: k }), [item, n]);
  const zone = await game(page, (g) => g.zone());
  const wb = zone.workbenches[0];
  await page.evaluate(([x, z]) => (window as any).__game.teleport(x - 6, z + 6, 0), [wb.x, wb.z]);
  await expect.poll(() => game(page, (g) => g.life().bag.some((s: { item: string }) => s.item === 'deed.farmCart')), { timeout: 30_000 }).toBe(true);
  await page.evaluate(() => (window as any).__game.lifeCommand({ t: 'summon', item: 'deed.farmCart' }));
  await expect.poll(() => game(page, (g) => g.life().vehicles.length), { timeout: 30_000 }).toBe(1);
  const cart = await game(page, (g) => g.life().vehicles[0]);
  // A crate from the bench, into the cart's bed.
  await page.evaluate(([x, z]) => (window as any).__game.teleport(x, z + 2, Math.PI), [wb.x, wb.z]);
  await page.evaluate(() => (window as any).__game.lifeCommand({ t: 'craft', recipe: 'pack.harvestCrate' }));
  await expect.poll(() => game(page, (g) => g.state().player.pack), { timeout: 30_000 }).toBeGreaterThan(0);
  const bed = [cart.x - Math.sin(cart.heading) * 2.6, cart.z - Math.cos(cart.heading) * 2.6, cart.heading];
  await page.evaluate(([x, z, f]) => (window as any).__game.teleport(x, z, f), bed);
  await expect.poll(() => game(page, (g) => g.life().focus?.action), { timeout: 30_000 }).toBe('load');
  await page.evaluate(() => (window as any).__game.pressLife('interact'));
  await expect.poll(() => game(page, (g) => g.life().vehicles[0].cargo.filter(Boolean).length), { timeout: 30_000 }).toBe(1);
  await expect.poll(() => game(page, (g) => g.state().player.pack)).toBe(0);
  await expect.poll(() => game(page, (g) => g.life().focus?.action), { timeout: 30_000 }).toBe('unload');

  // F: the crate is on your back at once (not a round trip later), and stays there, frame after
  // frame, while the server's answers arrive.
  const packs = await page.evaluate(async () => {
    const g = (window as any).__game;
    g.pressLife('interact');
    const seen: number[] = [];
    for (let i = 0; i < 70; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      seen.push(g.state().player.pack);
    }
    return seen;
  });
  expect(packs[1], 'on your back the next frame').toBeGreaterThan(0);
  expect(packs.filter((p) => p === 0), `never back in the cart: ${packs.join(',')}`).toEqual([]);
  await expect.poll(() => game(page, (g) => g.life().vehicles[0].cargo.filter(Boolean).length), { timeout: 30_000 }).toBe(0);

  // Put it back in, then get in at the driver's side: you're in the seat at once, and the cart, drawn
  // under you, stays where it stands rather than sinking into the ground and rising again.
  await page.evaluate(() => (window as any).__game.pressLife('interact'));
  await expect.poll(() => game(page, (g) => g.state().player.pack), { timeout: 30_000 }).toBe(0);
  const side = [cart.x + Math.cos(cart.heading) * 1.9 + Math.sin(cart.heading) * 0.9, cart.z - Math.sin(cart.heading) * 1.9 + Math.cos(cart.heading) * 0.9, cart.heading];
  await page.evaluate(([x, z, f]) => (window as any).__game.teleport(x, z, f), side);
  await expect.poll(() => game(page, (g) => g.life().focus?.action), { timeout: 30_000 }).toBe('board');
  const resting = (await game(page, (g) => g.drawnVehicles()[0])) as { y: number };
  const ride = await page.evaluate(async () => {
    const g = (window as any).__game;
    g.pressLife('interact');
    const ys: number[] = [];
    const modes: string[] = [];
    for (let i = 0; i < 70; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      ys.push(g.drawnVehicles()[0].y);
      modes.push(g.state().player.mode);
    }
    return { ys, modes };
  });
  expect(ride.modes[1], 'in the seat the next frame').toBe('ride');
  expect(ride.modes.filter((m) => m !== 'ride')).toEqual([]);
  const worst = Math.max(...ride.ys.map((y) => Math.abs(y - resting.y)));
  expect(worst, `the cart drawn ${worst.toFixed(2)} m off where it stood`).toBeLessThan(0.08);
});

test("another player's name shows near you, fades past 30 m and is gone by 45 m", async ({ browser }) => {
  const { a, b, nameA } = await pair(browser);
  const ann = () => seen(b, nameA);
  /** Ann goes to (x, z), and Bea waits until she sees her there. */
  const annTo = async (x: number, z: number) => {
    await a.bringToFront();
    await a.evaluate(([x, z]) => (window as any).__game.teleport(x, z), [x, z]);
    await b.bringToFront();
    await expect.poll(async () => {
      const p = await ann();
      return p ? Math.hypot(p.x - x, p.z - z) : Infinity;
    }, { timeout: 30_000 }).toBeLessThan(2);
    // A few frames drawn there.
    await b.waitForTimeout(300);
    return (await ann())!;
  };
  const bea = await game(b, (g) => g.state().player.pos);

  // Beside Bea: her name is whole.
  let p = await annTo(bea.x + 3, bea.z + 3);
  expect(p.away).toBeLessThan(30);
  expect(p.plate).toBe(1);
  // 33 m in front of her (a little more from her camera, behind her): fading.
  p = await annTo(bea.x, bea.z + 33);
  expect(p.away).toBeGreaterThan(30);
  expect(p.away).toBeLessThan(45);
  expect(p.plate).toBeGreaterThan(0);
  expect(p.plate).toBeLessThan(1);
  // Up at Hearthside Rise, 150 m off: no name floating over the trees.
  p = await annTo(142, -200);
  expect(p.away).toBeGreaterThan(45);
  expect(p.plate).toBe(0);
  // And back: whole again.
  p = await annTo(bea.x + 3, bea.z + 3);
  expect(p.plate).toBe(1);
});

test("everyone in a channel sees the same time of day, the server's, whatever their islands' clocks say", async ({ browser }) => {
  const { a, b } = await pair(browser);
  const sky = JSON.parse(readFileSync('shared/zones/emberholm.json', 'utf8')).sky;
  /** The hour of the day by the server's clock: it runs on this computer, so Date.now() is its clock. */
  const world = (ms: number) => {
    const days = ms / 1000 / sky.dayLengthSeconds + sky.startHour / 24;
    return (days - Math.floor(days)) * 24;
  };
  /** Hours between two times of day, either way round midnight. */
  const apart = (x: number, y: number) => {
    const d = Math.abs(x - y) % 24;
    return Math.min(d, 24 - d);
  };
  /** The hour a page's sky shows, the hour its clock on the HUD says, and when that was. */
  const reading = (page: Page) =>
    page.evaluate(() => {
      const [hh, mm] = document.querySelector('#hud-clock span')!.textContent!.match(/(\d\d):(\d\d)/)!.slice(1).map(Number);
      return { sky: (window as any).__game.dayHour() as number, hud: hh + mm / 60, at: Date.now() };
    });

  // Bea skips ahead a third of a day on her island, so her island's clock and Ann's are 8 hours apart.
  await b.bringToFront();
  const before = await game(b, (g) => g.life().clock);
  await game(b, (g) => g.lifeCommand({ t: 'warp', seconds: 600 }));
  await expect.poll(() => game(b, (g) => g.life().clock), { timeout: 30_000 }).toBeGreaterThan(before + 590);

  // Yet both skies, and both clocks on the HUD, show the server's hour.
  for (const page of [a, b]) {
    await page.bringToFront();
    await page.waitForTimeout(300);
    const r = await reading(page);
    expect(apart(r.sky, world(r.at)), 'the sky').toBeLessThan(0.01);
    expect(apart(r.hud, r.sky), 'the clock on the HUD').toBeLessThan(2 / 60);
  }
  // And it runs on smoothly: two seconds later, two seconds' worth of the day later.
  const first = await reading(b);
  await b.waitForTimeout(2000);
  const then = await reading(b);
  const passed = ((then.at - first.at) / 1000 / sky.dayLengthSeconds) * 24;
  expect(Math.abs(apart(then.sky, first.sky) - passed)).toBeLessThan(0.003);
});

test('the developer panel is up to the server', async ({ page }) => {
  await page.goto(`/?as=${fresh('dev')}&bugs=0`);
  await waitOnline(page);
  // The development server (DEV_LOGIN=1) offers it; Railway's production server doesn't.
  expect(await game(page, (g) => g.online().dev)).toBe(true);
});
