import { expect, test } from '@playwright/test';
import { onlineReady as waitOnline } from '../support/game';

// Fighting Emberholm's slimes on the game server, where the server decides every hit and the
// browser only draws: the slimes move smoothly between the server's updates, their warnings lie on
// the ground (the slime meadow is 18 m above the sea, where a circle drawn at sea level can't be
// seen), and a swing that connects sparks and flashes the slime straight away. Needs the game server
// with developer sign-in, as tests/integration/online.spec.ts does (npm run up); skipped without it. Tagged
// @gpu: it walks up to a slime and swings at it, which a software-drawn browser is too slow for.

const SERVER = process.env.RUINA_SERVER ?? 'http://localhost:7777';

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

const fresh = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(0, 20);

/** Where the region's slimes live (shared/regions/emberholm.json "slimes"), and a spot just south of them. */
const MEADOW = { x: -30, z: -40 };

test("the region's slimes move smoothly, warn on the ground, and flash when your swing lands", { tag: '@gpu' }, async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`/?as=${fresh('slimer')}&bugs=0`);
  await waitOnline(page);
  await page.evaluate(([x, z]) => window.__game.teleport(x, z), [MEADOW.x, MEADOW.z - 18]);
  await page.waitForFunction(
    ([x, z]) => {
      const p = window.__game.state().player.pos;
      return Math.hypot(p.x - x, p.z - z) < 2;
    },
    [MEADOW.x, MEADOW.z - 18],
    { timeout: 30_000 },
  );
  await page.waitForFunction(() => window.__game.shownActors().filter((a: any) => a.kind === 1).length > 0, null, { timeout: 15_000 });

  // Drawn between the server's updates: most frames that move a slime had no update of their own.
  const moved = await page.evaluate(async () => {
    const g = window.__game;
    let moves = 0;
    let between = 0;
    let last: Record<number, [number, number]> = {};
    let snap = g.net().snapshots;
    const t0 = performance.now();
    while (performance.now() - t0 < 2500) {
      await new Promise((r) => requestAnimationFrame(r));
      const now: Record<number, [number, number]> = {};
      for (const a of g.shownActors()) now[a.id] = [a.x, a.z];
      const s = g.net().snapshots;
      for (const [id, [x, z]] of Object.entries(now)) {
        const w = last[Number(id)];
        if (!w || Math.hypot(x - w[0], z - w[1]) < 1e-4) continue;
        moves++;
        if (s === snap) between++;
      }
      last = now;
      snap = s;
    }
    return { moves, between };
  });
  expect(moved.moves).toBeGreaterThan(10);
  expect(moved.between / moved.moves).toBeGreaterThan(0.3);

  // Walk up to the nearest slime and hit it: sparks and a flash on the guess, the number after.
  const hit = await page.evaluate(async () => {
    const g = window.__game;
    const me0 = g.state().player.pos;
    const target = g
      .shownActors()
      .filter((a: any) => a.kind === 1 && a.deadFrame < 0)
      .sort((a: any, b: any) => Math.hypot(a.x - me0.x, a.z - me0.z) - Math.hypot(b.x - me0.x, b.z - me0.z))[0];
    let flash = 0;
    for (let i = 0; i < 1200; i++) {
      const t = g.shownActors().find((a: any) => a.id === target.id);
      if (!t || t.deadFrame >= 0) break;
      flash = Math.max(flash, t.flash);
      const fx = g.netFx();
      if (flash > 0 && fx.claimed + fx.late > 0) break;
      const me = g.state().player.pos;
      const dx = t.x - me.x;
      const dz = t.z - me.z;
      const d = Math.hypot(dx, dz);
      g.scriptInput([[1, d < 1.3 ? { attackPressed: true, aimX: dx, aimZ: dz } : { moveX: dx / d, moveZ: dz / d }]]);
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { flash, fx: g.netFx(), numbers: g.combat().markers.filter((m: any) => m.kind === 'hit').length };
  });
  expect(hit.flash).toBeGreaterThan(0.3);
  expect(hit.fx.guessed + hit.fx.late).toBeGreaterThan(0);
  expect(hit.fx.claimed + hit.fx.late).toBeGreaterThan(0);
  expect(hit.numbers).toBeGreaterThan(0);

  // Angry now, it (or its pack) comes to slam the spot you stand on; the warning lies on the meadow.
  const warned = await page.evaluate(async () => {
    const g = window.__game;
    for (let i = 0; i < 1200; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (g.spells().circlesDrawn === 0) continue;
      const p = g.state().player.pos;
      const h = g.circleHeight(p.x, p.z);
      if (h !== null) return { gap: h - g.ground(p.x, p.z), ground: g.ground(p.x, p.z) };
    }
    return null;
  });
  expect(warned, 'a warning was drawn where you stand').not.toBeNull();
  expect(warned!.ground).toBeGreaterThan(5);
  expect(warned!.gap).toBeGreaterThan(0.005);
  expect(warned!.gap).toBeLessThan(0.05);
  expect(errors).toEqual([]);
});
