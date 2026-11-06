import { expect, test } from '@playwright/test';
import { ADJACENT, emptySkills, skillCount, skillIndex, SKILL_POINTS, skillsFrom, soundTree, withSkill } from '../../src/content/skills';
import { ABILITIES, emptyMovement, HOTBAR_SLOTS, NO_ABILITY, type Build, WEAPONS } from '../../src/content/tuning';
import { battlefield, net, script, scriptDone, seesPlayers, sometime, useBuild } from '../support/battlefield';

// Players fighting players on the battlefield (content/dungeons/battlefield.json), the developer
// zone for it: two admins on opposite sides, the server deciding every blow, lag compensation for a
// far player, the builds it takes, what each side sees of spells, arrows and swings, and its bots
// turning on a player. These were the old battle server's tests (pvp, combat's and skills' online
// ones); the battlefield is a place in the world now, and these play it there. The spec runs a world
// server of its own (tests/support/battlefield.ts).

// Ports 7900 and up, one a worker.
const { fighter } = battlefield(7900);
const SHOTS = 'screenshots';

const HEAL = 0;
const METEOR = 1;
// Abilities land in hotbar slots 1 and 2; the rest of the bar stays empty.
const build = (ids: string[], weapon: number, ability1 = NO_ABILITY, ability2 = NO_ABILITY): Build => {
  const abilities = new Array<number>(HOTBAR_SLOTS).fill(NO_ABILITY);
  abilities[0] = ability1;
  abilities[1] = ability2;
  return { skills: skillsFrom(...ids), weapon, abilities, movement: emptyMovement() };
};
/** A sound set of `n` skills, grown outward from Sword Training along the tree's links. */
const grown = (n: number) => {
  const order = [skillIndex('sword')];
  for (let q = 0; q < order.length && order.length < n; q++) for (const m of ADJACENT[order[q]]) if (order.length < n && !order.includes(m)) order.push(m);
  return order.reduce((s, i) => withSkill(s, i, true), emptySkills());
};

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

interface Marker {
  kind: string;
  amount: number;
  icon: string;
}
const markers = (page: import('@playwright/test').Page): Promise<Marker[]> => page.evaluate(() => window.__game.combat().markers as Marker[]);
const forget = (page: import('@playwright/test').Page) => page.evaluate(() => window.__game.clearMarkers());

test('two players: blue attacks red, the server lands the hits, both screens agree', { tag: '@gpu' }, async ({ browser }) => {
  const viewport = { width: 960, height: 540 };
  const blue = await fighter(browser, 0, undefined, { viewport });
  const red = await fighter(browser, 1, undefined, { viewport });
  await seesPlayers(blue.page, 1);
  await seesPlayers(red.page, 1);
  // Point each camera at the other player.
  await blue.page.evaluate(() => window.__game.setCamera({ yaw: Math.PI / 2 - 0.6, distance: 6.5 }));
  await red.page.evaluate(() => window.__game.setCamera({ yaw: -Math.PI / 2 + 0.6, distance: 6.5 }));

  // Blue runs at red and throws the three-hit combo.
  await script(blue.page, [
    [24, { moveX: 1 }],
    [1, { attackPressed: true }],
    [7, {}],
    [1, { attackPressed: true }],
    [10, {}],
    [1, { attackPressed: true }],
    [9, {}],
  ]);
  await scriptDone(blue.page);
  await blue.page.screenshot({ path: `${SHOTS}/30-pvp-blue-view.png` });
  await red.page.screenshot({ path: `${SHOTS}/31-pvp-red-view.png` });
  // Both screens settle on what the server decided.
  await red.page.waitForFunction(() => window.__game.net().hp < 100, null, { timeout: 5000 });
  await expect
    .poll(async () => {
      const [b, r] = [await net(blue.page), await net(red.page)];
      return b.remotes[0]?.hp === r.hp && Math.hypot(r.x - b.remotes[0].x, r.z - b.remotes[0].z) < 0.3;
    })
    .toBe(true);
  const blueNow = await net(blue.page);
  console.log('pvp', JSON.stringify({ redHp: (await net(red.page)).hp, blue: { corrections: blueNow.corrections, maxCorrection: blueNow.maxCorrection } }));
  expect(blueNow.maxCorrection).toBeLessThan(0.01); // blue's own prediction matched the server
  expect([...blue.errors, ...red.errors]).toEqual([]);
});

test('at 300 ms ping your own moves still respond instantly and agree with the server', async ({ browser }) => {
  const blue = await fighter(browser, 0, undefined, { lag: 150 });
  const before = await net(blue.page);

  // One frame of input: you move on your own screen straight away...
  await script(blue.page, [[1, { moveZ: -1 }]]);
  await scriptDone(blue.page);
  const right = await net(blue.page);
  expect(right.z).toBeLessThan(before.z);
  // ...while the server is still about 300 ms (around 18 inputs) behind.
  expect(right.pending).toBeGreaterThan(8);

  // A busier sequence: run, jump, double jump turning mid-air, slide, combo.
  await script(blue.page, [
    [30, { moveZ: -1 }],
    [1, { moveZ: -1, jumpPressed: true, jumpHeld: true }],
    [15, { moveZ: -1, jumpHeld: true }],
    [1, { moveX: 1, jumpPressed: true, jumpHeld: true }],
    [40, { moveX: 1, jumpHeld: true }],
    [1, { moveX: 1, slidePressed: true }],
    [30, { moveX: -1 }],
    [1, { attackPressed: true }],
    [7, {}],
    [1, { attackPressed: true }],
    [40, {}],
  ]);
  await scriptDone(blue.page);
  // The server catches up with every input of it.
  const last = (await net(blue.page)).seq;
  await blue.page.waitForFunction((s) => window.__game.net().ack >= s, last, { timeout: 5000 });
  const after = await net(blue.page);
  console.log('lag', JSON.stringify({ pendingRightAway: right.pending, corrections: after.corrections, maxCorrection: after.maxCorrection }));
  expect(after.maxCorrection).toBeLessThan(0.05);
  expect(blue.errors).toEqual([]);
});

test('lag compensation: at 300 ms ping, hits on your screen count on the server', { tag: '@gpu' }, async ({ browser }) => {
  const blue = await fighter(browser, 0, undefined, { lag: 150 });
  const red = await fighter(browser, 1);
  await seesPlayers(blue.page, 1);
  // The fight's numbers once the bots have gone (they fight each other while they're here).
  await blue.page.waitForFunction(() => window.__game.net().world?.bots === 0, null, { timeout: 5000 });
  const before = (await net(blue.page)).world!;

  // Red steps in close, then strafes left and right at full speed in front of blue.
  const strafe: Array<[number, Record<string, unknown>]> = [
    [30, { moveX: -1 }],
    [10, {}],
  ];
  for (let i = 0; i < 4; i++) strafe.push([40, { moveZ: 1 }], [40, { moveZ: -1 }]);
  await script(red.page, strafe);
  // Blue swings whenever red is within reach on blue's (300 ms delayed) screen.
  await blue.page.evaluate(() => window.__game.autoAttack(true));
  await scriptDone(red.page);
  await blue.page.evaluate(() => window.__game.autoAttack(false));
  // The stats come once a second: wait for a newer one.
  await blue.page.waitForFunction((t) => (window.__game.net().world?.tick ?? 0) > t + 20, before.tick, { timeout: 5000 });
  const after = (await net(blue.page)).world!;
  const result = {
    hits: after.pvpHits - before.pvpHits,
    savedByRewind: after.savedByRewind - before.savedByRewind,
    rewindMs: Math.round(after.rewindMs),
    redHp: (await net(red.page)).hp,
  };
  console.log('rewind', JSON.stringify(result));
  // The server checked the hits against where blue saw red: about 150 ms of lag, 100 ms of drawing
  // delay and the input's own. How many of them only landed because of it depends on where each blow
  // knocked red, so it's logged (savedByRewind) rather than held to a number; the server's test
  // a_swing_lands_where_its_swinger_saw_the_other_player shows a rewound swing landing where one
  // seeing the present misses.
  expect(result.hits).toBeGreaterThan(0);
  expect(result.rewindMs).toBeGreaterThan(200);
  expect(result.rewindMs).toBeLessThan(600);
  expect([...blue.errors, ...red.errors]).toEqual([]);
});

test('bots fight real players: run into the enemy army and they turn on you', { tag: '@gpu' }, async ({ browser }) => {
  // Where the battlefield lets you in, south of the blue army: placed anywhere, its bots would be on red before the test began.
  const red = await fighter(browser, 1, undefined, { viewport: { width: 960, height: 540 }, place: false, bots: true });
  await red.page.waitForFunction(() => window.__game.bots().length >= 30, null, { timeout: 10_000 });
  await red.page.evaluate(() => {
    const g = window.__game;
    g.setCamera({ yaw: 0, distance: 9, pitch: 0.45 });
    g.autoAttack(true);
  });
  const hpOf = () => red.page.evaluate(() => window.__game.bots().reduce((sum, b) => sum + (b.team === 0 ? b.hp : 0), 0));
  const blueArmy = await hpOf();
  // Run north into the blue army's rear, then stand and fight.
  await script(red.page, [[360, { moveZ: 1 }]]);
  await scriptDone(red.page);
  await red.page.waitForFunction(() => window.__game.net().hp < 100, null, { timeout: 15_000 });
  await red.page.screenshot({ path: `${SHOTS}/32-bots-vs-player.png` });
  await expect.poll(hpOf, { timeout: 15_000 }).toBeLessThan(blueArmy);
  await red.page.evaluate(() => window.__game.autoAttack(false));
  expect(red.errors).toEqual([]);
});

test('a hit puts a number on the attacker and the victim, and names what caused it', { tag: '@gpu' }, async ({ browser }) => {
  const blue = await fighter(browser, 0, SWORD);
  const red = await fighter(browser, 1, SWORD);
  await seesPlayers(blue.page, 1);

  await Promise.all([forget(blue.page), forget(red.page)]);
  // Close the 5 m gap, then one swing.
  await script(blue.page, [
    [26, { moveX: 1 }],
    [1, { attackPressed: true }],
    [40, {}],
  ]);
  await scriptDone(blue.page);
  await red.page.waitForFunction(() => (window.__game.combat().markers as Array<{ kind: string }>).some((m) => m.kind === 'hurt'), null, {
    timeout: 10_000,
    polling: 'raf',
  });
  await blue.page.waitForFunction(() => (window.__game.combat().markers as Array<{ kind: string }>).some((m) => m.kind === 'hit'), null, {
    timeout: 10_000,
    polling: 'raf',
  });

  const mine = (await markers(blue.page)).filter((m) => m.kind === 'hit');
  const theirs = (await markers(red.page)).filter((m) => m.kind === 'hurt');
  console.log('hit markers', JSON.stringify({ mine, theirs, redHp: (await net(red.page)).hp }));
  expect(mine.some((m) => m.amount === swordDamage)).toBe(true);
  expect(mine.every((m) => m.icon === '\u{1f5e1}\u{fe0f}')).toBe(true); // the sword that dealt it
  expect(theirs.some((m) => m.amount === swordDamage)).toBe(true);
  // Neither is told about the other's side of it.
  expect((await markers(blue.page)).some((m) => m.kind === 'hurt')).toBe(false);
  expect((await markers(red.page)).some((m) => m.kind === 'hit')).toBe(false);
  expect([...blue.errors, ...red.errors]).toEqual([]);
});

test('healing an ally shows a heal number to both of them', { tag: '@gpu' }, async ({ browser }) => {
  const healer = await fighter(browser, 0, HEALER);
  const ally = await fighter(browser, 0, SWORD);
  const red = await fighter(browser, 1, CLEAVER);
  await seesPlayers(red.page, 2);
  // Red cleaves both blues, then walks off, so there is damage to heal back.
  await script(red.page, [
    [24, { moveX: -1 }],
    [1, { attackPressed: true, aimX: -3, aimZ: 0 }],
    [30, {}],
    [40, { moveX: 1 }],
  ]);
  await scriptDone(red.page);
  await ally.page.waitForFunction(() => window.__game.net().hp < 100, null, { timeout: 5000 });

  await Promise.all([forget(healer.page), forget(ally.page)]);
  await script(healer.page, [
    [1, { abilitySlot: 1 }],
    [40, {}],
  ]);
  await healer.page.waitForFunction(() => (window.__game.combat().markers as Array<{ kind: string }>).filter((m) => m.kind === 'heal').length >= 2, null, {
    timeout: 10_000,
    polling: 'raf',
  });
  await ally.page.waitForFunction(() => (window.__game.combat().markers as Array<{ kind: string }>).some((m) => m.kind === 'heal'), null, {
    timeout: 10_000,
    polling: 'raf',
  });
  const healed = (await markers(ally.page)).filter((m) => m.kind === 'heal');
  expect(healed.some((m) => m.amount > 0 && m.amount <= healAmount)).toBe(true);
  expect([...healer.errors, ...ally.errors, ...red.errors]).toEqual([]);
});

test('the server takes any sound build here, and turns down unsound ones', async ({ browser }) => {
  // More skills than a newcomer's island has earned: on the island that's refused (the server's
  // tests), but the battlefield is for trying builds, and takes any sound one.
  const big = grown(SKILL_POINTS + 2);
  expect([soundTree(big), skillCount(big)]).toEqual([true, SKILL_POINTS + 2]);
  const blue = await fighter(browser, 0, PIERCER);
  const invalid: Array<[string, Build]> = [
    ['skipping a skill', build(['sword', 'whirlwind'], 0)],
    ['a weapon you never trained', build(['sword'], 3)],
    ['an ability you never learned', build(['sword'], 0, METEOR)],
    ['the same ability twice', build(['staff', 'meteor'], 2, METEOR, METEOR)],
  ];
  for (const [why, b] of invalid) {
    await blue.page.evaluate((b) => window.__game.sendRawBuild(b), b);
    // The server answers each in turn: a sound build after it is taken, so this one was turned down.
    const ticks = await blue.page.evaluate(() => window.__game.online()!.ticks);
    await blue.page.waitForFunction((t) => window.__game.online()!.ticks > t + 6, ticks);
    const n = await net(blue.page);
    expect({ why, skills: String(n.skills), weapon: n.weapon }).toEqual({ why, skills: String(PIERCER.skills), weapon: PIERCER.weapon });
  }
  await useBuild(blue.page, { ...build(['sword'], 0), skills: big });
  await useBuild(blue.page, MAGE);
  expect(blue.errors).toEqual([]);
});

test('other players see your weapon', async ({ browser }) => {
  const blue = await fighter(browser, 0, MAGE);
  const red = await fighter(browser, 1, SWORD);
  await seesPlayers(red.page, 1);
  await red.page.waitForFunction(() => window.__game.net().remotes[0]?.weapon === 2);
  await useBuild(blue.page, ARCHER);
  await red.page.waitForFunction(() => window.__game.net().remotes[0]?.weapon === 3);
  expect([...blue.errors, ...red.errors]).toEqual([]);
});

// Blue shoots one arrow at two red players standing together.
for (const [name, archer, expectedHits] of [
  ['an arrow hits the first enemy in its path', ARCHER, 1],
  ['Piercing Arrows go through both enemies', PIERCER, 2],
] as const) {
  test(`arrows: ${name}`, { tag: '@gpu' }, async ({ browser }) => {
    const blue = await fighter(browser, 0, archer);
    const reds = [await fighter(browser, 1, SWORD), await fighter(browser, 1, SWORD)];
    await seesPlayers(blue.page, 2);
    await blue.page.evaluate(() => window.__game.setCamera({ yaw: Math.PI / 2 - 0.5, distance: 6 }));
    await script(blue.page, [
      [1, { attackPressed: true, aimX: 5, aimZ: 0 }],
      [40, {}],
    ]);
    // Your own arrow is drawn the moment it leaves the bow.
    const drawn = await sometime(blue.page, '(window.__game.spells().arrowsDrawn ?? 0) > 0', 2000);
    await blue.page.screenshot({ path: `${SHOTS}/41-arrow-${expectedHits}.png` });
    await scriptDone(blue.page);
    await expect
      .poll(async () => (await Promise.all(reds.map(async (r) => (await net(r.page)).hp))).filter((hp) => hp === 100 - arrowDamage).length, { timeout: 5000 })
      .toBe(expectedHits);
    const hps = await Promise.all(reds.map(async (r) => (await net(r.page)).hp));
    const left = await blue.page.evaluate(() => window.__game.spells().online);
    console.log('arrows', name, JSON.stringify({ drawn, hps, left }));
    expect(drawn).toBe(true);
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
    const blue = await fighter(browser, 0, sword);
    const reds = [await fighter(browser, 1, SWORD), await fighter(browser, 1, SWORD)];
    await seesPlayers(blue.page, 2);
    await script(blue.page, [
      [26, { moveX: 1 }],
      [1, { attackPressed: true }],
      [40, {}],
    ]);
    await scriptDone(blue.page);
    await expect
      .poll(async () => (await Promise.all(reds.map(async (r) => (await net(r.page)).hp))).filter((hp) => hp === 100 - swordDamage).length, { timeout: 5000 })
      .toBe(expectedHits);
    const hps = await Promise.all(reds.map(async (r) => (await net(r.page)).hp));
    console.log('melee', name, JSON.stringify({ hps, blueX: (await net(blue.page)).x }));
    expect(hps.filter((hp) => hp === 100).length).toBe(2 - expectedHits);
    expect([...blue.errors, ...reds.flatMap((r) => r.errors)]).toEqual([]);
  });
}

test('Meteor: both sides see the warning circle, then the blast lands', { tag: '@gpu' }, async ({ browser }) => {
  const blue = await fighter(browser, 0, MAGE);
  const red = await fighter(browser, 1, SWORD);
  await seesPlayers(red.page, 1);
  for (const p of [blue.page, red.page]) await p.evaluate(() => window.__game.setCamera({ distance: 11, pitch: 0.45 }));
  await blue.page.evaluate(() => window.__game.setCamera({ yaw: Math.PI / 2 }));
  await red.page.evaluate(() => window.__game.setCamera({ yaw: -Math.PI / 2 }));
  await script(blue.page, [
    [1, { abilitySlot: 1, aimX: 5, aimZ: 0 }],
    [150, {}],
  ]);
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
  await red.page.waitForFunction(() => window.__game.net().hp < 100, null, { timeout: 4000 });
  const after = { red: await net(red.page), blue: await net(blue.page) };
  console.log('meteor', JSON.stringify({ blueCircle, redCircle, blueMeteor, redMeteor, redHp: after.red.hp, blueCooldown: after.blue.cooldowns[0] }));
  expect([blueCircle, redCircle, blueMeteor, redMeteor]).toEqual([true, true, true, true]);
  expect(after.red.hp).toBe(100 - meteorDamage);
  expect(after.blue.cooldowns[0]).toBeGreaterThan(0);
  expect([...blue.errors, ...red.errors]).toEqual([]);
});

test('getting hit while casting interrupts the spell', { tag: '@gpu' }, async ({ browser }) => {
  const blue = await fighter(browser, 0, MAGE);
  const red = await fighter(browser, 1, SWORD);
  await seesPlayers(red.page, 1);
  // Blue starts a Meteor on red; red charges in and hits blue before the cast finishes.
  await script(blue.page, [
    [1, { abilitySlot: 1, aimX: 5, aimZ: 0 }],
    [120, {}],
  ]);
  await script(red.page, [
    [24, { moveX: -1 }],
    [1, { attackPressed: true, aimX: -3, aimZ: 0 }],
    [30, {}],
  ]);
  const interrupted = await sometime(blue.page, "document.querySelector('#castbar .label')?.textContent === 'Interrupted!'");
  await blue.page.screenshot({ path: `${SHOTS}/44-interrupted.png` });
  await scriptDone(blue.page);
  // Long enough for a meteor to have landed, had it been cast: the next stats after it.
  const t = await blue.page.evaluate(() => window.__game.online()!.ticks);
  await blue.page.waitForFunction((t) => window.__game.online()!.ticks > t + 40, t);
  const after = { blue: await net(blue.page), red: await net(red.page) };
  console.log('interrupt', JSON.stringify({ interrupted, blueHp: after.blue.hp, redHp: after.red.hp }));
  expect(interrupted).toBe(true);
  expect(after.blue.hp).toBeLessThan(100);
  expect(after.red.hp).toBe(100); // no meteor came down
  expect([...blue.errors, ...red.errors]).toEqual([]);
});

test('Healing Circle heals you and allies nearby', { tag: '@gpu' }, async ({ browser }) => {
  const healer = await fighter(browser, 0, HEALER);
  const ally = await fighter(browser, 0, SWORD);
  const red = await fighter(browser, 1, CLEAVER);
  await seesPlayers(red.page, 2);
  // Red cleaves both blues twice, then walks away.
  await script(red.page, [
    [24, { moveX: -1 }],
    [1, { attackPressed: true, aimX: -3, aimZ: 0 }],
    [10, {}],
    [1, { attackPressed: true }],
    [30, {}],
    [40, { moveX: 1 }],
  ]);
  await scriptDone(red.page);
  await ally.page.waitForFunction(() => window.__game.net().hp < 100, null, { timeout: 5000 });
  const before = { healer: (await net(healer.page)).hp, ally: (await net(ally.page)).hp };
  await script(healer.page, [
    [1, { abilitySlot: 1 }],
    [40, {}],
  ]);
  await expect.poll(async () => (await net(ally.page)).hp, { timeout: 5000 }).toBe(Math.min(100, before.ally + healAmount));
  const after = { healer: (await net(healer.page)).hp, ally: (await net(ally.page)).hp };
  console.log('heal', JSON.stringify({ before, after }));
  expect(after.healer).toBe(Math.min(100, before.healer + healAmount));
  expect([...healer.errors, ...ally.errors, ...red.errors]).toEqual([]);
});
