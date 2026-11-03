import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ABILITIES, NO_ABILITY, skillBit, WEAPONS, type Build } from '../src/tuning';
import { serverBuilt, TestServer } from './testServer';

// The classless skill system: the skill panel, every weapon and ability in the training yard, and
// the same things online, where the server decides what hits.

const SHOTS = 'screenshots';
const skills = (...ids: string[]) => ids.reduce((bits, id) => bits | (1 << skillBit(id)), 0);
const HEAL = 0;
const METEOR = 1;
const build = (ids: string[], weapon: number, ability1 = NO_ABILITY, ability2 = NO_ABILITY): Build => ({ perks: skills(...ids), weapon, ability1, ability2 });

const SWORD = build(['sword'], 0);
const CLEAVER = build(['sword', 'cleave'], 0);
const ARCHER = build(['bow'], 3);
const PIERCER = build(['bow', 'rapidFire', 'piercing'], 3);
const MAGE = build(['staff', 'meteor'], 2, METEOR);
const HEALER = build(['club', 'heal'], 1, HEAL);

const arrowDamage = WEAPONS[3].combo[0].damage;
const swordDamage = WEAPONS[0].combo[0].damage;
const meteorDamage = ABILITIES[METEOR].damage!;
const healAmount = ABILITIES[HEAL].amount!;

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

const game = (page: Page) => page.evaluate(() => (window as any).__game.build());

// ---------- The skill panel ----------

test('skill panel: learn and unlearn down the trees, equip, and the build is remembered', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  const panel = page.locator('#skills');
  const points = page.locator('#skills .points b');
  const note = page.locator('#skills footer');

  await page.keyboard.press('KeyT');
  await expect(panel).toBeVisible();
  await expect(points).toHaveText('5'); // everyone starts with Sword Training

  await page.click('[data-skill="cleave"]');
  await page.click('[data-skill="whirlwind"]');
  await expect(points).toHaveText('3');
  // Skills are learned top to bottom.
  await page.click('[data-skill="heal"]');
  await expect(note).toContainText('Club Training first');
  await page.click('[data-skill="club"]');
  await page.click('[data-skill="heal"]'); // goes straight into the empty ability slot
  await page.click('[data-weapon="1"]');
  await page.screenshot({ path: `${SHOTS}/40-skill-panel.png` });
  expect((await game(page)).using).toEqual(build(['sword', 'cleave', 'whirlwind', 'club', 'heal'], 1, HEAL));

  await page.click('[data-skill="swiftMending"]');
  await expect(points).toHaveText('0');
  await page.click('[data-skill="staff"]');
  await expect(note).toContainText('No skill points left');

  // Unlearning a skill drops the ones below it, and anything that needed them.
  await page.click('[data-skill="club"]');
  await expect(points).toHaveText('3');
  expect((await game(page)).using).toEqual(build(['sword', 'cleave', 'whirlwind'], 0));
  // You always keep a weapon.
  await page.click('[data-skill="sword"]');
  await expect(note).toContainText('Keep at least one weapon skill');

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await page.reload();
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  expect((await game(page)).using).toEqual(build(['sword', 'cleave', 'whirlwind'], 0));
  expect(errors).toEqual([]);
});

test('skill panel works with a controller: View opens it, D-pad and A choose, B closes', async ({ page }) => {
  await page.addInitScript(() => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
    const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons, timestamp: 0 };
    (window as any).__pad = pad;
    Object.defineProperty(navigator, 'getGamepads', { value: () => [pad, null, null, null], configurable: true });
  });
  const errors = watchErrors(page);
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  const tap = async (button: number) => {
    await page.evaluate((i) => Object.assign((window as any).__pad.buttons[i], { pressed: true, value: 1 }), button);
    await page.waitForTimeout(60);
    await page.evaluate((i) => Object.assign((window as any).__pad.buttons[i], { pressed: false, value: 0 }), button);
    await page.waitForTimeout(60);
  };
  const [A, B, VIEW, DOWN, RIGHT] = [0, 1, 8, 13, 15];

  await tap(VIEW);
  await expect(page.locator('#skills')).toBeVisible();
  await tap(RIGHT); // Club Training
  await tap(A);
  await tap(DOWN); // Healing Circle
  await tap(A);
  await tap(DOWN);
  await tap(DOWN); // loadout row: the club
  await tap(A);
  await expect(page.locator('#skills .focus')).toHaveAttribute('data-weapon', '1');
  await tap(B);
  await expect(page.locator('#skills')).toBeHidden();
  expect((await game(page)).using).toEqual(build(['sword', 'club', 'heal'], 1, HEAL));
  // Closing with B didn't make the fighter slide.
  expect(await page.evaluate(() => (window as any).__game.state().player.mode)).not.toBe('slide');
  expect(errors).toEqual([]);
});

// ---------- Training yard: every weapon and ability against the dummy ----------

test('training yard: arrows, Meteor, Healing Circle and Whirlwind against the dummy', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?test');
  await page.waitForFunction(() => (window as any).__game?.ready === true);

  const result = await page.evaluate(
    ({ builds }) => {
      const g = (window as any).__game;
      const d = g.state().dummy;
      const out: Record<string, unknown> = {};
      const standOff = (b: unknown, dist: number) => {
        g.setBuild(b);
        g.reset({ x: d.x, z: d.z - dist, facing: 0, camYaw: 0 });
      };

      // Bow from 12 m away: the arrow takes a moment to arrive.
      standOff(builds.archer, 12);
      g.advance(1, { attackPressed: true });
      let shotFrame = -1;
      let hitFrame = -1;
      for (let f = 1; f < 60 && hitFrame < 0; f++) {
        g.advance(1);
        if (shotFrame < 0 && g.spells().training.arrows > 0) shotFrame = f;
        if (g.state().dummy.hp < 100) hitFrame = f;
      }
      out.bow = { shotFrame, hitFrame, hp: g.state().dummy.hp };

      // Rapid Fire draws faster.
      standOff(builds.piercer, 12);
      g.advance(1, { attackPressed: true });
      let fastShot = -1;
      for (let f = 1; f < 20 && fastShot < 0; f++) {
        g.advance(1);
        if (g.spells().training.arrows > 0) fastShot = f;
      }
      out.rapidFire = fastShot;

      // Meteor at 9 m: cast, fall, blast.
      standOff(builds.mage, 9);
      g.advance(1, { ability1Pressed: true });
      g.advance(30);
      const casting = { mode: g.state().player.mode, circles: g.spells().circlesDrawn };
      g.advance(60);
      const falling = g.spells().training.meteors;
      g.advance(30);
      out.meteor = { casting, falling, hp: g.state().dummy.hp, cooldown: g.state().player.cooldown1, explosions: g.events().filter((e: any) => e.type === 'explosion').length };

      // Healing Circle.
      standOff(builds.healer, 6);
      g.advance(1, { ability1Pressed: true });
      g.advance(40);
      out.heal = g.events().filter((e: any) => e.type === 'heal').length;

      // Whirlwind finishes the sword combo with a spin.
      standOff(builds.whirl, 1.6);
      for (let f = 0; f < 80; f++) g.advance(1, { attackPressed: f === 0 || f === 6 || f === 18 });
      out.whirlwind = g.events().filter((e: any) => e.type === 'hit').map((e: any) => e.damage);
      return out;
    },
    {
      builds: {
        archer: ARCHER,
        piercer: PIERCER,
        mage: MAGE,
        healer: HEALER,
        whirl: build(['sword', 'cleave', 'whirlwind'], 0),
      },
    },
  );
  console.log('training', JSON.stringify(result));
  const bow = result.bow as { shotFrame: number; hitFrame: number; hp: number };
  expect(bow.shotFrame).toBe(WEAPONS[3].combo[0].startup + 1);
  expect(bow.hitFrame).toBeGreaterThan(bow.shotFrame + 10); // 12 m at 38 m/s
  expect(bow.hp).toBe(100 - arrowDamage);
  expect(result.rapidFire).toBe(WEAPONS[3].rapidFireStartup! + 1);
  const meteor = result.meteor as { casting: { mode: string; circles: number }; falling: number; hp: number; cooldown: number; explosions: number };
  expect(meteor.casting).toEqual({ mode: 'cast', circles: 1 });
  expect(meteor.falling).toBe(1);
  expect(meteor.explosions).toBe(1);
  expect(meteor.hp).toBe(100 - meteorDamage);
  expect(meteor.cooldown).toBeGreaterThan(0);
  expect(result.heal).toBe(1);
  expect(result.whirlwind).toEqual([WEAPONS[0].combo[0].damage, WEAPONS[0].combo[1].damage, WEAPONS[0].whirlwind!.damage]);
  expect(errors).toEqual([]);
});

// ---------- Online: the server decides ----------

test.describe('online', () => {
  test.skip(!serverBuilt, 'build the server first: cargo build --release --manifest-path server/Cargo.toml');
  const server = new TestServer(7791, ['--bots', '40']);
  test.beforeAll(async () => server.start());
  test.afterAll(() => server.stop());

  const contexts: BrowserContext[] = [];
  test.afterEach(async () => {
    for (const c of contexts.splice(0)) await c.close();
  });

  // Joins a team (blue spawns at x = -2.5, red at x = 2.5, both at z = -100) with a build.
  async function joinAs(browser: Browser, team: number, b: Build): Promise<{ page: Page; errors: string[] }> {
    const context = await browser.newContext({ viewport: { width: 800, height: 450 } });
    contexts.push(context);
    const page = await context.newPage();
    const errors = watchErrors(page);
    await page.goto(`/?server=${encodeURIComponent(server.url)}&team=${team}`);
    await page.waitForFunction(() => (window as any).__game?.net()?.joined === true, null, { timeout: 10_000 });
    await useBuild(page, b);
    return { page, errors };
  }

  async function useBuild(page: Page, b: Build): Promise<void> {
    expect(await page.evaluate((b) => (window as any).__game.setBuild(b), b)).toBe(true);
    await confirmed(page, b);
  }

  // Waits until the server's copy of this fighter uses build b.
  const confirmed = (page: Page, b: Build) =>
    page.waitForFunction(
      (b) => {
        const n = (window as any).__game.net();
        return n.perks === b.perks && n.weapon === b.weapon && n.ability1 === b.ability1 && n.ability2 === b.ability2;
      },
      b,
      { timeout: 5000 },
    );

  const net = (page: Page) => page.evaluate(() => (window as any).__game.net());
  const script = (page: Page, segments: Array<[number, Record<string, unknown>]>) => page.evaluate((s) => (window as any).__game.scriptInput(s), segments);
  const seesPlayers = (page: Page, n: number) => page.waitForFunction((n) => (window as any).__game.net().remotes.length >= n, n, { timeout: 5000 });
  // Polls something on the page every frame until it's true (or times out).
  const sometime = (page: Page, fn: string, timeout = 4000) =>
    page.waitForFunction(fn, null, { timeout, polling: 'raf' }).then(
      () => true,
      () => false,
    );

  test('the server takes valid builds and turns down invalid ones', async ({ browser }) => {
    const blue = await joinAs(browser, 0, PIERCER);
    const invalid: Array<[string, Build]> = [
      ['seven skills', build(['sword', 'cleave', 'whirlwind', 'club', 'heal', 'swiftMending', 'staff'], 0)],
      ['skipping a skill', build(['sword', 'whirlwind'], 0)],
      ['a weapon you never trained', build(['sword'], 3)],
      ['an ability you never learned', build(['sword'], 0, METEOR)],
      ['the same ability twice', build(['staff', 'meteor'], 2, METEOR, METEOR)],
    ];
    for (const [why, b] of invalid) {
      await blue.page.evaluate((b) => (window as any).__game.sendRawBuild(b), b);
      await blue.page.waitForTimeout(300);
      const n = await net(blue.page);
      expect({ why, perks: n.perks, weapon: n.weapon }).toEqual({ why, perks: PIERCER.perks, weapon: PIERCER.weapon });
    }
    await useBuild(blue.page, MAGE);
    expect(blue.errors).toEqual([]);
  });

  test('other players see your weapon', async ({ browser }) => {
    const blue = await joinAs(browser, 0, MAGE);
    const red = await joinAs(browser, 1, SWORD);
    await seesPlayers(red.page, 1);
    await red.page.waitForFunction(() => (window as any).__game.net().remotes[0]?.weapon === 2);
    await useBuild(blue.page, ARCHER);
    await red.page.waitForFunction(() => (window as any).__game.net().remotes[0]?.weapon === 3);
    expect([...blue.errors, ...red.errors]).toEqual([]);
  });

  // Blue shoots one arrow at two red players standing together.
  for (const [name, archer, expectedHits] of [
    ['an arrow hits the first enemy in its path', ARCHER, 1],
    ['Piercing Arrows go through both enemies', PIERCER, 2],
  ] as const) {
    test(`arrows: ${name}`, async ({ browser }) => {
      const blue = await joinAs(browser, 0, archer);
      const reds = [await joinAs(browser, 1, SWORD), await joinAs(browser, 1, SWORD)];
      await seesPlayers(blue.page, 2);
      await blue.page.evaluate(() => (window as any).__game.setCamera({ yaw: Math.PI / 2 - 0.5, distance: 6 }));
      await script(blue.page, [[1, { attackPressed: true, aimX: 5, aimZ: 0 }], [40, {}]]);
      // Your own arrow is drawn the moment it leaves the bow.
      const drawn = await sometime(blue.page, '(window.__game.spells().arrowsDrawn ?? 0) > 0', 2000);
      await blue.page.screenshot({ path: `${SHOTS}/41-arrow-${expectedHits}.png` });
      await blue.page.waitForTimeout(1200);
      const hps = await Promise.all(reds.map(async (r) => (await net(r.page)).hp));
      const left = await blue.page.evaluate(() => (window as any).__game.spells().online);
      console.log('arrows', name, JSON.stringify({ drawn, hps, left }));
      expect(drawn).toBe(true);
      expect(hps.filter((hp) => hp === 100 - arrowDamage).length).toBe(expectedHits);
      expect(hps.filter((hp) => hp === 100).length).toBe(2 - expectedHits);
      expect(left.localArrows).toBe(0); // the server's arrow took over from the one drawn straight away
      expect([...blue.errors, ...reds.flatMap((r) => r.errors)]).toEqual([]);
    });
  }

  // Blue runs at two red players standing together and swings once.
  for (const [name, sword, expectedHits] of [
    ['a sword swing hits one enemy', SWORD, 1],
    ['Cleave hits both enemies with one swing', CLEAVER, 2],
  ] as const) {
    test(`melee: ${name}`, async ({ browser }) => {
      const blue = await joinAs(browser, 0, sword);
      const reds = [await joinAs(browser, 1, SWORD), await joinAs(browser, 1, SWORD)];
      await seesPlayers(blue.page, 2);
      await script(blue.page, [[26, { moveX: 1 }], [1, { attackPressed: true }], [40, {}]]);
      await blue.page.waitForTimeout(1500);
      const hps = await Promise.all(reds.map(async (r) => (await net(r.page)).hp));
      console.log('melee', name, JSON.stringify({ hps, blueX: (await net(blue.page)).x }));
      expect(hps.filter((hp) => hp === 100 - swordDamage).length).toBe(expectedHits);
      expect(hps.filter((hp) => hp === 100).length).toBe(2 - expectedHits);
      expect([...blue.errors, ...reds.flatMap((r) => r.errors)]).toEqual([]);
    });
  }

  test('Meteor: both sides see the warning circle, then the blast lands', async ({ browser }) => {
    const blue = await joinAs(browser, 0, MAGE);
    const red = await joinAs(browser, 1, SWORD);
    await seesPlayers(red.page, 1);
    for (const p of [blue.page, red.page]) await p.evaluate(() => (window as any).__game.setCamera({ distance: 11, pitch: 0.45 }));
    await blue.page.evaluate(() => (window as any).__game.setCamera({ yaw: Math.PI / 2 }));
    await red.page.evaluate(() => (window as any).__game.setCamera({ yaw: -Math.PI / 2 }));
    await script(blue.page, [[1, { ability1Pressed: true, aimX: 5, aimZ: 0 }], [150, {}]]);
    const [blueCircle, redCircle] = await Promise.all([
      sometime(blue.page, 'window.__game.spells().circlesDrawn > 0'),
      sometime(red.page, 'window.__game.spells().circlesDrawn > 0'),
    ]);
    await red.page.screenshot({ path: `${SHOTS}/42-meteor-warning-enemy-view.png` });
    const [blueMeteor, redMeteor] = await Promise.all([
      sometime(blue.page, 'window.__game.spells().meteorsDrawn > 0'),
      sometime(red.page, 'window.__game.spells().meteorsDrawn > 0'),
    ]);
    await red.page.screenshot({ path: `${SHOTS}/43-meteor-falling-enemy-view.png` });
    await red.page.waitForFunction(() => (window as any).__game.net().hp < 100, null, { timeout: 4000 });
    const after = { red: await net(red.page), blue: await net(blue.page) };
    console.log('meteor', JSON.stringify({ blueCircle, redCircle, blueMeteor, redMeteor, redHp: after.red.hp, blueCooldown: after.blue.cooldown1 }));
    expect([blueCircle, redCircle, blueMeteor, redMeteor]).toEqual([true, true, true, true]);
    expect(after.red.hp).toBe(100 - meteorDamage);
    expect(after.blue.cooldown1).toBeGreaterThan(0);
    expect([...blue.errors, ...red.errors]).toEqual([]);
  });

  test('getting hit while casting interrupts the spell', async ({ browser }) => {
    const blue = await joinAs(browser, 0, MAGE);
    const red = await joinAs(browser, 1, SWORD);
    await seesPlayers(red.page, 1);
    // Blue starts a Meteor on red; red charges in and hits blue before the cast finishes.
    await script(blue.page, [[1, { ability1Pressed: true, aimX: 5, aimZ: 0 }], [120, {}]]);
    await script(red.page, [[24, { moveX: -1 }], [1, { attackPressed: true, aimX: -3, aimZ: 0 }], [30, {}]]);
    const interrupted = await sometime(blue.page, "document.querySelector('#castbar .label')?.textContent === 'Interrupted!'");
    await blue.page.screenshot({ path: `${SHOTS}/44-interrupted.png` });
    await blue.page.waitForTimeout(2500); // long enough for a meteor to have landed, had it been cast
    const after = { blue: await net(blue.page), red: await net(red.page) };
    console.log('interrupt', JSON.stringify({ interrupted, blueHp: after.blue.hp, redHp: after.red.hp }));
    expect(interrupted).toBe(true);
    expect(after.blue.hp).toBeLessThan(100);
    expect(after.red.hp).toBe(100); // no meteor came down
    expect([...blue.errors, ...red.errors]).toEqual([]);
  });

  test('Healing Circle heals you and allies nearby', async ({ browser }) => {
    const healer = await joinAs(browser, 0, HEALER);
    const ally = await joinAs(browser, 0, SWORD);
    const red = await joinAs(browser, 1, CLEAVER);
    await seesPlayers(red.page, 2);
    // Red cleaves both blues twice, then walks away.
    await script(red.page, [[24, { moveX: -1 }], [1, { attackPressed: true, aimX: -3, aimZ: 0 }], [10, {}], [1, { attackPressed: true }], [30, {}], [40, { moveX: 1 }]]);
    await red.page.waitForFunction(() => (window as any).__game.net().scriptLeft === 0);
    await healer.page.waitForTimeout(600);
    const before = { healer: (await net(healer.page)).hp, ally: (await net(ally.page)).hp };
    await script(healer.page, [[1, { ability1Pressed: true }], [40, {}]]);
    await healer.page.waitForTimeout(1200);
    const after = { healer: (await net(healer.page)).hp, ally: (await net(ally.page)).hp };
    console.log('heal', JSON.stringify({ before, after }));
    expect(before.ally).toBeLessThan(100);
    expect(after.ally).toBe(Math.min(100, before.ally + healAmount));
    expect(after.healer).toBe(Math.min(100, before.healer + healAmount));
    expect([...healer.errors, ...ally.errors, ...red.errors]).toEqual([]);
  });
});
