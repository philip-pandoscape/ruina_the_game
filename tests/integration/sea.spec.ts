import { expect, test } from '@playwright/test';

// The sea along the shore. Its foam is drawn by how deep the water is under each point, so it
// depends on the point being where it really is: drawn as one 9 km sheet, the positions the GPU
// worked out across its two triangles were off by metres, and the foam round a lagoon strobed
// thick and thin while the camera turned.

test('the foam round a lagoon holds still as the camera turns @gpu', async ({ page }) => {
  await page.goto('/?world&test');
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 60_000 });
  // On the Windspire's shoulder, looking down over the island to the lagoon on the west coast, the
  // camera turns a fifth of a degree a frame, as a slow pan with the mouse does.
  const counts = await page.evaluate(() => {
    const g = (window as any).__game;
    g.reset();
    g.teleport(24, 264);
    const out: number[] = [];
    const game = document.getElementById('game') as HTMLCanvasElement;
    const copy = document.createElement('canvas');
    copy.width = game.width;
    copy.height = game.height;
    const ctx = copy.getContext('2d', { willReadFrequently: true })!;
    for (let i = 0; i < 12; i++) {
      g.setCamera({ yaw: 3.25 + i * 0.003, pitch: 0.36, distance: 12 });
      g.render();
      ctx.drawImage(game, 0, 0);
      // The lower left of the view, below the horizon: the coast, the lagoon and the islet.
      const w = Math.round(copy.width * 0.4);
      const y0 = Math.round(copy.height * 0.27);
      const h = Math.round(copy.height * 0.15);
      const px = ctx.getImageData(0, y0, w, h).data;
      let foam = 0;
      for (let k = 0; k < px.length; k += 4) if (0.2126 * px[k] + 0.7152 * px[k + 1] + 0.0722 * px[k + 2] > 235) foam++;
      out.push(foam);
    }
    return out;
  });
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const jumps = counts.slice(1).map((c, i) => Math.abs(c - counts[i]));
  expect(mean, `foam pixels per frame: ${counts.join(' ')}`).toBeGreaterThan(20);
  // As one sheet the count leapt from a few dozen to over a thousand and back; steady, it only
  // drifts as the coast slides across the view.
  expect(Math.max(...jumps), `foam pixels per frame: ${counts.join(' ')}`).toBeLessThan(mean * 0.6);
});
