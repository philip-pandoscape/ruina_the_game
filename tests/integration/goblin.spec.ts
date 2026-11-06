import { expect, test, type Page } from '@playwright/test';
import { COMBAT, emptyMovement, HOTBAR_SLOTS, NO_ABILITY, type Build } from '../../src/tuning';
import { skillsFrom } from '../../src/skills';
import { actorKind } from '../../src/content/actors';
import { attackDef } from '../../src/content/attacks';
import { behaviour } from '../../src/sim/ai/brain';

// The basic goblin (shared/creatures/goblin.json, design/goblins.md), played in the training yard
// where every frame is stepped by the test: easy one at a time, dangerous as a band. They notice
// you and wake each other, only a few strike at once while the rest circle just outside your
// reach, they read your weapon, slip in when you turn your back, and run to their friends (or off
// to drink a stolen potion) when hurt.

// Its tests share nothing, so they spread across the workers (playwright.config.ts).
test.describe.configure({ mode: 'parallel' });

const build =(tree: string, weapon: number): Build => ({ skills: skillsFrom(tree), weapon, abilities: new Array<number>(HOTBAR_SLOTS).fill(NO_ABILITY), movement: emptyMovement() });
const SWORD = build('sword', 0);
const BOW = build('bow', 3);
const GOBLIN = actorKind('goblin');
const STAB = attackDef('goblin-stab')!;
const PACK = behaviour('goblin')!.pack!;

interface Goblin {
  id: number; x: number; z: number; hp: number; maxHp: number; alive: boolean; state: string; angry: number;
  target: number; band: number; token: boolean; opening: boolean; afraid: boolean; slotX: number; slotZ: number; charges: number; facing: number;
}
interface Me { pos: { x: number; z: number }; hp: number; facing: number }

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** The yard, paused, with you at (0, -14) facing north and nothing else of note nearby. */
async function open(page: Page, b: Build = SWORD): Promise<string[]> {
  const errors = watchErrors(page);
  await page.goto('/?yard&test');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  await page.evaluate((v) => (window as any).__game.setBuild(v), b);
  await page.evaluate(() => (window as any).__game.reset({ x: 0, z: -14, facing: 0 }));
  return errors;
}

const goblins = (page: Page) => page.evaluate(() => (window as any).__game.actors('goblin') as Goblin[]);
const me = async (page: Page) => (await page.evaluate(() => (window as any).__game.state())).player as Me;
const band = (page: Page, n: number, x: number, z: number) =>
  page.evaluate(([c, a, b]) => (window as any).__game.spawnBand('goblin', c, a, b) as number[], [n, x, z] as const);
const advance = (page: Page, frames: number, actions: Record<string, unknown> = {}) =>
  page.evaluate(([f, a]) => (window as any).__game.advance(f, a, false), [frames, actions] as const);
const hurt = (page: Page, id: number, amount: number) => page.evaluate(([i, n]) => (window as any).__game.hurtActor(i, n), [id, amount] as const);
const missiles = (page: Page) => page.evaluate(() => (window as any).__game.missiles() as Array<{ id: number }>);
const events = (page: Page, type: string) =>
  page.evaluate((t) => ((window as any).__game.events() as Array<{ type: string }>).filter((e) => e.type === t), type);
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/** Steps a few frames at a time, collecting what `look` sees each time, for `frames` frames. */
async function watch<T>(page: Page, frames: number, look: () => Promise<T>, every = 3, actions: Record<string, unknown> = {}): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; f < frames; f += every) {
    out.push(await look());
    await advance(page, every, actions);
  }
  return out;
}

test('a goblin notices you, shrieks, and wakes its band', async ({ page }) => {
  const errors = await open(page);
  await band(page, 4, 0, -2);
  const before = await goblins(page);
  expect(before.every((g) => g.angry === 0)).toBe(true);
  // 12 m off: within sight, and the band is close together.
  const seen = await watch(page, 120, () => goblins(page));
  expect(seen.some((list) => list.some((g) => g.state === 'spot'))).toBe(true);
  const after = await goblins(page);
  expect(after.every((g) => g.angry > 0)).toBe(true);
  expect(after.every((g) => g.target === 1)).toBe(true);
  expect(errors).toEqual([]);
});

test('one on one, a goblin is easy: a few swings kill it and it barely scratches you', async ({ page }) => {
  const errors = await open(page);
  const [id] = await band(page, 1, 0, -10);
  // Stand your ground facing it and keep swinging, as a player would when it comes in.
  for (let t = 0; t < 40; t++) {
    const g = (await goblins(page)).find((x) => x.id === id)!;
    if (!g.alive) break;
    const p = await me(page);
    const near = dist(g, p.pos) < 2.6;
    await advance(page, 12, near ? { attackPressed: true, aimX: g.x - p.pos.x, aimZ: g.z - p.pos.z } : {});
  }
  const g = (await goblins(page)).find((x) => x.id === id)!;
  expect(g.alive, 'the goblin should be dead after eight seconds of a sword').toBe(false);
  const hp = (await me(page)).hp;
  expect(COMBAT.maxHp - hp).toBeLessThanOrEqual(STAB.damage * 3);
  expect(errors).toEqual([]);
});

test('in a band only a few strike at once, and the rest wait on a ring outside your reach', async ({ page }) => {
  const errors = await open(page);
  await band(page, 6, 0, -9);
  // Stand still with a sword and let them come. Count who is going for you each moment.
  const seen = await watch(page, 540, async () => ({ list: await goblins(page), p: await me(page) }));
  const late = seen.slice(60);
  const striking = late.map(({ list }) => list.filter((g) => g.alive && (g.state === 'close' || g.state === 'stab')).length);
  const most = Math.max(...striking);
  expect(most).toBeGreaterThan(0);
  expect(most).toBeLessThanOrEqual(PACK.tokens[PACK.tokens.length - 1] + 1);
  // Those circling wait on places just outside a sword's 2.1 m.
  const ring: number[] = [];
  for (const { list, p } of late) {
    if (p.hp <= 0) continue;
    for (const g of list) if (g.state === 'circle') ring.push(Math.hypot(g.slotX - p.pos.x, g.slotZ - p.pos.z));
  }
  expect(ring.length).toBeGreaterThan(10);
  for (const r of ring) expect(r).toBeCloseTo(2.1 + PACK.ring, 1);
  // A band wears down someone who just stands there.
  expect(Math.min(...seen.map(({ p }) => p.hp))).toBeLessThan(COMBAT.maxHp - 20);
  expect(errors).toEqual([]);
});

test('against a sword they keep back and throw stones; against a bow they come right up', async ({ page }) => {
  const errors = await open(page, SWORD);
  /** Where the circling ones wait (how far their ring places are from you), and how often something is in the air. */
  async function fight(): Promise<{ ring: number; throwing: number }> {
    await band(page, 4, 0, -8);
    const ring: number[] = [];
    let throwing = 0;
    for (let f = 0; f < 720; f += 4) {
      const p = await me(page);
      if ((await missiles(page)).length > 0) throwing++;
      if (p.hp > 0) for (const g of await goblins(page)) if (g.alive && g.state === 'circle') ring.push(Math.hypot(g.slotX - p.pos.x, g.slotZ - p.pos.z));
      await advance(page, 4);
    }
    ring.sort((a, b) => a - b);
    return { ring: ring[Math.floor(ring.length / 2)], throwing };
  }
  const sword = await fight();
  expect(sword.throwing, 'stones thrown at a swordsman').toBeGreaterThan(0);
  expect(sword.ring, 'they wait just outside a sword').toBeCloseTo(2.1 + PACK.ring, 1);

  await open(page, BOW);
  const bow = await fight();
  expect(bow.throwing, 'no stones at an archer: they close in').toBe(0);
  expect(bow.ring, 'and wait right up against an archer').toBeCloseTo(PACK.ring, 1);
  expect(errors).toEqual([]);
});

test('turn your back and the one behind you is let in', async ({ page }) => {
  const errors = await open(page);
  // Two in front of you, one behind, all of one band.
  const ids = await band(page, 3, 0, -10.5);
  await page.evaluate(([a, b, c]) => {
    const g = (window as any).__game;
    g.setActor(a, { x: -1.2, z: -10.5, homeX: -1.2, homeZ: -10.5 });
    g.setActor(b, { x: 1.2, z: -10.5, homeX: 1.2, homeZ: -10.5 });
    g.setActor(c, { x: 0, z: -18, homeX: 0, homeZ: -18 });
  }, ids);
  const seen = await watch(page, 240, () => goblins(page));
  const behind = seen.flat().filter((g) => g.id === ids[2] && g.opening);
  expect(behind.length, 'the goblin at your back got an opening').toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('hurt and alone, a goblin runs off and drinks its potion when it gets clear', async ({ page }) => {
  const errors = await open(page);
  const [id] = await band(page, 1, 0, -9);
  await advance(page, 60);
  // Wear it down to under half, then back off out of its way.
  await hurt(page, id, 18);
  let drank = false;
  for (let f = 0; f < 900 && !drank; f += 6) {
    await advance(page, 6, { moveX: 0, moveZ: -1 });
    drank = (await events(page, 'actorHeal')).length > 0;
  }
  expect(drank, 'it drank').toBe(true);
  const g = (await goblins(page)).find((x) => x.id === id)!;
  expect(g.hp).toBeGreaterThan(GOBLIN.maxHp - 18);
  expect(g.charges).toBe(0);
  expect(errors).toEqual([]);
});

test('a blow while it drinks spills the potion', async ({ page }) => {
  const errors = await open(page);
  const [id] = await band(page, 1, 0, -9);
  await advance(page, 60);
  await hurt(page, id, 18);
  let drinking = false;
  for (let f = 0; f < 900 && !drinking; f += 3) {
    await advance(page, 3, { moveX: 0, moveZ: -1 });
    drinking = (await goblins(page)).find((x) => x.id === id)!.state === 'drink';
  }
  expect(drinking).toBe(true);
  await hurt(page, id, GOBLIN.poise!);
  const g = (await goblins(page)).find((x) => x.id === id)!;
  expect(g.state).toBe('flinch');
  expect(g.charges).toBe(0);
  await advance(page, 120);
  expect(await events(page, 'actorHeal')).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('a hurt goblin runs to the biggest group of its band', async ({ page }) => {
  const errors = await open(page);
  const ids = await band(page, 5, 0, -4);
  // Its friends wait well back; one goblin comes at you on its own.
  await page.evaluate((list) => {
    const g = (window as any).__game;
    list.forEach((id: number, i: number) => {
      if (i === 0) g.setActor(id, { x: 0, z: -11.5, homeX: 0, homeZ: -11.5 });
      else g.setActor(id, { x: -1 + (i % 2) * 2, z: -1 - Math.floor(i / 2), homeX: -1 + (i % 2) * 2, homeZ: -1 - Math.floor(i / 2) });
    });
  }, ids);
  await advance(page, 20);
  await hurt(page, ids[0], 20);
  const seen = await watch(page, 200, () => goblins(page));
  const runner = seen.map((list) => list.find((g) => g.id === ids[0])!).filter((g) => g.afraid);
  expect(runner.length).toBeGreaterThan(0);
  const start = runner[0];
  const end = runner[runner.length - 1];
  // Toward its friends at about (0, -1.5).
  expect(dist(end, { x: 0, z: -1.5 })).toBeLessThan(dist(start, { x: 0, z: -1.5 }) - 2);
  expect(errors).toEqual([]);
});
