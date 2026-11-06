import { expect, test } from '@playwright/test';
import { creatureIds } from '../../src/content/creatures/index';

// Close-up bodies drawn as their content builds them, on the content library's creature bench
// (/dev/library.html#/rig-<id>/rest, src/library/subjects/rigs.ts): each rig with each weapon in its
// hand, without an error, its joints there to pose. The pictures in screenshots/ are for a human.
// That the content describes a whole creature (every joint the poses turn, the weapons in the right
// hands, a skeleton that hangs together) needs no drawing: tests/unit/creatures.test.ts.

const SHOTS = 'screenshots';

test('looks right', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/dev/library.html?test');
  await page.waitForFunction(() => (window as any).__library?.ready === true, null, { timeout: 90_000 });
  for (const id of creatureIds()) {
    for (const weapon of ['sword', 'bow']) {
      await page.evaluate(([i, w]) => (window as any).__library.open(`rig-${i}`, 'rest', { attach: w }), [id, weapon] as const);
      const shown = await page.evaluate(() => {
        const L = (window as any).__library;
        // The body alone, as the bench drew it: no skeleton over it.
        if (L.app.prefs.skeleton) L.app.togglePref('skeleton');
        return { subject: L.state().subject, bones: L.bones().length, line: L.take().info(0).line as string };
      });
      expect(shown.subject).toBe(`rig-${id}`);
      expect(shown.line).toContain(`holding the ${weapon}`);
      expect(shown.bones).toBeGreaterThan(20);
      const frames = await page.evaluate(() => (window as any).__library.app.frameCount as number);
      await page.waitForFunction((f) => (window as any).__library.app.frameCount > f + 2, frames);
      await page.locator('.viewport').screenshot({ path: `${SHOTS}/creature-${id}-${weapon}.png` });
    }
  }
  expect(errors).toEqual([]);
});
