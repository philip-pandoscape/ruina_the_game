import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { HERO_MOVES } from '../../src/render/detail/moves';

// Every clip the made hero's moves play (moves.ts), retargeted onto it as the game does it
// (retarget.ts), held against its own skeleton in the content library's retargeting check
// (/dev/library.html#/retarget/<file>:<clip>, src/dev/library/subjects/retarget.ts) frame by frame: each
// bone points where the source's does, and the feet stay out of the ground. RECORD=1 keeps the
// frames (test-results/retarget/<file>-<clip>/) for a GIF.

const clips = new Map<string, { file: string; clip: string }>();
for (const sets of Object.values(HERO_MOVES)) {
  for (const set of Object.values(sets)) {
    for (const m of set) {
      if (!m) continue;
      const clip = [...new Set(m.parts.map((p) => p.clip))].join('~');
      clips.set(`${m.file}:${clip}`, { file: m.file, clip });
    }
  }
}

for (const { file, clip } of clips.values()) {
  test(`${file} ${clip}: every bone of the made hero follows the clip's`, async ({ page }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`/dev/library.html?test#/retarget/${file}:${encodeURIComponent(clip)}`);
    await page.waitForFunction(() => (window as any).__library?.ready === true, null, { timeout: 120_000 });
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => (window as any).__library.state().anim)).toBe(`${file}:${clip}`);
    const seconds: number = await page.evaluate(() => (window as any).__library.take().seconds);
    const dir = `test-results/retarget/${file}-${clip.replace(/[^A-Za-z0-9_]/g, '_')}`;
    if (process.env.RECORD) {
      mkdirSync(dir, { recursive: true });
      await page.evaluate(() => (window as any).__library.pause());
    }
    let mean = 0;
    let worst = 0;
    let worstBone = '';
    let lowest = Infinity;
    let n = 0;
    for (let i = 0, t = 0; t <= seconds; i++, t = i / 30) {
      const r = await page.evaluate((tt) => (window as any).__library.take().measureAt(tt), t);
      mean += r.mean;
      n++;
      if (r.worst > worst) {
        worst = r.worst;
        worstBone = `${r.bone} at ${t.toFixed(2)} s`;
      }
      lowest = Math.min(lowest, r.feet);
      if (process.env.RECORD) {
        await page.evaluate((f) => (window as any).__library.seek(f), Math.round(t * 60));
        const drawn = await page.evaluate(() => (window as any).__library.app.frameCount as number);
        await page.waitForFunction((d) => (window as any).__library.app.frameCount > d + 1, drawn);
        await page.locator('.viewport').screenshot({ path: `${dir}/${String(i).padStart(3, '0')}.png` });
      }
    }
    mean /= n;
    console.log(
      `${file} ${clip}: ${n} frames, bones off by ${mean.toFixed(2)} deg on average, ${worst.toFixed(2)} deg at worst (${worstBone}); lowest ankle ${(lowest * 100).toFixed(1)} cm from where it stands`,
    );
    expect(mean).toBeLessThan(0.1);
    expect(worst).toBeLessThan(1);
    expect(lowest).toBeGreaterThan(-0.025);
  });
}

test('the check shows a clip beside its source, frame by frame, with how far it is off', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/dev/library.html?test#/retarget/hero_swings:Sword_Regular_C?f=20');
  await page.waitForFunction(() => (window as any).__library?.ready === true, null, { timeout: 120_000 });
  const seen = await page.evaluate(() => {
    const L = (window as any).__library;
    L.bakeAll();
    const take = L.take();
    return {
      state: L.state(),
      line: take.info(20).line as string,
      bones: L.bones() as string[],
      frames: take.frames as number,
      seconds: take.seconds as number,
    };
  });
  expect(seen.state.frame).toBe(20);
  expect(seen.state.baked).toBe(seen.frames);
  expect(seen.frames).toBe(Math.floor(seen.seconds * 60) + 1);
  expect(seen.line).toMatch(/bones [\d.]+° off on average, [\d.]+° at worst \(\w+\)/);
  // Its own bones to correct by hand, as any animation's.
  for (const b of ['hips', 'armR', 'handR', 'footL']) expect(seen.bones).toContain(b);
  const drawn = await page.evaluate(() => (window as any).__library.app.frameCount as number);
  await page.waitForFunction((d) => (window as any).__library.app.frameCount > d + 1, drawn);
  await page.locator('.viewport').screenshot({ path: 'screenshots/retarget-Sword_Regular_C.png' });
  expect(errors).toEqual([]);
});
