import { expect, test, type Page } from '@playwright/test';

// Emberholm on the game server: signing in, your island kept in Postgres between visits, starting
// over, and one window per character. These play the real game against the real server, so they
// need it running with developer sign-in: `npm run up` (Docker). Without it they're skipped.

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

/** Waits until the island has loaded and the server connection is up. */
async function waitOnline(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__game?.ready === true && (window as any).__game.online()?.status === 'online', null, { timeout: 60_000 });
}

/** Saves now and waits for the server to confirm it. */
async function saveAndWait(page: Page): Promise<void> {
  const before = await game(page, (g) => g.online().lastSaved);
  await game(page, (g) => g.saveNow());
  await expect.poll(() => game(page, (g) => g.online().lastSaved), { timeout: 10_000 }).toBeGreaterThan(before);
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

  // Earn something and walk somewhere, then come back later.
  const start = await game(page, (g) => g.life().coins);
  await game(page, (g) => g.lifeCommand({ t: 'grant', coins: 4321 }));
  await expect.poll(() => game(page, (g) => g.life().coins)).toBe(start + 4321);
  await game(page, (g) => g.teleport(142, -200));
  await saveAndWait(page);

  await page.reload();
  await waitOnline(page);
  expect(await game(page, (g) => g.life().coins)).toBe(start + 4321);
  const p = await game(page, (g) => g.state().player.pos);
  expect(Math.hypot(p.x - 142, p.z + 200)).toBeLessThan(2);
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
