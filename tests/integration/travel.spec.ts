import { expect, test, type Page } from '@playwright/test';
import type { Command } from '../../src/engine/island';
import { EMBERHOLM, SURFACE } from '../../src/engine/zone';
import { isTitleCase } from '../../src/ui/theme/text';
import type { LifePress } from '../../src/ui/life/lifeUI';
import { gameReady, onlineReady } from '../support/game';

// Auto-run and travel by road (src/input/autoWalk.ts, src/engine/world/roads.ts, src/ui/life/travelUI.ts).
// The road network and its routes are checked here in Node; the walking, the map and the readout in
// the open world offline, driven through window.__game a frame at a time like the other specs; and
// one trip on the game server, at the end, when one is running.

const SHOTS = 'screenshots';
const PAVED = new Set<number>([SURFACE.road, SURFACE.plaza]);

// ---------- Walking, in the game ----------

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?test');
  await gameReady(page, 60_000);
  await page.evaluate(() => window.__game.reset());
  return errors;
}

const g = (page: Page) => ({
  advance: (frames: number, a: Record<string, unknown> = {}) => page.evaluate(([n, x]) => window.__game.advance(n, x), [frames, a] as const),
  player: () => page.evaluate(() => window.__game.state().player),
  walk: () => page.evaluate(() => window.__game.walk()),
  life: () => page.evaluate(() => window.__game.life()),
  cmd: (c: Command) => page.evaluate((x) => window.__game.lifeCommand(x), c),
  press: (k: LifePress) => page.evaluate((x) => window.__game.pressLife(x), k),
  camera: (yaw: number) => page.evaluate((y) => window.__game.setCamera({ yaw: y }), yaw),
  teleport: (x: number, z: number, facing = 0) => page.evaluate(([a, b, c]) => window.__game.teleport(a, b, c), [x, z, facing] as const),
  travelTo: (x: number, z: number, label: string) => page.evaluate(([a, b, c]) => window.__game.travelTo(a, b, c), [x, z, label] as const),
  surface: (x: number, z: number) => page.evaluate(([a, b]) => window.__game.surface(a, b), [x, z] as const),
});

const place = (id: string) => EMBERHOLM.places.find((p) => p.id === id)!;

/** Labels under `sel` that aren't in Title Case (design/ui.html), key caps left out. */
async function untitled(page: Page, sel: string): Promise<string[]> {
  const labels = await page.evaluate((s) => {
    return [...document.querySelectorAll<HTMLElement>(s)].map((e) => {
      const c = e.cloneNode(true) as HTMLElement;
      c.querySelectorAll('.key, svg, img').forEach((x) => x.remove());
      return c.textContent!.replace(/\s+/g, ' ').trim();
    });
  }, sel);
  expect(labels.length).toBeGreaterThan(0);
  return labels.filter((l) => !isTitleCase(l));
}

/**
 * Lets the travel run until it stops or `seconds` of game time pass, sampling what is underfoot
 * (or under the hooves or wheels) every half second. It all runs in the page, drawing only at the
 * end: a browser drawing in software (CI's) takes a second or more over every frame it draws.
 */
async function travel(page: Page, seconds: number): Promise<{ seconds: number; paved: number; samples: number }> {
  return page.evaluate(
    ([seconds, paved]) => {
      const g = window.__game;
      let onRoad = 0;
      let samples = 0;
      let frames = 0;
      for (; frames < seconds * 60; frames += 30) {
        g.advance(30, {}, false);
        const p = g.state().player;
        samples++;
        if (paved.includes(g.surface(p.pos.x, p.pos.z))) onRoad++;
        if (g.walk().mode === 'off') break;
      }
      g.render();
      return { seconds: frames / 60, paved: onRoad, samples };
    },
    [seconds, [...PAVED]] as const,
  );
}

test('auto-run: H runs you on where the camera looks, the mouse steering; A and D strafe, W or S take over', async ({ page }) => {
  const errors = await open(page);
  const w = g(page);
  // Up the north road out of Lanternwick, the camera looking north along it.
  await w.teleport(0, -200, 0);
  await w.camera(0);
  await w.press('autorun');
  expect((await w.walk()).mode).toBe('run');
  const a = (await w.player()).pos;
  await w.advance(120);
  const b = (await w.player()).pos;
  expect(b.z - a.z).toBeGreaterThan(12); // two seconds at a run
  expect(Math.abs(b.x - a.x)).toBeLessThan(0.5);
  await expect(page.locator('#lui-walk')).toBeVisible();
  await expect(page.locator('#lui-walk')).toContainText('Auto-Run');
  expect(await untitled(page, '#lui-walk .lbl, #lui-walk .stop')).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/travel-01-auto-run.png` });
  // Turning the camera turns the run: a quarter turn left, toward +x.
  await w.camera(Math.PI / 2);
  await w.advance(60);
  const c = (await w.player()).pos;
  expect(c.x - b.x).toBeGreaterThan(5);
  // D (the camera's right, +z now) strafes as you run, without stopping it.
  await w.advance(60, { stickX: 1, moveZ: 1 });
  const d = (await w.player()).pos;
  expect((await w.walk()).mode).toBe('run');
  expect(d.x - c.x).toBeGreaterThan(2.5);
  expect(d.z - c.z).toBeGreaterThan(2.5);
  // Jumping and sprinting don't stop it either.
  await w.advance(30, { jumpPressed: true, jumpHeld: true, sprintHeld: true });
  expect((await w.walk()).mode).toBe('run');
  // W on the real keyboard: you take over, and the readout goes.
  await page.keyboard.down('KeyW');
  await page.evaluate(() => window.__game.advanceLive(2));
  await page.keyboard.up('KeyW');
  expect((await w.walk()).mode).toBe('off');
  await w.advance(1);
  await expect(page.locator('#lui-walk')).toBeHidden();
  // Num Lock and H, pressed for real while the game runs, both start it; S stops it.
  await page.evaluate(() => window.__game.setPaused(false));
  for (const key of ['NumLock', 'KeyH']) {
    await page.keyboard.press(key);
    await expect.poll(async () => (await w.walk()).mode).toBe('run');
    await page.keyboard.down('KeyS');
    await expect.poll(async () => (await w.walk()).mode).toBe('off');
    await page.keyboard.up('KeyS');
  }
  await page.evaluate(() => window.__game.setPaused(true));
  // The controls hint offers it.
  await expect(page.locator('#hint')).toContainText('Auto-Run');
  expect(errors).toEqual([]);
});

test('travel by road: from the town square to Westwatch, on the roads the whole way', async ({ page }) => {
  const errors = await open(page);
  const w = g(page);
  const ww = place('westwatch');
  expect(await w.travelTo(ww.x, ww.z, ww.name)).toBe(true);
  const start = await w.walk();
  expect(start.mode).toBe('travel');
  // Running is 7.5 m/s: the trip should take little more than its length over that.
  const run = await travel(page, (start.length / 7.5) * 1.2);
  const p = (await w.player()).pos;
  console.log('to Westwatch', { metres: Math.round(start.length), ...run, at: [p.x.toFixed(1), p.z.toFixed(1)] });
  const end = await w.walk();
  expect(end.mode).toBe('off');
  expect(end.marker).toBeNull();
  expect(Math.hypot(p.x - ww.x, p.z - ww.z)).toBeLessThan(3);
  expect(run.paved / run.samples).toBeGreaterThan(0.95);
  await expect(page.locator('#lui-toasts')).toContainText('Arrived at Westwatch Trading Post');
  expect(errors).toEqual([]);
});

test('the map: a click on a place sets off along the roads, the way drawn on the map and the minimap; a second click stops', async ({ page }) => {
  const errors = await open(page);
  const w = g(page);
  await w.teleport(0, -200, 0);
  await w.press('map');
  await w.advance(2);
  const canvas = page.locator('.mw.map canvas');
  await expect(canvas).toBeVisible();
  await expect(page.locator('.mw.map .mw-foot')).toContainText('Click a place to travel there by road');
  const box = (await canvas.boundingBox())!;
  const half = (EMBERHOLM.terrain.cells * EMBERHOLM.terrain.cell) / 2;
  const onMap = (x: number, z: number) => ({ x: box.x + ((half - x) / (2 * half)) * box.width, y: box.y + ((half - z) / (2 * half)) * box.height });
  const hs = place('hearthside');
  const at = onMap(hs.x, hs.z);
  await page.mouse.click(at.x, at.y);
  let s = await w.walk();
  expect(s.mode).toBe('travel');
  expect(s.marker.label).toBe('Hearthside Rise');
  // The map stays open, and you walk on under it.
  const before = (await w.player()).pos;
  await w.advance(240);
  const after = (await w.player()).pos;
  expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(20);
  await expect(page.locator('.mw.map .mw-foot')).toContainText('Hearthside Rise');
  await expect(page.locator('.mw.map .mw-foot [data-act="halt"]')).toHaveText('Stop');
  await expect(page.locator('#lui-walk')).toContainText('Travelling to Hearthside Rise');
  await page.screenshot({ path: `${SHOTS}/travel-02-map-route.png` });
  // Closed, the minimap draws what is left of the way.
  await w.press('map');
  await w.advance(30);
  await page.screenshot({ path: `${SHOTS}/travel-03-minimap-route.png` });
  // A second click on the marker stops and forgets it.
  await w.press('map');
  await w.advance(2);
  await page.mouse.click(at.x, at.y);
  s = await w.walk();
  expect(s.mode).toBe('off');
  expect(s.marker).toBeNull();
  // A right-click offers it all, travelling first.
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await expect(page.locator('.ctx .ctx-h')).toHaveText('Hearthside Rise');
  await expect(page.locator('.ctx .ctx-i').first()).toHaveText('Travel Here');
  await expect(page.locator('.ctx .ctx-i').nth(1)).toHaveText('Mark Here');
  await page.locator('.ctx .ctx-i').nth(1).click();
  s = await w.walk();
  expect(s.mode).toBe('off');
  expect(s.marker.label).toBe('Hearthside Rise');
  // The foot's Travel sets off; its labels are in Title Case.
  await page.locator('.mw.map .mw-foot [data-act="go"]').click();
  expect((await w.walk()).mode).toBe('travel');
  await w.advance(1);
  expect(await untitled(page, '.mw.map .mw-foot .lui-btn, .mw.map .mw-foot > span:first-child')).toEqual([]);
  // On the keyboard (and the D-pad), the arrows pick the next place that way and Enter sets off.
  await page.evaluate(() => window.__game.setPaused(false));
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await w.walk()).marker?.label).toBe('Lanternwick Docks');
  expect((await w.walk()).mode).toBe('off');
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await w.walk()).marker?.label).toBe('Lanternwick');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await w.walk()).mode).toBe('travel');
  await page.evaluate(() => window.__game.setPaused(true));
  expect(errors).toEqual([]);
});

test('off the road: travel says so and keeps the marker; once on a road, H follows the roads to it', async ({ page }) => {
  const errors = await open(page);
  const w = g(page);
  const ww = place('westwatch');
  await w.teleport(60, -150, 0);
  expect(await w.travelTo(ww.x, ww.z, ww.name)).toBe(false);
  await w.advance(1);
  await expect(page.locator('#lui-toasts')).toContainText('No road under your feet');
  let s = await w.walk();
  expect(s.mode).toBe('off');
  expect(s.refusal).toBe('offRoad');
  expect(s.marker.label).toBe('Westwatch Trading Post');
  // Off the road, H runs straight on instead.
  await w.press('autorun');
  expect((await w.walk()).mode).toBe('run');
  await w.press('autorun');
  // On the north road, H sets off along the roads to the marker.
  await w.teleport(0, -200, 0);
  await w.press('autorun');
  s = await w.walk();
  expect(s.mode).toBe('travel');
  await w.advance(120);
  expect((await w.walk()).mode).toBe('travel');
  // Moving yourself takes over, and the marker stays for later.
  await w.advance(1, { moveX: 1, stickX: -1 });
  s = await w.walk();
  expect(s.mode).toBe('off');
  expect(s.marker.label).toBe('Westwatch Trading Post');
  expect(errors).toEqual([]);
});

test('travel by road on horseback, faster than on foot; getting on or off stops it', async ({ page }) => {
  const errors = await open(page);
  const w = g(page);
  await w.cmd({ t: 'grant', item: 'whistle.horse', n: 1 });
  await w.advance(1);
  const spire = place('windspire');
  // On foot and on the way: mounting stops it.
  await w.teleport(0, -200, 0);
  expect(await w.travelTo(spire.x, spire.z, spire.name)).toBe(true);
  await w.advance(30);
  await w.cmd({ t: 'mount' });
  await w.advance(2);
  expect((await w.player()).mode).toBe('ride');
  expect((await w.walk()).mode).toBe('off');
  // Riding: up the north road to its end, the Windspire's foot beyond.
  expect(await w.travelTo(spire.x, spire.z, spire.name)).toBe(true);
  const length = (await w.walk()).length;
  const run = await travel(page, 60);
  console.log('on horseback', { metres: Math.round(length), ...run });
  const s = await w.walk();
  expect(s.mode).toBe('off');
  // A horse runs at 12.5 m/s: well quicker than the 7.5 on foot.
  expect(length / run.seconds).toBeGreaterThan(9);
  expect(run.paved / run.samples).toBeGreaterThan(0.9);
  await expect(page.locator('#lui-toasts')).toContainText('The road goes no nearer - Windspire is');
  expect(s.marker.label).toBe('Windspire');
  expect((await w.player()).mode).toBe('ride');
  // Getting off stops it too.
  expect(await w.travelTo(0, -200, 'Back')).toBe(true);
  await w.advance(30);
  await w.cmd({ t: 'mount' });
  await w.advance(2);
  expect((await w.player()).mode).toBe('normal');
  expect((await w.walk()).mode).toBe('off');
  expect(errors).toEqual([]);
});

test('travel by road in a farm cart, steering for the bends', async ({ page }) => {
  const errors = await open(page);
  const w = g(page);
  await w.cmd({ t: 'grant', item: 'deed.farmCart', n: 1 });
  await w.advance(1);
  await w.teleport(0, -200, 0);
  await w.cmd({ t: 'summon', item: 'deed.farmCart' });
  await w.advance(2);
  const cart = (await w.life()).vehicles[0];
  // Get in from the side, level with the seat.
  await w.teleport(
    cart.x + Math.cos(cart.heading) * 1.9 + Math.sin(cart.heading) * 0.9,
    cart.z - Math.sin(cart.heading) * 1.9 + Math.cos(cart.heading) * 0.9,
    cart.heading,
  );
  await w.advance(2);
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  expect((await w.player()).mode).toBe('ride');
  // Down the north road to where the quarry road leaves it, round its bends.
  expect(await w.travelTo(6, 60, 'The Fork')).toBe(true);
  const length = (await w.walk()).length;
  const run = await travel(page, 90);
  const v = (await w.life()).vehicles[0];
  console.log('farm cart', { metres: Math.round(length), ...run, at: [v.x.toFixed(1), v.z.toFixed(1)] });
  expect((await w.walk()).mode).toBe('off');
  expect(Math.hypot(v.x - 6, v.z - 60)).toBeLessThan(4);
  expect(run.paved / run.samples).toBeGreaterThan(0.9);
  // H in a cart holds the throttle open; S takes over.
  await w.press('autorun');
  expect((await w.walk()).mode).toBe('run');
  await w.advance(60);
  expect(Math.abs((await w.life()).vehicles[0].speed)).toBeGreaterThan(2);
  await w.advance(1, { stickY: -1 });
  expect((await w.walk()).mode).toBe('off');
  expect(errors).toEqual([]);
});

test('travel by road in a roadster: it slows in time for the square and stops at the end', async ({ page }) => {
  const errors = await open(page);
  const w = g(page);
  await w.cmd({ t: 'grant', item: 'deed.roadster', n: 1 });
  await w.advance(1);
  // On the north road, facing the town.
  await w.teleport(0, -200, Math.PI);
  await w.cmd({ t: 'summon', item: 'deed.roadster' });
  await w.advance(2);
  const car = (await w.life()).vehicles.find((v: { def: string }) => v.def === 'roadster');
  await w.teleport(
    car.x + Math.cos(car.heading) * 1.9 + Math.sin(car.heading) * 0.9,
    car.z - Math.sin(car.heading) * 1.9 + Math.cos(car.heading) * 0.9,
    car.heading,
  );
  await w.advance(2);
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  expect((await w.player()).mode).toBe('ride');
  // Down into Lanternwick's square, round the well and out along the west road.
  expect(await w.travelTo(60, -246, 'The West Road')).toBe(true);
  // Driven in the page, drawn at the end (see travel()).
  const { fastest, inSquare } = await page.evaluate(() => {
    const g = window.__game;
    let fastest = 0;
    let inSquare = 0;
    for (let i = 0; i < 60 && g.walk().mode === 'travel'; i++) {
      g.advance(15, {}, false);
      const v = g.life().vehicles.find((x: { def: string }) => x.def === 'roadster');
      fastest = Math.max(fastest, Math.abs(v.speed));
      if (Math.hypot(v.x, v.z + 250) < 15) inSquare = Math.max(inSquare, Math.abs(v.speed));
    }
    g.render();
    return { fastest, inSquare };
  });
  const v = (await w.life()).vehicles.find((x: { def: string }) => x.def === 'roadster');
  console.log('roadster', { fastest: fastest.toFixed(1), inSquare: inSquare.toFixed(1), at: [v.x.toFixed(1), v.z.toFixed(1)] });
  expect((await w.walk()).mode).toBe('off');
  await expect(page.locator('#lui-toasts')).toContainText('Arrived at The West Road');
  expect(Math.hypot(v.x - 60, v.z + 246)).toBeLessThan(4);
  expect(fastest).toBeGreaterThan(12);
  expect(inSquare).toBeLessThan(6);
  expect(errors).toEqual([]);
});

// ---------- Online ----------
// Travel by road only makes the controls, so on the game server it is the server that walks you
// along the roads, from the same key presses. Needs the server with developer sign-in (npm run up,
// or RUINA_SERVER); skipped without it.

const SERVER = process.env.RUINA_SERVER ?? 'http://localhost:7777';

test.describe('online', () => {
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

  test('online, the server walks you along the roads from the controls travel makes, and agrees where you end up', async ({ page }) => {
    test.setTimeout(240_000);
    const name = `road${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(0, 20);
    await page.goto(`/?as=${name}&bugs=0`);
    await onlineReady(page, 90_000);
    const docks = place('docks');
    expect(await page.evaluate(([x, z, l]) => window.__game.travelTo(x, z, l), [docks.x, docks.z, docks.name] as const)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__game.walk().mode), { timeout: 180_000 }).toBe('off');
    await expect(page.locator('#lui-toasts')).toContainText('Arrived at Lanternwick Docks');
    // Where you stand is the server's word: it moved you there, and never had to put you right by much.
    await page.waitForTimeout(500);
    const o = await page.evaluate(() => ({ pos: window.__game.state().player.pos, ...window.__game.online() }));
    console.log('online travel', { at: [o.pos.x.toFixed(1), o.pos.z.toFixed(1)], corrections: o.corrections, maxCorrection: o.maxCorrection });
    expect(Math.hypot(o.pos.x - docks.x, o.pos.z - docks.z)).toBeLessThan(3);
    expect(o.maxCorrection).toBeLessThan(1);
  });
});
