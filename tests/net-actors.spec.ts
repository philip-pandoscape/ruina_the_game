import { expect, test, type Page } from '@playwright/test';
import { emptyMovement, HOTBAR_SLOTS, NO_ABILITY, type Build } from '../src/tuning';
import { skillsFrom } from '../src/skills';
import { ActorTimeline } from '../src/net/actorTimeline';
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

test('drawn between two updates: blended, turning the short way round, and never sliding back from a respawn', () => {
  const t = new ActorTimeline();
  const base = { kind: 1, y: 0, state: 1, progress: 0.2, hp: 1, deadFrame: -1, targetX: 0, targetZ: 0 };
  t.push(10, [{ ...base, id: 1, x: 0, z: 0, facing: 3.0 }, { ...base, id: 2, x: 5, z: 5, facing: 0, deadFrame: 200 }], 0);
  t.push(11, [{ ...base, id: 1, x: 1, z: 0, facing: -3.0, progress: 0.3, hp: 0.8 }, { ...base, id: 2, x: 30, z: 30, facing: 0 }], 50);
  const mid = t.at(10.5);
  const a = mid.find((x) => x.id === 1)!;
  expect(a.x).toBeCloseTo(0.5);
  expect(a.progress).toBeCloseTo(0.25);
  // From 3.0 to -3.0 is a short turn through pi, not most of the way round through 0.
  expect(Math.cos(a.facing)).toBeLessThan(-0.99);
  // Health is the newest word on it, whenever it's drawn.
  expect(a.hp).toBe(0.8);
  // The other came back to life across the field: it is in one place or the other, never between.
  expect([5, 30]).toContain(mid.find((x) => x.id === 2)!.x);
  // An update running late: carried on a little past the newest, rather than stopping dead.
  expect(t.at(11.5).find((x) => x.id === 1)!.x).toBeCloseTo(1.5);
  // And the blow that took the health off was noticed, on the tick it showed.
  expect(t.hurts.map((h) => [h.id, h.tick])).toEqual([[1, 11]]);
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

// Frame rates: a browser drawing fewer frames than the server sends updates has nothing to draw
// between them, and a flash lasts a tenth of a second. Real GPUs only (CI draws in software).
test('between the server updates they are drawn moving, not jumping from one to the next', { tag: '@gpu' }, async ({ page }) => {
  await join(page);
  await seeActors(page);
  // Every drawn frame for two seconds: the server's update count, and where each one is drawn.
  const frames = await page.evaluate(async () => {
    const g = (window as any).__game;
    const out: Array<{ snap: number; at: Record<number, [number, number]> }> = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 2000) {
      await new Promise((r) => requestAnimationFrame(r));
      const at: Record<number, [number, number]> = {};
      for (const a of g.shownActors() as Array<{ id: number; x: number; z: number }>) at[a.id] = [a.x, a.z];
      out.push({ snap: g.net().snapshots, at });
    }
    return out;
  });
  // Frames that drew a hopping slime somewhere new: count the ones no update arrived for.
  let moves = 0;
  let between = 0;
  let worst = 0;
  for (let i = 1; i < frames.length; i++) {
    for (const [id, [x, z]] of Object.entries(frames[i].at)) {
      const was = frames[i - 1].at[Number(id)];
      if (!was) continue;
      const step = Math.hypot(x - was[0], z - was[1]);
      if (step < 1e-4) continue;
      moves++;
      if (frames[i].snap === frames[i - 1].snap) between++;
      worst = Math.max(worst, step);
    }
  }
  expect(moves, 'something moved').toBeGreaterThan(10);
  // Drawn as they arrive, every move would come with an update; drawn between them, most don't.
  expect(between / moves).toBeGreaterThan(0.3);
  // And no frame jumps one far: a slime covers a few centimetres in a sixtieth of a second.
  expect(worst).toBeLessThan(0.5);
});

test('a hit sparks and flashes the slime the moment the swing lands, and the server number follows', { tag: '@gpu' }, async ({ page }) => {
  await join(page);
  await seeActors(page);
  const seen = await page.evaluate(async () => {
    const g = (window as any).__game;
    type Shown = { id: number; x: number; z: number; deadFrame: number; flash: number };
    const near = () => {
      const me = g.state().player.pos;
      return (g.shownActors() as Shown[])
        .filter((a) => a.deadFrame < 0)
        .sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0];
    };
    let flash = 0;
    const target = near();
    for (let i = 0; i < 300 && target; i++) {
      const t = (g.shownActors() as Shown[]).find((a) => a.id === target.id);
      if (!t || t.deadFrame >= 0) break;
      flash = Math.max(flash, t.flash);
      const fx = g.netFx();
      if (fx.claimed + fx.late > 0 && flash > 0) break;
      const me = g.state().player.pos;
      const dx = t.x - me.x;
      const dz = t.z - me.z;
      const d = Math.hypot(dx, dz);
      g.scriptInput([[1, d < 1.3 ? { attackPressed: true, aimX: dx, aimZ: dz } : { moveX: dx / d, moveZ: dz / d }]]);
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { flash, fx: g.netFx(), hits: (g.combat().markers as Array<{ kind: string }>).filter((m) => m.kind === 'hit').length };
  });
  // Shown on the guess, then confirmed by the server (or, if the guess missed it, shown then).
  expect(seen.fx.guessed + seen.fx.late).toBeGreaterThan(0);
  expect(seen.fx.claimed + seen.fx.late).toBeGreaterThan(0);
  expect(seen.flash).toBeGreaterThan(0.3);
  expect(seen.hits).toBeGreaterThan(0);
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

test('hit one and it fights back: the server lands its slam on you', async ({ page }) => {
  await join(page);
  await seeActors(page);

  // Walk up to the nearest one, hit it once, then stand there and let it come for you.
  const hurt = await page.evaluate(async () => {
    const g = (window as any).__game;
    const near = () => {
      const list = (g.netActors?.() ?? []) as Array<{ id: number; x: number; z: number; deadFrame: number }>;
      const me = g.state().player.pos;
      return list
        .filter((a) => a.deadFrame < 0)
        .sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0];
    };
    const full = g.net().hp;
    let swung = false;
    for (let i = 0; i < 400; i++) {
      if (g.net().hp < full) return true;
      const t = near();
      if (!t) break;
      const me = g.state().player.pos;
      const dx = t.x - me.x;
      const dz = t.z - me.z;
      const d = Math.hypot(dx, dz);
      if (!swung && d < 1.3) {
        g.scriptInput([[1, { attackPressed: true }]]);
        swung = true;
      } else if (!swung) {
        g.scriptInput([[1, { moveX: dx / d, moveZ: dz / d }]]);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return g.net().hp < full;
  });
  expect(hurt).toBe(true);
});
