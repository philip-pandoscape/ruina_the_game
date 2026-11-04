import { test } from '@playwright/test';
// Planning in the tree by clicking, the dashed path and the tooltip; then the island's book.
test('tree planning', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?yard');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  await page.keyboard.press('KeyN');
  await page.waitForTimeout(500);
  await page.mouse.move(560, 300);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -200);
  await page.waitForTimeout(300);
  // A notable on screen, near the middle.
  const at = await page.evaluate(() => {
    const out: Array<{ x: number; y: number; d: number; id: string }> = [];
    for (const g of document.querySelectorAll('#skills .st .n.nt')) {
      const r = g.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x > 100 && x < 1180 && y > 100 && y < 620) out.push({ x, y, d: Math.hypot(x - 640, y - 360), id: g.getAttribute('data-n')! });
    }
    out.sort((a, b) => a.d - b.d);
    return out[0];
  });
  console.log('notable', JSON.stringify(at));
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'scratch/shots/tree-hover.jpg', quality: 85 });
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(300);
  await page.mouse.move(at.x + 4, at.y + 2);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'scratch/shots/tree-planned.jpg', quality: 85 });
  console.log('panel', JSON.stringify(await page.evaluate(() => (window as any).__game.panel())));
  await page.click('#skills [data-act="learn"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'scratch/shots/tree-learned.jpg', quality: 85 });
  console.log('skills', JSON.stringify(await page.evaluate(() => (window as any).__game.skills())));
  console.log('errors', JSON.stringify(errors));
});
test('island book', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?world&test');
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  await page.waitForTimeout(1500);
  await page.keyboard.press('KeyT');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'scratch/shots/book-island.jpg', quality: 85 });
  await page.keyboard.press('KeyN');
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'scratch/shots/tree-island.jpg', quality: 85 });
  console.log('skills', JSON.stringify(await page.evaluate(() => (window as any).__game.skills())));
  console.log('errors', JSON.stringify(errors));
});
