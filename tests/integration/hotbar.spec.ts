import { expect, test, type Page } from '@playwright/test';
import { abilityIndex, emptyMovement, HOTBAR_SLOTS, movementIndex, NO_ABILITY, SLIDE_SKILL, weaponIndex, type Build } from '../../src/content/tuning';

// Sliding is an action state now, not a mode of its own.
const sliding = (p: { mode: string; actionId: number }) => p.mode === 'action' && p.actionId === SLIDE_SKILL;
import { skillsFrom } from '../../src/content/skills';
import { gameReady } from '../support/game';

// Its tests share nothing, so they spread across the workers (playwright.config.ts).
test.describe.configure({ mode: 'parallel' });

// The eight-slot hotbar, and the sprint and crouch that share the movement keys with it.

const skills = (...ids: string[]) => skillsFrom(...ids);
const HEAL = abilityIndex('heal');
const METEOR = abilityIndex('meteor');
const bar = (...a: number[]): number[] => {
  const out = new Array<number>(HOTBAR_SLOTS).fill(NO_ABILITY);
  a.forEach((v, i) => (out[i] = v));
  return out;
};
// Both abilities learned, so slots can actually be filled and swapped.
const CASTER: Build = {
  skills: skills('staff', 'meteor', 'club', 'heal'),
  weapon: weaponIndex('staff'),
  abilities: bar(METEOR, HEAL),
  movement: emptyMovement(),
};

const state = (page: Page) => page.evaluate(() => window.__game.state().player);
const panel = (page: Page) => page.evaluate(() => window.__game.panel());
const ready = async (page: Page) => {
  await page.goto('/?yard');
  await gameReady(page);
};

// A standard (Xbox) controller.
async function withPad(page: Page) {
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
    };
    (window as any).__pad = pad;
    Object.defineProperty(navigator, 'getGamepads', { value: () => [pad, null, null, null], configurable: true });
  });
  const setButton = async (i: number, on: boolean) => {
    await page.evaluate(
      ([i, on]) => {
        const b = (window as any).__pad.buttons[i as number];
        b.pressed = on as boolean;
        b.value = on ? 1 : 0;
      },
      [i, on] as const,
    );
    await page.waitForTimeout(60); // let the frame loop poll it
  };
  return {
    setButton,
    tap: async (...buttons: number[]) => {
      for (const b of buttons) await setButton(b, true);
      for (const b of [...buttons].reverse()) await setButton(b, false);
    },
    setAxis: async (i: number, v: number) => {
      await page.evaluate(([i, v]) => void ((window as any).__pad.axes[i as number] = v), [i, v]);
      await page.waitForTimeout(60);
    },
  };
}
const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, LS: 10, RS: 11 };

// ---------- Sprint and crouch ----------

// ---------- The bar itself ----------

test('health, MP and stamina sit over the hotbar, with the dodge and the guard on Q and E', async ({ page }) => {
  await ready(page);
  const duelist: Build = {
    skills: skills('sword', 'dodgeRoll', 'club', 'block', 'staff', 'meteor'),
    weapon: weaponIndex('sword'),
    abilities: bar(METEOR),
    movement: [movementIndex('dodgeRoll'), movementIndex('block')],
  };
  expect(await page.evaluate((b) => window.__game.setBuild(b), duelist)).toBe(true);
  await page.evaluate(() => window.__game.advance(2));
  await expect(page.locator('#player-hp')).toBeVisible();
  await expect(page.locator('#player-hp .pv-hp .label')).toHaveText('100 / 100');
  await expect(page.locator('#player-hp .pv-mp, #player-hp .pv-st')).toHaveCount(2);
  await expect(page.locator('#abilities .mslot')).toHaveCount(2);
  await expect(page.locator('#abilities .short')).toHaveCount(0);
  // Short of stamina and MP: the dodge and the meteor say so; the guard costs nothing.
  await page.evaluate(() => window.__game.setVitals({ stamina: 5, mp: 5 }));
  await page.evaluate(() => window.__game.advance(1, { movementSlot: 1, moveZ: 1 }));
  await expect(page.locator('#abilities .mslot[data-move="0"]')).toHaveClass(/short/);
  await expect(page.locator('#abilities .mslot[data-move="0"]')).toHaveAttribute('title', /Not Enough Stamina/);
  await expect(page.locator('#abilities .mslot[data-move="1"]')).not.toHaveClass(/short/);
  await expect(page.locator('#abilities .slot[data-slot="1"]')).toHaveClass(/short/);
  await expect(page.locator('#hud-refuse')).toHaveText('Not Enough Stamina');
  expect((await state(page)).mode).toBe('normal');
});

test('number keys 1-8 drive the slots', async ({ page }) => {
  await ready(page);
  await page.evaluate((b) => window.__game.setBuild(b), CASTER);
  // Digit2 is the heal, which casts on the spot rather than needing a circle placed.
  await page.keyboard.press('Digit2');
  await page.waitForFunction(() => window.__game.state().player.cooldowns[1] > 0, null, { timeout: 4000, polling: 'raf' });
  expect((await state(page)).cooldowns[1]).toBeGreaterThan(0);
});

test('a trigger plus a face button picks a slot on a controller', async ({ page }) => {
  const pad = await withPad(page);
  await ready(page);
  await page.evaluate((b) => window.__game.setBuild(b), CASTER);

  // RT + B is slot 6, which is empty: nothing should happen, and B must not slide.
  await pad.tap(PAD.RT, PAD.B);
  let p = await state(page);
  expect(sliding(p)).toBe(false);
  expect(p.cooldowns.every((c: number) => c === 0)).toBe(true);

  // LT + B is slot 2, the heal.
  await pad.tap(PAD.LT, PAD.B);
  await page.waitForFunction(() => window.__game.state().player.cooldowns[1] > 0, null, { timeout: 4000, polling: 'raf' });
  p = await state(page);
  expect(p.cooldowns[1]).toBeGreaterThan(0);

  // With no trigger held, B slides as it always did.
  await page.evaluate(() => window.__game.reset({}));
  await pad.setButton(PAD.B, true);
  await page.waitForFunction(
    (slide) => {
      const p = window.__game.state().player;
      return p.mode === 'action' && p.actionId === slide;
    },
    SLIDE_SKILL,
    { timeout: 3000, polling: 'raf' },
  );
  await pad.setButton(PAD.B, false);
});

test('the left stick click sprints and the right stick click crouches', async ({ page }) => {
  const pad = await withPad(page);
  await ready(page);
  await pad.setAxis(1, -1); // stick forward
  await pad.setButton(PAD.LS, true);
  await page.waitForFunction(() => window.__game.state().player.sprinting === true, null, { timeout: 4000, polling: 'raf' });
  await pad.setButton(PAD.LS, false);

  await pad.setButton(PAD.RS, true);
  await page.waitForFunction(() => window.__game.state().player.crouching === true, null, { timeout: 4000, polling: 'raf' });
  expect((await state(page)).sprinting).toBe(false);
  await pad.setButton(PAD.RS, false);
  await pad.setAxis(1, 0);
});

// ---------- Assigning abilities ----------

test('the controller assigns with Y then a trigger and a face button, and B backs out', async ({ page }) => {
  const pad = await withPad(page);
  await ready(page);
  await page.evaluate((b) => window.__game.setBuild(b), CASTER);

  // View opens the skill book, then move the cursor onto a learned ability and press Y.
  await pad.tap(PAD.VIEW);
  await page.waitForFunction(() => window.__game.panel().open === true, null, { timeout: 4000, polling: 'raf' });

  // One pad tap can land between polls of the frame loop, so press until it takes.
  const startAssigning = async () => {
    for (let i = 0; i < 6; i++) {
      await pad.tap(PAD.Y);
      if ((await panel(page)).assigning) return;
    }
    throw new Error('assignment never started');
  };

  // Put the book's cursor on Meteor.
  await page.evaluate(() => {
    const g = window.__game;
    g.panelFocus({ book: 'meteor' });
  });
  await startAssigning();

  // B backs out of assignment without changing anything.
  const before = (await panel(page)).abilities;
  await pad.tap(PAD.B);
  await page.waitForFunction(() => window.__game.panel().assigning === false, null, { timeout: 4000, polling: 'raf' });
  expect((await panel(page)).abilities).toEqual(before);
  expect((await panel(page)).open).toBe(true); // backing out of assignment doesn't close the panel

  // Y again, then RT + X = slot 7.
  await startAssigning();
  await pad.tap(PAD.RT, PAD.X);
  await page.waitForFunction(() => window.__game.panel().assigning === false, null, { timeout: 4000, polling: 'raf' });

  const after = (await panel(page)).abilities;
  expect(after[6]).toBe(METEOR); // RT + X is slot 7
  expect(after.filter((a: number) => a === METEOR)).toHaveLength(1); // it moved, it didn't clone
});
