import { expect, test, type Page } from '@playwright/test';

// Its tests share nothing, so they spread across the workers (playwright.config.ts).
test.describe.configure({ mode: 'parallel' });

// Species drawn as the crowd draws them, on the content library's crowd bench
// (/dev/library.html#/crowds/<species>/<clip>, src/dev/library/galleries/crowds.ts): any number of a
// species in the same two draw calls, and pictures of each, one close up and a crowd of them, for a
// human to look at afterwards (screenshots/). Everything that is numbers off the baked clips (the
// budget, the clips, how each one moves, the hero baked as it poses) needs no drawing:
// tests/unit/species.test.ts.

const SHOTS = 'screenshots';

interface Loaded {
  id: string;
  clips: Array<{ name: string; frames: number; fps: number; loop: boolean }>;
}

const bench = async (page: Page, id: string) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  // Still, so nothing is drawn but what a test asks for.
  await page.goto(`/dev/library.html?test#/crowds/${id}/idle?play=0`);
  await page.waitForFunction(() => (window as any).__library?.ready === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => typeof (window as any).__library.gallery()?.load === 'function');
  return errors;
};

const load = (page: Page, id: string, capacity = 1) =>
  page.evaluate(([i, c]) => (window as any).__library.gallery().load(i, c) as Loaded, [id, capacity] as const);

// What every species must satisfy when drawn, whatever shape it is.
const SPECIES = [
  { id: 'fighter', still: 'idle' },
  { id: 'slime', still: 'idle' },
  { id: 'quadruped', still: 'idle' },
] as const;

test.describe('species contract', () => {
  for (const spec of SPECIES) {
    test(`${spec.id} draws any number of itself in two calls`, async ({ page }) => {
      // The bodies and the ground. Instancing means the count does not move with the crowd.
      await bench(page, spec.id);
      await load(page, spec.id, 2000);
      const one = await page.evaluate((c) => (window as any).__library.gallery().grid(1, c), spec.still);
      const many = await page.evaluate((c) => (window as any).__library.gallery().grid(2000, c), spec.still);
      expect(one.draws).toBe(2);
      expect(many.draws).toBe(2);
      expect(many.triangles).toBeGreaterThan(one.triangles * 1000);
    });
  }
});

test.describe('looks right', () => {
  for (const spec of SPECIES) {
    test(`${spec.id} renders`, async ({ page }) => {
      const errors = await bench(page, spec.id);
      await load(page, spec.id, 400);
      const moving = (await load(page, spec.id, 400)).clips.find((c) => c.name !== spec.still)?.name ?? spec.still;
      await page.evaluate((c) => (window as any).__library.gallery().solo(c, 0.4), moving);
      await page.locator('.gallery').screenshot({ path: `${SHOTS}/species-${spec.id}-solo.png` });
      await page.evaluate((c) => (window as any).__library.gallery().grid(400, c), moving);
      await page.locator('.gallery').screenshot({ path: `${SHOTS}/species-${spec.id}-crowd.png` });
      expect(errors).toEqual([]);
    });
  }
});

test('the bench shows what its address asks: a crowd of a clip, still, and what a frame of it costs', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/dev/library.html?test#/crowds/slime/hop?show=crowd&count=100&play=0');
  await page.waitForFunction(() => (window as any).__library?.ready === true, null, { timeout: 90_000 });
  const label = await page.locator('.gallery .gl-label').textContent();
  expect(label).toBe('slime  joints=5  boxes=6  tris=72');
  const stats = await page.evaluate(() => (window as any).__library.gallery().stats());
  expect(stats.draws).toBe(2);
  const cost = await page.evaluate(() => (window as any).__library.gallery().bench(100, 'hop', 300));
  expect(cost.count).toBe(100);
  expect(cost.cpuMsPerFrame).toBeGreaterThan(0);
  expect(cost.sustainedFps).toBeGreaterThan(0);
  // Its numbers say so, and measure again from a button.
  await page.locator('.tabs').getByRole('button', { name: 'Numbers' }).click();
  await expect(page.locator('.pane')).toContainText('What a Frame Costs');
  await page.locator('.pane').getByRole('button', { name: 'Measure a Crowd of 100' }).click();
  await expect(page.locator('.pane')).toContainText('sustainedFps');
  expect(errors).toEqual([]);
});
