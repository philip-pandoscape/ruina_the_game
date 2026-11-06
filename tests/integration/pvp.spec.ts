import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { serverBuilt, TestServer } from '../support/testServer';

// Two real players on the Rust server, each in their own browser window. The tests start their own
// server (2000 bots) on a separate port.

const server = new TestServer(7792, ['--bots', '2000']);
const SERVER = server.url;
const SHOTS = 'screenshots';

test.skip(!serverBuilt, 'build the server first: cargo build --release');
test.beforeAll(async () => server.start());
test.afterAll(() => server.stop());

// Every window a test opens is closed afterwards, so players from one test never linger into the next.
const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of openContexts.splice(0)) await c.close();
});

async function joinAs(browser: Browser, team: number, extra = ''): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  openContexts.push(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`/?server=${encodeURIComponent(SERVER)}&team=${team}${extra}`);
  await page.waitForFunction(() => window.__game?.net()?.joined === true, null, { timeout: 10_000 });
  return { page, errors };
}

const net = (page: Page) => page.evaluate(() => window.__game.net());
const script = (page: Page, segments: Array<[number, Record<string, unknown>]>) => page.evaluate((s) => window.__game.scriptInput(s), segments);
const scriptDone = (page: Page) => page.waitForFunction(() => window.__game.net().scriptLeft === 0);

test('two players: blue attacks red, the server lands the hits, both screens agree', { tag: '@gpu' }, async ({ browser }) => {
  const blue = await joinAs(browser, 0);
  const red = await joinAs(browser, 1);
  await blue.page.waitForFunction(() => window.__game.net().remotes.length > 0);
  await red.page.waitForFunction(() => window.__game.net().remotes.length > 0);
  // Point each camera at the other player.
  await blue.page.evaluate(() => window.__game.setCamera({ yaw: Math.PI / 2 - 0.6, distance: 6.5 }));
  await red.page.evaluate(() => window.__game.setCamera({ yaw: -Math.PI / 2 + 0.6, distance: 6.5 }));
  const start = { blue: await net(blue.page), red: await net(red.page) };

  // Blue runs at red and throws the three-hit combo.
  await script(blue.page, [
    [24, { moveX: 1 }],
    [1, { attackPressed: true }],
    [7, {}],
    [1, { attackPressed: true }],
    [10, {}],
    [1, { attackPressed: true }],
    [9, {}],
  ]);
  await scriptDone(blue.page);
  await blue.page.screenshot({ path: `${SHOTS}/30-pvp-blue-view.png` });
  await red.page.screenshot({ path: `${SHOTS}/31-pvp-red-view.png` });
  await blue.page.waitForTimeout(700);

  const blueNow = await net(blue.page);
  const redNow = await net(red.page);
  console.log(
    'pvp',
    JSON.stringify({
      start: { blue: [start.blue.x, start.blue.z], red: [start.red.x, start.red.z] },
      redHp: redNow.hp,
      redOnOwnScreen: [redNow.x, redNow.z],
      redAsSeenByBlue: blueNow.remotes[0],
      blue: { corrections: blueNow.corrections, maxCorrection: blueNow.maxCorrection },
      red: { corrections: redNow.corrections, maxCorrection: redNow.maxCorrection },
    }),
  );

  expect(redNow.hp).toBeLessThan(100); // the server landed blue's hits on red
  expect(blueNow.remotes[0].hp).toBe(redNow.hp); // and blue's screen shows the same health
  expect(blueNow.maxCorrection).toBeLessThan(0.01); // blue's own prediction matched the server
  // Red's own screen and blue's screen agree on where the knockback left red.
  expect(Math.hypot(redNow.x - blueNow.remotes[0].x, redNow.z - blueNow.remotes[0].z)).toBeLessThan(0.3);
  expect([...blue.errors, ...red.errors]).toEqual([]);
});

test('at 300 ms ping your own moves still respond instantly and agree with the server', async ({ browser }) => {
  const blue = await joinAs(browser, 0, '&lag=150');
  await blue.page.waitForTimeout(800);
  const before = await net(blue.page);

  // One frame of input: you move on your own screen straight away...
  await script(blue.page, [[1, { moveZ: -1 }]]);
  await scriptDone(blue.page);
  const right = await net(blue.page);
  expect(right.z).toBeLessThan(before.z);
  // ...while the server is still about 300 ms (around 18 inputs) behind.
  expect(right.pending).toBeGreaterThan(8);

  // A busier sequence: run, jump, double jump turning mid-air, slide, combo.
  await script(blue.page, [
    [30, { moveZ: -1 }],
    [1, { moveZ: -1, jumpPressed: true, jumpHeld: true }],
    [15, { moveZ: -1, jumpHeld: true }],
    [1, { moveX: 1, jumpPressed: true, jumpHeld: true }],
    [40, { moveX: 1, jumpHeld: true }],
    [1, { moveX: 1, slidePressed: true }],
    [30, { moveX: -1 }],
    [1, { attackPressed: true }],
    [7, {}],
    [1, { attackPressed: true }],
    [40, {}],
  ]);
  await scriptDone(blue.page);
  await blue.page.waitForTimeout(1000); // let the server catch up
  const after = await net(blue.page);
  console.log(
    'lag',
    JSON.stringify({ pendingRightAway: right.pending, corrections: after.corrections, maxCorrection: after.maxCorrection, pendingAfter: after.pending }),
  );
  expect(after.maxCorrection).toBeLessThan(0.05);
  expect(blue.errors).toEqual([]);
});

test('lag compensation: at 300 ms ping, hits on your screen count on the server', { tag: '@gpu' }, async ({ browser }) => {
  const blue = await joinAs(browser, 0, '&lag=150');
  const red = await joinAs(browser, 1);
  await blue.page.waitForFunction(() => window.__game.net().remotes.length > 0);
  await blue.page.waitForFunction(() => window.__game.net().server !== null, null, { timeout: 5000 });
  const before = (await net(blue.page)).server;

  // Red steps in close, then strafes left and right at full speed in front of blue.
  const strafe: Array<[number, Record<string, unknown>]> = [
    [30, { moveX: -1 }],
    [10, {}],
  ];
  for (let i = 0; i < 4; i++) strafe.push([40, { moveZ: 1 }], [40, { moveZ: -1 }]);
  await script(red.page, strafe);
  // Blue swings whenever red is within reach on blue's (300 ms delayed) screen.
  await blue.page.evaluate(() => window.__game.autoAttack(true));
  await scriptDone(red.page);
  await blue.page.evaluate(() => window.__game.autoAttack(false));
  await blue.page.waitForTimeout(1600); // let the once-a-second server stats arrive
  const after = (await net(blue.page)).server;
  const result = {
    hits: after.pvpHits - before.pvpHits,
    savedByRewind: after.savedByRewind - before.savedByRewind,
    rewindMs: Math.round(after.rewindMs),
    redHp: (await net(red.page)).hp,
  };
  console.log('rewind', JSON.stringify(result));
  expect(result.hits).toBeGreaterThan(0);
  expect(result.savedByRewind).toBeGreaterThan(0); // these would have missed without rewinding
  expect(result.rewindMs).toBeGreaterThan(200); // about 150 ms lag + 100 ms drawing delay + input delay
  expect(result.rewindMs).toBeLessThan(600);
  expect([...blue.errors, ...red.errors]).toEqual([]);
});

test('bots fight real players: run into the enemy army and they turn on you', { tag: '@gpu' }, async ({ browser }) => {
  const red = await joinAs(browser, 1);
  await red.page.waitForFunction(() => window.__game.net().server !== null, null, { timeout: 5000 });
  const before = (await net(red.page)).server;
  await red.page.evaluate(() => {
    const g = window.__game;
    g.setCamera({ yaw: 0, distance: 9, pitch: 0.45 });
    g.autoAttack(true);
  });
  // Run north into the blue army's rear, then stand and fight.
  await script(red.page, [[420, { moveZ: 1 }]]);
  await scriptDone(red.page);
  await red.page.waitForTimeout(4000);
  await red.page.screenshot({ path: `${SHOTS}/32-bots-vs-player.png` });
  await red.page.waitForTimeout(1200);
  const now = await net(red.page);
  const result = {
    botHitsOnPlayer: now.server.botHitsOnPlayers - before.botHitsOnPlayers,
    playerHitsOnBots: now.server.hitsOnBots - before.hitsOnBots,
    hp: now.hp,
    z: Math.round(now.z),
  };
  console.log('bots', JSON.stringify(result));
  expect(result.botHitsOnPlayer).toBeGreaterThan(0);
  expect(result.playerHitsOnBots).toBeGreaterThan(0);
  expect(red.errors).toEqual([]);
});
