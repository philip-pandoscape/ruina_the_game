import { expect, test, type Page } from '@playwright/test';
import { gameReady } from '../support/game';

// The buildings you can walk into (src/content/buildings.ts, src/render/village): their plans fit
// their footprints and the kit, the rules wall them with their doorways open, and in the game you
// walk in through a door, are drawn the room cut open, and climb the stairs. The server plays the
// same walls and stairs from the baked island: tests/conformance/world.test.ts walks into the inn
// and up its stairs on both sides.

const SHOTS = 'screenshots';

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?world&test');
  await gameReady(page, 60_000);
  await page.evaluate(() => window.__game.reset());
  await page.waitForFunction(() => window.__game.assetsReady === true, null, { timeout: 90_000 });
  return errors;
}

test('every piece and prop the buildings are made of is in the kit', async ({ page }) => {
  await open(page);
  const missing = await page.evaluate(async () => {
    const kitPath = '/src/render/village/kit.ts';
    const asmPath = '/src/render/village/assemble.ts';
    const contentPath = '/src/content/buildings.ts';
    const kit = await (await import(/* @vite-ignore */ kitPath)).loadKit();
    const { assemble } = await import(/* @vite-ignore */ asmPath);
    const c = await import(/* @vite-ignore */ contentPath);
    const out: string[] = [];
    const ids = c.buildingPlanIds();
    for (const id of ids)
      for (const stage of [1, 2, 3, 4]) {
        const a = assemble(c.buildingPlan(id), 1, stage);
        for (const p of [...a.pieces, ...a.doors]) if (!kit.pieces.has(p.piece)) out.push(`${id}: ${p.piece}`);
      }
    for (const id of c.furnitureIds()) {
      const f = c.furnitureDef(id);
      for (const m of [f.model, ...(f.parts ?? []).map((p: { model: string }) => p.model)])
        if (m && !m.startsWith('@') && !kit.pieces.has(m)) out.push(`${id}: ${m}`);
    }
    return [...new Set(out)];
  });
  expect(missing).toEqual([]);
});

test('into the inn through its door and up its stairs: cut open above you, the door open, the lamps lit', async ({ page }) => {
  const errors = await open(page);
  const w = {
    advance: (n: number, a: Record<string, number> = {}) => page.evaluate(([f, x]) => window.__game.advance(f, x), [n, a] as const),
    indoors: () => page.evaluate(() => window.__game.indoors()),
    stats: () => page.evaluate(() => window.__game.villageStats()),
  };
  const stats = await w.stats();
  expect(stats.drawn, 'the village is drawn').toBeGreaterThan(10);
  expect(
    stats.list.some((m: { name: string }) => m.name.startsWith('doors:')),
    'with doors',
  ).toBe(true);
  expect(
    stats.list.some((m: { name: string }) => m.name === 'fires'),
    'and fires in the hearths',
  ).toBe(true);
  // The inn faces south: its plan's +X is the world's -X, its +Z the world's -Z.
  await page.evaluate(() => window.__game.teleport(-24, -226.5, 0));
  await w.advance(50, { moveZ: 1 });
  expect(await w.indoors(), 'in through the door').toMatchObject({ id: 'inn', storey: 0 });
  await page.evaluate(() => window.__game.setCamera({ yaw: 0.6, pitch: 0.5, distance: 8 }));
  await w.advance(2);
  await page.screenshot({ path: `${SHOTS}/village-inn.png` });
  await w.advance(50, { moveX: -0.952, moveZ: 0.307 });
  await w.advance(12, { moveZ: 1 });
  await w.advance(70, { moveX: 1 });
  expect(await w.indoors(), 'up the stairs').toMatchObject({ id: 'inn', storey: 1 });
  await page.screenshot({ path: `${SHOTS}/village-inn-upstairs.png` });
  // Back out through the door the way you came in: down the stairs and out.
  await w.advance(80, { moveX: -1 });
  expect(await w.indoors(), 'back down').toMatchObject({ id: 'inn', storey: 0 });
  expect(errors).toEqual([]);
});
