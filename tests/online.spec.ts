import { expect, test, type Browser, type Page } from '@playwright/test';

// Emberholm on the game server: signing in, the server playing your island and keeping it in
// Postgres between visits, starting over, one window per character, and sharing a channel. These
// play the real game against the real server, so they need it running with developer sign-in:
// `npm run up` (Docker). Without it they're skipped.

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
    return (window as any).__game?.ready === true && o?.status === 'online' && o.ticks > 3;
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
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Password (8 or more characters)').fill(PASSWORD);
  await page.getByLabel('Password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await waitOnline(page);
  expect(await game(page, (g) => g.online().account)).toBe(name);
  await expect(page.locator('#ruina-badge')).toContainText(name);

  // Earn something and go somewhere (both decided by the server), then come back later.
  const start = await game(page, (g) => g.life().coins);
  await game(page, (g) => g.lifeCommand({ t: 'grant', coins: 4321 }));
  await expect.poll(() => game(page, (g) => g.life().coins)).toBe(start + 4321);
  await game(page, (g) => g.teleport(142, -200));
  await expect.poll(async () => {
    const p = await game(page, (g) => g.state().player.pos);
    return Math.hypot(p.x - 142, p.z + 200);
  }).toBeLessThan(2);
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
    }, { timeout: 10_000 })
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
  await expect.poll(() => game(page, (g) => g.net().scriptLeft), { timeout: 30_000 }).toBe(0);
  // Every input answered, and the answers matched the prediction.
  await expect.poll(() => game(page, (g) => g.online().seq - g.online().ack), { timeout: 10_000 }).toBeLessThan(12);
  const o = await game(page, (g) => g.online());
  expect(o.maxCorrection, `${o.corrections} corrections`).toBeLessThan(0.05);
});

test('a wrong password is refused, and the right one signs in', async ({ page, request }) => {
  const name = fresh('back');
  expect((await request.post('/api/register', { data: { username: name, password: PASSWORD } })).ok()).toBe(true);

  await page.goto('/?bugs=0');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Wrong name or password.')).toBeVisible();

  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
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
  await expect.poll(() => game(page, (g) => g.life().coins)).toBe(start + 500);
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

  const second = await page.context().newPage();
  await second.goto('/?bugs=0');
  await waitOnline(second);

  await expect(page.getByRole('heading', { name: 'Playing in another window' })).toBeVisible();
  expect(await game(page, (g) => g.online().status)).toBe('kicked');
  // The window that took over saves; the one it replaced can't any more.
  await saveAndWait(second);
});

test('signing out goes back to the sign-in screen, and stays signed out', async ({ page }) => {
  await page.goto(`/?as=${fresh('leave')}&bugs=0`);
  await waitOnline(page);
  await page.locator('#ruina-badge').getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.goto('/?bugs=0');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(await page.evaluate(() => fetch('/api/me').then((r) => r.json()))).toBeNull();
});

test('the open world needs a signed-in player', async ({ page }) => {
  await page.goto('/?yard&bugs=0');
  const outcome = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://${location.host}/ws/world`);
        ws.onmessage = () => resolve('welcomed');
        ws.onclose = () => resolve('refused');
      }),
  );
  expect(outcome).toBe('refused');
});

// ---------- Sharing Emberholm ----------

/** Two new players who share a channel (new names until they do, should one channel fill up). */
async function pair(browser: Browser): Promise<{ a: Page; b: Page; nameA: string; nameB: string }> {
  const a = await (await browser.newContext()).newPage();
  const nameA = fresh('ann');
  await a.goto(`/?as=${nameA}&bugs=0`);
  await waitOnline(a);
  const channel = await game(a, (g) => g.online().channel);
  for (let tries = 0; tries < 3; tries++) {
    const b = await (await browser.newContext()).newPage();
    const nameB = fresh('bea');
    await b.goto(`/?as=${nameB}&bugs=0`);
    await waitOnline(b);
    if ((await game(b, (g) => g.online().channel)) === channel) return { a, b, nameA, nameB };
    await b.context().close();
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
  await expect.poll(() => game(a, (g) => g.life().focus?.action), { timeout: 15_000 }).toBe('claim');
  await a.evaluate(() => (window as any).__game.lifeCommand({ t: 'interact' }));
  await expect.poll(() => game(a, (g) => g.life().houses.length), { timeout: 15_000 }).toBe(1);

  // Bea sees the building site, and the plot is Ann's.
  await b.bringToFront();
  await expect.poll(async () => (await seen(b, nameA))?.houses, { timeout: 30_000 }).toBe(1);
  await expect.poll(() => b.evaluate((id) => (window as any).__game.online().claims[id], plot.id), { timeout: 30_000 }).toBe(nameA);
  await b.evaluate(() => (window as any).__game.lifeCommand({ t: 'grant', item: 'blueprint.cottage', n: 1 }));
  await b.evaluate(([x, z, f]) => (window as any).__game.teleport(x, z, f), site);
  await expect.poll(() => game(b, (g) => g.life().focus?.label), { timeout: 15_000 }).toBe(`${nameA}'s plot`);
});

test('the developer panel is up to the server', async ({ page }) => {
  await page.goto(`/?as=${fresh('dev')}&bugs=0`);
  await waitOnline(page);
  // The development server (DEV_LOGIN=1) offers it; Railway's production server doesn't.
  expect(await game(page, (g) => g.online().dev)).toBe(true);
});
