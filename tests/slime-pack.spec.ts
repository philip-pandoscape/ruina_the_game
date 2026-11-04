import { expect, test, type Page } from '@playwright/test';
import { COMBAT, emptyMovement, HOTBAR_SLOTS, NO_ABILITY, SLIME, type Build } from '../src/tuning';
import { skillsFrom } from '../src/skills';
import { actorKind } from '../src/content/actors';

// Slimes as a pack (shared/behaviours.json "slime", src/sim/actors/step.ts): they leave you alone
// until you hit one, then the pack comes for you - winding up, leaping, and slamming the spot you
// were standing on. Played in the training yard, where every frame is stepped by the test.

const SWORD: Build = { skills: skillsFrom('sword'), weapon: 0, abilities: new Array<number>(HOTBAR_SLOTS).fill(NO_ABILITY), movement: emptyMovement() };
const SLAM = actorKind('slime').slam!;

interface Slime {
  id: number; kind: string; x: number; y: number; z: number; hp: number; maxHp: number; alive: boolean;
  state: string; deadFrame: number; mass: number; gone: boolean; transient: boolean; angry: number;
  rallyTo: number; calling: number; fuse: number; group: number; slamCd: number; gatherCd: number;
  targetX: number; targetZ: number;
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

const open = async (page: Page) => {
  const errors = watchErrors(page);
  await page.goto('/?yard');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  await page.evaluate((v) => (window as any).__game.setBuild(v), SWORD);
  return errors;
};

const all = (page: Page, kind?: string) => page.evaluate((k) => (window as any).__game.actors(k) as Slime[], kind);
const slimes = (page: Page) => all(page, 'slime');
const byId = async (page: Page, id: number) => (await all(page)).find((a) => a.id === id);
const me = async (page: Page) => (await page.evaluate(() => (window as any).__game.state())).player as { pos: { x: number; z: number }; hp: number };
const place = (page: Page, i: number, x: number, z: number) =>
  page.evaluate(([a, b, c]) => (window as any).__game.placeActor('slime', a, b, c), [i, x, z] as const);
const advance = (page: Page, frames: number, actions: Record<string, unknown> = {}) =>
  page.evaluate(([f, a]) => (window as any).__game.advance(f, a), [frames, actions] as const);
const hurt = (page: Page, id: number, amount: number) => page.evaluate(([i, n]) => (window as any).__game.hurtActor(i, n), [id, amount] as const);
const events = (page: Page, type: string) =>
  page.evaluate((t) => ((window as any).__game.events() as Array<{ type: string }>).filter((e) => e.type === t), type);

/** Puts slime 0 in front of you and every other one far off, out of earshot of each other. */
async function alone(page: Page, distance: number) {
  const p = await me(page);
  for (let i = 1; i < SLIME.count; i++) await place(page, i, 60 + i * 30, 60);
  await place(page, 0, p.pos.x, p.pos.z + distance);
  return { p, slime: (await slimes(page))[0] };
}

/** Steps a few frames at a time until slime `id` is in `state`, or gives up. */
async function until(page: Page, id: number, state: string, frames = 300): Promise<Slime | undefined> {
  for (let f = 0; f < frames; f += 3) {
    const s = await byId(page, id);
    if (s?.state === state) return s;
    await advance(page, 3);
  }
  return undefined;
}

test('a slime left alone never touches you', async ({ page }) => {
  const errors = await open(page);
  const { slime } = await alone(page, 1.5);
  await advance(page, 400);
  expect((await me(page)).hp).toBe(COMBAT.maxHp);
  expect((await byId(page, slime.id))?.angry).toBe(0);
  expect(await events(page, 'slam')).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('hit a slime and it winds up, leaps, and slams the spot where you stood', async ({ page }) => {
  const errors = await open(page);
  const { p, slime } = await alone(page, 3);
  await hurt(page, slime.id, 1);
  const winding = await until(page, slime.id, 'windup');
  expect(winding).toBeDefined();
  // It picked your spot when it started, so you can see it coming.
  expect(Math.hypot(winding!.targetX - p.pos.x, winding!.targetZ - p.pos.z)).toBeLessThan(0.3);

  // Standing still, you're in the ring when it lands.
  await advance(page, 75);
  const after = await me(page);
  expect(after.hp).toBe(COMBAT.maxHp - SLAM.damage);
  expect(await events(page, 'slam')).toHaveLength(1);
  const hurts = ((await page.evaluate(() => (window as any).__game.combat())).markers as Array<{ kind: string; amount: number }>)
    .filter((m) => m.kind === 'hurt');
  expect(hurts.some((m) => m.amount === SLAM.damage)).toBe(true);
  expect(errors).toEqual([]);
});

test('walking out of the ring before it lands means it misses', async ({ page }) => {
  await open(page);
  const { slime } = await alone(page, 3);
  await hurt(page, slime.id, 1);
  expect(await until(page, slime.id, 'windup')).toBeDefined();
  // Run sideways while it winds up and flies.
  await advance(page, 70, { moveX: 1, moveZ: 0 });
  expect(await events(page, 'slam')).toHaveLength(1);
  expect((await me(page)).hp).toBe(COMBAT.maxHp);
});

test('hitting one angers the pack around it, but not slimes far away', async ({ page }) => {
  await open(page);
  const p = await me(page);
  await place(page, 0, p.pos.x, p.pos.z + 4);
  await place(page, 1, p.pos.x + 8, p.pos.z + 4); // within earshot
  for (let i = 2; i < SLIME.count; i++) await place(page, i, 60 + i * 30, 60); // well out of it
  const list = await slimes(page);
  await hurt(page, list[0].id, 1);
  const now = await slimes(page);
  expect(now[0].angry).toBeGreaterThan(0);
  expect(now[1].angry).toBeGreaterThan(0);
  for (let i = 2; i < SLIME.count; i++) expect(now[i].angry).toBe(0);
});
