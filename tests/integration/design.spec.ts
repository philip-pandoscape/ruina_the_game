import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

// The design bible (design/index.html, drawn by design/bible.ts) reads the game's own modules, so a
// change to the content or the rules can break it without breaking the game. Every part must draw
// without a console error and show what the data and the tracker hold.

const json = (path: string) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));

test('the design bible draws from the game data without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  // The web fonts are decoration; the test should not need the network.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.goto('/design/');
  await page.waitForSelector('html[data-ready]', { timeout: 60_000 });
  expect(errors).toEqual([]);

  const status = json('design/status.json');
  await expect(page.locator('#ledger tbody tr')).toHaveCount(status.features.length);
  await expect(page.locator('#vehicleTable tbody tr')).toHaveCount(json('shared/vehicles.json').vehicles.length);
  await expect(page.locator('#questFlow .node')).toHaveCount(json('shared/quests.json').quests.length);
  await expect(page.locator('#sessions .entry')).toHaveCount(status.sessions.length);
  await expect(page.locator('#facts')).toContainText('trees');
  // It is the bible's Development tab: it leads to the bible, which says how the game works.
  await expect(page.locator('.rail a.bible-link')).toHaveAttribute('href', '/bible/');

  // The tracker's filters.
  await page.click('#trackerTools button[data-st="done"]');
  await expect(page.locator('#ledger tbody tr')).toHaveCount(status.features.filter((f: { status: string }) => f.status === 'done').length);

  // The map is the region the generator grew: many colours of land and water, not a blank canvas.
  const colours = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('#worldMap')!;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return seen.size;
  });
  expect(colours).toBeGreaterThan(50);
});

test("the UI design system page draws its specimens with the game's own styles", async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/design/ui.html');
  await page.waitForSelector('html[data-ready]', { timeout: 60_000 });
  expect(errors).toEqual([]);
  await expect(page.locator('#buttons .lui-btn')).toHaveCount(6);
  await expect(page.locator('#windows .mw')).toHaveCount(2);
  expect(await page.locator('#swatches .swatch').count()).toBeGreaterThan(15);
  // The Title Case example converts as the rule says.
  await page.fill('#tcIn', 'sell all produce for the merchant');
  await expect(page.locator('#tcOut')).toHaveText('→ Sell All Produce for the Merchant');
  // The live specimen's right-click menu.
  await page.locator('#items .ib.big').click({ button: 'right' });
  await expect(page.locator('#ui .ctx .ctx-i.primary')).toHaveText('Place');
  await page.screenshot({ path: 'screenshots/design-ui.png', fullPage: true });
});
