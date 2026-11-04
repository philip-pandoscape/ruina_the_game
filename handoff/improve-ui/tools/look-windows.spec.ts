import { test, type Page } from '@playwright/test';
// Throwaway: shots of the new UI in the game.
const OUT = 'scratch/shots'; // relative to the worktree root (git-ignored)
const g = (page: Page) => ({
  advance: (n: number) => page.evaluate((k) => (window as any).__game.advance(k, {}), n),
  cmd: (c: Record<string, unknown>) => page.evaluate((x) => (window as any).__game.lifeCommand(x), c),
  zone: () => page.evaluate(() => (window as any).__game.zone()),
  teleport: (x: number, z: number, f: number) => page.evaluate(([a, b, c]) => (window as any).__game.teleport(a, b, c), [x, z, f] as const),
  cam: (c: Record<string, number>) => page.evaluate((x) => (window as any).__game.setCamera(x), c),
  render: () => page.evaluate(() => (window as any).__game.render()),
  press: (k: string) => page.evaluate((x) => (window as any).__game.pressLife(x), k),
  close: () => page.evaluate(() => (window as any).__game.closeLifePanel()),
});
async function shot(page: Page, name: string) {
  const w = g(page);
  for (let i = 0; i < 3; i++) await w.render();
  await page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 86 });
}
test('look', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/?world&test');
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 90_000 });
  await page.evaluate(() => (window as any).__game.reset());
  const w = g(page);
  for (const [item, n] of [['seed.sunroot', 12], ['sunroot', 18], ['barley', 9], ['apple', 6], ['egg', 4], ['wool', 7], ['lumber', 20], ['stone', 10], ['deed.farmCart', 1], ['glider.wayfarer', 1], ['whistle.donkey', 1]] as const) await w.cmd({ t: 'grant', item, n });
  await w.cmd({ t: 'grant', coins: 12500, seals: 3 });
  await w.advance(2);
  await w.cmd({ t: 'use', item: 'glider.wayfarer' });
  await w.advance(2);
  const z = await w.zone();
  const near = async (id: string, d: number, yaw: number, dist = 7, pitch = 0.26) => {
    const n = z.npcs.find((x: { id: string }) => x.id === id);
    const f = n.facing + Math.PI;
    await w.teleport(n.x + Math.sin(n.facing) * d, n.z + Math.cos(n.facing) * d, f);
    await w.advance(3);
    await w.cam({ yaw: f + yaw, pitch, distance: dist });
    await w.advance(30);
  };
  await near('mara', 3, -0.4, 8, 0.3);
  await shot(page, 'world');
  await near('hollis', 2.3, 0.6);
  await w.cmd({ t: 'interact' });
  await w.advance(30);
  await shot(page, 'handin');
  await w.close();
  await near('mara', 2.6, 0.5, 9.5, 0.34);
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  await page.locator('.lui-card [data-act="shop"]').click();
  await w.advance(30);
  await page.locator('.lui-card [data-act="buy"]').nth(4).hover();
  await shot(page, 'merchant');
  await w.close();
  await w.press('character');
  await w.advance(40);
  await shot(page, 'character');
  await w.close();
  await w.press('quests');
  await w.advance(2);
  await shot(page, 'log');
  await w.close();
  await w.press('map');
  await w.advance(2);
  await shot(page, 'map');
  console.log('errors', JSON.stringify(errors.slice(0, 8)));
});
