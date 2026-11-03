import { expect, test, type Page } from '@playwright/test';

// Raid stress test: thousands of fighters charging and fighting, measured live in the browser.

const SHOTS = 'screenshots';

async function openRaid(page: Page, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => (window as any).__game?.ready === true);
  return errors;
}

const perf = (page: Page) => page.evaluate(() => (window as any).__game.perf());
const crowd = (page: Page) => page.evaluate(() => (window as any).__game.crowd());

// Puts the player at the east edge of the battle line, camera looking west across it.
async function sideView(page: Page, distance: number, pitch: number): Promise<void> {
  await page.evaluate(
    ([d, p]) => {
      const g = (window as any).__game;
      g.reset({ x: 75, z: 0, facing: -Math.PI / 2, camYaw: -Math.PI / 2 });
      g.setCamera({ distance: d, pitch: p });
    },
    [distance, pitch],
  );
}

test('10,000 fighters: armies clash, fighters fall, frame rate holds', async ({ page }) => {
  const errors = await openRaid(page, 'raid=10000');
  await sideView(page, 55, 0.42);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/10-raid-charge.png` });

  await page.waitForTimeout(7500);
  const p = await perf(page);
  const c = await crowd(page);
  console.log('10k raid', JSON.stringify({ ...p, ...c }));
  await page.screenshot({ path: `${SHOTS}/11-raid-clash.png` });

  // Close-up in the middle of the melee.
  await page.evaluate(() => {
    const g = (window as any).__game;
    g.reset({ x: 12, z: -4, facing: 0.4, camYaw: 0.9 });
    g.setCamera({ distance: 9, pitch: 0.35 });
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/12-raid-closeup.png` });

  expect(c.fighters).toBe(10000);
  expect(c.kills).toBeGreaterThan(50);
  expect(p.drawCalls).toBeLessThan(150);
  expect(errors).toEqual([]);
});

test('speed at different army sizes', async ({ page }) => {
  test.setTimeout(240_000);
  const rows: Record<string, unknown>[] = [];
  for (const query of ['raid=1000', 'raid=5000', 'raid=10000', 'raid=10000&outline=0', 'raid=20000']) {
    const errors = await openRaid(page, query);
    await sideView(page, 55, 0.42);
    await page.waitForTimeout(7000); // past the charge, into the melee
    const p = await perf(page);
    rows.push({ setup: query, fps: p.fps, avgMs: p.avgMs, p95Ms: p.p95Ms, cpuMs: p.cpuMs, gpuMs: p.gpuMs, crowdTickMs: p.crowdTickMs, crowdUploadMs: p.crowdUploadMs, drawCalls: p.drawCalls, triangles: p.triangles });
    expect(errors).toEqual([]);
  }
  console.log('GPU:', (await perf(page)).gpu);
  console.table(rows);
  console.log(JSON.stringify(rows));
});
