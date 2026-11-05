import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { HERO_MOVES } from '../src/render/detail/moves';

// Every clip the made hero's moves play (moves.ts), retargeted onto it as the game does it
// (retarget.ts), held against its own skeleton on /retarget.html frame by frame: each bone points
// where the source's does, and the feet stay out of the ground. RECORD=1 keeps the frames
// (test-results/retarget/<file>-<clip>/) for a GIF.

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
    await page.setViewportSize({ width: 900, height: 620 });
    await page.goto(`/retarget.html?look=new&file=${file}&clip=${encodeURIComponent(clip)}${process.env.RECORD ? '' : '&draw=0'}`);
    await page.waitForFunction(() => (window as any).__retarget?.ready === true, null, { timeout: 120_000 });
    expect(errors).toEqual([]);
    const seconds: number = await page.evaluate(() => (window as any).__retarget.seconds);
    const dir = `test-results/retarget/${file}-${clip.replace(/[^A-Za-z0-9_]/g, '_')}`;
    if (process.env.RECORD) mkdirSync(dir, { recursive: true });
    let mean = 0;
    let worst = 0;
    let worstBone = '';
    let lowest = Infinity;
    let n = 0;
    for (let i = 0, t = 0; t <= seconds; i++, t = i / 30) {
      const r = await page.evaluate((tt) => (window as any).__retarget.seek(tt), t);
      mean += r.mean;
      n++;
      if (r.worst > worst) {
        worst = r.worst;
        worstBone = `${r.bone} at ${t.toFixed(2)} s`;
      }
      lowest = Math.min(lowest, r.feet);
      if (process.env.RECORD) await page.screenshot({ path: `${dir}/${String(i).padStart(3, '0')}.png` });
    }
    mean /= n;
    console.log(`${file} ${clip}: ${n} frames, bones off by ${mean.toFixed(2)} deg on average, ${worst.toFixed(2)} deg at worst (${worstBone}); lowest ankle ${(lowest * 100).toFixed(1)} cm from where it stands`);
    expect(mean).toBeLessThan(0.1);
    expect(worst).toBeLessThan(1);
    expect(lowest).toBeGreaterThan(-0.025);
  });
}
