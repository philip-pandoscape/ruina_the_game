import { expect, test, type Page } from '@playwright/test';
import { skillsFrom } from '../../src/skills';
import { COMBAT, emptyMovement, HOTBAR_SLOTS, MOVEMENT_SKILLS, MP, NO_ABILITY, NO_MOVEMENT, SLIDE_SKILL, STAMINA, STEP, type Build } from '../../src/tuning';
import { gameReady } from '../support/game';

// Its tests share nothing, so they spread across the workers (playwright.config.ts).
test.describe.configure({ mode: 'parallel' });

// Movement skills: the data-driven action states on Q / E (LB / RB). A dodge commits to a
// direction and cannot be hit for part of it, and costs stamina rather than having a cooldown; a
// guard stays up while you hold it and lets only part of a hit through.

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

const state = (page: Page) => page.evaluate(() => window.__game.state().player);
const ready = async (page: Page, b: Build) => {
  await page.goto('/?yard');
  await gameReady(page);
  expect(await page.evaluate((x) => window.__game.setBuild(x), b)).toBe(true);
};

test('a dodge moves you, costs stamina rather than a cooldown, and ends on its own', async ({ page }) => {
  await ready(page, ROLLER);
  const seen = await page.evaluate(() => {
    const g = window.__game;
    g.reset({});
    const from = { ...g.state().player.pos };
    const full = g.state().player.stamina;
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
      full,
      left: started.stamina,
      delay: started.staminaDelay,
    };
  });
  expect(seen.mode).toBe('action');
  expect(seen.actionId).toBe(DODGE);
  expect(seen.travelled).toBeGreaterThan(2); // it actually carried us
  expect(seen.endedMode).toBe('normal'); // and let go again
  expect(seen.full).toBe(STAMINA.max);
  expect(seen.full - seen.left).toBe(MOVEMENT_SKILLS[DODGE].staminaCost); // paid for in stamina
  expect(seen.delay).toBe(STAMINA.regenDelayFrames); // which waits a moment before refilling
  expect(seen.cooldown).toBe(0); // and no cooldown
});

test('a dodge commits to the direction it started in', async ({ page }) => {
  await ready(page, ROLLER);
  const seen = await page.evaluate(() => {
    const g = window.__game;
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
      const g = window.__game;
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
      const g = window.__game;
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
    const g = window.__game;
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
    const g = window.__game;
    g.reset({ facing: 0 }); // facing +Z
    const from = { ...g.state().player.pos };
    g.advance(1, { movementSlot: 1 });
    for (let i = 0; i < 20; i++) g.advance(1, {});
    const after = g.state().player.pos;
    return { dz: after.z - from.z };
  });
  expect(seen.dz).toBeLessThan(-1); // away from the way we were looking
});

test('an empty movement slot does nothing, and dodges run on stamina: back to back until it runs out', async ({ page }) => {
  await ready(page, ROLLER);
  const cost = MOVEMENT_SKILLS[DODGE].staminaCost!;
  const seen = await page.evaluate((cost) => {
    const g = window.__game;
    g.reset({});
    g.advance(1, { movementSlot: 2 }); // nothing bound there
    const empty = g.state().player.mode;
    // Roll after roll, each the moment the last one is over.
    const rolls: number[] = [];
    let refused: { at: number; stamina: number; mode: string; shorts: number } | null = null;
    for (let k = 0; k < 8 && !refused; k++) {
      const before = g.state().player.stamina;
      g.advance(1, { movementSlot: 1, moveZ: k % 2 ? -1 : 1 });
      const p = g.state().player;
      if (p.mode === 'action') {
        rolls.push(before);
        g.advance(24, {});
      } else {
        const shorts = g.events().filter((e: { type: string; what?: string }) => e.type === 'short' && e.what === 'stamina').length;
        refused = { at: k, stamina: p.stamina, mode: p.mode, shorts };
      }
    }
    // It comes back once a moment has passed since the last roll, at its own pace.
    const waits: number[] = [];
    for (let i = 0; i < 12; i++) {
      waits.push(g.state().player.stamina);
      g.advance(1, {});
    }
    let frames = 0;
    while (g.state().player.stamina < cost && frames < 600) {
      g.advance(1, {});
      frames++;
    }
    g.advance(1, { movementSlot: 1, moveZ: 1 });
    return { empty, rolls, refused, waits, again: g.state().player.mode };
  }, cost);
  expect(seen.empty).toBe('normal');
  // No cooldown between them: as many rolls in a row as the stamina pays for, then no more.
  expect(seen.rolls.length).toBe(Math.floor(STAMINA.max / cost));
  expect(seen.refused).not.toBeNull();
  expect(seen.refused!.mode).toBe('normal');
  expect(seen.refused!.stamina).toBeLessThan(cost);
  expect(seen.refused!.shorts).toBe(1); // and the screen is told why
  const steps = seen.waits.slice(1).map((v, i) => v - seen.waits[i]);
  expect(steps.some((d) => d === 0)).toBe(true); // a pause first,
  expect(steps[steps.length - 1]).toBeCloseTo(STAMINA.regenPerSecond * STEP, 9); // then refilling
  expect(seen.again).toBe('action'); // and a roll again once there is enough
});

test('getting back up after a knock-down fills stamina and MP', async ({ page }) => {
  await ready(page, ROLLER);
  const seen = await page.evaluate((down) => {
    const g = window.__game;
    g.reset({});
    g.advance(1, { movementSlot: 1, moveZ: 1 });
    g.advance(24, {});
    g.setVitals({ mp: 3 });
    g.takeHit(1000, 0, 1, 3);
    const knocked = g.state().player;
    g.advance((down as number) + 2, {});
    const up = g.state().player;
    return { knocked: { stamina: knocked.stamina, mp: knocked.mp, down: knocked.downFrame }, up: { stamina: up.stamina, mp: up.mp, delay: up.staminaDelay, down: up.downFrame } };
  }, COMBAT.downFrames);
  expect(seen.knocked.down).toBeGreaterThanOrEqual(0);
  expect(seen.knocked.stamina).toBeLessThan(STAMINA.max);
  expect(seen.knocked.mp).toBeLessThan(MP.max);
  expect(seen.up.down).toBe(-1);
  expect(seen.up).toEqual({ stamina: STAMINA.max, mp: MP.max, delay: 0, down: -1 });
});

test('the tree is what grants a movement skill', async ({ page }) => {
  await page.goto('/?yard');
  await gameReady(page);
  // Binding one you never learned is refused, the same way an unlearned ability is.
  const bogus: Build = { skills: skillsFrom('sword'), weapon: 0, abilities: bar(), movement: moves(DODGE) };
  expect(await page.evaluate((b) => window.__game.setBuild(b), bogus)).toBe(false);
  expect(await page.evaluate((b) => window.__game.setBuild(b), ROLLER)).toBe(true);
  expect((await state(page)).movement[0]).toBe(DODGE);
  expect((await state(page)).movement[1]).toBe(NO_MOVEMENT);
});

// ---------- The slide, now that it is an action state like the rest ----------

test('the slide runs for exactly its tuned frames and no longer', async ({ page }) => {
  await ready(page, ROLLER);
  const frames = await page.evaluate(
    (slide) => {
      const g = window.__game;
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
    const g = window.__game;
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
    const g = window.__game;
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
  expect(await page.evaluate((b) => window.__game.setBuild(b), bogus)).toBe(false);
  // But everyone can still slide.
  const slid = await page.evaluate(
    (slide) => {
      const g = window.__game;
      g.reset({});
      g.advance(1, { moveZ: 1, slidePressed: true });
      const p = g.state().player;
      return p.mode === 'action' && p.actionId === slide;
    },
    SLIDE_SKILL,
  );
  expect(slid).toBe(true);
});

// ---------- Combat stance: facing the fight while moving every other way ----------
// With faceX / faceZ set (the game sets them while an enemy is marked, or just after a swing), the
// rules keep you facing that way: the stick strafes and backs off, slower than running ahead, and
// dodges and double jumps go wherever you push without turning you. Sprinting runs free.

const AHEAD = { faceX: 0, faceZ: 1 };

test('fighting, you strafe instead of turning, a little slower than running', async ({ page }) => {
  await ready(page, ROLLER);
  const seen = await page.evaluate((face) => {
    const g = window.__game;
    g.reset({ facing: 0 });
    g.advance(40, { ...face, moveX: 1 });
    const p = g.state().player;
    return { facing: p.facing, vx: p.vel.x, vz: p.vel.z };
  }, AHEAD);
  expect(Math.abs(seen.facing)).toBeLessThan(0.01); // still looking ahead
  expect(seen.vx).toBeCloseTo(7.5 * 0.85, 3); // sideways, at strafing speed
  expect(Math.abs(seen.vz)).toBeLessThan(0.01);
});

test('fighting, you back away slower still, facing the fight', async ({ page }) => {
  await ready(page, ROLLER);
  const seen = await page.evaluate((face) => {
    const g = window.__game;
    g.reset({ facing: 0 });
    g.advance(40, { ...face, moveZ: -1 });
    const p = g.state().player;
    return { facing: p.facing, vz: p.vel.z };
  }, AHEAD);
  expect(Math.abs(seen.facing)).toBeLessThan(0.01);
  expect(seen.vz).toBeCloseTo(-7.5 * 0.65, 3);
});

test('out of a fight you turn and run the way you push, as before', async ({ page }) => {
  await ready(page, ROLLER);
  const seen = await page.evaluate(() => {
    const g = window.__game;
    g.reset({ facing: 0 });
    g.advance(40, { moveX: 1 });
    const p = g.state().player;
    return { facing: p.facing, vx: p.vel.x };
  });
  expect(seen.facing).toBeCloseTo(Math.PI / 2, 2);
  expect(seen.vx).toBeCloseTo(7.5, 3);
});

test('sprinting breaks the stance: you turn and run', async ({ page }) => {
  await ready(page, ROLLER);
  const seen = await page.evaluate((face) => {
    const g = window.__game;
    g.reset({ facing: 0 });
    g.advance(40, { ...face, moveX: 1, sprintHeld: true });
    const p = g.state().player;
    return { facing: p.facing, vx: p.vel.x, sprinting: p.sprinting };
  }, AHEAD);
  expect(seen.sprinting).toBe(true);
  expect(seen.facing).toBeCloseTo(Math.PI / 2, 2);
  expect(seen.vx).toBeGreaterThan(9);
});

test('fighting, a dodge goes the way you push without turning you', async ({ page }) => {
  await ready(page, ROLLER);
  const seen = await page.evaluate((face) => {
    const g = window.__game;
    g.reset({ facing: 0 });
    const from = { ...g.state().player.pos };
    g.advance(1, { ...face, movementSlot: 1, moveX: -1 });
    const started = g.state().player;
    for (let i = 0; i < 14; i++) g.advance(1, { ...face });
    const after = g.state().player;
    return { facing: started.facing, dirX: started.actionDirX, dx: after.pos.x - from.x, dz: after.pos.z - from.z };
  }, AHEAD);
  expect(Math.abs(seen.facing)).toBeLessThan(0.01); // still facing ahead
  expect(seen.dirX).toBeCloseTo(-1, 5); // rolling off to the right (-X)
  expect(seen.dx).toBeLessThan(-1.5);
  expect(Math.abs(seen.dz)).toBeLessThan(0.3);
});

test('fighting, a double jump flies the way you push and keeps you facing the fight', async ({ page }) => {
  await ready(page, ROLLER);
  const seen = await page.evaluate((face) => {
    const g = window.__game;
    g.reset({ facing: 0 });
    g.advance(1, { ...face, jumpPressed: true, jumpHeld: true });
    g.advance(12, { ...face, jumpHeld: true });
    g.advance(1, { ...face, moveX: 1, jumpPressed: true, jumpHeld: true });
    const p = g.state().player;
    return { facing: p.facing, vx: p.vel.x, flipping: p.flipFrame >= 0 };
  }, AHEAD);
  expect(seen.flipping).toBe(true);
  expect(Math.abs(seen.facing)).toBeLessThan(0.01);
  expect(seen.vx).toBeGreaterThan(5);
});
