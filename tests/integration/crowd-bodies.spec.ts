import { expect, test } from '@playwright/test';
import { onlineReady } from '../support/game';

// Other players far off are drawn as crowd bodies, those near as heroes up close
// (src/render/open/peersView.ts, CROWD_AT), the switch a crossfade with nobody missing from the
// screen for a frame. An admin's wanderers stand in for other players (crates/server/src/play/bots.rs),
// on Emberholm. Needs the game server with a database (npm run up, or the private rig in
// docs/testing.md).

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

/** Open fields north of Lanternwick, and a spot 70 m further south, toward the town. */
const FIELD = { x: -30, z: -100 };
const AWAY = { x: -30, z: -170 };

test('far off, other players are crowd bodies; coming close, heroes again, fading from one to the other', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`/?as=${fresh('crowd')}&bugs=0`);
  await onlineReady(page);
  const teleport = (at: { x: number; z: number }) => page.evaluate(([x, z]) => window.__game.teleport(x, z), [at.x, at.z] as const);
  const standing = (at: { x: number; z: number }) =>
    page.waitForFunction(([x, z]) => Math.hypot(window.__game.net()!.x - x, window.__game.net()!.z - z) < 3, [at.x, at.z] as const, { timeout: 15_000 });
  await teleport(FIELD);
  await standing(FIELD);
  expect(await page.evaluate(() => window.__game.sendBots(6, 'wanderer', 0))).toBe(true);
  const bots = () => page.evaluate(() => window.__game.peers().filter((p) => p.bot && p.online));
  await page.waitForFunction(() => window.__game.peers().filter((p) => p.bot && p.online).length >= 6, null, { timeout: 20_000 });

  // Up close: every one of them a hero.
  await page.waitForFunction(
    () =>
      window.__game
        .peers()
        .filter((p) => p.bot && p.online && p.away < 30)
        .every((p) => p.look.body === 'hero'),
    null,
    {
      timeout: 10_000,
      polling: 'raf',
    },
  );
  expect((await bots()).filter((p) => p.away < 30).length).toBeGreaterThan(0);

  // 70 m off: crowd bodies, one instanced draw for all of them.
  await teleport(AWAY);
  await standing(AWAY);
  await page.waitForFunction(
    () => {
      const far = window.__game.peers().filter((p) => p.bot && p.online && p.away > 45);
      return far.length >= 6 && far.every((p) => p.look.body === 'crowd' && p.look.crowd === 1);
    },
    null,
    { timeout: 10_000, polling: 'raf' },
  );
  expect(await page.evaluate(() => window.__game.crowdBodies())).toBeGreaterThanOrEqual(6);

  // Back among them: each fades from its crowd body into its hero, drawn as one or the other or both
  // in every frame, never neither.
  await teleport(FIELD);
  const seen = await page.evaluate(
    async ([x, z]) => {
      const g = window.__game;
      const looks: Record<number, string[]> = {};
      const t0 = performance.now();
      while (performance.now() - t0 < 6000) {
        await new Promise((r) => requestAnimationFrame(r));
        for (const p of g.peers()) {
          if (!p.bot || !p.online) continue;
          const list = (looks[p.id] ??= []);
          if (list[list.length - 1] !== p.look.body) list.push(p.look.body);
        }
        // Once back among them, until every one near is a hero again.
        const back = Math.hypot(g.net()!.x - x, g.net()!.z - z) < 3;
        if (back && g.peers().every((p) => !p.bot || !p.online || p.away > 30 || p.look.body === 'hero')) break;
      }
      return looks;
    },
    [FIELD.x, FIELD.z] as const,
  );
  const near = (await bots()).filter((p) => p.away < 30);
  expect(near.length).toBeGreaterThan(0);
  for (const p of near) {
    const went = seen[p.id] ?? [];
    expect(went, `bot ${p.id}`).not.toContain('none');
    expect(went[went.length - 1], `bot ${p.id}`).toBe('hero');
    // From the crowd body to the hero by way of both at once, not a cut.
    if (went[0] === 'crowd') expect(went, `bot ${p.id}`).toContain('both');
  }
  expect(errors).toEqual([]);
});
