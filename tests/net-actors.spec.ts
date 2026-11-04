import { expect, test, type Page } from '@playwright/test';
import { emptyMovement, HOTBAR_SLOTS, NO_ABILITY, type Build } from '../src/tuning';
import { skillsFrom } from '../src/skills';
import { serverBuilt, TestServer } from './testServer';

// Monsters on a live server. The rules for them run in Rust, the browser only draws what it is
// told, and the behaviour both sides interpret is the same shared/behaviours.json that
// ai-conformance.spec.ts pins down. This checks the whole path: spawned, streamed, hittable.

const SWORD: Build = { skills: skillsFrom('sword'), weapon: 0, abilities: new Array<number>(HOTBAR_SLOTS).fill(NO_ABILITY), movement: emptyMovement() };
const SLIMES = 12;

interface NetActor {
  id: number; kind: number; x: number; y: number; z: number;
  facing: number; state: number; progress: number; hp: number; deadFrame: number;
}

const server = new TestServer(7791, ['--bots', '600', '--slimes', String(SLIMES), '--hz', '20']);

test.beforeAll(async () => {
  test.skip(!serverBuilt, 'build it first: cargo build --release --manifest-path server/Cargo.toml');
  await server.start();
});
test.afterAll(async () => server.stop());

const join = async (page: Page) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`/?server=${encodeURIComponent(server.url)}&team=0`);
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  await page.evaluate((b) => (window as any).__game.setBuild(b), SWORD);
  return errors;
};
const actors = (page: Page) => page.evaluate(() => ((window as any).__game.netActors?.() ?? []) as NetActor[]);
const seeActors = (page: Page, atLeast = 1) =>
  page.waitForFunction((n) => (((window as any).__game.netActors?.() ?? []) as unknown[]).length >= n, atLeast, { timeout: 15_000, polling: 'raf' });

test('the server streams its monsters to a player who joins', async ({ page }) => {
  const errors = await join(page);
  await seeActors(page);
  const list = await actors(page);
  expect(list.length).toBeGreaterThan(0);
  expect(list.length).toBeLessThanOrEqual(SLIMES);
  // Every one is a kind the browser can name, standing up, at full health.
  for (const a of list) {
    expect(a.kind).toBeGreaterThanOrEqual(0);
    expect(a.deadFrame).toBe(-1);
    expect(a.hp).toBeGreaterThan(0.9);
    expect(Number.isFinite(a.x) && Number.isFinite(a.z)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('they move, and the browser is told which animation they are playing', async ({ page }) => {
  await join(page);
  await seeActors(page);
  const first = new Map((await actors(page)).map((a) => [a.id, [a.x, a.z] as const]));

  // Over a couple of seconds the server should have hopped at least one of them somewhere else.
  await page.waitForFunction(
    (before) => {
      const now = ((window as any).__game.netActors?.() ?? []) as Array<{ id: number; x: number; z: number }>;
      return now.some((a) => {
        const was = (before as Record<string, [number, number]>)[a.id];
        return was && Math.hypot(a.x - was[0], a.z - was[1]) > 0.3;
      });
    },
    Object.fromEntries(first),
    { timeout: 15_000, polling: 'raf' },
  );

  // And at some point one of them is mid-hop, off the ground.
  const states = new Set<number>();
  let airborne = false;
  for (let i = 0; i < 40 && !airborne; i++) {
    for (const a of await actors(page)) {
      states.add(a.state);
      if (a.y > 0.15) airborne = true;
    }
    await page.waitForTimeout(100);
  }
  expect(states.size).toBeGreaterThan(1); // it is not stuck in one behaviour state
  expect(airborne).toBe(true);
});

test('a player can kill one, and everyone sees it go down', async ({ page }) => {
  await join(page);
  await seeActors(page);

  // Walk at the nearest one and keep swinging until something dies.
  const killed = await page.evaluate(async () => {
    const g = (window as any).__game;
    const near = () => {
      const list = (g.netActors?.() ?? []) as Array<{ id: number; x: number; z: number; hp: number; deadFrame: number }>;
      const me = g.state().player.pos;
      return list
        .filter((a) => a.deadFrame < 0)
        .sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0];
    };
    for (let i = 0; i < 400; i++) {
      const t = near();
      if (!t) break;
      const me = g.state().player.pos;
      const dx = t.x - me.x;
      const dz = t.z - me.z;
      const d = Math.hypot(dx, dz);
      const close = d < 1.3;
      g.scriptInput([[1, close ? { attackPressed: true } : { moveX: dx / d, moveZ: dz / d }]]);
      await new Promise((r) => setTimeout(r, 50));
      const after = ((g.netActors?.() ?? []) as Array<{ id: number; deadFrame: number }>).find((a) => a.id === t.id);
      if (after && after.deadFrame >= 0) return true;
    }
    return false;
  });
  expect(killed).toBe(true);
});
