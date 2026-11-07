import { expect, test, type Page } from '@playwright/test';
import { emptyMovement, HOTBAR_SLOTS, NO_ABILITY, SLIME, WEAPONS, weaponIndex, type Build } from '../../src/content/tuning';
import { skillsFrom } from '../../src/content/skills';
import { gameReady } from '../support/game';

// Slimes in the training yard: the first creature built out of species data to make it into the
// game itself. They hop, they take hits from everything the player has, they die and come back.

/** The skills, the weapon in hand and the ability in the first slot, each by id. */
const build = (ids: string[], weapon: string, ability = NO_ABILITY): Build => {
  const abilities = new Array<number>(HOTBAR_SLOTS).fill(NO_ABILITY);
  abilities[0] = ability;
  return { skills: skillsFrom(...ids), weapon: weaponIndex(weapon), abilities, movement: emptyMovement() };
};
const SWORD = build(['sword'], 'sword');
const swordDamage = WEAPONS[weaponIndex('sword')].combo[0].damage;
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
  await page.goto('/?test=yard'); // paused: only the test steps the game
  await gameReady(page);
  if (b) await page.evaluate((v) => window.__game.setBuild(v), b);
  return errors;
};

const slimes = (page: Page) => page.evaluate(() => window.__game.actors('slime') as Actor[]);
const place = (page: Page, i: number, x: number, z: number) => page.evaluate(([a, b, c]) => window.__game.placeActor('slime', a, b, c), [i, x, z] as const);
const advance = (page: Page, frames: number, actions: Record<string, unknown> = {}) =>
  page.evaluate(([f, a]) => window.__game.advance(f, a), [frames, actions] as const);
const markers = async (page: Page) => (await page.evaluate(() => window.__game.combat())).markers as Array<{ kind: string; amount: number }>;

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
