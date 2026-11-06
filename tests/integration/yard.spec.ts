import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { skillsFrom } from '../../src/content/skills';
import { emptyMovement, HOTBAR_SLOTS, NO_ABILITY, type Build } from '../../src/content/tuning';
import { onlineReady } from '../support/game';

// The yard's monsters on the game server (content/instances/yard.json, a developer zone): the rules
// for them run in Rust, the browser only draws what it is told, and the behaviour both sides
// interpret is the same shared/behaviours.json that tests/conformance/ai.test.ts pins down. This
// checks the whole path: spawned, streamed, hittable, fighting back. Each player has a yard of their
// own, so it plays on the shared development server (npm run up; everyone is an admin there) and
// skips without one. Drawn between updates and flashing as a blow lands: online-combat.spec.ts,
// on the island's slimes.

const SERVER = process.env.RUINA_SERVER ?? 'http://localhost:7777';
const YARD = JSON.parse(readFileSync('content/instances/yard.json', 'utf8')) as { spawns: Array<{ kind: string }> };
const SWORD: Build = { skills: skillsFrom('sword'), weapon: 0, abilities: new Array<number>(HOTBAR_SLOTS).fill(NO_ABILITY), movement: emptyMovement() };

let serverUp = false;
test.beforeAll(async () => {
  try {
    const r = await fetch(`${SERVER}/api/health`);
    serverUp = r.ok && (await r.json()).database === true;
  } catch {
    serverUp = false;
  }
});
test.beforeEach(() => test.skip(!serverUp, `needs the game server with a database at ${SERVER} (npm run up)`));
test.describe.configure({ mode: 'parallel' });

const fresh = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`.slice(0, 20);

/** Someone new, in a yard of their own with a sword. Returns the errors the page logs from then on. */
async function intoTheYard(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`/?as=${fresh('yard')}&bugs=0`);
  await onlineReady(page);
  expect(await page.evaluate(() => window.__game.enterZone('yard'))).toBe(true);
  await page.waitForFunction(() => window.__game.space()?.kind === 'dungeon', null, { timeout: 30_000 });
  expect(await page.evaluate((b) => window.__game.setBuild(b), SWORD)).toBe(true);
  return errors;
}

interface Shown {
  id: number;
  kindId: string;
  x: number;
  y: number;
  z: number;
  state: number;
  hp: number;
  deadFrame: number;
}
const slimes = (page: Page) => page.evaluate(() => window.__game.shownActors().filter((a) => a.kindId === 'slime') as Shown[]);
const seeSlimes = (page: Page) =>
  page.waitForFunction(() => window.__game.shownActors().some((a) => a.kindId === 'slime'), null, { timeout: 15_000, polling: 'raf' });

test('the server streams its monsters to a player who comes in', async ({ page }) => {
  const errors = await intoTheYard(page);
  await seeSlimes(page);
  const list = await page.evaluate(() => window.__game.shownActors() as Shown[]);
  // What the yard's file brings, each a kind the browser can name, standing up, at full health.
  expect(list.length).toBe(YARD.spawns.length);
  for (const a of list) {
    expect(a.kindId).not.toBe('');
    expect(a.deadFrame).toBe(-1);
    expect(a.hp).toBeGreaterThan(0.9);
    expect(Number.isFinite(a.x) && Number.isFinite(a.z)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('they move, and the browser is told which animation they are playing', async ({ page }) => {
  await intoTheYard(page);
  await seeSlimes(page);
  const first = Object.fromEntries((await slimes(page)).map((a) => [a.id, [a.x, a.z] as const]));

  // Over a few seconds the server hops at least one of them somewhere else.
  await page.waitForFunction(
    (before) =>
      window.__game.shownActors().some((a) => {
        const was = (before as Record<string, [number, number]>)[a.id];
        return was && Math.hypot(a.x - was[0], a.z - was[1]) > 0.3;
      }),
    first,
    { timeout: 15_000, polling: 'raf' },
  );

  // And at some point one of them is mid-hop, off the ground, in another state than idling.
  const seen = await page.evaluate(async () => {
    const states = new Set<number>();
    for (let i = 0; i < 600; i++) {
      for (const a of window.__game.shownActors()) {
        if (a.kindId !== 'slime') continue;
        states.add(a.state);
        if (a.y > 0.15 && states.size > 1) return { states: states.size, airborne: true };
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { states: states.size, airborne: false };
  });
  expect(seen.states).toBeGreaterThan(1); // it is not stuck in one behaviour state
  expect(seen.airborne).toBe(true);
});

/** Walks at the nearest slime still up and swings when close, until it's killed, or (`hurt`) until one has been hit and has hit back. */
const fightNearest = (page: Page, until: 'killed' | 'hurt') =>
  page.evaluate(async (until) => {
    const g = window.__game;
    const near = () => {
      const me = g.state().player.pos;
      return g
        .shownActors()
        .filter((a) => a.kindId === 'slime' && a.deadFrame < 0)
        .sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0];
    };
    const full = g.net().hp;
    // Hurting it once is enough to make it fight back (twice or three times kills it): then stand and wait.
    let struck: number | null = null;
    for (let i = 0; i < 1500; i++) {
      if (until === 'hurt' && g.net().hp < full) return true;
      if (struck !== null) {
        g.scriptInput([[1, {}]]);
        await new Promise((r) => requestAnimationFrame(r));
        continue;
      }
      const t = near();
      if (!t) break;
      const me = g.state().player.pos;
      const dx = t.x - me.x;
      const dz = t.z - me.z;
      const d = Math.hypot(dx, dz);
      // Aimed at it, as a player does with the camera: with a monster marked you face where the
      // camera looks, so an unaimed swing would go wherever this test's camera happens to point.
      const swing = d < 1.3;
      g.scriptInput([[1, swing ? { attackPressed: true, aimX: dx, aimZ: dz } : { moveX: dx / d, moveZ: dz / d }]]);
      await new Promise((r) => requestAnimationFrame(r));
      const after = g.shownActors().find((a) => a.id === t.id);
      if (until === 'killed' && after && after.deadFrame >= 0) return true;
      if (until === 'hurt' && after && after.hp < 1) struck = after.id;
    }
    return until === 'hurt' ? g.net().hp < full : false;
  }, until);

test('a player can kill one, and sees it go down', async ({ page }) => {
  await intoTheYard(page);
  await seeSlimes(page);
  expect(await fightNearest(page, 'killed')).toBe(true);
});

test('hit one and it fights back: the server lands its slam on you', async ({ page }) => {
  await intoTheYard(page);
  await seeSlimes(page);
  expect(await fightNearest(page, 'hurt')).toBe(true);
});
