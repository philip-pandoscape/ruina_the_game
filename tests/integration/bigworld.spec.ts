import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import { openGame } from '../support/game';

// The client in a big world (R10.23): the tests' fixture world played offline in the page
// (tests/fixtures/world/world.json: Emberholm; Saltmere across a chunk of open sea to its west, from
// x = 1024 m; Thornmarch beside Saltmere across a land border at x = 2048 m). Crossed on foot,
// swimming, by cart and by glider, in real time with every frame timed: the region you cross into was
// grown in the page's worker and adopted before you got there (src/app/regions.ts), so nothing loads at
// the crossing: no region arrives then, the rules grow none on the page's thread, and no frame is long.
// What you leave behind is let go. And Farholt, 102 km out (far.json), is drawn from the scene's
// moving origin as precisely as anywhere: the same drawn from any origin near it, and not as it is with
// the origin left at the world's (src/render/origin.ts). The crossing with a friend riding along is
// the engine's (crates/engine/src/open/fixture.rs): offline there's nobody to ride with.

const SEA_BORDER = 1024;
const LAND_BORDER = 2048;
/** No frame at a crossing may take this long: a region grown on the page's own thread takes 150 ms and more. */
const LONG_FRAME_MS = 50;

type Act = Partial<{ moveX: number; moveZ: number; stickX: number; stickY: number; sprintHeld: boolean; jumpPressed: boolean; jumpHeld: boolean }>;

async function open(page: Page, fixture = 'world'): Promise<string[]> {
  const errors = await openGame(page, `/?test&fixture=${fixture}`);
  await page.evaluate(() => window.__game.reset());
  return errors;
}

/** Puts you at (x, z) as if you'd come from afar: what's near grown in the worker first, and everything drawn. */
async function arrive(page: Page, x: number, z: number, facing: number): Promise<void> {
  await page.evaluate(([a, b]) => window.__game.regionsReady(a, b), [x, z] as const);
  await page.evaluate(([a, b, f]) => window.__game.teleport(a, b, f), [x, z, facing] as const);
  await page.evaluate(() => window.__game.setCamera({ yaw: Math.PI / 2, pitch: 0.25, distance: 10 }));
  // Built a little each frame: drawn whole before you set off.
  await page.waitForFunction(() => window.__game.regionsNow().building.length === 0, null, { timeout: 60_000, polling: 100 });
  await page.waitForFunction(() => window.__game.assetsReady === true, null, { timeout: 60_000 });
  await page.evaluate(() => window.__game.advance(2));
}

interface Crossing {
  /** Each frame drawn: how long it took, and where you were then (x) and what you were doing. */
  frames: Array<[number, number, string]>;
  /** What happened to the regions while you went (anything grown, adopted or let go). */
  happened: number;
  /** Regions the rules grew on the page's own thread meanwhile. */
  grownHere: number;
}

/** Plays in real time with `script` pressed, timing every frame, until you're past `x`. */
async function crossTo(page: Page, x: number, script: Array<[number, Act]>, timeout = 30_000): Promise<Crossing> {
  const before = await page.evaluate(() => window.__game.regionsNow());
  await page.evaluate((segments) => {
    const w = window as unknown as { __frames: Array<[number, number, string]>; __timing: boolean };
    const g = window.__game;
    w.__frames = [];
    w.__timing = true;
    let last = performance.now();
    const tick = (now: number) => {
      if (!w.__timing) return;
      const p = g.where();
      w.__frames.push([now - last, p.x, p.mode]);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    g.scriptInput(segments);
    g.setPaused(false);
  }, script);
  await page.waitForFunction((past) => window.__game.where().x > past, x, { timeout, polling: 'raf' });
  const frames = await page.evaluate(() => {
    const w = window as unknown as { __frames: Array<[number, number, string]>; __timing: boolean };
    w.__timing = false;
    window.__game.setPaused(true);
    return w.__frames;
  });
  const after = await page.evaluate(() => window.__game.regionsNow());
  return { frames, happened: after.log.length - before.log.length, grownHere: after.unheld - before.unheld };
}

/** The longest frame within `m` metres of a border, and the longest of all (the first, as play resumes, aside). */
function longest(c: Crossing, border: number, m = 15): { atBorder: number; all: number } {
  const frames = c.frames.slice(1);
  const near = frames.filter(([, x]) => Math.abs(x - border) <= m).map(([ms]) => ms);
  return { atBorder: Math.max(0, ...near), all: Math.max(0, ...frames.map(([ms]) => ms)) };
}

test.describe('crossing the fixture world with nothing loading', () => {
  test('on foot across the land border into Thornmarch @gpu', async ({ page }) => {
    const errors = await open(page);
    await arrive(page, LAND_BORDER - 40, 0, Math.PI / 2);
    expect((await page.evaluate(() => window.__game.regionsNow())).ids).toEqual(expect.arrayContaining(['saltmere', 'thornmarch']));
    const c = await crossTo(page, LAND_BORDER + 20, [[1200, { moveX: 1, sprintHeld: true }]]);
    const t = longest(c, LAND_BORDER);
    console.log('walking across the land border', JSON.stringify({ ...t, frames: c.frames.length }));
    expect(c.frames.some(([, x, mode]) => x > LAND_BORDER && mode !== 'swim')).toBe(true);
    expect(c.happened, 'nothing grown, adopted or let go on the way').toBe(0);
    expect(c.grownHere, 'nothing grown on the page').toBe(0);
    expect(t.atBorder).toBeLessThan(LONG_FRAME_MS);
    expect(errors).toEqual([]);
  });

  test('swimming across the open sea into Saltmere @gpu', async ({ page }) => {
    const errors = await open(page);
    await arrive(page, SEA_BORDER - 40, 0, Math.PI / 2);
    await page.evaluate(() => window.__game.advance(30));
    expect((await page.evaluate(() => window.__game.where())).mode).toBe('swim');
    const c = await crossTo(page, SEA_BORDER + 20, [[1800, { moveX: 1, sprintHeld: true }]]);
    const t = longest(c, SEA_BORDER);
    console.log('swimming into Saltmere', JSON.stringify({ ...t, frames: c.frames.length }));
    expect(c.frames.filter(([, x]) => x > SEA_BORDER).every(([, , mode]) => mode === 'swim')).toBe(true);
    expect(c.happened).toBe(0);
    expect(c.grownHere).toBe(0);
    expect(t.atBorder).toBeLessThan(LONG_FRAME_MS);
    expect(errors).toEqual([]);
  });

  test('by cart across the land border @gpu', async ({ page }) => {
    const errors = await open(page);
    await arrive(page, LAND_BORDER - 60, 0, Math.PI / 2);
    await page.evaluate(() => window.__game.lifeCommand({ t: 'grant', item: 'deed.farmCart', n: 1 }));
    await page.evaluate(() => window.__game.advance(1));
    await page.evaluate(() => window.__game.lifeCommand({ t: 'summon', item: 'deed.farmCart' }));
    await page.evaluate(() => window.__game.advance(2));
    const cart = (await page.evaluate(() => window.__game.life())).vehicles[0];
    expect(cart?.def).toBe('farmCart');
    // Summoned facing the way you face (west); got into from its side, level with the seat.
    expect(Math.abs(cart.heading - Math.PI / 2)).toBeLessThan(0.3);
    const h = cart.heading;
    await page.evaluate(([x, z, f]) => window.__game.teleport(x, z, f), [
      cart.x + Math.cos(h) * 1.9 + Math.sin(h) * 0.9,
      cart.z - Math.sin(h) * 1.9 + Math.cos(h) * 0.9,
      h,
    ] as const);
    await page.evaluate(() => window.__game.advance(2));
    expect((await page.evaluate(() => window.__game.life())).focus?.action).toBe('board');
    await page.evaluate(() => window.__game.lifeCommand({ t: 'interact' }));
    await page.evaluate(() => window.__game.advance(2));
    expect((await page.evaluate(() => window.__game.where())).mode).toBe('ride');
    const c = await crossTo(page, LAND_BORDER + 20, [[1800, { stickY: 1 }]]);
    const t = longest(c, LAND_BORDER);
    console.log('driving across the land border', JSON.stringify({ ...t, frames: c.frames.length }));
    expect(c.frames.filter(([, x]) => x > LAND_BORDER).every(([, , mode]) => mode === 'ride')).toBe(true);
    expect(c.happened).toBe(0);
    expect(c.grownHere).toBe(0);
    expect(t.atBorder).toBeLessThan(LONG_FRAME_MS);
    expect(errors).toEqual([]);
  });

  test('by glider across the land border @gpu', async ({ page }) => {
    const errors = await open(page);
    await page.evaluate(() => window.__game.lifeCommand({ t: 'grant', item: 'glider.wayfarer', n: 1 }));
    await page.evaluate(() => window.__game.advance(1));
    await page.evaluate(() => window.__game.lifeCommand({ t: 'use', item: 'glider.wayfarer' }));
    // Jump, double jump and open the wing; then on west.
    const glide: Array<[number, Act]> = [
      [1, { jumpPressed: true, jumpHeld: true }],
      [12, { jumpHeld: true }],
      [1, { jumpPressed: true, jumpHeld: true }],
      [16, { jumpHeld: true }],
      [1, { jumpPressed: true, jumpHeld: true }],
      [600, { moveX: 1 }],
    ];
    // Once well short of the border first, so the wing and the dust of landing have been drawn before
    // (their first drawing is no region's).
    await arrive(page, LAND_BORDER - 200, 0, Math.PI / 2);
    for (const [n, a] of glide.slice(0, -1)) await page.evaluate(([k, x]) => window.__game.advance(k, x), [n, a] as const);
    await page.evaluate(() => window.__game.advance(240, { moveX: 1 }));
    await arrive(page, LAND_BORDER - 22, 0, Math.PI / 2);
    const c = await crossTo(page, LAND_BORDER + 10, glide);
    const t = longest(c, LAND_BORDER);
    const modes = c.frames.filter((f, i) => i === 0 || f[2] !== c.frames[i - 1][2]).map(([, x, m]) => `${m}@${x.toFixed(1)}`);
    console.log('gliding across the land border', JSON.stringify({ ...t, frames: c.frames.length, modes }));
    expect(
      c.frames.some(([, x, mode]) => x > LAND_BORDER && mode === 'glide'),
      'over the border on the wing',
    ).toBe(true);
    expect(c.happened).toBe(0);
    expect(c.grownHere).toBe(0);
    expect(t.atBorder).toBeLessThan(LONG_FRAME_MS);
    expect(errors).toEqual([]);
  });
});

test('what you leave behind is let go, and grown again as you come back', async ({ page }) => {
  const errors = await open(page);
  await arrive(page, 1700, 0, Math.PI / 2);
  let r = await page.evaluate(() => window.__game.regionsNow());
  expect(r.ids).toEqual(expect.arrayContaining(['emberholm', 'saltmere', 'thornmarch']));
  const ground = await page.evaluate(() => window.__game.ground(1700, 0));
  // Far into Thornmarch: Saltmere is more than 900 m behind you.
  await arrive(page, 3000, 0, Math.PI / 2);
  await page.evaluate(() => window.__game.advance(2));
  r = await page.evaluate(() => window.__game.regionsNow());
  const saltmere = 1;
  expect(r.log.some((e) => e.t === 'dropped' && e.id === 'saltmere')).toBe(true);
  expect(r.held).not.toContain(saltmere);
  expect(r.drawn, 'no longer drawn').not.toContain(saltmere);
  expect(r.rules, 'no longer held by the rules').not.toContain(saltmere);
  // Back: grown again, the same ground under you as before.
  await arrive(page, 1700, 0, Math.PI / 2);
  r = await page.evaluate(() => window.__game.regionsNow());
  expect(r.held).toContain(saltmere);
  expect(r.log.filter((e) => e.t === 'arrived' && e.id === 'saltmere').length).toBe(2);
  expect(await page.evaluate(() => window.__game.ground(1700, 0))).toBe(ground);
  expect(r.unheld).toBe(0);
  // How long each took: grown in the worker, all of it there (its sea's depths and map too), and taken in by the page.
  for (const e of r.log.filter((x) => x.t === 'arrived'))
    console.log(`${e.id}: grown in ${e.growMs?.toFixed(0)} ms, ${e.allMs?.toFixed(0)} ms in the worker, taken in by the page in ${e.takeMs?.toFixed(1)} ms`);
  expect(errors).toEqual([]);
});

test('the world map shows every region of the world, where it stands', async ({ page }) => {
  const errors = await open(page);
  await arrive(page, 1700, 0, Math.PI / 2);
  await page.evaluate(() => window.__game.pressLife('map'));
  await page.evaluate(() => window.__game.advance(2));
  const scope = page.locator('.map-scope');
  await expect(scope).toHaveText('World Map');
  // The region you're in: Saltmere.
  await expect(page.locator('.mw-bar').first()).toContainText('Saltmere');
  await scope.click();
  await page.evaluate(() => window.__game.advance(2));
  await expect(page.locator('.mw-bar').first()).toContainText('World Map');
  await expect(page.locator('.map-scope')).toHaveText('Region Map');
  await page.screenshot({ path: 'screenshots/bigworld-world-map.png' });
  expect(errors).toEqual([]);
});

/** A screenshot without the HUD, as pixels. */
async function pixels(page: Page): Promise<{ data: Buffer; width: number; height: number }> {
  const png = await page.screenshot();
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** The share of pixels that differ by more than a little between two pictures. */
function differ(a: { data: Buffer }, b: { data: Buffer }): number {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 3) {
    const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (d > 24) n++;
  }
  return n / (a.data.length / 3);
}

test('drawn precisely far from the origin: Farholt, 102 km out @gpu', async ({ page }) => {
  const errors = await open(page, 'far');
  await arrive(page, 102_656 + 40, 10, Math.PI * 0.75);
  await page.addStyleTag({ content: 'body > *:not(#game) { visibility: hidden !important; }' });
  await page.evaluate(() => window.__game.setCamera({ yaw: Math.PI * 0.75, pitch: 0.3, distance: 9 }));
  await page.evaluate(() => window.__game.advance(2));
  // What the graphics card is handed is near the scene's origin, the camera and the sun's shadows too.
  const span = await page.evaluate(() => window.__game.sceneSpan());
  console.log('far out', JSON.stringify(span));
  expect(span.origin[0]).toBeGreaterThan(100_000);
  expect(span.camera).toBeLessThan(4000);
  expect(span.shadow).toBeLessThan(4000);
  const moving = await pixels(page);
  await page.screenshot({ path: 'screenshots/bigworld-far-origin-moving.png' });
  // From another origin near it: the same picture.
  await page.evaluate(() => window.__game.pinOrigin([102_400 + 2048, 2048]));
  const another = await pixels(page);
  // With the origin left at the world's: 32-bit floats a few millimetres apart out here.
  await page.evaluate(() => window.__game.pinOrigin([0, 0]));
  const fixed = await pixels(page);
  await page.screenshot({ path: 'screenshots/bigworld-far-origin-fixed.png' });
  await page.evaluate(() => window.__game.pinOrigin(null));
  const same = differ(moving, another);
  const broken = differ(moving, fixed);
  console.log('pixels that differ', JSON.stringify({ fromAnotherOrigin: same, fromTheWorldsOrigin: broken }));
  expect(same).toBeLessThan(0.01);
  expect(broken).toBeGreaterThan(same * 5);
  expect(errors).toEqual([]);
});
