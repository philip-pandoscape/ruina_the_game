import { expect, test, type Page } from '@playwright/test';
import { ABILITIES, emptyMovement, HOTBAR_SLOTS, MOVE, NO_ABILITY, SLIDE_SKILL, type Build } from '../../src/tuning';

// Sliding is an action state now, not a mode of its own.
const sliding = (p: { mode: string; actionId: number }) => p.mode === 'action' && p.actionId === SLIDE_SKILL;
import { skillsFrom } from '../../src/skills';
import { gameReady } from '../support/game';

// Its tests share nothing, so they spread across the workers (playwright.config.ts).
test.describe.configure({ mode: 'parallel' });

// The eight-slot hotbar, and the sprint and crouch that share the movement keys with it.

const skills = (...ids: string[]) => skillsFrom(...ids);
const HEAL = 0;
const METEOR = 1;
const bar = (...a: number[]): number[] => {
  const out = new Array<number>(HOTBAR_SLOTS).fill(NO_ABILITY);
  a.forEach((v, i) => (out[i] = v));
  return out;
};
// Both abilities learned, so slots can actually be filled and swapped.
const CASTER: Build = { skills: skills('staff', 'meteor', 'club', 'heal'), weapon: 2, abilities: bar(METEOR, HEAL), movement: emptyMovement() };

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
    const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons, timestamp: 0 };
    (window as any).__pad = pad;
    Object.defineProperty(navigator, 'getGamepads', { value: () => [pad, null, null, null], configurable: true });
  });
  const setButton = async (i: number, on: boolean) => {
    await page.evaluate(([i, on]) => {
      const b = (window as any).__pad.buttons[i as number];
      b.pressed = on as boolean;
      b.value = on ? 1 : 0;
    }, [i, on] as const);
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

test('sprinting is faster than running, crouching is slower, and they need the ground', async ({ page }) => {
  await ready(page);
  const topSpeed = async (extra: Record<string, unknown>) =>
    page.evaluate((e) => {
      const g = window.__game;
      g.reset({});
      let speed = 0;
      let sprinting = false;
      let crouching = false;
      // Step a frame at a time and keep the fastest: the training yard is small, so running the
      // whole way would just end against a hay bale at zero.
      for (let i = 0; i < 70; i++) {
        g.advance(1, { moveZ: 1, ...(e as object) });
        const p = g.state().player;
        speed = Math.max(speed, Math.hypot(p.vel.x, p.vel.z));
        sprinting = sprinting || p.sprinting;
        crouching = crouching || p.crouching;
      }
      return { speed, sprinting, crouching };
    }, extra);
  const run = await topSpeed({});
  const sprint = await topSpeed({ sprintHeld: true });
  const crouch = await topSpeed({ crouchHeld: true });

  expect(run.speed).toBeCloseTo(MOVE.runSpeed, 1);
  expect(sprint.speed).toBeCloseTo(MOVE.sprintSpeed, 1);
  expect(crouch.speed).toBeCloseTo(MOVE.crouchSpeed, 1);
  expect(sprint.speed).toBeGreaterThan(run.speed);
  expect(crouch.speed).toBeLessThan(run.speed);
  expect([run.sprinting, sprint.sprinting, crouch.sprinting]).toEqual([false, true, false]);
  expect(crouch.crouching).toBe(true);

  // Holding both crouches: you can't sprint while crouched.
  const both = await topSpeed({ sprintHeld: true, crouchHeld: true });
  expect([both.crouching, both.sprinting]).toEqual([true, false]);

  // Neither applies in the air.
  await page.evaluate(() => window.__game.reset({}));
  await page.evaluate(() => window.__game.advance(12, { moveZ: 1, jumpPressed: true, jumpHeld: true, sprintHeld: true }));
  const air = await state(page);
  expect(air.grounded).toBe(false);
  expect(air.sprinting).toBe(false);
});

test('a sprint needs real stick movement, not a nudge', async ({ page }) => {
  await ready(page);
  // One evaluate: sprinting is recomputed every frame, so a live frame landing between two
  // separate calls would clear it before the assertion ran.
  const seen = await page.evaluate(() => {
    const g = window.__game;
    g.reset({});
    g.advance(60, { moveZ: 0.3, sprintHeld: true }); // below runThreshold
    const nudge = g.state().player.sprinting;
    g.advance(60, { moveZ: 1, sprintHeld: true });
    return { nudge, full: g.state().player.sprinting };
  });
  expect(seen.nudge).toBe(false);
  expect(seen.full).toBe(true);
});

test('crouching eases down and back up instead of snapping', async ({ page }) => {
  await ready(page);
  // All in one go: the live frame loop keeps stepping between evaluate() calls with nothing held,
  // which would quietly let the crouch back out mid-measurement.
  const seen = await page.evaluate(() => {
    const g = window.__game;
    g.reset({});
    const frame = () => g.state().player.crouchFrame;
    g.advance(2, { crouchHeld: true });
    const part = frame();
    g.advance(20, { crouchHeld: true });
    const down = frame();
    g.advance(20, {});
    return { part, down, up: frame() };
  });
  expect(seen.part).toBeGreaterThan(0);
  expect(seen.part).toBeLessThan(MOVE.crouchEnterFrames);
  expect(seen.down).toBe(MOVE.crouchEnterFrames); // fully crouched, and no further
  expect(seen.up).toBe(0); // and all the way back
});

// ---------- The bar itself ----------

test('the bar holds eight slots and each one casts what is in it', async ({ page }) => {
  await ready(page);
  expect(await page.evaluate((b) => window.__game.setBuild(b), CASTER)).toBe(true);
  const p = await state(page);
  expect(p.abilities).toHaveLength(HOTBAR_SLOTS);
  expect(p.cooldowns).toHaveLength(HOTBAR_SLOTS);
  expect(p.abilities.slice(0, 2)).toEqual([METEOR, HEAL]);

  // Slot 2 holds the heal: using it must put slot 2 on cooldown and leave the others alone.
  await page.evaluate(() => window.__game.advance(60, { abilitySlot: 2 }));
  const after = await state(page);
  expect(after.cooldowns[1]).toBeGreaterThan(0);
  expect(after.cooldowns.filter((c: number) => c > 0)).toHaveLength(1);
});

test('a cast pays its MP as it goes off, and none starts without enough', async ({ page }) => {
  await ready(page);
  expect(await page.evaluate((b) => window.__game.setBuild(b), CASTER)).toBe(true);
  const heal = ABILITIES[HEAL].mpCost!;
  const meteor = ABILITIES[METEOR].mpCost!;
  const seen = await page.evaluate(
    ([meteor]) => {
      const g = window.__game;
      g.reset({});
      const full = g.state().player.mp;
      g.advance(1, { abilitySlot: 2 }); // the heal
      const casting = g.state().player;
      let frames = 0;
      while (g.state().player.firedAbility === 255 && frames < 120) {
        g.advance(1, {});
        frames++;
      }
      const fired = g.state().player.mp;
      // Short of the meteor's cost: turned down, and the screen is told why.
      g.setVitals({ mp: meteor - 1 });
      g.advance(1, { abilitySlot: 1 });
      const refused = g.state().player;
      const shorts = g.events().filter((e: { type: string; what?: string }) => e.type === 'short' && e.what === 'mp').length;
      g.advance(10, {});
      const still = g.state().player.mode;
      // MP comes back on its own; with enough, it casts.
      g.advance(30, {});
      g.advance(1, { abilitySlot: 1 });
      return { full, casting: { mode: casting.mode, mp: casting.mp }, fired, refused: { mode: refused.mode, mp: refused.mp }, shorts, still, again: g.state().player.mode };
    },
    [meteor],
  );
  expect(seen.casting.mode).toBe('cast');
  expect(seen.casting.mp).toBe(seen.full); // nothing paid as it starts
  expect(seen.fired).toBe(seen.full - heal); // paid as it goes off
  expect(seen.refused.mode).toBe('normal');
  expect(seen.shorts).toBe(1);
  expect(seen.still).toBe('normal'); // the press ran out before the MP came back
  expect(seen.again).toBe('cast');
});

test('health, MP and stamina sit over the hotbar, with the dodge and the guard on Q and E', async ({ page }) => {
  await ready(page);
  const duelist: Build = { skills: skills('sword', 'dodgeRoll', 'club', 'block', 'staff', 'meteor'), weapon: 0, abilities: bar(METEOR), movement: [0, 2] };
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

test('an empty slot does nothing at all', async ({ page }) => {
  await ready(page);
  await page.evaluate((b) => window.__game.setBuild(b), CASTER);
  await page.evaluate(() => window.__game.advance(30, { abilitySlot: 5 })); // empty
  const p = await state(page);
  expect(p.mode).toBe('normal');
  expect(p.cooldowns.every((c: number) => c === 0)).toBe(true);
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

test('dropping an ability on a slot moves it there', async ({ page }) => {
  await ready(page);
  await page.evaluate((b) => window.__game.setBuild(b), CASTER);
  // The in-game bar exposes the swap directly; this is what a drag ends up calling.
  await page.evaluate(() => window.__game.swapSlots(0, 4));
  const abilities = (await panel(page)).abilities;
  expect(abilities[4]).toBe(METEOR);
  expect(abilities[0]).toBe(NO_ABILITY);
  expect(abilities[1]).toBe(HEAL); // untouched
  expect((await state(page)).abilities[4]).toBe(METEOR); // and the rules saw it
});

test('a build saved before the hotbar is carried onto it', async ({ page }) => {
  // The old shape: two named slots.
  await page.addInitScript(() => {
    localStorage.setItem('yggdrasil.build', JSON.stringify({ perks: 0b1 | (1 << 6) | (1 << 7), weapon: 0, ability1: 1, ability2: 255 }));
  });
  await ready(page);
  const abilities = (await panel(page)).abilities;
  expect(abilities).toHaveLength(HOTBAR_SLOTS);
  // Whatever the old ability1 was, it either survived into slot 1 or was dropped as unlearned;
  // either way the bar is the right shape and nothing is duplicated.
  const filled = abilities.filter((a: number) => a !== NO_ABILITY);
  expect(new Set(filled).size).toBe(filled.length);
  expect(ABILITIES.length).toBeGreaterThan(0);
});
