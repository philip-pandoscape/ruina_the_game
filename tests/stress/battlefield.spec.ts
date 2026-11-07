import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { battlefield, stand } from '../support/battlefield';

// A browser among a crowd (R10.24, the proof at scale; R10.12's stress test): an admin stands at
// the battlefield's south end, looking over it, while N bots fight across it (to the server each
// bot is a whole player, to the browser today a whole hero). For each N it measures this browser's
// frames as requestAnimationFrame sees them (the median, the 95th and 99th percentiles, the
// longest), the server's tick (the rules and the sim's publishing apart, from the admin's stats) and the
// update's size. These are the numbers the wire for crowds (R10.8: each client sent what's near it,
// compact and binary, far bodies drawn by the crowd renderer) is measured against; the server's
// side at scale, without a browser, is the load harness's (crates/tools/src/bin/loadtest.rs,
// docs/testing.md). CROWD=0,32,64,128,256 picks the sizes (the server takes up to 4096 here). The
// numbers go to scratch/scale/browser-crowd.json. Tagged @gpu: it times frames.

const SIZES = (process.env.CROWD ?? '0,32,64,128,256').split(',').map(Number);
/** Frames measured at each size. */
const FRAMES = 300;
/** Where the admin watches from: the south end, facing north over the whole arena. */
const POST = { x: 0, z: -57 };
const GROUP = 16;

const { fighter } = battlefield(7960, { MAX_BOTS: '4096' });

/**
 * Where `n` bots go: groups of GROUP, half a side, in a grid over each side's half of the arena (x
 * from -50 to 50, 8 to 52 m from the middle), as the load harness lays them out.
 */
function layout(n: number): Array<{ team: number; x: number; z: number; n: number }> {
  const out: Array<{ team: number; x: number; z: number; n: number }> = [];
  for (const team of [0, 1]) {
    const mine = Math.floor(n / 2) + (team === 0 ? n % 2 : 0);
    const groups = Math.ceil(mine / GROUP);
    if (!groups) continue;
    const cols = Math.min(groups, Math.max(1, Math.ceil(Math.sqrt((groups * 100) / 44))));
    const rows = Math.ceil(groups / cols);
    for (let g = 0; g < groups; g++) {
      const d = 8 + (44 * (Math.floor(g / cols) + 0.5)) / rows;
      out.push({ team, x: -50 + (100 * ((g % cols) + 0.5)) / cols, z: team === 0 ? -d : d, n: Math.min(GROUP, mine - g * GROUP) });
    }
  }
  return out;
}

/** The lengths of the next `n` frames, ms, as requestAnimationFrame sees them. */
const frameTimes = (page: Page, n: number) =>
  page.evaluate(
    (n) =>
      new Promise<number[]>((resolve) => {
        const out: number[] = [];
        let last = -1;
        const step = (t: number) => {
          if (last >= 0) out.push(t - last);
          last = t;
          if (out.length < n) requestAnimationFrame(step);
          else resolve(out);
        };
        requestAnimationFrame(step);
      }),
    n,
  );

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : Number.NaN);
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const median = (xs: number[]) => pct(sorted(xs), 0.5);
const r2 = (v: number) => Math.round(v * 100) / 100;

test('a browser among a crowd: frames, the server tick and the update, with 0 to 256 bots fighting', { tag: '@gpu' }, async ({ browser }) => {
  test.setTimeout(120_000 + SIZES.length * 60_000);
  const { page, errors } = await fighter(browser, 0, undefined, { place: false, bots: true, viewport: { width: 1280, height: 720 } });
  const rows = [];
  for (const n of SIZES) {
    // The bots there go, and this size's come, a group at a time round where the admin is put.
    expect(await page.evaluate(() => window.__game.sendBots(0))).toBe(true);
    await page.waitForFunction(() => window.__game.bots().length === 0, null, { timeout: 15_000 });
    for (const g of layout(n)) {
      await page.evaluate(([x, z]) => window.__game.teleport(x, z, 0), [g.x, g.z] as const);
      await page.evaluate(([n, team]) => window.__game.sendBots(n, 'skirmisher', team), [g.n, g.team] as const);
    }
    await stand(page, POST.x, POST.z, 0);
    await page.waitForFunction((n) => window.__game.bots().length >= n, n, { timeout: 30_000 });
    // Two seconds of ticks to settle: everyone drawn, the fight under way, the stats said again.
    const t = await page.evaluate(() => window.__game.online()?.ticks ?? 0);
    await page.waitForFunction((t) => (window.__game.online()?.ticks ?? 0) > t + 40, t, { timeout: 30_000 });
    const frames = sorted(await frameTimes(page, FRAMES));
    const s = (await page.evaluate(() => window.__game.net().world))!;
    const perf = await page.evaluate(() => window.__game.perf());
    const ticks = s.ticks ?? [];
    rows.push({
      bots: n,
      seen: await page.evaluate(() => window.__game.bots().length),
      fps: Math.round(1000 / pct(frames, 0.5)),
      frameMs: r2(pct(frames, 0.5)),
      p95Ms: r2(pct(frames, 0.95)),
      p99Ms: r2(pct(frames, 0.99)),
      maxMs: r2(frames[frames.length - 1]),
      cpuMs: perf.cpuMs,
      gpuMs: perf.gpuMs,
      drawCalls: perf.drawCalls,
      triangles: perf.triangles,
      tickMs: r2(s.tickMs),
      rulesMs: r2(median(ticks.map((t) => t[0]))),
      updatesMs: r2(median(ticks.map((t) => t[1]))),
      updateKB: r2(s.bytes / 1024),
    });
  }
  console.table(rows);
  mkdirSync('scratch/scale', { recursive: true });
  const gpu = (await page.evaluate(() => window.__game.perf())).gpu;
  writeFileSync('scratch/scale/browser-crowd.json', `${JSON.stringify({ when: new Date().toISOString(), gpu, frames: FRAMES, rows }, null, 2)}\n`);
  for (const r of rows) {
    expect(r.seen, `${r.bots} bots: all of them seen`).toBeGreaterThanOrEqual(r.bots);
    expect(r.tickMs, `${r.bots} bots: the server keeps up with 20 ticks a second`).toBeLessThan(50);
  }
  expect(errors).toEqual([]);
});
