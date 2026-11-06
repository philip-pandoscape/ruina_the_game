import { expect, test, type Page } from '@playwright/test';
import { SLIDE_SKILL, WEAPONS } from '../../src/content/tuning';
import { gameReady } from '../support/game';

// Sliding is an action state now, not a mode of its own.
const sliding = (p: { mode: string; actionId: number }) => p.mode === 'action' && p.actionId === SLIDE_SKILL;

// These tests drive the real game in a browser through window.__game (see the end of src/main.ts).
// Screenshots land in screenshots/ so they can be reviewed by eye.

type Actions = Partial<{
  moveX: number;
  moveZ: number;
  jumpPressed: boolean;
  jumpHeld: boolean;
  attackPressed: boolean;
  slidePressed: boolean;
}>;
type Script = Array<[number, Actions]>;
type ResetOpts = { x?: number; z?: number; facing?: number; camYaw?: number };

const SHOTS = 'screenshots';
const EAST = Math.PI / 2; // facing +X
// A lane inside the training yard with nothing in the way when running toward +X.
const LANE = { x: -3.5, z: -3, facing: EAST, camYaw: EAST };

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?test');
  await gameReady(page);
  return errors;
}

const reset = (page: Page, opts: ResetOpts = {}) => page.evaluate((o) => window.__game.reset(o), opts);
const advance = (page: Page, frames: number, actions: Actions = {}) => page.evaluate(([n, a]) => window.__game.advance(n, a), [frames, actions] as const);
const advanceLive = (page: Page, frames: number) => page.evaluate((n) => window.__game.advanceLive(n), frames);
const state = (page: Page) => page.evaluate(() => window.__game.state());
const events = (page: Page) => page.evaluate(() => window.__game.events());

// Runs a script of [frames, actions] and returns the highest point the player reached.
const peakHeight = (page: Page, script: Script) =>
  page.evaluate((s) => {
    const g = window.__game;
    g.reset();
    let maxY = 0;
    for (const [frames, actions] of s) {
      for (let i = 0; i < frames; i++) {
        g.advance(1, actions);
        maxY = Math.max(maxY, g.state().player.pos.y);
      }
    }
    return maxY;
  }, script);

test('loads and renders the scene without errors', async ({ page }) => {
  const errors = await open(page);
  await reset(page);
  await advance(page, 30);
  await page.screenshot({ path: `${SHOTS}/01-overview.png` });
  const perf = await page.evaluate(() => window.__game.perf());
  console.log('render stats', perf);
  expect(perf.drawCalls).toBeGreaterThan(10);
  expect(errors).toEqual([]);
});

test('jumps: short hop < full jump < double jump', async ({ page }) => {
  const errors = await open(page);
  const full = await peakHeight(page, [
    [1, { jumpPressed: true, jumpHeld: true }],
    [70, { jumpHeld: true }],
  ]);
  const hop = await peakHeight(page, [
    [1, { jumpPressed: true, jumpHeld: true }],
    [70, {}],
  ]);
  const double = await peakHeight(page, [
    [1, { jumpPressed: true, jumpHeld: true }],
    [16, { jumpHeld: true }],
    [1, { jumpPressed: true, jumpHeld: true }],
    [80, { jumpHeld: true }],
  ]);
  console.log('jump heights (m)', { hop: hop.toFixed(2), full: full.toFixed(2), double: double.toFixed(2) });
  expect(hop).toBeLessThan(full * 0.6);
  expect(double).toBeGreaterThan(full * 1.5);
  const after = await state(page);
  expect(after.player.grounded).toBe(true);

  // Mid-flip picture of the double jump.
  await reset(page, LANE);
  await advance(page, 1, { jumpPressed: true, jumpHeld: true, moveX: 1 });
  await advance(page, 16, { jumpHeld: true, moveX: 1 });
  await advance(page, 1, { jumpPressed: true, jumpHeld: true, moveX: 1 });
  await advance(page, 8, { jumpHeld: true, moveX: 1 });
  await page.screenshot({ path: `${SHOTS}/02-double-jump.png` });
  expect(errors).toEqual([]);
});

test('slide is faster and goes further than running', async ({ page }) => {
  const errors = await open(page);
  await reset(page, LANE);
  await advance(page, 12, { moveX: 1 });
  const runStart = (await state(page)).player.pos.x;
  await advance(page, 26, { moveX: 1 });
  const runDist = (await state(page)).player.pos.x - runStart;

  await reset(page, LANE);
  await advance(page, 12, { moveX: 1 });
  const slideStart = (await state(page)).player.pos.x;
  await advance(page, 1, { moveX: 1, slidePressed: true });
  await advance(page, 5, { moveX: 1 });
  const mid = await state(page);
  expect(sliding(mid.player)).toBe(true);
  expect(Math.hypot(mid.player.vel.x, mid.player.vel.z)).toBeGreaterThan(9);
  await page.screenshot({ path: `${SHOTS}/03-slide.png` });
  await advance(page, 20, { moveX: 1 });
  const slideDist = (await state(page)).player.pos.x - slideStart;
  console.log('distance over 26 frames (m)', { run: runDist.toFixed(2), slide: slideDist.toFixed(2) });
  expect(slideDist).toBeGreaterThan(runDist * 1.15);
  expect(errors).toEqual([]);
});

test('three-hit combo lands every hit on the dummy', async ({ page }) => {
  const errors = await open(page);
  await reset(page, { x: 0, z: 1.6, facing: 0, camYaw: 0.5 });
  const result = await page.evaluate(() => {
    const g = window.__game;
    for (let f = 0; f < 100; f++) g.advance(1, { attackPressed: f === 0 || f === 8 || f === 20 });
    return { hits: g.events().filter((e: any) => e.type === 'hit'), hp: g.state().dummy.hp };
  });
  console.log('combo hits', result.hits.map((h: any) => `#${h.index + 1}: ${h.damage}`).join(', '), '→ dummy hp', result.hp);
  expect(result.hits.map((h: any) => h.index)).toEqual([0, 1, 2]);
  expect(result.hp).toBe(100 - WEAPONS[0].combo.reduce((sum, s) => sum + s.damage, 0));

  // Pictures: first slash mid-swing, and the overhead finisher.
  await reset(page, { x: 0, z: 1.6, facing: 0, camYaw: 0.5 });
  await advance(page, 1, { attackPressed: true });
  await advance(page, 6);
  await page.screenshot({ path: `${SHOTS}/04-slash-1.png` });
  await reset(page, { x: 0, z: 1.6, facing: 0, camYaw: 0.5 });
  await page.evaluate(() => {
    const g = window.__game;
    for (let f = 0; f < 100; f++) {
      g.advance(1, { attackPressed: f === 0 || f === 8 || f === 20 });
      const p = g.state().player;
      if (p.attackIndex === 2 && p.attackFrame >= 10) break;
    }
  });
  await page.screenshot({ path: `${SHOTS}/05-slash-3.png` });
  expect(errors).toEqual([]);
});

test('Xbox controller: sticks and A/B/X work, rumble fires on hit', async ({ page }) => {
  // Simulated controller using the browser's standard (Xbox) button layout.
  await page.addInitScript(() => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
    const pad = {
      id: 'Xbox Wireless Controller (STANDARD GAMEPAD)',
      index: 0,
      connected: true,
      mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons,
      timestamp: 0,
      rumbles: [] as unknown[],
      vibrationActuator: {
        playEffect(type: string, params: unknown) {
          pad.rumbles.push({ type, params });
          return Promise.resolve('complete');
        },
      },
    };
    (window as any).__pad = pad;
    Object.defineProperty(navigator, 'getGamepads', { value: () => [pad, null, null, null], configurable: true });
  });
  const errors = await open(page);
  const setAxis = (i: number, v: number) => page.evaluate(([i, v]) => ((window as any).__pad.axes[i] = v), [i, v]);
  const setButton = (i: number, on: boolean) =>
    page.evaluate(
      ([i, on]) => {
        const b = (window as any).__pad.buttons[i];
        b.pressed = on;
        b.value = on ? 1 : 0;
      },
      [i, on] as const,
    );
  const tap = async (i: number) => {
    await setButton(i, true);
    await advanceLive(page, 1);
    await setButton(i, false);
  };

  // Left stick up = forward relative to the camera (camera faces +X here).
  await reset(page, LANE);
  await setAxis(1, -1);
  await advanceLive(page, 20);
  let s = await state(page);
  expect(s.player.pos.x).toBeGreaterThan(LANE.x + 1.5);
  expect(Math.abs(s.player.pos.z - LANE.z)).toBeLessThan(0.2);
  expect(await page.evaluate(() => window.__game.device())).toBe('gamepad');

  // A = jump
  await tap(0);
  await advanceLive(page, 6);
  s = await state(page);
  expect(s.player.pos.y).toBeGreaterThan(0.3);
  await advanceLive(page, 60);

  // B = slide (stick still held forward)
  await tap(1);
  s = await state(page);
  expect(sliding(s.player)).toBe(true);
  await setAxis(1, 0);
  await advanceLive(page, 40);

  // X = attack, with rumble on the hit
  await reset(page, { x: 0, z: 1.6, facing: 0, camYaw: 0 });
  await tap(2);
  await advanceLive(page, 14);
  const hits = (await events(page)).filter((e: any) => e.type === 'hit');
  expect(hits.length).toBe(1);
  const rumbles = await page.evaluate(() => (window as any).__pad.rumbles.length);
  expect(rumbles).toBeGreaterThan(0);

  // Right stick turns the camera.
  const yawBefore = await page.evaluate(() => window.__game.camera().yaw);
  await setAxis(2, 1);
  await advanceLive(page, 30);
  await setAxis(2, 0);
  const yawAfter = await page.evaluate(() => window.__game.camera().yaw);
  expect(yawAfter).toBeLessThan(yawBefore - 0.5);

  await page.screenshot({ path: `${SHOTS}/06-controller-hud.png` });
  expect(errors).toEqual([]);
});

test('keyboard: WASD moves, Space jumps', async ({ page }) => {
  const errors = await open(page);
  await reset(page, LANE);
  await page.keyboard.down('KeyW');
  await advanceLive(page, 20);
  await page.keyboard.up('KeyW');
  let s = await state(page);
  expect(s.player.pos.x).toBeGreaterThan(LANE.x + 1.5);
  await page.keyboard.press('Space');
  await advanceLive(page, 4);
  s = await state(page);
  expect(s.player.grounded).toBe(false);
  expect(errors).toEqual([]);
});

test('keyboard: C crouches standing still, slides on the run and crouches after; K slides; C in the air never slides on landing', async ({ page }) => {
  const errors = await open(page);
  const slides = () => page.evaluate((id) => window.__game.events().filter((e: any) => e.type === 'action' && e.id === id).length, SLIDE_SKILL);
  // Standing still: down into a crouch, and no slide.
  await reset(page, LANE);
  await page.keyboard.down('KeyC');
  await advanceLive(page, 10);
  let p = (await state(page)).player;
  expect([p.crouching, sliding(p)]).toEqual([true, false]);
  await page.keyboard.up('KeyC');
  await advanceLive(page, 10);
  expect((await state(page)).player.crouching).toBe(false);
  expect(await slides()).toBe(0);

  // On the run: the press slides, and held on through it you're crouched once it's done.
  await page.keyboard.down('KeyW');
  await advanceLive(page, 15);
  await page.keyboard.down('KeyC');
  await advanceLive(page, 2);
  expect(sliding((await state(page)).player)).toBe(true);
  await advanceLive(page, 30);
  p = (await state(page)).player;
  expect([sliding(p), p.crouching]).toEqual([false, true]);
  await page.keyboard.up('KeyC');
  await page.keyboard.up('KeyW');
  expect(await slides()).toBe(1);

  // K slides from a standstill.
  await reset(page, LANE);
  await page.keyboard.press('KeyK');
  await advanceLive(page, 2);
  expect(sliding((await state(page)).player)).toBe(true);
  await advanceLive(page, 40);

  // Pressed in the air just before a running jump comes down (within the few frames a slide press
  // is kept for), C leaves nothing waiting for the landing: you come down crouched, not sliding.
  await reset(page, LANE);
  await page.keyboard.down('KeyW');
  await advanceLive(page, 10);
  await page.keyboard.down('Space');
  await advanceLive(page, 20);
  await page.keyboard.up('Space');
  // A frame at a time in the page, drawn only at the end.
  await page.evaluate(() => {
    const g = window.__game;
    for (let i = 0; i < 30; i++) {
      const q = g.state().player;
      if (q.vel.y < 0 && q.pos.y < 0.45) break;
      g.advanceLive(1, false);
    }
  });
  expect((await state(page)).player.grounded).toBe(false);
  const before = await slides();
  await page.keyboard.down('KeyC');
  const landed = await page.evaluate(() => {
    const g = window.__game;
    for (let i = 0; i < 40; i++) {
      g.advanceLive(1, false);
      if (g.state().player.grounded) return true;
    }
    return false;
  });
  await advanceLive(page, 8);
  p = (await state(page)).player;
  expect(landed).toBe(true);
  expect([sliding(p), p.crouching, (await slides()) - before]).toEqual([false, true, 0]);
  await page.keyboard.up('KeyC');
  await page.keyboard.up('KeyW');
  expect(errors).toEqual([]);
});
