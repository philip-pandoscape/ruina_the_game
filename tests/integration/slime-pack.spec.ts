import { expect, test, type Page } from '@playwright/test';
import { COMBAT, emptyMovement, HOTBAR_SLOTS, NO_ABILITY, SLIME, type Build } from '../../src/tuning';
import { skillsFrom } from '../../src/skills';
import { actorKind } from '../../src/content/actors';

// Its tests share nothing, so they spread across the workers (playwright.config.ts).
test.describe.configure({ mode: 'parallel' });

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

const open = async (page: Page, live = false) => {
  const errors = watchErrors(page);
  // Paused, so only the test steps the game; `live` lets it run, for what only the frame loop does.
  await page.goto(live ? '/?yard' : '/?yard&test');
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

// ---------- bursting and reforming ----------

const LADDER = { fuse: 360, alone: 1200 }; // shared/actors.json ladders[0]
const kill = (page: Page, id: number) => hurt(page, id, 9999);
const pieces = async (page: Page) => (await all(page, 'slimelet')).filter((s) => s.alive && !s.gone);
const spawn = (page: Page, kind: string, x: number, z: number) =>
  page.evaluate(([k, a, b]) => (window as any).__game.spawnActor(k, a, b) as number, [kind, x, z] as const);

test('a slime you kill bursts into three slimelets on a fuse', async ({ page }) => {
  const errors = await open(page);
  const { slime } = await alone(page, 3);
  await kill(page, slime.id);
  await advance(page, 1);
  const bits = await pieces(page);
  expect(bits).toHaveLength(actorKind('slime').burst!.count);
  expect(new Set(bits.map((b) => b.group)).size).toBe(1);
  expect(bits[0].group).toBeGreaterThan(0);
  for (const b of bits) {
    expect(b.transient).toBe(true);
    expect(b.fuse).toBeGreaterThan(LADDER.fuse - 5);
  }
  // They scatter.
  await advance(page, 30);
  const spread = await pieces(page);
  const far = spread.filter((b) => Math.hypot(b.x - slime.x, b.z - slime.z) > 1.5);
  expect(far.length).toBe(spread.length);
  expect(errors).toEqual([]);
});

test('kill every piece before the fuse runs out and nothing comes back; then the slime respawns', async ({ page }) => {
  await open(page);
  const { slime } = await alone(page, 3);
  await kill(page, slime.id);
  await advance(page, 1);
  for (const b of await pieces(page)) await kill(page, b.id);
  await advance(page, LADDER.fuse + 30);
  expect(await all(page, 'great-slime')).toHaveLength(0);
  expect(await pieces(page)).toHaveLength(0);
  // With its pieces gone there's room for it again, and it comes back as it was.
  await advance(page, SLIME.respawnFrames);
  const back = await byId(page, slime.id);
  expect(back?.alive).toBe(true);
  expect(back?.kind).toBe('slime');
});

test('leave two pieces and they come back together as a great slime', async ({ page }) => {
  const errors = await open(page);
  const { slime } = await alone(page, 3);
  await kill(page, slime.id);
  await advance(page, 1);
  const bits = await pieces(page);
  await kill(page, bits[0].id);
  // They head back to each other near the end.
  await advance(page, LADDER.fuse - 60);
  const late = await pieces(page);
  expect(late.every((b) => b.state === 'regroup')).toBe(true);
  await advance(page, 70);
  const big = await all(page, 'great-slime');
  expect(big).toHaveLength(1);
  expect(big[0].hp).toBe(actorKind('great-slime').maxHp);
  expect(big[0].angry).toBeGreaterThan(0);
  expect(await pieces(page)).toHaveLength(0);
  expect((await page.evaluate(() => (window as any).__game.events() as Array<{ type: string }>)).some((e) => e.type === 'actorGrow')).toBe(true);
  expect(errors).toEqual([]);
});

test('a lone survivor does not reform; it dissolves a while later', async ({ page }) => {
  await open(page);
  const { slime } = await alone(page, 3);
  await kill(page, slime.id);
  await advance(page, 1);
  const bits = await pieces(page);
  await kill(page, bits[0].id);
  await kill(page, bits[1].id);
  await advance(page, LADDER.fuse + 10);
  expect(await all(page, 'great-slime')).toHaveLength(0);
  const left = await pieces(page);
  expect(left).toHaveLength(1);
  expect(left[0].group).toBe(0);
  await advance(page, LADDER.alone + 70);
  expect(await all(page, 'slimelet')).toHaveLength(0);
  // Three finished off, then the last piece dissolving on its own: not a kill, so no quest counts it.
  const deaths = (await events(page, 'actorDie')) as unknown as Array<{ killed: boolean }>;
  expect(deaths.map((d) => d.killed)).toEqual([true, true, true, false]);
});

test('the home slime waits to respawn while its pieces are still about', async ({ page }) => {
  await open(page);
  const { slime } = await alone(page, 3);
  await kill(page, slime.id);
  await advance(page, SLIME.respawnFrames + 20);
  // Its three pieces are alive (or reformed into something bigger), so the yard is full.
  expect((await byId(page, slime.id))?.alive).toBe(false);
});

test('a slime monarch bursts into seven, and comes back a monarch', async ({ page }) => {
  await open(page);
  const p = await me(page);
  for (let i = 0; i < SLIME.count; i++) await place(page, i, 60 + i * 30, 60);
  const id = await spawn(page, 'slime-monarch', p.pos.x, p.pos.z + 5);
  await kill(page, id);
  await advance(page, 1);
  expect(await pieces(page)).toHaveLength(actorKind('slime-monarch').burst!.count);
  await advance(page, LADDER.fuse + 10);
  const back = (await all(page, 'slime-monarch')).filter((s) => s.alive);
  expect(back).toHaveLength(1);
});

test('a burst never takes the creature past its cap', async ({ page }) => {
  await open(page);
  for (let i = 0; i < SLIME.count; i++) await place(page, i, 60 + i * 30, 60);
  // Five slimes plus 34 pieces is 39 of the 40 allowed; kill one slime and there's room for two.
  for (let i = 0; i < 34; i++) await spawn(page, 'slimelet', -20 + (i % 6) * 2, -20 - Math.floor(i / 6) * 2);
  const before = (await all(page, 'slimelet')).length;
  await kill(page, (await slimes(page))[0].id);
  await advance(page, 1);
  expect((await all(page, 'slimelet')).length - before).toBe(2);
});

// ---------- the rally and the gather ----------

const GATHER = { radius: 8, castFrames: 150, breakAt: 0.25 }; // shared/behaviours.json "slime"

/**
 * Slime 0 a few metres in front of you; three more about 10 m from it, close enough to hear it
 * call; the last 20 m off, too far to.
 */
async function pack(page: Page) {
  const p = await me(page);
  const cx = p.pos.x;
  const cz = p.pos.z + 4;
  await place(page, 0, cx, cz);
  await place(page, 1, cx + 10, cz);
  await place(page, 2, cx - 10, cz);
  await place(page, 3, cx, cz + 10);
  await place(page, 4, cx + 20, cz + 4);
  return { p, list: await slimes(page) };
}

test('hit a slime and the pack rushes to it, and it starts gathering them', async ({ page }) => {
  const errors = await open(page);
  const { list } = await pack(page);
  const caller = list[0];
  await hurt(page, caller.id, 1);
  expect(await until(page, caller.id, 'call', 60)).toBeDefined();
  const heard = await slimes(page);
  for (const i of [1, 2, 3]) expect(heard[i].rallyTo).toBe(caller.id);
  expect(heard[4].rallyTo).toBe(0); // too far off to hear it
  expect(await events(page, 'actorCall')).not.toHaveLength(0);

  // They close on it, not on you.
  const before = heard.slice(1, 4).map((s) => Math.hypot(s.x - caller.x, s.z - caller.z));
  await advance(page, 60);
  const now = await slimes(page);
  const c = await byId(page, caller.id);
  for (const [k, i] of [1, 2, 3].entries()) expect(Math.hypot(now[i].x - c!.x, now[i].z - c!.z)).toBeLessThan(before[k] - 1);

  expect(await until(page, caller.id, 'gather', 300)).toBeDefined();
  expect(await events(page, 'gatherStart')).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('a gather that runs its course takes them in, and the caller grows into a great slime', async ({ page }) => {
  await open(page);
  const { list } = await pack(page);
  const caller = list[0];
  await hurt(page, caller.id, 1);
  expect(await until(page, caller.id, 'gather', 400)).toBeDefined();
  await advance(page, GATHER.castFrames + 5);
  const grown = await byId(page, caller.id);
  expect(grown?.kind).toBe('great-slime');
  expect(grown?.hp).toBe(actorKind('great-slime').maxHp);
  expect(grown!.mass).toBeGreaterThanOrEqual(actorKind('great-slime').mass!);
  const taken = (await slimes(page)).filter((s) => s.gone);
  expect(taken.length).toBeGreaterThanOrEqual(2);
  expect((await byId(page, list[4].id))?.gone).toBe(false); // the one out of earshot was left alone
});

test('hitting the caster for a quarter of its health breaks the gather, and it is dazed', async ({ page }) => {
  await open(page);
  const { list } = await pack(page);
  const caller = list[0];
  await hurt(page, caller.id, 1);
  expect(await until(page, caller.id, 'gather', 400)).toBeDefined();
  await advance(page, 20);
  await hurt(page, caller.id, Math.ceil(actorKind('slime').maxHp * GATHER.breakAt));
  await advance(page, 1);
  expect((await byId(page, caller.id))?.state).toBe('dazed');
  expect(await events(page, 'gatherBroken')).toHaveLength(1);
  await advance(page, GATHER.castFrames);
  expect((await byId(page, caller.id))?.kind).toBe('slime');
  expect((await slimes(page)).filter((s) => s.gone)).toHaveLength(0);
});

test('a slime whose gather is on cooldown does not call; its neighbours just come for you', async ({ page }) => {
  await open(page);
  const { list } = await pack(page);
  const caller = list[0];
  await page.evaluate((id) => (window as any).__game.setActor(id, { gatherCd: 900 }), caller.id);
  await hurt(page, caller.id, 1);
  await advance(page, 60);
  const now = await slimes(page);
  expect(now[0].calling).toBe(-1);
  for (const i of [1, 2, 3]) {
    expect(now[i].rallyTo).toBe(0);
    expect(now[i].angry).toBeGreaterThan(0);
  }
});

test('kill the caller and the nearest one rallying to it takes the call over', async ({ page }) => {
  await open(page);
  const { list } = await pack(page);
  const caller = list[0];
  await hurt(page, caller.id, 1);
  expect(await until(page, caller.id, 'call', 60)).toBeDefined();
  await advance(page, 20);
  const at = await byId(page, caller.id);
  const rallying = (await slimes(page)).filter((s) => s.rallyTo === caller.id);
  const nearest = rallying.sort((a, b) => Math.hypot(a.x - at!.x, a.z - at!.z) - Math.hypot(b.x - at!.x, b.z - at!.z))[0];
  await kill(page, caller.id);
  await advance(page, 2);
  const heir = await byId(page, nearest.id);
  expect(heir?.state).toBe('call');
  expect(heir!.calling).toBeGreaterThanOrEqual(0);
  for (const s of await slimes(page)) if (s.id !== nearest.id && rallying.some((r) => r.id === s.id)) expect(s.rallyTo).toBe(nearest.id);
});

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
  await page.evaluate(() => (window as any).__game.placeActor('dummy', 0, -40, -40));
  const caster = (await slimes(page))[0];
  await hurt(page, caster.id, 1);
  expect(await until(page, caster.id, 'gather', 300)).toBeDefined();
  await advance(page, 40);
  expect((await page.evaluate(() => (window as any).__game.combat())).target?.key).toBe(`actor:${caster.id}`);
  const plate = await page.evaluate(() => {
    const el = document.querySelector('#target-plate') as HTMLElement;
    const cast = el.querySelector('.cast') as HTMLElement;
    return { name: el.querySelector('.name')!.textContent, shown: cast.style.display, label: cast.querySelector('.label')!.textContent, width: (cast.querySelector('.fill') as HTMLElement).style.width };
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
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 60_000 });
  await page.evaluate((v) => (window as any).__game.setBuild(v), SWORD);
  // The steepest walkable ground within reach of the spawn.
  const spot = await page.evaluate(() => {
    const g = (window as any).__game;
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
  await page.evaluate(([x, z]) => (window as any).__game.teleport(x, z), [spot.x, spot.z]);
  const p = await me(page);
  // A slime beside you, angry: it winds up to slam where you stand.
  const id = await page.evaluate(([x, z]) => (window as any).__game.spawnActor('slime', x + 2.5, z), [p.pos.x, p.pos.z]);
  await hurt(page, id, 1);
  const winding = await until(page, id, 'windup');
  expect(winding).toBeDefined();
  await advance(page, 10);
  // Wherever you look inside the ring, it is drawn just over the ground there.
  const gaps = await page.evaluate(([tx, tz, r]) => {
    const g = (window as any).__game;
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
  }, [winding!.targetX, winding!.targetZ, SLAM.radius]);
  const rise = (Math.max(...gaps.filter(Number.isFinite)) - Math.min(...gaps)) as number;
  expect(gaps.every(Number.isFinite), 'the ring is drawn all the way across').toBe(true);
  // Lifted a hair off the ground everywhere (it would be a metre off at one side lying flat).
  for (const gap of gaps) expect(gap).toBeGreaterThan(0.005);
  for (const gap of gaps) expect(gap).toBeLessThan(0.05);
  expect(rise).toBeLessThan(0.01);
  expect(errors).toEqual([]);
});
