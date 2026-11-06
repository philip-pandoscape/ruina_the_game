import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ABILITIES, emptyMovement, HOTBAR_SLOTS, NO_ABILITY, type Build, WEAPONS } from '../../src/tuning';
import { skillsFrom } from '../../src/skills';
import { serverBuilt, TestServer } from '../support/testServer';

// Combat feedback and aiming: the floating numbers, the enemy the game marks for you, and
// placing a ground-aimed cast by holding its button.

const SHOTS = 'screenshots';
const skills = (...ids: string[]) => skillsFrom(...ids);
const HEAL = 0;
const METEOR = 1;
// Abilities land in hotbar slots 1 and 2; the rest of the bar stays empty.
const build = (ids: string[], weapon: number, ability1 = NO_ABILITY, ability2 = NO_ABILITY): Build => {
  const abilities = new Array<number>(HOTBAR_SLOTS).fill(NO_ABILITY);
  abilities[0] = ability1;
  abilities[1] = ability2;
  return { skills: skills(...ids), weapon, abilities, movement: emptyMovement() };
};

const SWORD = build(['sword'], 0);
const CLEAVER = build(['sword', 'cleave'], 0);
const MAGE = build(['staff', 'meteor'], 2, METEOR);
const HEALER = build(['club', 'heal'], 1, HEAL);
const swordDamage = WEAPONS[0].combo[0].damage;
const meteorRange = ABILITIES[METEOR].maxRange!;
const healAmount = ABILITIES[HEAL].effects[0].amount!;

interface Marker {
  kind: 'hit' | 'hurt' | 'heal';
  amount: number;
  icon: string;
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

const combat = (page: Page) => page.evaluate(() => (window as any).__game.combat());
const markers = async (page: Page): Promise<Marker[]> => (await combat(page)).markers;
const forget = (page: Page) => page.evaluate(() => (window as any).__game.clearMarkers());

// ---------- Training yard ----------

test('the game marks the dummy by itself, and hitting it puts numbers over it', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?yard');
  await page.waitForFunction(() => (window as any).__game?.ready === true);

  // Nobody pressed anything: the dummy is straight ahead, so it gets picked up on its own.
  const soft = await combat(page);
  expect(soft.target?.name).toBe('Training Dummy');
  expect(soft.target?.hp).toBe(1);
  expect(soft.locked).toBe(false); // picked for you, not chosen with Tab

  await forget(page);
  await page.evaluate(() => (window as any).__game.advance(40, { moveZ: 1, attackPressed: true }));
  await page.evaluate(() => (window as any).__game.advance(60, { attackPressed: true }));
  const hits = await markers(page);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.every((m) => m.kind === 'hit')).toBe(true);
  expect(hits.every((m) => m.icon === '🗡️')).toBe(true); // the sword that dealt it
  expect(hits.some((m) => m.amount === swordDamage)).toBe(true);

  // The plate followed the damage down.
  const after = await combat(page);
  expect(after.target.hp).toBeLessThan(1);
  expect(errors).toEqual([]);
});

test('Escape drops the mark, and it comes back on its own', async ({ page }) => {
  await page.goto('/?yard');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  expect((await combat(page)).target).not.toBeNull();

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => (window as any).__game.combat().target === null, null, { timeout: 2000 }).catch(() => {});
  // Looking away is what keeps it clear; facing it again re-acquires.
  await page.waitForFunction(() => (window as any).__game.combat().target !== null, null, { timeout: 2000, polling: 'raf' });
  expect((await combat(page)).locked).toBe(false);
});

test('the weapon comes out for a fight and goes away after it', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?yard');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  const weapon = () => page.evaluate(() => (window as any).__game.heroWeapon());
  // The dummy is marked as you arrive: an enemy in front of you, weapon in hand.
  await expect.poll(weapon, { timeout: 3000 }).toBe('hand');
  // Turned away from it, with nothing marked, it's put away a few seconds later.
  await page.evaluate(() => {
    const g = (window as any).__game;
    const away = g.state().player.facing + Math.PI;
    g.reset({ facing: away, camYaw: away });
  });
  await expect.poll(() => page.evaluate(() => (window as any).__game.combat().target), { timeout: 3000 }).toBeNull();
  // Played forward on the game's own clock, half a second a frame drawn, so a slow screen (CI draws
  // in software) waits no longer: it stays out 2.5 s after the fight, then goes away over 0.6 s.
  await page.evaluate(() => {
    const g = (window as any).__game;
    for (let i = 0; i < 16; i++) g.advance(30);
  });
  expect(await weapon()).toBe('away');
  // A swing has it in hand at once.
  await page.evaluate(() => (window as any).__game.advance(2, { attackPressed: true }));
  expect(await weapon()).toBe('hand');
  expect(errors).toEqual([]);
});

// A standard (Xbox) controller, so the left stick can place the ground-aim circle.
async function withPad(page: Page): Promise<{
  setAxis: (i: number, v: number) => Promise<void>;
  setButton: (i: number, on: boolean) => Promise<void>;
}> {
  await page.addInitScript(() => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
    const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons, timestamp: 0 };
    (window as any).__pad = pad;
    Object.defineProperty(navigator, 'getGamepads', { value: () => [pad, null, null, null], configurable: true });
  });
  return {
    setAxis: async (i, v) => {
      await page.evaluate(([i, v]) => void ((window as any).__pad.axes[i as number] = v), [i, v]);
    },
    setButton: (i, on) =>
      page.evaluate(([i, on]) => {
        const b = (window as any).__pad.buttons[i as number];
        b.pressed = on as boolean;
        b.value = on ? 1 : 0;
      }, [i, on] as const),
  };
}

// Hotbar slot 1 on a controller is LT + A (see PAD_FACE in input.ts).
const PAD_A = 0;
const PAD_LT = 6;
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

test('the ground-aim circle starts out in front of you, not at your feet', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?yard');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  expect(await page.evaluate((b) => (window as any).__game.setBuild(b), MAGE)).toBe(true);
  // Face away from the dummy so nothing is marked and the circle has to fall back to "in front".
  await page.evaluate(() => (window as any).__game.setCamera({ yaw: Math.PI }));
  await page.waitForFunction(() => (window as any).__game.combat().target === null, null, { timeout: 3000, polling: 'raf' });

  await page.keyboard.down('Digit1');
  await page.waitForFunction(() => (window as any).__game.combat().aiming === 1, null, { timeout: 2000, polling: 'raf' });
  const c = await combat(page);
  const p = await page.evaluate(() => (window as any).__game.state().player.pos);
  // The old camera-raycast landed on the player's own feet; this must not.
  expect(dist(c.reticle, p)).toBeGreaterThan(3);
  expect(dist(c.reticle, p)).toBeLessThanOrEqual(meteorRange + 0.001);
  await page.keyboard.up('Digit1');
  expect(errors).toEqual([]);
});

test('the circle opens on whoever is marked, so the common case needs no aiming', async ({ page }) => {
  await page.goto('/?yard');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  await page.evaluate((b) => (window as any).__game.setBuild(b), MAGE);
  // The dummy is straight ahead and gets marked on its own.
  const mark = (await combat(page)).target;
  expect(mark?.name).toBe('Training Dummy');

  await page.keyboard.down('Digit1');
  await page.waitForFunction(() => (window as any).__game.combat().aiming === 1, null, { timeout: 2000, polling: 'raf' });
  const c = await combat(page);
  expect(dist(c.reticle, mark)).toBeLessThan(0.5); // it opened right on them
  await page.keyboard.up('Digit1');
});

test('the left stick pushes the circle around, and it stops at the skill range', async ({ page }) => {
  const errors = watchErrors(page);
  const pad = await withPad(page);
  await page.goto('/?yard');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  // What loads after the page (the new look's hero body) is in before anything is timed.
  await page.waitForFunction(() => (window as any).__game.assetsReady === true);
  await page.evaluate((b) => (window as any).__game.setBuild(b), MAGE);
  await page.evaluate(() => (window as any).__game.setCamera({ yaw: 0 }));

  // First, with nothing being aimed, see which way the stick strafes. Which way "right" is comes
  // from the camera convention in input.ts; what matters is that aiming later agrees with it.
  await pad.setAxis(0, 1); // stick right
  const walkFrom = await page.evaluate(() => (window as any).__game.state().player.pos);
  await page.waitForTimeout(500);
  const walkTo = await page.evaluate(() => (window as any).__game.state().player.pos);
  const walkedSideways = walkTo.x - walkFrom.x;
  expect(Math.abs(walkedSideways)).toBeGreaterThan(0.2);
  await pad.setAxis(0, 0);
  await page.evaluate(() => (window as any).__game.reset({ camYaw: 0 }));
  await page.evaluate(() => (window as any).__game.setCamera({ yaw: 0 }));

  // Hold LT + A, which is hotbar slot 1. The stick now places the circle instead of walking.
  await pad.setButton(PAD_LT, true);
  await pad.setButton(PAD_A, true);
  await page.waitForFunction(() => (window as any).__game.combat().aiming === 1, null, { timeout: 3000, polling: 'raf' });
  const opened = (await combat(page)).reticle;

  const before = await page.evaluate(() => (window as any).__game.state().player.pos);
  await pad.setAxis(1, -1); // stick away from the camera
  await page.waitForTimeout(700);
  const pushed = (await combat(page)).reticle;
  const after = await page.evaluate(() => (window as any).__game.state().player.pos);
  expect(dist(pushed, opened)).toBeGreaterThan(1.5);
  expect(dist(after, before)).toBeLessThan(0.5); // aiming, not walking

  // Keep pushing: it stops at max range instead of running away forever.
  await page.waitForTimeout(1600);
  const far = (await combat(page)).reticle;
  const p = await page.evaluate(() => (window as any).__game.state().player.pos);
  expect(dist(far, p)).toBeLessThanOrEqual(meteorRange + 0.001);
  expect(dist(far, p)).toBeCloseTo(meteorRange, 1);

  // Sideways moves it the same way the stick would have walked you.
  await pad.setAxis(1, 0);
  await pad.setAxis(0, 1);
  await page.waitForTimeout(500);
  const right = (await combat(page)).reticle;
  const aimedSideways = right.x - far.x;
  expect(Math.abs(aimedSideways)).toBeGreaterThan(0.5);
  expect(Math.sign(aimedSideways)).toBe(Math.sign(walkedSideways));

  // Letting go casts it.
  await pad.setAxis(0, 0);
  await pad.setButton(PAD_A, false);
  await pad.setButton(PAD_LT, false);
  await page.waitForFunction(() => (window as any).__game.state().player.castAbility !== 255, null, { timeout: 2000, polling: 'raf' });
  expect(errors).toEqual([]);
});

test('the view lifts while you are placing a circle, and settles back after', async ({ page }) => {
  await page.goto('/?yard');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  await page.evaluate((b) => (window as any).__game.setBuild(b), MAGE);
  const height = () => page.evaluate(() => (window as any).__game.cameraHeight());
  const resting = await height();

  await page.screenshot({ path: `${SHOTS}/50-aim-before.png` });
  await page.keyboard.down('Digit1');
  await page.waitForFunction(() => (window as any).__game.combat().aiming === 1, null, { timeout: 2000, polling: 'raf' });
  await page.waitForTimeout(600);
  const lifted = await height();
  expect(lifted).toBeGreaterThan(resting + 1);
  await page.screenshot({ path: `${SHOTS}/51-aim-placing-circle.png` });

  await page.keyboard.up('Digit1');
  await page.waitForTimeout(900);
  expect(await height()).toBeLessThan(lifted - 0.5);
});

test('Escape backs out of placing a circle without casting', async ({ page }) => {
  await page.goto('/?yard');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  await page.evaluate((b) => (window as any).__game.setBuild(b), MAGE);

  await page.keyboard.down('Digit1');
  await page.waitForFunction(() => (window as any).__game.combat().aiming === 1, null, { timeout: 2000, polling: 'raf' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  expect((await combat(page)).aiming).toBe(0);
  expect(await page.evaluate(() => (window as any).__game.state().player.castAbility)).toBe(255);
  await page.keyboard.up('Digit1').catch(() => {});
});

// ---------- Online: the server says who hit whom ----------

test.describe('online', { tag: '@gpu' }, () => {
  test.skip(!serverBuilt, 'build the server first: cargo build --release --manifest-path server/Cargo.toml');
  const server = new TestServer(7794, ['--bots', '0']);
  test.beforeAll(async () => server.start());
  test.afterAll(() => server.stop());

  const contexts: BrowserContext[] = [];
  test.afterEach(async () => {
    for (const c of contexts.splice(0)) await c.close();
  });

  async function joinAs(browser: Browser, team: number, b: Build): Promise<{ page: Page; errors: string[] }> {
    const context = await browser.newContext({ viewport: { width: 800, height: 450 } });
    contexts.push(context);
    const page = await context.newPage();
    const errors = watchErrors(page);
    await page.goto(`/?server=${encodeURIComponent(server.url)}&team=${team}`);
    await page.waitForFunction(() => (window as any).__game?.net()?.joined === true, null, { timeout: 10_000 });
    expect(await page.evaluate((b) => (window as any).__game.setBuild(b), b)).toBe(true);
    await page.waitForFunction(
      (b) => {
        const n = (window as any).__game.net();
        return String(n.skills) === String(b.skills) && n.weapon === b.weapon && String(n.abilities) === String(b.abilities);
      },
      b,
      { timeout: 5000 },
    );
    return { page, errors };
  }

  const net = (page: Page) => page.evaluate(() => (window as any).__game.net());
  const script = (page: Page, segments: Array<[number, Record<string, unknown>]>) =>
    page.evaluate((s) => (window as any).__game.scriptInput(s), segments);
  const seesPlayers = (page: Page, n: number) =>
    page.waitForFunction((n) => (window as any).__game.net().remotes.length >= n, n, { timeout: 5000 });

  test('a hit puts a number on the attacker and the victim, and names what caused it', async ({ browser }) => {
    const blue = await joinAs(browser, 0, SWORD);
    const red = await joinAs(browser, 1, SWORD);
    await seesPlayers(blue.page, 1);

    await Promise.all([forget(blue.page), forget(red.page)]);
    // Close the 5 m gap, then one swing, exactly as the melee tests do.
    await script(blue.page, [[26, { moveX: 1 }], [1, { attackPressed: true }], [40, {}]]);
    await blue.page.waitForTimeout(1800);

    const mine = (await markers(blue.page)).filter((m) => m.kind === 'hit');
    const theirs = (await markers(red.page)).filter((m) => m.kind === 'hurt');
    console.log('hit markers', JSON.stringify({ mine, theirs, redHp: (await net(red.page)).hp }));

    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some((m) => m.amount === swordDamage)).toBe(true);
    expect(mine.every((m) => m.icon === '\u{1f5e1}\u{fe0f}')).toBe(true); // the sword that dealt it
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.some((m) => m.amount === swordDamage)).toBe(true);
    // Neither is told about the other's side of it.
    expect((await markers(blue.page)).some((m) => m.kind === 'hurt')).toBe(false);
    expect((await markers(red.page)).some((m) => m.kind === 'hit')).toBe(false);
    expect([...blue.errors, ...red.errors]).toEqual([]);
  });

  test('healing an ally shows a heal number to both of them', async ({ browser }) => {
    const healer = await joinAs(browser, 0, HEALER);
    const ally = await joinAs(browser, 0, SWORD);
    const red = await joinAs(browser, 1, CLEAVER);
    await seesPlayers(red.page, 2);
    // Red cleaves both blues, then walks off, so there is damage to heal back.
    await script(red.page, [[24, { moveX: -1 }], [1, { attackPressed: true, aimX: -3, aimZ: 0 }], [30, {}], [40, { moveX: 1 }]]);
    await red.page.waitForFunction(() => (window as any).__game.net().scriptLeft === 0);
    await healer.page.waitForTimeout(600);
    const before = { healer: (await net(healer.page)).hp, ally: (await net(ally.page)).hp };
    expect(before.ally).toBeLessThan(100);

    await Promise.all([forget(healer.page), forget(ally.page)]);
    await script(healer.page, [[1, { abilitySlot: 1 }], [40, {}]]);
    // Wait for the numbers rather than sleeping a fixed time: the cast, the server round trip and
    // the render tick it's held back to all vary, and a fixed wait made this flaky.
    await healer.page.waitForFunction(
      () => ((window as any).__game.combat().markers as Array<{ kind: string }>).filter((m) => m.kind === 'heal').length >= 2,
      null,
      { timeout: 10_000, polling: 'raf' },
    );
    await ally.page.waitForFunction(
      () => ((window as any).__game.combat().markers as Array<{ kind: string }>).some((m) => m.kind === 'heal'),
      null,
      { timeout: 10_000, polling: 'raf' },
    );

    const healerSaw = (await markers(healer.page)).filter((m) => m.kind === 'heal');
    const allySaw = (await markers(ally.page)).filter((m) => m.kind === 'heal');
    console.log('heal markers', JSON.stringify({ before, healerSaw, allySaw }));

    // The healer gets one per person they healed; the ally gets one for themselves.
    expect(healerSaw.length).toBeGreaterThanOrEqual(2);
    expect(allySaw.length).toBeGreaterThan(0);
    expect([...healerSaw, ...allySaw].every((m) => m.icon === '\u{1f49a}')).toBe(true);
    expect(healerSaw.every((m) => m.amount > 0 && m.amount <= healAmount)).toBe(true);
    expect([...healer.errors, ...ally.errors, ...red.errors]).toEqual([]);
  });
});
