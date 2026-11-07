import { expect } from 'vitest';
import { test, type Page } from '../../support/headless';
import { abilityIndex, emptyMovement, HOTBAR_SLOTS, NO_ABILITY, SLIME, WEAPONS, weaponIndex, type Build } from '../../../src/content/tuning';
import { skillsFrom } from '../../../src/content/skills';
import { gameReady } from '../../support/headless';

// Slimes in the training yard: the first creature built out of species data to make it into the
// game itself. They hop, they take hits from everything the player has, they die and come back.

const SHOTS = 'screenshots';
const METEOR = abilityIndex('meteor');
/** The skills, the weapon in hand and the ability in the first slot, each by id. */
const build = (ids: string[], weapon: string, ability = NO_ABILITY): Build => {
  const abilities = new Array<number>(HOTBAR_SLOTS).fill(NO_ABILITY);
  abilities[0] = ability;
  return { skills: skillsFrom(...ids), weapon: weaponIndex(weapon), abilities, movement: emptyMovement() };
};
const SWORD = build(['sword'], 'sword');
const ARCHER = build(['bow'], 'bow');
const MAGE = build(['staff', 'meteor'], 'staff', METEOR);
const swordReach = WEAPONS[weaponIndex('sword')].combo[0].reach;

interface Actor {
  id: number;
  kind: string;
  x: number;
  y: number;
  z: number;
  hp: number;
  alive: boolean;
  state: string;
  deadFrame: number;
  flash: number;
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

const open = async (page: Page, b?: Build) => {
  const errors = watchErrors(page);
  await page.goto('/?yard&test'); // paused: only the test steps the game
  await gameReady(page);
  if (b) await page.evaluate((v) => window.__game.setBuild(v), b);
  return errors;
};

const slimes = (page: Page) => page.evaluate(() => window.__game.actors('slime') as Actor[]);
const place = (page: Page, i: number, x: number, z: number) => page.evaluate(([a, b, c]) => window.__game.placeActor('slime', a, b, c), [i, x, z] as const);
const advance = (page: Page, frames: number, actions: Record<string, unknown> = {}) =>
  page.evaluate(([f, a]) => window.__game.advance(f, a), [frames, actions] as const);

test('there are slimes in the yard, and they hop', async ({ page }) => {
  const errors = await open(page);
  const first = await slimes(page);
  expect(first).toHaveLength(SLIME.count);
  expect(first.every((s) => s.hp === SLIME.hp)).toBe(true);

  // Over a couple of seconds every one of them should have moved.
  const before = first.map((s) => [s.x, s.z]);
  await advance(page, 180);
  const after = await slimes(page);
  const moved = after.filter((s, i) => Math.hypot(s.x - before[i][0], s.z - before[i][1]) > 0.2);
  expect(moved.length).toBe(SLIME.count);
  // And at some point one of them was off the ground.
  let airborne = false;
  for (let i = 0; i < 60 && !airborne; i++) {
    await advance(page, 3);
    airborne = (await slimes(page)).some((s) => s.state === 'move' && s.y > 0.2);
  }
  expect(airborne).toBe(true);
  expect(errors).toEqual([]);
});

test('a slime hops toward you when you are close enough to be interesting', async ({ page }) => {
  await open(page);
  const me = (await page.evaluate(() => window.__game.state())).player;
  // Just inside its aggro range, and far enough that it will want to close.
  await place(page, 0, me.pos.x, me.pos.z + SLIME.aggroRange - 1.5);
  const start = (await slimes(page))[0];
  await advance(page, 240);
  const now = (await slimes(page))[0];
  const was = Math.hypot(start.x - me.pos.x, start.z - me.pos.z);
  const is = Math.hypot(now.x - me.pos.x, now.z - me.pos.z);
  expect(is).toBeLessThan(was - 1);
  expect(is).toBeGreaterThan(SLIME.keepAway - 1); // but it does not climb into your lap
});

test('hitting a slime flashes it white', async ({ page }) => {
  await open(page, SWORD);
  const me = (await page.evaluate(() => window.__game.state())).player;
  await place(page, 0, me.pos.x, me.pos.z + swordReach * 0.6);
  expect((await slimes(page))[0].flash).toBeGreaterThan(10);
  await advance(page, 1, { attackPressed: true });
  await advance(page, 12);
  expect((await slimes(page))[0].flash).toBeLessThan(10);
});

test('an arrow hits the slime in its path', async ({ page }) => {
  await open(page, ARCHER);
  const me = (await page.evaluate(() => window.__game.state())).player;
  // In front of the player but short of the training dummy, which would otherwise stop the
  // arrow first - whatever stands earliest in the path is what gets hit.
  await place(page, 0, me.pos.x, me.pos.z + 2.2);
  // Park the rest well out of the way so only the one in front can be hit.
  for (let i = 1; i < SLIME.count; i++) await place(page, i, 40 + i, 40);
  await advance(page, 1, { attackPressed: true });
  await advance(page, 90);
  expect((await slimes(page))[0].hp).toBeLessThan(SLIME.hp);
});

test('a meteor catches every slime in the circle', async ({ page }) => {
  await open(page, MAGE);
  const me = (await page.evaluate(() => window.__game.state())).player;
  const tx = me.pos.x;
  const tz = me.pos.z + 6;
  for (let i = 0; i < 3; i++) await place(page, i, tx + (i - 1) * 0.6, tz);
  for (let i = 3; i < SLIME.count; i++) await place(page, i, 40 + i, 40);
  // Face the cluster and cast at it.
  await advance(page, 1, { abilitySlot: 1, aimX: tx - me.pos.x, aimZ: tz - me.pos.z });
  await advance(page, 240);
  const hurt = (await slimes(page)).slice(0, 3).filter((s) => s.hp < SLIME.hp || !s.alive);
  expect(hurt).toHaveLength(3);
});

test('looks right', async ({ page }) => {
  const errors = await open(page);
  const me = (await page.evaluate(() => window.__game.state())).player;
  // Line them up in front of the camera, one of them mid-hop.
  for (let i = 0; i < SLIME.count; i++) await place(page, i, me.pos.x + (i - 2) * 1.6, me.pos.z + 5);
  await advance(page, 40);
  await page.screenshot({ path: `${SHOTS}/slimes-yard.png` });
  expect(errors).toEqual([]);
});
