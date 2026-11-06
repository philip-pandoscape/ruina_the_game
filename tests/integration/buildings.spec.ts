import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Its tests share nothing, so they spread across the workers (playwright.config.ts).
test.describe.configure({ mode: 'parallel' });

// The buildings you can walk into in the content library's buildings gallery
// (/dev/library.html#/buildings/<plan>, src/dev/library/galleries/buildings.ts): every plan is drawn from
// the village kit without an error, cut open, with the rules' walls over it, mirrored and by night.
// The plans themselves: tests/unit/buildings.test.ts; walking in, in the game: village.spec.ts. The
// screenshots in screenshots/ are for a human.

const SHOTS = 'screenshots';

interface Solid {
  id: string;
  boxes: number;
  decks: number;
  posts: number;
}

async function open(page: Page, plan: string, options: Record<string, string> = {}): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  const q = new URLSearchParams(options).toString();
  await page.goto(`/dev/library.html?test#/buildings/${plan}${q ? `?${q}` : ''}`);
  await page.waitForFunction(() => (window as any).__library?.ready === true, null, { timeout: 90_000 });
  // The kit and its furniture load after the page: drawn whole only once they have.
  await page.waitForFunction(() => (window as any).__library.state().ready === true, null, { timeout: 90_000 });
  return errors;
}

const gallery = (page: Page) =>
  page.evaluate(() => {
    const g = (window as any).__library.gallery();
    return { plans: g.plans as string[], colliders: g.colliders as Solid[], cut: g.cut as number | null, night: g.night as boolean };
  });

test('every plan is drawn from the kit, side by side, with walls, decks and posts of its own', async ({ page }) => {
  const errors = await open(page, 'all');
  const g = await gallery(page);
  const plans = (JSON.parse(readFileSync(new URL('../../shared/buildings.json', import.meta.url), 'utf8')) as { plans: Array<{ id: string }> }).plans.map(
    (p) => p.id,
  );
  expect(g.plans).toEqual(plans);
  for (const s of g.colliders) {
    expect.soft(s.boxes, `${s.id}: walls`).toBeGreaterThan(3);
    expect.soft(s.decks + s.posts, `${s.id}: floors, treads or furniture`).toBeGreaterThan(0);
  }
  await page.locator('.gallery').screenshot({ path: `${SHOTS}/buildings-all.png` });
  expect(errors).toEqual([]);
});

test('one plan cut open above its ground floor, its walls over it, mirrored, by night', async ({ page }) => {
  const errors = await open(page, 'inn', { cut: '0', colliders: '1', mirror: '1', night: '1' });
  const g = await gallery(page);
  expect(g.plans).toEqual(['inn']);
  expect(g.cut).toBe(0);
  expect(g.night).toBe(true);
  expect(await page.locator('.gallery .gl-label').textContent()).toBe('inn\ncut open above storey 0');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/buildings/inn?cut=0&colliders=1&night=1&mirror=1');
  await page.locator('.gallery').screenshot({ path: `${SHOTS}/buildings-inn-cut.png` });
  expect(errors).toEqual([]);
});
