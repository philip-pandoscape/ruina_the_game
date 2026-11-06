import { expect, test } from '@playwright/test';
import { gameReady } from '../support/game';

// The hero's animations in the game itself, where the hero and what it rides are drawn together, at
// a set frame rate. The films measured on their own (planted feet, floor clearance, joint limits,
// trails, the bowstring, grips, holds): tests/unit/animation.test.ts, which plays them through the
// real close-up hero without a page (src/dev/library/bench/hero.ts); the content library plays them too
// (/dev/library.html#/hero/<film>).

/**
 * Hands the page's frame loop a clock that moves exactly 1000/fps ms a frame, as fast as it can
 * draw, so the game plays at any frame rate: window.__fps, window.__afterFrame (called after each).
 */
function fixedFrameRate(): void {
  const w = window as any;
  let queue: FrameRequestCallback[] = [];
  let t = performance.now();
  w.__fps = 60;
  w.__clockFrom = (from: number) => (t = from);
  window.requestAnimationFrame = (cb) => queue.push(cb);
  window.cancelAnimationFrame = () => {};
  const tick = () => {
    const due = queue;
    queue = [];
    t += 1000 / w.__fps;
    for (const cb of due) cb(t);
    w.__afterFrame?.();
    setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
}

for (const fps of [30, 144]) {
  test(`rowing in the game at ${fps} fps, the hands stay on the oars: ahead, turning, backing, spinning, starting, stopping`, { tag: '@gpu' }, async ({
    page,
  }) => {
    // The boat is placed and its oars swing before the rower is posed in its seat, tilting and
    // riding the swell with it (src/main.ts draw(), LifeView.placeRide): the hands reach for where
    // the handles are this frame, not a frame ago.
    await page.setViewportSize({ width: 480, height: 270 });
    await page.addInitScript(fixedFrameRate);
    await page.goto('/?world&test');
    await gameReady(page, 60_000);
    const boarded = await page.evaluate(() => {
      const g = window.__game;
      g.reset();
      g.lifeCommand({ t: 'grant', item: 'deed.rowboat', n: 1 });
      g.advance(1);
      g.teleport(-10, -334, Math.PI);
      g.lifeCommand({ t: 'summon', item: 'deed.rowboat' });
      g.advance(2);
      const b = g.life().vehicles[0];
      for (const side of [1, -1]) {
        g.teleport(b.x + Math.cos(b.heading) * 1.3 * side, b.z - Math.sin(b.heading) * 1.3 * side, b.heading);
        g.advance(2);
        g.lifeCommand({ t: 'interact' });
        // Half a second a frame at a time, so the body has eased into the seat.
        for (let i = 0; i < 30; i++) g.advance(1);
        if (g.state().player.mode === 'ride') return true;
      }
      return false;
    });
    expect(boarded).toBe(true);
    const legs: Array<[number, Record<string, number>]> = [
      [60, {}],
      [150, { stickY: 1 }],
      [120, { stickY: 1, stickX: -1 }],
      [120, { stickY: 1, stickX: 1 }],
      [90, {}],
      [120, { stickY: -1 }],
      [120, { stickX: 1 }],
      [60, {}],
    ];
    const frames = legs.reduce((n, [f]) => n + f, 0);
    await page.evaluate(
      ([legs, fps]) => {
        const w = window as any;
        const g = w.__game;
        w.__fps = fps;
        w.__gaps = [];
        // Each hand from its handle, as drawn.
        w.__afterFrame = () => {
          const h = g.holds();
          if (h)
            w.__gaps.push(Math.max(...h.hands.map((p: number[], i: number) => Math.hypot(p[0] - h.holds[i][0], p[1] - h.holds[i][1], p[2] - h.holds[i][2]))));
        };
        g.scriptInput(legs);
        w.__clockFrom(performance.now());
        g.setPaused(false);
      },
      [legs, fps] as const,
    );
    const start = await page.evaluate(() => window.__game.state().frame);
    await page.waitForFunction(([s, n]) => window.__game.state().frame >= s + n, [start, frames] as const, { timeout: 100_000, polling: 250 });
    const gaps = await page.evaluate(() => {
      const w = window as any;
      w.__game.setPaused(true);
      return w.__gaps as number[];
    });
    expect(gaps.length).toBeGreaterThan(frames * (fps / 60) * 0.9);
    const worst = Math.max(...gaps);
    expect(worst, `a hand ${worst.toFixed(3)} m off its oar, on frame ${gaps.indexOf(worst)} of ${gaps.length}`).toBeLessThan(0.02);
  });
}
