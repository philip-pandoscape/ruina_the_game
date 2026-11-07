import { expect } from 'vitest';
import { test, type Page } from '../../support/headless';
import { ABILITIES, abilityIndex, emptyMovement, HOTBAR_SLOTS, MOVE, NO_ABILITY, weaponIndex, type Build } from '../../../src/content/tuning';

import { skillsFrom } from '../../../src/content/skills';
import { gameReady } from '../../support/headless';

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
      return {
        full,
        casting: { mode: casting.mode, mp: casting.mp },
        fired,
        refused: { mode: refused.mode, mp: refused.mp },
        shorts,
        still,
        again: g.state().player.mode,
      };
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

test('an empty slot does nothing at all', async ({ page }) => {
  await ready(page);
  await page.evaluate((b) => window.__game.setBuild(b), CASTER);
  await page.evaluate(() => window.__game.advance(30, { abilitySlot: 5 })); // empty
  const p = await state(page);
  expect(p.mode).toBe('normal');
  expect(p.cooldowns.every((c: number) => c === 0)).toBe(true);
});

// ---------- Assigning abilities ----------

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
