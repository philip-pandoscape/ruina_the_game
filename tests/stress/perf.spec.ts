import { expect, test } from '@playwright/test';
import { openGame } from '../support/game';

// What the training yard costs while it runs live, in a real browser on a real GPU: the stress tier
// plays one test at a time, so these numbers mean something.

test('performance snapshot while running live', async ({ page }) => {
  const errors = await openGame(page, '/?test=yard');
  await page.evaluate(() => window.__game.reset({}));
  await page.evaluate(() => window.__game.setPaused(false));
  // Three seconds of running across the yard, as a player would, with the game's own clock.
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(3000);
  await page.keyboard.up('KeyD');
  const perf = await page.evaluate(() => window.__game.perf());
  console.log('live perf (headless browser)', perf);
  expect(perf.drawCalls).toBeLessThan(300);
  expect(errors).toEqual([]);
});
