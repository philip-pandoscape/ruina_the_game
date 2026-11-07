import { expect, test, type Page } from '@playwright/test';
import { COMBAT, emptyMovement, HOTBAR_SLOTS, NO_ABILITY, SLIME, weaponIndex, type Build } from '../../src/content/tuning';
import { skillsFrom } from '../../src/content/skills';
import { actorKind } from '../../src/content/actors';
import { gameReady } from '../support/game';

// Its tests share nothing, so they spread across the workers (playwright.config.ts).
test.describe.configure({ mode: 'parallel' });

// Slimes as a pack (shared/behaviours.json "slime", crates/engine/src/actors.rs): they leave you alone
// until you hit one, then the pack comes for you - winding up, leaping, and slamming the spot you
// were standing on. Played in the training yard, where every frame is stepped by the test.

const SWORD: Build = {
  skills: skillsFrom('sword'),
  weapon: weaponIndex('sword'),
  abilities: new Array<number>(HOTBAR_SLOTS).fill(NO_ABILITY),
  movement: emptyMovement(),
};
const SLAM = actorKind('slime').slam!;

interface Slime {
  id: number;
  kind: string;
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  state: string;
  deadFrame: number;
  mass: number;
  gone: boolean;
  transient: boolean;
  angry: number;
  rallyTo: number;
  calling: number;
  fuse: number;
  group: number;
  slamCd: number;
  gatherCd: number;
  targetX: number;
  targetZ: number;
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

const open = async (page: Page, live = false) => {
  const errors = watchErrors(page);
  // Paused, so only the test steps the game; `live` lets it run, for what only the frame loop does.
  await page.goto(live ? '/?offline=yard' : '/?test=yard');
  await gameReady(page);
  await page.evaluate((v) => window.__game.setBuild(v), SWORD);
  return errors;
};

const all = (page: Page, kind?: string) => page.evaluate((k) => window.__game.actors(k) as Slime[], kind);
const slimes = (page: Page) => all(page, 'slime');
const byId = async (page: Page, id: number) => (await all(page)).find((a) => a.id === id);
const me = async (page: Page) => (await page.evaluate(() => window.__game.state())).player as { pos: { x: number; z: number }; hp: number };
const place = (page: Page, i: number, x: number, z: number) => page.evaluate(([a, b, c]) => window.__game.placeActor('slime', a, b, c), [i, x, z] as const);
const advance = (page: Page, frames: number, actions: Record<string, unknown> = {}) =>
  page.evaluate(([f, a]) => window.__game.advance(f, a), [frames, actions] as const);
const hurt = (page: Page, id: number, amount: number) => page.evaluate(([i, n]) => window.__game.hurtActor(i, n), [id, amount] as const);
const events = (page: Page, type: string) => page.evaluate((t) => (window.__game.events() as Array<{ type: string }>).filter((e) => e.type === t), type);

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
  const hurts = ((await page.evaluate(() => window.__game.combat())).markers as Array<{ kind: string; amount: number }>).filter((m) => m.kind === 'hurt');
  expect(hurts.some((m) => m.amount === SLAM.damage)).toBe(true);
  expect(errors).toEqual([]);
});

// ---------- bursting and reforming ----------

// shared/actors.json ladders[0]

// ---------- the rally and the gather ----------

// shared/behaviours.json "slime"

test('the target plate shows the gather filling', async ({ page }) => {
  // The game picks its soft-lock mark once per rendered frame, so this one runs live; the cast
  // lasts 2.5 s, plenty of slack for the frames that pass between the test's own steps.
  await open(page, true);
  const p = await me(page);
  // The caster straight ahead, two of its pack further off behind it, so it's the one the game
  // marks for you.
  await place(page, 0, p.pos.x, p.pos.z + 4);
  await place(page, 1, p.pos.x + 2, p.pos.z + 10);
  await place(page, 2, p.pos.x - 2, p.pos.z + 10);
  for (let i = 3; i < SLIME.count; i++) await place(page, i, 60 + i * 30, 60);
  // The training dummy stands straight ahead too; move it out of the way.
  await page.evaluate(() => window.__game.placeActor('dummy', 0, -40, -40));
  const caster = (await slimes(page))[0];
  await hurt(page, caster.id, 1);
  expect(await until(page, caster.id, 'gather', 300)).toBeDefined();
  await advance(page, 40);
  expect((await page.evaluate(() => window.__game.combat())).target?.key).toBe(`actor:${caster.id}`);
  const plate = await page.evaluate(() => {
    const el = document.querySelector('#target-plate') as HTMLElement;
    const cast = el.querySelector('.cast') as HTMLElement;
    return {
      name: el.querySelector('.name')!.textContent,
      shown: cast.style.display,
      label: cast.querySelector('.label')!.textContent,
      width: (cast.querySelector('.fill') as HTMLElement).style.width,
    };
  });
  expect(plate.name).toBe('Slime');
  expect(plate.shown).toBe('block');
  expect(plate.label).toBe('Gathering');
  expect(parseInt(plate.width, 10)).toBeGreaterThan(10);
});

test('on a hillside the slam warning lies on the slope, not under it', async ({ page }) => {
  const errors = watchErrors(page);
  // The island, offline and stepped by the test: the training yard is flat, the island is not.
  await page.goto('/?world&test');
  await gameReady(page, 60_000);
  await page.evaluate((v) => window.__game.setBuild(v), SWORD);
  // The steepest walkable ground within reach of the spawn.
  const spot = await page.evaluate(() => {
    const g = window.__game;
    const s = g.zone().spawn;
    let best = { x: s.x, z: s.z, slope: 0 };
    for (let dx = -150; dx <= 150; dx += 3) {
      for (let dz = -150; dz <= 150; dz += 3) {
        const x = s.x + dx;
        const z = s.z + dz;
        if (g.ground(x, z) < 2) continue;
        const slope = Math.hypot(g.ground(x + 1.5, z) - g.ground(x - 1.5, z), g.ground(x, z + 1.5) - g.ground(x, z - 1.5)) / 3;
        if (slope > best.slope && slope < 0.65) best = { x, z, slope };
      }
    }
    return best;
  });
  expect(spot.slope).toBeGreaterThan(0.3);
  await page.evaluate(([x, z]) => window.__game.teleport(x, z), [spot.x, spot.z]);
  const p = await me(page);
  // A slime beside you, angry: it winds up to slam where you stand.
  const id = await page.evaluate(([x, z]) => window.__game.spawnActor('slime', x + 2.5, z), [p.pos.x, p.pos.z]);
  await hurt(page, id, 1);
  const winding = await until(page, id, 'windup');
  expect(winding).toBeDefined();
  await advance(page, 10);
  // Wherever you look inside the ring, it is drawn just over the ground there.
  const gaps = await page.evaluate(
    ([tx, tz, r]) => {
      const g = window.__game;
      g.render();
      const out: number[] = [];
      for (let i = 0; i < 24; i++) {
        const a = i * 2.39996;
        const d = r * 0.95 * Math.sqrt((i + 0.5) / 24);
        const x = tx + Math.cos(a) * d;
        const z = tz + Math.sin(a) * d;
        const h = g.circleHeight(x, z);
        out.push(h === null ? Infinity : h - g.ground(x, z));
      }
      return out;
    },
    [winding!.targetX, winding!.targetZ, SLAM.radius],
  );
  const rise = (Math.max(...gaps.filter(Number.isFinite)) - Math.min(...gaps)) as number;
  expect(gaps.every(Number.isFinite), 'the ring is drawn all the way across').toBe(true);
  // Lifted a hair off the ground everywhere (it would be a metre off at one side lying flat).
  for (const gap of gaps) expect(gap).toBeGreaterThan(0.005);
  for (const gap of gaps) expect(gap).toBeLessThan(0.05);
  expect(rise).toBeLessThan(0.01);
  expect(errors).toEqual([]);
});
