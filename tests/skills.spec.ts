import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ABILITIES, comboFor, emptyMovement, HOTBAR_SLOTS, NO_ABILITY, SLIDE_SKILL, type Build, WEAPONS } from '../src/tuning';
import { ADJACENT, emptySkills, LEVEL_XP, resolveSkills, SKILL_POINTS, skillCount, skillIndex, skillsFrom, soundTree, START_POINTS, withSkill } from '../src/skills';
import { serverBuilt, TestServer } from './testServer';

// The classless skill system: the skill panel, every weapon and ability in the training yard, and
// the same things online, where the server decides what hits.

const SHOTS = 'screenshots';
const skills = (...ids: string[]) => skillsFrom(...ids);
const HEAL = 0;
const METEOR = 1;
// Abilities land in hotbar slots 1 and 2; the rest of the bar stays empty.
const build = (ids: string[], weapon: number, ability1 = NO_ABILITY, ability2 = NO_ABILITY, ...move: number[]): Build => {
  const abilities = new Array<number>(HOTBAR_SLOTS).fill(NO_ABILITY);
  abilities[0] = ability1;
  abilities[1] = ability2;
  const movement = emptyMovement();
  move.forEach((m, i) => (movement[i] = m));
  return { skills: skills(...ids), weapon, abilities, movement };
};
/** A sound set of `n` skills, grown outward from Sword Training along the tree's links. */
const grown = (n: number) => {
  const order = [skillIndex('sword')];
  for (let q = 0; q < order.length && order.length < n; q++) for (const m of ADJACENT[order[q]]) if (order.length < n && !order.includes(m)) order.push(m);
  return order.reduce((s, i) => withSkill(s, i, true), emptySkills());
};
const DODGE = 0; // index into MOVEMENT_SKILLS
const NO_MOVEMENT_SLOT = 255;

const SWORD = build(['sword'], 0);
const CLEAVER = build(['sword', 'cleave'], 0);
const ARCHER = build(['bow'], 3);
const PIERCER = build(['bow', 'rapidFire', 'piercing'], 3);
const MAGE = build(['staff', 'meteor'], 2, METEOR);
const HEALER = build(['club', 'heal'], 1, HEAL);

const arrowDamage = WEAPONS[3].combo[0].damage;
const swordDamage = WEAPONS[0].combo[0].damage;
const meteorDamage = ABILITIES[METEOR].effects[0].damage!;
const healAmount = ABILITIES[HEAL].effects[0].amount!;

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

const game = (page: Page) => page.evaluate(() => (window as any).__game.build());

// ---------- The skill tree and the skill book ----------

const panelState = (page: Page) => page.evaluate(() => (window as any).__game.panel());

test('skill tree: plan the way to a skill, learn it, give it back, and the build is remembered', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?yard');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  const left = page.locator('#skills .st-chip b').first();
  const note = page.locator('#skills .st-note');
  const learn = page.locator('#skills [data-act="learn"]');
  const node = (id: string) => page.locator(`#skills [data-n="${skillIndex(id)}"]`);

  await page.keyboard.press('KeyN');
  await expect(page.locator('#skills .st')).toBeVisible();
  await expect(left).toHaveText(String(SKILL_POINTS - 1)); // everyone starts with Sword Training
  // Whirlwind is two steps out: one click plans the way there, Learn spends the points.
  await node('whirlwind').click();
  expect((await panelState(page)).plan).toEqual(['cleave', 'whirlwind']);
  await learn.click();
  await expect(left).toHaveText(String(SKILL_POINTS - 3));
  // Healing Circle hangs off Club Training: planning it plans both, and it goes straight onto the bar.
  await node('heal').click();
  await learn.click();
  await expect(left).toHaveText(String(SKILL_POINTS - 5));
  await page.screenshot({ path: `${SHOTS}/40-skill-tree.png` });
  expect((await game(page)).using).toEqual(build(['sword', 'cleave', 'whirlwind', 'club', 'heal'], 0, HEAL));
  // Clicking a planned node takes it back out of the plan.
  await node('swiftMending').click();
  expect((await panelState(page)).plan).toEqual(['swiftMending']);
  await node('swiftMending').click();
  expect((await panelState(page)).plan).toEqual([]);

  // Giving Club Training back takes Healing Circle with it, and you always keep a weapon.
  await node('club').click({ button: 'right' });
  await expect(left).toHaveText(String(SKILL_POINTS - 3));
  expect((await game(page)).using).toEqual(build(['sword', 'cleave', 'whirlwind'], 0));
  await node('sword').click({ button: 'right' });
  await expect(note).toContainText('Keep at least one weapon skill');

  // Opened with N, Escape closes it; the build survives a reload.
  await page.keyboard.press('Escape');
  await expect(page.locator('#skills')).toBeHidden();
  await page.reload();
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  expect((await game(page)).using).toEqual(build(['sword', 'cleave', 'whirlwind'], 0));
  expect(errors).toEqual([]);
});

test('skill book: every skill with its level, equip a weapon, put an ability on the bar', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?yard');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  await page.evaluate((b) => (window as any).__game.setBuild(b), build(['sword', 'club', 'heal', 'dodgeRoll'], 0));
  await page.keyboard.press('KeyT');
  const book = page.locator('#skills .sb');
  await expect(book).toBeVisible();
  // Everything you can use is in it; what you haven't learned is locked.
  await expect(page.locator('#skills .sk')).toHaveCount(10);
  await expect(page.locator('#skills .sk.locked')).toHaveCount(5); // staff, bow, meteor, backstep, block
  await expect(page.locator('#skills .sk .lv')).toHaveCount(5); // sword, club, heal, dodge roll, slide

  // A weapon: equip it from its page.
  await page.locator('#skills .sk', { hasText: 'Club' }).click();
  await expect(page.locator('#skills .sd-name')).toHaveText('Club');
  await page.click('#skills [data-act="equip"]');
  expect((await game(page)).using.weapon).toBe(1);
  // An ability: onto the bar, then dragged to another slot.
  await page.locator('#skills .sk', { hasText: 'Healing Circle' }).click();
  await expect(page.locator('#skills .sd-stats')).toContainText('Heals');
  await page.click('#skills [data-act="slot"]');
  expect((await game(page)).using.abilities[0]).toBe(HEAL);
  await page.dragAndDrop('#skills [data-slot="0"]', '#skills [data-slot="3"]');
  expect((await game(page)).using.abilities.slice(0, 4)).toEqual([NO_ABILITY, NO_ABILITY, NO_ABILITY, HEAL]);
  // A movement skill: bound to E.
  await page.locator('#skills .sk', { hasText: 'Dodge Roll' }).click();
  await page.click('#skills [data-act="bind1"]');
  expect((await game(page)).using.movement).toEqual([NO_MOVEMENT_SLOT, DODGE]);
  // A locked skill sends you to the tree, focused on it.
  await page.locator('#skills .sk', { hasText: 'Meteor' }).click();
  await page.click('#skills [data-act="find"]');
  await expect(page.locator('#skills .st')).toBeVisible();
  expect((await panelState(page)).focus).toBe('meteor');
  await page.screenshot({ path: `${SHOTS}/41-skill-book-to-tree.png` });
  // Back to the book from the tree, then shut it.
  await page.click('#skills [data-act="book"]');
  await expect(book).toBeVisible();
  await page.keyboard.press('KeyT');
  await expect(page.locator('#skills')).toBeHidden();
  expect(errors).toEqual([]);
});

test('skill book and tree with a controller: View opens the book, A equips, a bumper turns to the tree, B backs out', async ({ page }) => {
  await page.addInitScript(() => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
    const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons, timestamp: 0 };
    (window as any).__pad = pad;
    Object.defineProperty(navigator, 'getGamepads', { value: () => [pad, null, null, null], configurable: true });
  });
  const errors = watchErrors(page);
  await page.goto('/?yard');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  await page.evaluate((b) => (window as any).__game.setBuild(b), build(['sword', 'club'], 0));
  // A press lasts at least 60 ms and two frames, so a slow frame (the first time a panel is drawn,
  // in a software-drawn browser) can't swallow it.
  const frames = (n: number) => page.evaluate((n) => new Promise<void>((done) => { const f = () => (--n <= 0 ? done() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
  const set = (i: number, on: boolean) => page.evaluate(([i, on]) => Object.assign((window as any).__pad.buttons[i as number], { pressed: on, value: on ? 1 : 0 }), [i, on] as const);
  const tap = async (button: number) => {
    await set(button, true);
    await page.waitForTimeout(60);
    await frames(2);
    await set(button, false);
    await page.waitForTimeout(60);
    await frames(2);
  };
  const [A, B, Y, RB, VIEW, RIGHT] = [0, 1, 3, 5, 8, 15];

  await tap(VIEW);
  await expect(page.locator('#skills .sb')).toBeVisible();
  // The cursor starts on the weapon in your hands; right is Club, and A equips it.
  await tap(RIGHT);
  expect((await panelState(page)).selected).toBe('club');
  await tap(A);
  expect((await game(page)).using.weapon).toBe(1);
  // A bumper turns to the tree. A plans the way to the focused node, Y learns it.
  await tap(RB);
  await expect(page.locator('#skills .st')).toBeVisible();
  await page.evaluate(() => (window as any).__game.panelFocus({ node: 'heal' }));
  await tap(A);
  expect((await panelState(page)).plan).toEqual(['heal']);
  await tap(Y);
  expect((await game(page)).using).toEqual(build(['sword', 'club', 'heal'], 1, HEAL));
  // B goes back to the book (the tree was opened from it), and B again closes it.
  await tap(B);
  await expect(page.locator('#skills .sb')).toBeVisible();
  await tap(B);
  await expect(page.locator('#skills')).toBeHidden();
  // Closing with B didn't make the fighter slide.
  expect(await page.evaluate(() => (window as any).__game.state().player.actionId)).not.toBe(SLIDE_SKILL);
  expect(errors).toEqual([]);
});

// ---------- The island: points from quests, levels from use ----------

test('island: the tree spends points earned from quests, and the sword levels up on slimes', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  await page.goto('/?world&test');
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 90_000 });
  await page.evaluate(() => (window as any).__game.reset());
  const skillsNow = () => page.evaluate(() => (window as any).__game.skills());
  const cmd = (c: Record<string, unknown>) => page.evaluate((x) => (window as any).__game.lifeCommand(x), c);
  const advance = (n: number, a: Record<string, unknown> = {}) => page.evaluate(([k, x]) => (window as any).__game.advance(k, x), [n, a] as const);

  // A new character has Sword Training and one point to spend.
  expect((await skillsNow()).budget).toBe(START_POINTS);
  expect(await page.evaluate(() => (window as any).__game.learnNode('cleave'))).toBe(true);
  expect((await skillsNow()).left).toBe(0);
  expect(await page.evaluate(() => (window as any).__game.learnNode('club'))).toBe(false);
  await expect(page.locator('#skills .st-note')).toContainText('needs 1 point');
  // A whole build is held to the same points: the server would turn this one down.
  expect(await page.evaluate((b) => (window as any).__game.setBuild(b), build(['sword', 'cleave', 'club'], 0))).toBe(false);
  // Finishing Landfall earns another.
  await page.evaluate(() => (window as any).__game.skillPanel(false));
  const hollis = (await page.evaluate(() => (window as any).__game.zone())).npcs.find((n: { id: string }) => n.id === 'hollis');
  await page.evaluate(([x, z, f]) => (window as any).__game.teleport(x, z, f), [hollis.x + Math.sin(hollis.facing) * 2.2, hollis.z + Math.cos(hollis.facing) * 2.2, hollis.facing + Math.PI] as const);
  await advance(2);
  await cmd({ t: 'interact' });
  await advance(2);
  await cmd({ t: 'complete', quest: 'landfall' });
  await advance(2);
  expect((await skillsNow()).budget).toBe(START_POINTS + 1);
  await page.evaluate(() => (window as any).__game.closeLifePanel());
  expect(await page.evaluate(() => (window as any).__game.learnNode('club'))).toBe(true);
  await page.evaluate(() => (window as any).__game.skillPanel(false));

  // On the meadow, every hit the sword lands trains it, until it reaches level 2.
  const meadow = (await page.evaluate(() => (window as any).__game.zone())).places.find((p: { id: string }) => p.id === 'meadow');
  await page.evaluate(([x, z]) => (window as any).__game.teleport(x, z, 0), [meadow.x, meadow.z] as const);
  await page.evaluate((b) => (window as any).__game.setBuild(b), build(['sword', 'cleave', 'club'], 0));
  await advance(30);
  for (let round = 0; round < 150 && ((await skillsNow()).xp.sword ?? 0) < LEVEL_XP[1]; round++) {
    await page.evaluate(() => {
      const g = (window as any).__game;
      const p = g.state().player.pos;
      const slimes = g.actors().filter((a: { alive: boolean; kind: string }) => a.alive && /slime/.test(a.kind));
      slimes.sort((a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
      const s = slimes[0];
      if (!s) return g.advance(30, {});
      if (Math.hypot(s.x - p.x, s.z - p.z) > 1.6) {
        const f = Math.atan2(s.x - p.x, s.z - p.z);
        g.teleport(s.x - Math.sin(f) * 1.2, s.z - Math.cos(f) * 1.2, f);
        g.advance(2, {});
      }
      g.advance(1, { attackPressed: true });
      g.advance(14, {});
    });
  }
  const after = await skillsNow();
  expect(after.levels.sword).toBe(2);
  expect(after.levels.club).toBe(1);
  await expect(page.locator('#lui-toasts')).toContainText('Sword reached level 2');
  // The book shows it, and the sword hits harder for it.
  await page.evaluate(() => (window as any).__game.selectBook('sword'));
  await expect(page.locator('#skills .sd-lv')).toHaveText(/Level 2/i);
  expect(errors).toEqual([]);
});

test('island: a kept build the island has not earned the points for falls back to Sword Training', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  // A build tried out in the training yard, kept in this browser.
  const tried = build(['sword', 'cleave', 'whirlwind', 'club'], 1);
  await page.goto('/?yard');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  expect(await page.evaluate((b) => (window as any).__game.setBuild(b), tried)).toBe(true);
  // A new island starts with START_POINTS, not enough for it, as the server would say on joining.
  await page.goto('/?world&test');
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 90_000 });
  const island = await page.evaluate(() => (window as any).__game.build());
  expect(island.chosen.skills).toEqual(skills('sword'));
  expect(island.using.weapon).toBe(0);
  expect((await page.evaluate(() => (window as any).__game.skills())).left).toBe(START_POINTS - 1);
  // The yard still has it.
  await page.goto('/?yard');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  expect((await game(page)).chosen.skills).toEqual(tried.skills);
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
      // What each skill learned since `from`.
      const xp = () => g.skills().xp as Record<string, number>;
      const learned = (from: Record<string, number>, ...ids: string[]) => Object.fromEntries(ids.map((id) => [id, (xp()[id] ?? 0) - (from[id] ?? 0)]));

      // Bow from 12 m away: the arrow takes a moment to arrive. The sword is out by the time it
      // lands, but the bow that loosed it is what learns from the hit.
      standOff(builds.archer, 12);
      const beforeShot = xp();
      g.advance(1, { attackPressed: true });
      let shotFrame = -1;
      let hitFrame = -1;
      for (let f = 1; f < 60 && hitFrame < 0; f++) {
        g.advance(1);
        if (shotFrame < 0 && g.spells().training.arrows > 0) {
          shotFrame = f;
          g.setBuild(builds.archerSword);
        }
        if (g.state().dummy.hp < 100) hitFrame = f;
      }
      out.bow = { shotFrame, hitFrame, hp: g.state().dummy.hp, learned: learned(beforeShot, 'bow', 'sword') };

      // Rapid Fire draws faster.
      standOff(builds.piercer, 12);
      g.advance(1, { attackPressed: true });
      let fastShot = -1;
      for (let f = 1; f < 20 && fastShot < 0; f++) {
        g.advance(1);
        if (g.spells().training.arrows > 0) fastShot = f;
      }
      out.rapidFire = fastShot;

      // Meteor at 9 m: cast, fall, blast. The cast trains Meteor; the blast trains no weapon.
      standOff(builds.mage, 9);
      const beforeCast = xp();
      g.advance(1, { abilitySlot: 1 });
      g.advance(30);
      const casting = { mode: g.state().player.mode, circles: g.spells().circlesDrawn };
      g.advance(60);
      const falling = g.spells().training.meteors;
      g.advance(30);
      out.meteor = {
        casting,
        falling,
        hp: g.state().dummy.hp,
        cooldown: g.state().player.cooldowns[0],
        explosions: g.events().filter((e: any) => e.type === 'explosion').length,
        learned: learned(beforeCast, 'meteor', 'staff'),
      };

      // Healing Circle.
      standOff(builds.healer, 6);
      g.advance(1, { abilitySlot: 1 });
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
        archerSword: build(['bow', 'sword'], 0),
        piercer: PIERCER,
        mage: MAGE,
        healer: HEALER,
        whirl: build(['sword', 'cleave', 'whirlwind'], 0),
      },
    },
  );
  console.log('training', JSON.stringify(result));
  const bow = result.bow as { shotFrame: number; hitFrame: number; hp: number; learned: Record<string, number> };
  expect(bow.shotFrame).toBe(WEAPONS[3].combo[0].startup + 1);
  expect(bow.hitFrame).toBeGreaterThan(bow.shotFrame + 10); // 12 m at 38 m/s
  expect(bow.hp).toBe(100 - arrowDamage);
  expect(bow.learned).toEqual({ bow: 1, sword: 0 });
  expect(result.rapidFire).toBe(comboFor(3, resolveSkills(skills('bow', 'rapidFire')))[0].startup + 1);
  const meteor = result.meteor as { casting: { mode: string; circles: number }; falling: number; hp: number; cooldown: number; explosions: number; learned: Record<string, number> };
  expect(meteor.casting).toEqual({ mode: 'cast', circles: 1 });
  expect(meteor.falling).toBe(1);
  expect(meteor.explosions).toBe(1);
  expect(meteor.hp).toBe(100 - meteorDamage);
  expect(meteor.cooldown).toBeGreaterThan(0);
  expect(meteor.learned).toEqual({ meteor: 1, staff: 0 });
  expect(result.heal).toBe(1);
  const spin = comboFor(0, resolveSkills(skills('sword', 'cleave', 'whirlwind')));
  expect(result.whirlwind).toEqual([spin[0].damage, spin[1].damage, spin[2].damage]);
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
        return String(n.skills) === String(b.skills) && n.weapon === b.weapon && String(n.abilities) === String(b.abilities);
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
    // Sound, so only its size is wrong.
    const tooMany = grown(SKILL_POINTS + 1);
    expect([soundTree(tooMany), skillCount(tooMany)]).toEqual([true, SKILL_POINTS + 1]);
    const blue = await joinAs(browser, 0, PIERCER);
    const invalid: Array<[string, Build]> = [
      // One more skill than the budget allows, whatever the budget currently is.
      ['more skills than points', { ...build(['sword'], 0), skills: tooMany }],
      ['skipping a skill', build(['sword', 'whirlwind'], 0)],
      ['a weapon you never trained', build(['sword'], 3)],
      ['an ability you never learned', build(['sword'], 0, METEOR)],
      ['the same ability twice', build(['staff', 'meteor'], 2, METEOR, METEOR)],
    ];
    for (const [why, b] of invalid) {
      await blue.page.evaluate((b) => (window as any).__game.sendRawBuild(b), b);
      await blue.page.waitForTimeout(300);
      const n = await net(blue.page);
      expect({ why, skills: String(n.skills), weapon: n.weapon }).toEqual({ why, skills: String(PIERCER.skills), weapon: PIERCER.weapon });
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
    test(`arrows: ${name}`, { tag: '@gpu' }, async ({ browser }) => {
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
    test(`melee: ${name}`, { tag: '@gpu' }, async ({ browser }) => {
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

  test('Meteor: both sides see the warning circle, then the blast lands', { tag: '@gpu' }, async ({ browser }) => {
    const blue = await joinAs(browser, 0, MAGE);
    const red = await joinAs(browser, 1, SWORD);
    await seesPlayers(red.page, 1);
    for (const p of [blue.page, red.page]) await p.evaluate(() => (window as any).__game.setCamera({ distance: 11, pitch: 0.45 }));
    await blue.page.evaluate(() => (window as any).__game.setCamera({ yaw: Math.PI / 2 }));
    await red.page.evaluate(() => (window as any).__game.setCamera({ yaw: -Math.PI / 2 }));
    await script(blue.page, [[1, { abilitySlot: 1, aimX: 5, aimZ: 0 }], [150, {}]]);
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
    console.log('meteor', JSON.stringify({ blueCircle, redCircle, blueMeteor, redMeteor, redHp: after.red.hp, blueCooldown: after.blue.cooldowns[0] }));
    expect([blueCircle, redCircle, blueMeteor, redMeteor]).toEqual([true, true, true, true]);
    expect(after.red.hp).toBe(100 - meteorDamage);
    expect(after.blue.cooldowns[0]).toBeGreaterThan(0);
    expect([...blue.errors, ...red.errors]).toEqual([]);
  });

  test('getting hit while casting interrupts the spell', { tag: '@gpu' }, async ({ browser }) => {
    const blue = await joinAs(browser, 0, MAGE);
    const red = await joinAs(browser, 1, SWORD);
    await seesPlayers(red.page, 1);
    // Blue starts a Meteor on red; red charges in and hits blue before the cast finishes.
    await script(blue.page, [[1, { abilitySlot: 1, aimX: 5, aimZ: 0 }], [120, {}]]);
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

  test('Healing Circle heals you and allies nearby', { tag: '@gpu' }, async ({ browser }) => {
    const healer = await joinAs(browser, 0, HEALER);
    const ally = await joinAs(browser, 0, SWORD);
    const red = await joinAs(browser, 1, CLEAVER);
    await seesPlayers(red.page, 2);
    // Red cleaves both blues twice, then walks away.
    await script(red.page, [[24, { moveX: -1 }], [1, { attackPressed: true, aimX: -3, aimZ: 0 }], [10, {}], [1, { attackPressed: true }], [30, {}], [40, { moveX: 1 }]]);
    await red.page.waitForFunction(() => (window as any).__game.net().scriptLeft === 0);
    await healer.page.waitForTimeout(600);
    const before = { healer: (await net(healer.page)).hp, ally: (await net(ally.page)).hp };
    await script(healer.page, [[1, { abilitySlot: 1 }], [40, {}]]);
    await healer.page.waitForTimeout(1200);
    const after = { healer: (await net(healer.page)).hp, ally: (await net(ally.page)).hp };
    console.log('heal', JSON.stringify({ before, after }));
    expect(before.ally).toBeLessThan(100);
    expect(after.ally).toBe(Math.min(100, before.ally + healAmount));
    expect(after.healer).toBe(Math.min(100, before.healer + healAmount));
    expect([...healer.errors, ...ally.errors, ...red.errors]).toEqual([]);
  });
});
