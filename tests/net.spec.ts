import { expect, test, type Page } from '@playwright/test';
import { serverBuilt, TestServer } from './testServer';

// Networked raid: the browser draws the battle streamed by the Rust server. The tests start their
// own server (10,000 bots) on a separate port.

const SHOTS = 'screenshots';
const server = new TestServer(7793, ['--bots', '10000']);
const SERVER = server.url;

test.skip(!serverBuilt, 'build the server first: cargo build --release --manifest-path server/Cargo.toml');
test.beforeAll(async () => server.start());
test.afterAll(() => server.stop());

const crowd = (page: Page) => page.evaluate(() => (window as any).__game.crowd());
const perf = (page: Page) => page.evaluate(() => (window as any).__game.perf());

test('browser draws the battle streamed from the Rust server', { tag: '@gpu' }, async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`/?server=${encodeURIComponent(SERVER)}&play=0`); // watch without joining
  await page.waitForFunction(() => (window as any).__game?.crowd()?.fighters > 0);
  // The once-a-second message tells us about every fighter.
  await page.waitForFunction(() => { const c = (window as any).__game.crowd(); return c.known >= c.fighters * 0.9; }, null, { timeout: 5000 });

  // Stand in the middle of the melee, so the server sends lots of nearby detail.
  await page.evaluate(() => {
    const g = (window as any).__game;
    g.reset({ x: 10, z: -4, facing: 0.4, camYaw: 0.9 });
    g.setCamera({ distance: 9, pitch: 0.35 });
  });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SHOTS}/20-net-closeup.png` });
  const c = await crowd(page);
  const p = await perf(page);
  console.log('networked raid', JSON.stringify({ fps: p.fps, gpuMs: p.gpuMs, cpuMs: p.cpuMs, downloadKBps: p.downloadKBps, messagesPerSec: p.messagesPerSec, known: c.known, server: c.server }));

  // Wide view across the battle line.
  await page.evaluate(() => {
    const g = (window as any).__game;
    g.reset({ x: 75, z: 0, facing: -Math.PI / 2, camYaw: -Math.PI / 2 });
    g.setCamera({ distance: 55, pitch: 0.42 });
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/21-net-wide.png` });

  expect(c.connected).toBe(true);
  expect(c.known).toBeGreaterThanOrEqual(c.fighters * 0.9);
  expect(p.downloadKBps).toBeGreaterThan(50);
  expect(c.server?.realPlayers).toBeGreaterThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('fallen fighters sink away before respawning: nobody visibly slides across the field', { tag: '@gpu' }, async ({ page }) => {
  await page.goto(`/?server=${encodeURIComponent(SERVER)}&play=0`);
  await page.waitForFunction(
    () => {
      const c = (window as any).__game?.crowd();
      return c && c.fighters > 0 && c.known >= c.fighters * 0.9;
    },
    null,
    { timeout: 8000 },
  );
  // Watch the battle from above, so plenty of fighters fall and respawn in view.
  await page.evaluate(() => {
    const g = (window as any).__game;
    g.reset({ x: 0, z: -40, facing: 0, camYaw: 0 });
    g.setCamera({ distance: 70, pitch: 0.7 });
  });
  await page.waitForTimeout(1500);

  // Check every fighter every frame for 6 seconds.
  const r = await page.evaluate(async () => {
    const g = (window as any).__game;
    const n: number = g.crowd().fighters;
    const fast = new Float32Array(n); // distance covered in the current run of very fast frames
    const counted = new Uint8Array(n);
    let last: Float32Array | null = null;
    let lastT = 0;
    let frames = 0;
    let slides = 0;
    let visibleJumps = 0;
    let hiddenJumps = 0;
    const end = performance.now() + 6000;
    while (performance.now() < end) {
      await new Promise((done) => requestAnimationFrame(done));
      const cur: Float32Array = g.crowdRoots();
      const t = performance.now();
      if (last) {
        const dt = Math.max(0.001, (t - lastT) / 1000);
        for (let i = 0; i < n; i++) {
          const k = i * 4;
          const d = Math.hypot(cur[k] - last[k], cur[k + 2] - last[k + 2]);
          const visible = cur[k + 1] > -0.5 && last[k + 1] > -0.5;
          if (d > 3) {
            if (visible) visibleJumps++;
            else hiddenJumps++;
          }
          if (visible && d / dt > 15) {
            fast[i] += d;
            if (fast[i] > 10 && !counted[i]) {
              slides++; // moved more than 10 m at over 15 m/s while visible: sliding across the field
              counted[i] = 1;
            }
          } else {
            fast[i] = 0;
            counted[i] = 0;
          }
        }
      }
      last = cur;
      lastT = t;
      frames++;
    }
    return { frames, hiddenJumps, visibleJumps, slides };
  });
  console.log('respawns', JSON.stringify(r));
  await page.screenshot({ path: `${SHOTS}/22-net-respawns.png` });
  expect(r.hiddenJumps).toBeGreaterThan(0); // fighters did respawn while we watched...
  expect(r.visibleJumps).toBe(0); // ...without ever visibly jumping...
  expect(r.slides).toBe(0); // ...or sliding across the battlefield
});
