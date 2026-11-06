import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { battlefield } from '../support/battlefield';

// How the battlefield holds up as bots join (the refactor's R10.12): the server's tick time and the
// size of each update an admin there is sent, and this browser's frame time, with the battlefield's
// own bots and then with as many as a game holds (MAX_BOTS in crates/server/src/play/bots.rs). Every
// bot is a whole player to the server and a whole hero to the browser today; crowds at scale (each
// client sent what's near it, compact updates for many, far bodies drawn by the crowd renderer) are
// R10.8 and R10.9, and this is the number they improve on. The numbers go to
// screenshots/stress-battlefield.json. Tagged @gpu: it times frames.

const { fighter } = battlefield(7960);

test('the battlefield with its bots, then as many as it holds: tick time, update size, frame rate', { tag: '@gpu' }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { page, errors } = await fighter(browser, 0, undefined, { place: false, bots: true, viewport: { width: 1280, height: 720 } });
  await page.waitForFunction(() => window.__game.bots().length >= 30, null, { timeout: 30_000 });

  /** A few seconds of play, then the server's newest numbers and this browser's frame times. */
  const measure = async (label: string) => {
    const t = await page.evaluate(() => window.__game.online()!.ticks);
    await page.waitForFunction((t) => window.__game.online()!.ticks > t + 80, t, { timeout: 30_000 });
    const s = (await page.evaluate(() => window.__game.net().world))!;
    const perf = await page.evaluate(() => window.__game.perf());
    return {
      label,
      bots: s.bots,
      players: s.players,
      tickMs: +s.tickMs.toFixed(2),
      updateKB: +(s.bytes / 1024).toFixed(1),
      fps: perf.fps,
      frameMs: perf.avgMs,
      p95Ms: perf.p95Ms,
    };
  };
  const rows = [await measure('the battlefield as it comes')];
  // As many as a game holds, half a side each, round where the admin stands.
  await page.evaluate(() => {
    window.__game.sendBots(16, 'skirmisher', 0);
    window.__game.sendBots(16, 'skirmisher', 1);
  });
  await page.waitForFunction(() => window.__game.bots().length >= 60, null, { timeout: 30_000 });
  rows.push(await measure('as many as it holds'));
  console.table(rows);
  writeFileSync('screenshots/stress-battlefield.json', `${JSON.stringify(rows, null, 2)}\n`);
  for (const r of rows) expect(r.tickMs, `${r.label}: the server keeps up with 20 ticks a second`).toBeLessThan(50);
  expect(errors).toEqual([]);
});
