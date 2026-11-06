import { expect, test, type Page } from '@playwright/test';
import { emptyMovement, HOTBAR_SLOTS, NO_ABILITY, SLIME, WEAPONS, type Build } from '../../src/tuning';
import { skillsFrom } from '../../src/skills';
import { gameReady } from '../support/game';

// Slimes in the training yard: the first creature built out of species data to make it into the
// game itself. They hop, they take hits from everything the player has, they die and come back.

const SHOTS = 'screenshots';
const METEOR = 1;
const build = (ids: string[], weapon: number, ability = NO_ABILITY): Build => {
  const abilities = new Array<number>(HOTBAR_SLOTS).fill(NO_ABILITY);
  abilities[0] = ability;
  return { skills: skillsFrom(...ids), weapon, abilities, movement: emptyMovement() };
};
const SWORD = build(['sword'], 0);
const ARCHER = build(['bow'], 3);
const MAGE = build(['staff', 'meteor'], 2, METEOR);
const swordDamage = WEAPONS[0].combo[0].damage;
const swordReach = WEAPONS[0].combo[0].reach;

interface Actor {
  id: number; kind: string; x: number; y: number; z: number;
  hp: number; alive: boolean; state: string; deadFrame: number; flash: number;
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
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
const place = (page: Page, i: number, x: number, z: number) =>
  page.evaluate(([a, b, c]) => window.__game.placeActor('slime', a, b, c), [i, x, z] as const);
const advance = (page: Page, frames: number, actions: Record<string, unknown> = {}) =>
  page.evaluate(([f, a]) => window.__game.advance(f, a), [frames, actions] as const);
const markers = async (page: Page) => (await page.evaluate(() => window.__game.combat())).markers as Array<{ kind: string; amount: number }>;

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

test('a sword kills a slime, which flashes, dies, bursts, and comes back once the pieces are gone', async ({ page }) => {
  const errors = await open(page, SWORD);
  const me = (await page.evaluate(() => window.__game.state())).player;
  const put = () => place(page, 0, me.pos.x, me.pos.z + swordReach * 0.6);

  let swings = 0;
  let killed = false;
  for (let i = 0; i < 20 && !killed; i++) {
    await put(); // it keeps hopping, so pin it back in reach before each swing
    await advance(page, 1, { attackPressed: true });
    await advance(page, 30);
    swings++;
    killed = !(await slimes(page))[0].alive;
  }
  expect(killed).toBe(true);
  expect(swings).toBeGreaterThanOrEqual(Math.floor(SLIME.hp / swordDamage));

  // Numbers came up for the hits.
  const hits = (await markers(page)).filter((m) => m.kind === 'hit');
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.some((m) => m.amount === swordDamage)).toBe(true);

  // Down, in pieces (tests/integration/slime-pack.spec.ts covers those); clear them away and it comes back
  // on its feet with full health where it fell.
  await advance(page, 10);
  expect((await slimes(page))[0].alive).toBe(false);
  const bits = await page.evaluate(() => (window.__game.actors('slimelet') as Actor[]).filter((a) => a.alive));
  expect(bits.length).toBeGreaterThan(0);
  for (const b of bits) await page.evaluate((id) => window.__game.hurtActor(id, 9999), b.id);
  await advance(page, SLIME.respawnFrames + 4);
  const back = (await slimes(page))[0];
  expect(back.alive).toBe(true);
  expect(back.hp).toBe(SLIME.hp);
  expect(errors).toEqual([]);
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
