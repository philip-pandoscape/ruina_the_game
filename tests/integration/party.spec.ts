import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Parties and dungeons on the game server (server/src/parties.rs, server/src/spaces.rs): two players
// form a party by name, see each other in the party frame, and go through Goblin's Dread's portal
// into one copy of it; someone on their own gets a copy of their own; leaving, you're back outside
// its door, and the copy is still there when you come back. These play the real game against the
// real server, so they need it running with developer sign-in (`npm run up`, or RUINA_SERVER for a
// server of your own). Without it they're skipped.

const SERVER = process.env.RUINA_SERVER ?? 'http://localhost:7777';
const ZONE = JSON.parse(readFileSync('shared/zones/emberholm.json', 'utf8'));
const DOOR = ZONE.dungeons.find((d: { id: string }) => d.id === 'goblinsDread');
const DUNGEON = JSON.parse(readFileSync('shared/dungeons/goblinsDread.json', 'utf8'));

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

const opened: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of opened.splice(0)) await c.close().catch(() => {});
});

const fresh = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(0, 20);
const game = <T>(page: Page, fn: (g: any) => T) => page.evaluate(`(${fn.toString()})(window.__game)`) as Promise<T>;

async function waitOnline(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const o = (window as any).__game?.online?.();
    return (window as any).__game?.ready === true && o?.status === 'online' && o.ticks > 3 && o.lifeLoaded;
  }, null, { timeout: 60_000 });
}

/** A new player, signed in and playing. */
async function player(browser: Browser, prefix: string): Promise<{ page: Page; name: string }> {
  const context = await browser.newContext();
  opened.push(context);
  const page = await context.newPage();
  const name = fresh(prefix);
  await page.goto(`/?as=${name}&bugs=0`);
  await waitOnline(page);
  return { page, name };
}

/** Stands someone outside Goblin's Dread's portal, on the ledge behind the falls. */
async function toThePortal(page: Page): Promise<void> {
  await page.bringToFront();
  await page.evaluate(([x, z, f]) => (window as any).__game.teleport(x, z, f), [DOOR.outside.x, DOOR.outside.z, DOOR.outside.facing]);
  await expect.poll(async () => {
    const p = await game(page, (g) => g.state().player.pos);
    return Math.hypot(p.x - DOOR.outside.x, p.z - DOOR.outside.z);
  }, { timeout: 20_000 }).toBeLessThan(1);
}

const space = (page: Page) => game(page, (g) => g.space());

/** Ann invites Bea by name, and Bea says yes. */
async function form(a: Page, b: Page, nameB: string): Promise<void> {
  await a.bringToFront();
  expect(await a.evaluate((n) => (window as any).__game.partyInvite(n), nameB.toUpperCase())).toBe(true);
  await b.bringToFront();
  await expect.poll(() => game(b, (g) => g.party()?.windows.invite), { timeout: 20_000 }).toBe(true);
  expect(await game(b, (g) => g.partyAnswer(true))).toBe(true);
  for (const p of [a, b]) await expect.poll(() => game(p, (g) => g.party()?.party?.members.length ?? 0), { timeout: 20_000 }).toBe(2);
}

test('two players form a party by name and see each other in the party frame', async ({ browser }) => {
  const { page: a, name: nameA } = await player(browser, 'ann');
  const { page: b, name: nameB } = await player(browser, 'bea');
  await form(a, b, nameB);
  const pa = await game(a, (g) => g.party());
  expect(pa.party.members.map((m: { name: string }) => m.name)).toEqual([nameA, nameB]);
  expect(pa.party.leader).toBe(pa.party.members[0].id);
  expect(pa.windows.frame).toBe(true);
  expect(pa.frameRows.join(' ')).toContain(nameB);
  // Bea leaves: a party of one is no party.
  await b.bringToFront();
  await b.evaluate(() => (window as any).__game.partyLeave());
  for (const p of [a, b]) await expect.poll(() => game(p, (g) => g.party()?.party ?? null), { timeout: 20_000 }).toBe(null);
});

test("a party goes through Goblin's Dread's portal into one copy, and someone on their own into theirs", async ({ browser }) => {
  test.setTimeout(240_000);
  const { page: a } = await player(browser, 'ann');
  const { page: b, name: nameB } = await player(browser, 'bea');
  await form(a, b, nameB);
  // Too far from the portal: the server says no, and Ann stays put.
  await a.bringToFront();
  expect((await space(a)).kind).toBe('channel');
  await a.evaluate(() => (window as any).__game.throughPortal(true));
  await a.waitForTimeout(1500);
  expect((await space(a)).kind).toBe('channel');
  for (const p of [a, b]) {
    await toThePortal(p);
    await p.evaluate(() => (window as any).__game.throughPortal(true));
    await expect.poll(() => space(p), { timeout: 30_000 }).toMatchObject({ kind: 'dungeon', dungeon: 'goblinsDread' });
  }
  const copyA = (await space(a)).copy;
  expect((await space(b)).copy).toBe(copyA);
  // Inside, high above the sea, on the dungeon's floor where it's entered.
  const pos = await game(a, (g) => g.state().player.pos);
  expect(Math.hypot(pos.x - (DUNGEON.origin.x + DUNGEON.arrive.x), pos.z - (DUNGEON.origin.z + DUNGEON.arrive.z))).toBeLessThan(2);
  expect(Math.abs(pos.y - DUNGEON.origin.y)).toBeLessThan(1);
  // Each sees the other there, and the party says two are inside.
  await expect.poll(() => game(a, (g) => g.party()?.party?.dungeons[0]?.inside), { timeout: 20_000 }).toBe(2);
  // Cy, on his own, gets a copy of his own.
  const { page: c } = await player(browser, 'cy');
  await toThePortal(c);
  await c.evaluate(() => (window as any).__game.throughPortal(true));
  await expect.poll(() => space(c), { timeout: 30_000 }).toMatchObject({ kind: 'dungeon' });
  expect((await space(c)).copy).not.toBe(copyA);
});

test('leaving through the way out puts you outside the door, and the copy waits for you', async ({ browser }) => {
  test.setTimeout(180_000);
  const { page: a } = await player(browser, 'dee');
  await toThePortal(a);
  await a.evaluate(() => (window as any).__game.throughPortal(true));
  await expect.poll(() => space(a), { timeout: 30_000 }).toMatchObject({ kind: 'dungeon' });
  const copy = (await space(a)).copy;
  // Not at the way out yet: still inside.
  await a.evaluate(() => (window as any).__game.throughPortal(false));
  await a.waitForTimeout(1500);
  expect((await space(a)).kind).toBe('dungeon');
  // To the way out (the developer teleport stands you on the dungeon's floor), and out.
  const ex = { x: DUNGEON.origin.x + DUNGEON.exit.x, z: DUNGEON.origin.z + DUNGEON.exit.z };
  await a.evaluate(([x, z]) => (window as any).__game.teleport(x, z), [ex.x, ex.z]);
  await expect.poll(async () => {
    const p = await game(a, (g) => g.state().player.pos);
    return Math.hypot(p.x - ex.x, p.z - ex.z);
  }, { timeout: 20_000 }).toBeLessThan(1);
  await a.evaluate(() => (window as any).__game.throughPortal(false));
  await expect.poll(() => space(a), { timeout: 30_000 }).toMatchObject({ kind: 'channel' });
  // Outside the door at once, as the server has it.
  const pos = await game(a, (g) => g.state().player.pos);
  expect(Math.hypot(pos.x - DOOR.outside.x, pos.z - DOOR.outside.z)).toBeLessThan(1.5);
  expect(await game(a, (g) => g.dungeon().inside)).toBe(null);
  // Back in: the same copy.
  await toThePortal(a);
  await a.evaluate(() => (window as any).__game.throughPortal(true));
  await expect.poll(() => space(a), { timeout: 30_000 }).toMatchObject({ kind: 'dungeon', copy });
});
