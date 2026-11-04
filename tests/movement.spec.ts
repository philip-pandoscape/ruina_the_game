import { expect, test, type Page } from '@playwright/test';
import { skillsFrom } from '../src/skills';
import { emptyMovement, HOTBAR_SLOTS, MOVEMENT_SKILLS, NO_ABILITY, NO_MOVEMENT, SLIDE_SKILL, type Build } from '../src/tuning';

// Movement skills: the data-driven action states on Q / E (LB / RB). A dodge commits to a
// direction and cannot be hit for part of it; a guard stays up while you hold it and lets only
// part of a hit through.

const DODGE = 0;
const BACKSTEP = 1;
const BLOCK = 2;
const roll = MOVEMENT_SKILLS[DODGE].action;
const guard = MOVEMENT_SKILLS[BLOCK].action;

const bar = () => new Array<number>(HOTBAR_SLOTS).fill(NO_ABILITY);
const moves = (...m: number[]) => {
  const out = emptyMovement();
  m.forEach((v, i) => (out[i] = v));
  return out;
};
// Everything bound at once: dodge on Q, block on E.
const DUELIST: Build = {
  skills: skillsFrom('sword', 'dodgeRoll', 'club', 'block'),
  weapon: 0,
  abilities: bar(),
  movement: moves(DODGE, BLOCK),
};
const ROLLER: Build = { skills: skillsFrom('sword', 'dodgeRoll'), weapon: 0, abilities: bar(), movement: moves(DODGE) };
const STEPPER: Build = { skills: skillsFrom('bow', 'rapidFire', 'backstep'), weapon: 3, abilities: bar(), movement: moves(BACKSTEP) };

const state = (page: Page) => page.evaluate(() => (window as any).__game.state().player);
const ready = async (page: Page, b: Build) => {
  await page.goto('/?yard');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  expect(await page.evaluate((x) => (window as any).__game.setBuild(x), b)).toBe(true);
};

test('a dodge moves you, costs its cooldown, and ends on its own', async ({ page }) => {
  await ready(page, ROLLER);
  const seen = await page.evaluate(() => {
    const g = (window as any).__game;
    g.reset({});
    const from = { ...g.state().player.pos };
    g.advance(1, { movementSlot: 1, moveZ: 1 });
    const started = g.state().player;
    // Run it out without holding anything, so nothing but the action is moving us.
    for (let i = 0; i < 60; i++) g.advance(1, {});
    const after = g.state().player;
    return {
      from,
      mode: started.mode,
      actionId: started.actionId,
      travelled: Math.hypot(after.pos.x - from.x, after.pos.z - from.z),
      endedMode: after.mode,
      cooldown: after.movementCooldowns[0],
    };
  });
  expect(seen.mode).toBe('action');
  expect(seen.actionId).toBe(DODGE);
  expect(seen.travelled).toBeGreaterThan(2); // it actually carried us
  expect(seen.endedMode).toBe('normal'); // and let go again
  expect(seen.cooldown).toBeGreaterThan(0);
});

test('a dodge commits to the direction it started in', async ({ page }) => {
  await ready(page, ROLLER);
  const seen = await page.evaluate(() => {
    const g = (window as any).__game;
    g.reset({});
    const from = { ...g.state().player.pos };
    // Start rolling one way, then push hard the other way for the rest of it.
    g.advance(1, { movementSlot: 1, moveZ: 1 });
    for (let i = 0; i < 14; i++) g.advance(1, { moveZ: -1 });
    const after = g.state().player.pos;
    return { dz: after.z - from.z, dx: after.x - from.x };
  });
  // Still went forwards: a roll is a commitment, not something you steer out of.
  expect(seen.dz).toBeGreaterThan(1.5);
  expect(Math.abs(seen.dx)).toBeLessThan(1);
});

test('a dodge cannot be hit during its invulnerable frames', async ({ page }) => {
  await ready(page, ROLLER);
  const seen = await page.evaluate(
    ([from, to]) => {
      const g = (window as any).__game;
      const hitAt = (frame: number) => {
        g.reset({});
        g.advance(1, { movementSlot: 1, moveZ: 1 });
        for (let i = 1; i < frame; i++) g.advance(1, {});
        const before = g.state().player.hp;
        g.takeHit(30, 0, 1, 3);
        return before - g.state().player.hp;
      };
      // Inside the window, and well after it.
      return { inside: hitAt(((from as number) + (to as number)) >> 1), after: hitAt((to as number) + 6) };
    },
    [roll.invulnFrom ?? 0, roll.invulnTo ?? 0],
  );
  expect(seen.inside).toBe(0); // untouchable
  expect(seen.after).toBeGreaterThan(0); // and touchable again afterwards
});

test('a guard lets only part of a hit through, and holds its ground', async ({ page }) => {
  await ready(page, DUELIST);
  const seen = await page.evaluate(
    (startup) => {
      const g = (window as any).__game;
      g.reset({});
      // Slot 2 is the block; hold it so it stays up.
      g.advance(1, { movementSlot: 2, movementHeld: 2 });
      for (let i = 0; i < (startup as number) + 2; i++) g.advance(1, { movementHeld: 2 });
      const before = g.state().player;
      g.takeHit(40, 0, 1, 6);
      const after = g.state().player;
      return {
        mode: before.mode,
        taken: before.hp - after.hp,
        stillGuarding: after.mode,
        knockback: Math.hypot(after.vel.x, after.vel.z),
      };
    },
    guard.startup,
  );
  expect(seen.mode).toBe('action');
  expect(seen.taken).toBeCloseTo(40 * (guard.damageTaken ?? 1), 5);
  expect(seen.stillGuarding).toBe('action'); // a guard isn't broken by one hit
  expect(seen.knockback).toBeLessThan(1); // nor knocked about
});

test('a guard drops when you let go', async ({ page }) => {
  await ready(page, DUELIST);
  const seen = await page.evaluate(() => {
    const g = (window as any).__game;
    g.reset({});
    g.advance(1, { movementSlot: 2, movementHeld: 2 });
    for (let i = 0; i < 10; i++) g.advance(1, { movementHeld: 2 });
    const held = g.state().player.mode;
    for (let i = 0; i < 30; i++) g.advance(1, {}); // released
    return { held, released: g.state().player.mode };
  });
  expect(seen.held).toBe('action');
  expect(seen.released).toBe('normal');
});

test('a backstep goes the other way from where you face', async ({ page }) => {
  await ready(page, STEPPER);
  const seen = await page.evaluate(() => {
    const g = (window as any).__game;
    g.reset({ facing: 0 }); // facing +Z
    const from = { ...g.state().player.pos };
    g.advance(1, { movementSlot: 1 });
    for (let i = 0; i < 20; i++) g.advance(1, {});
    const after = g.state().player.pos;
    return { dz: after.z - from.z };
  });
  expect(seen.dz).toBeLessThan(-1); // away from the way we were looking
});

test('an empty movement slot does nothing, and a cooldown blocks a second go', async ({ page }) => {
  await ready(page, ROLLER);
  const seen = await page.evaluate(() => {
    const g = (window as any).__game;
    g.reset({});
    g.advance(1, { movementSlot: 2 }); // nothing bound there
    const empty = g.state().player.mode;
    g.advance(1, { movementSlot: 1, moveZ: 1 });
    for (let i = 0; i < 40; i++) g.advance(1, {});
    const cooling = g.state().player.movementCooldowns[0];
    g.advance(1, { movementSlot: 1, moveZ: 1 }); // still on cooldown
    return { empty, cooling, second: g.state().player.mode };
  });
  expect(seen.empty).toBe('normal');
  expect(seen.cooling).toBeGreaterThan(0);
  expect(seen.second).toBe('normal');
});

test('the tree is what grants a movement skill', async ({ page }) => {
  await page.goto('/?yard');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  // Binding one you never learned is refused, the same way an unlearned ability is.
  const bogus: Build = { skills: skillsFrom('sword'), weapon: 0, abilities: bar(), movement: moves(DODGE) };
  expect(await page.evaluate((b) => (window as any).__game.setBuild(b), bogus)).toBe(false);
  expect(await page.evaluate((b) => (window as any).__game.setBuild(b), ROLLER)).toBe(true);
  expect((await state(page)).movement[0]).toBe(DODGE);
  expect((await state(page)).movement[1]).toBe(NO_MOVEMENT);
});

// ---------- The slide, now that it is an action state like the rest ----------

test('the slide runs for exactly its tuned frames and no longer', async ({ page }) => {
  await ready(page, ROLLER);
  const frames = await page.evaluate(
    (slide) => {
      const g = (window as any).__game;
      g.reset({});
      g.advance(1, { moveZ: 1, slidePressed: true });
      let n = 0;
      for (let i = 0; i < 90; i++) {
        const p = g.state().player;
        if (p.mode !== 'action' || p.actionId !== slide) break;
        n++;
        g.advance(1, { moveZ: 1 });
      }
      return n;
    },
    SLIDE_SKILL,
  );
  // An action with no recovery ends on the last of its active frames, not one after it.
  expect(frames).toBe(MOVEMENT_SKILLS[SLIDE_SKILL].action.active);
});

test('the slide can still be steered, unlike a dodge', async ({ page }) => {
  await ready(page, ROLLER);
  const seen = await page.evaluate(() => {
    const g = (window as any).__game;
    g.reset({});
    const from = { ...g.state().player.pos };
    g.advance(1, { moveZ: 1, slidePressed: true });
    // Push hard sideways for the rest of it.
    for (let i = 0; i < 24; i++) g.advance(1, { moveX: 1 });
    const after = g.state().player.pos;
    return { dx: after.x - from.x, dz: after.z - from.z };
  });
  expect(seen.dx).toBeGreaterThan(2); // it turned, where a dodge would not have
  expect(seen.dz).toBeGreaterThan(0); // and kept some of the way it set off
});

test('jumping out of a slide carries its speed', async ({ page }) => {
  await ready(page, ROLLER);
  const seen = await page.evaluate(() => {
    const g = (window as any).__game;
    const run = (jump: boolean) => {
      g.reset({});
      g.advance(1, { moveZ: 1, slidePressed: true });
      for (let i = 0; i < 6; i++) g.advance(1, { moveZ: 1 });
      g.advance(1, { moveZ: 1, jumpPressed: jump, jumpHeld: jump });
      const p = g.state().player;
      return { speed: Math.hypot(p.vel.x, p.vel.z), grounded: p.grounded, mode: p.mode };
    };
    return { jumped: run(true), slid: run(false) };
  });
  expect(seen.jumped.grounded).toBe(false); // it took off
  expect(seen.jumped.mode).toBe('normal'); // and left the slide
  expect(seen.slid.mode).toBe('action'); // the control case is still sliding
  // Most of the slide's speed came with it, rather than all or none of it.
  expect(seen.jumped.speed).toBeGreaterThan(seen.slid.speed * 0.6);
  expect(seen.jumped.speed).toBeLessThan(seen.slid.speed);
});

test('the slide is built in, not something the tree hands out', async ({ page }) => {
  await ready(page, ROLLER);
  // It can't be bound to Q or E: no node grants it, so a build naming it is refused.
  const bogus = { ...ROLLER, movement: moves(SLIDE_SKILL) };
  expect(await page.evaluate((b) => (window as any).__game.setBuild(b), bogus)).toBe(false);
  // But everyone can still slide.
  const slid = await page.evaluate(
    (slide) => {
      const g = (window as any).__game;
      g.reset({});
      g.advance(1, { moveZ: 1, slidePressed: true });
      const p = g.state().player;
      return p.mode === 'action' && p.actionId === slide;
    },
    SLIDE_SKILL,
  );
  expect(slid).toBe(true);
});
