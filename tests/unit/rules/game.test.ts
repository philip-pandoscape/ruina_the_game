import { expect } from 'vitest';
import { test, type Page } from '../../support/headless';
import { SLIDE_SKILL, WEAPONS, weaponIndex } from '../../../src/content/tuning';
import { gameReady } from '../../support/headless';

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
const state = (page: Page) => page.evaluate(() => window.__game.state());

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
  expect(result.hp).toBe(100 - WEAPONS[weaponIndex('sword')].combo.reduce((sum, s) => sum + s.damage, 0));

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
