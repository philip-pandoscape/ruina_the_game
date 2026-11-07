#!/usr/bin/env node
// How the game runs in a browser: start-up, frame time and memory, measured the same way on any
// build, so two builds can be compared (the refactor's R8.14 measured where it started, beta
// d49c3b8, against refactor/first). It wraps the page's requestAnimationFrame before any of the
// page's scripts run, so it asks nothing of the game but `window.__game.ready` and `setPaused`.
//
//   node tools/perf/measure.mjs --url http://localhost:4173 --path '/?test&quality=medium' \
//     --runs 3 --seconds 10 --label now --out scratch/perf-now.json
//
// - Start-up: from navigation to the first frame drawn once the game says it's ready.
// - Frames: for `seconds` of running forward across the island, each frame's length and the time
//   the page's own work took in it (its animation-frame callbacks: the rules and the drawing's
//   commands, not the graphics card's drawing).
// - Memory: after a garbage collection, the JavaScript heap and the memory behind array buffers
//   (WebAssembly's included).
//
// Each run is a fresh browser. Give `--headed` to draw in a window; headless Chromium is given the
// graphics card as the integration tier's is (playwright.config.ts), and the result says which
// renderer WebGL reports.

import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const url = opt('url', 'http://localhost:4173');
const path = opt('path', '/?test');
const runs = Number(opt('runs', '3'));
const seconds = Number(opt('seconds', '10'));
const label = opt('label', path);
const out = opt('out', '');
const headed = args.includes('--headed');

/** Installed before the page's scripts: times every animation frame and notes when the game is ready. */
function watchFrames() {
  const raf = window.requestAnimationFrame.bind(window);
  const m = { recording: false, frames: [], work: [], readyAt: -1, firstFrame: -1 };
  window.__perf = m;
  let frameT = -1;
  let prevT = -1;
  let work = 0;
  const close = () => {
    if (frameT < 0) return;
    if (m.recording) {
      m.work.push(work);
      if (prevT >= 0) m.frames.push(frameT - prevT);
    }
    prevT = frameT;
  };
  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      if (t !== frameT) {
        close();
        frameT = t;
        work = 0;
        if (m.readyAt < 0 && window.__game?.ready === true) m.readyAt = performance.now();
        else if (m.readyAt >= 0 && m.firstFrame < 0) m.firstFrame = performance.now();
      }
      const a = performance.now();
      try {
        cb(t);
      } finally {
        work += performance.now() - a;
      }
    });
}

const sorted = (xs) => [...xs].sort((a, b) => a - b);
const pct = (xs, p) => {
  const s = sorted(xs);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const median = (xs) => pct(xs, 50);

async function once() {
  const browser = await chromium.launch({
    headless: !headed,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(watchFrames);
    await page.goto(url + path);
    await page.waitForFunction(() => window.__perf?.firstFrame >= 0, null, { timeout: 120_000 });
    const start = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return {
        ready: window.__perf.readyAt,
        firstFrame: window.__perf.firstFrame,
        domContentLoaded: nav?.domContentLoadedEventEnd ?? -1,
        renderer: gl ? String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : 'none',
      };
    });

    await page.evaluate(() => window.__game.setPaused(false));
    // A second to settle (the first frames upload what the camera first sees), then the run.
    await page.waitForTimeout(1000);
    await page.keyboard.down('KeyW');
    await page.evaluate(() => {
      window.__perf.recording = true;
    });
    await page.waitForTimeout(seconds * 1000);
    const { frames, work } = await page.evaluate(() => {
      window.__perf.recording = false;
      return { frames: window.__perf.frames, work: window.__perf.work };
    });
    await page.keyboard.up('KeyW');

    const cdp = await context.newCDPSession(page);
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    await browser.close();
    return {
      renderer: start.renderer,
      startup: { ready: round(start.ready), firstFrame: round(start.firstFrame), domContentLoaded: round(start.domContentLoaded) },
      frames: {
        count: frames.length,
        fps: round(1000 / mean(frames), 1),
        mean: round(mean(frames)),
        p50: round(pct(frames, 50)),
        p95: round(pct(frames, 95)),
        p99: round(pct(frames, 99)),
        max: round(Math.max(...frames)),
        over20ms: frames.filter((f) => f > 20).length,
      },
      work: { mean: round(mean(work)), p50: round(pct(work, 50)), p95: round(pct(work, 95)), p99: round(pct(work, 99)), max: round(Math.max(...work)) },
      memoryMB: {
        jsHeap: round(heap.usedSize / 1048576, 1),
        jsHeapTotal: round(heap.totalSize / 1048576, 1),
        buffers: round((heap.backingStorageSize ?? 0) / 1048576, 1),
      },
      errors,
    };
  } finally {
    if (browser.isConnected()) await browser.close();
  }
}

const results = [];
for (let i = 0; i < runs; i++) {
  const r = await once();
  results.push(r);
  console.log(
    `${label} run ${i + 1}: ready ${r.startup.ready} ms, ${r.frames.fps} fps, frame p95 ${r.frames.p95} ms, work ${r.work.mean} ms (p95 ${r.work.p95}), heap ${r.memoryMB.jsHeap} MB, buffers ${r.memoryMB.buffers} MB`,
  );
}
const pick = (f) => median(results.map(f));
const summary = {
  label,
  url: url + path,
  runs,
  seconds,
  renderer: results[0]?.renderer,
  median: {
    readyMs: pick((r) => r.startup.ready),
    firstFrameMs: pick((r) => r.startup.firstFrame),
    fps: pick((r) => r.frames.fps),
    frameP50: pick((r) => r.frames.p50),
    frameP95: pick((r) => r.frames.p95),
    frameP99: pick((r) => r.frames.p99),
    workMean: pick((r) => r.work.mean),
    workP95: pick((r) => r.work.p95),
    jsHeapMB: pick((r) => r.memoryMB.jsHeap),
    buffersMB: pick((r) => r.memoryMB.buffers),
  },
  results,
};
console.log(JSON.stringify(summary.median));
if (out) writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
