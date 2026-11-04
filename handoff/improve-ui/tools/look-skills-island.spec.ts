import { test } from '@playwright/test';
// The island's skill book and tree, driven through the test API (the loop is paused in ?test):
// swing at the meadow's slimes until the sword levels, then look at the book.
test('island skills', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?world&test');
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 90_000 });
  await page.evaluate(() => (window as any).__game.reset());
  const render = async () => { for (let i = 0; i < 3; i++) await page.evaluate(() => (window as any).__game.render()); };
  const z = await page.evaluate(() => (window as any).__game.zone());
  const meadow = z.places.find((p: any) => p.id === 'meadow');
  await page.evaluate(([x, zz]) => (window as any).__game.teleport(x, zz, 0), [meadow.x, meadow.z]);
  await page.evaluate(() => (window as any).__game.advance(30, {}));
  let swings = 0;
  for (let round = 0; round < 120; round++) {
    const done = await page.evaluate(() => {
      const g = (window as any).__game;
      const p = g.state().player.pos;
      const slimes = g.actors().filter((a: any) => a.alive && /slime/.test(a.kind));
      if (!slimes.length) return 'none';
      slimes.sort((a: any, b: any) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
      const s = slimes[0];
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      if (d > 1.6) {
        // Step in close, facing it.
        const f = Math.atan2(s.x - p.x, s.z - p.z);
        g.teleport(s.x - Math.sin(f) * 1.2, s.z - Math.cos(f) * 1.2, f);
        g.advance(2, {});
      }
      g.advance(1, { attackPressed: true });
      g.advance(14, {});
      return g.skills().xp.sword ?? 0;
    });
    swings++;
    if (done === 'none' || (typeof done === 'number' && done >= 22)) break;
  }
  const after = await page.evaluate(() => (window as any).__game.skills());
  console.log('swings', swings, 'after', JSON.stringify(after));
  await page.evaluate(() => (window as any).__game.openPanel('book'));
  await render();
  await page.screenshot({ path: 'scratch/shots/book-island.jpg', quality: 85 });
  await page.evaluate(() => (window as any).__game.openPanel('tree'));
  await render();
  await page.screenshot({ path: 'scratch/shots/tree-island.jpg', quality: 85 });
  const toasts = await page.evaluate(() => [...document.querySelectorAll('#lui-toasts *')].map((e) => e.textContent).slice(0, 8));
  console.log('toasts', JSON.stringify(toasts));
  console.log('quests', JSON.stringify(await page.evaluate(() => (window as any).__game.life?.()?.quests ?? null)).slice(0, 400));
  console.log('errors', JSON.stringify(errors));
});
