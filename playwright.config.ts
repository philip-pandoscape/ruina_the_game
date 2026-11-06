import { defineConfig } from '@playwright/test';

// The page the tests play is served by Vite on this port. PW_PORT moves it, so two checkouts can
// run their suites at once without one testing the other's code (TEST_PORT_OFFSET moves the
// battle servers some tests start, tests/testServer.ts).
const port = Number(process.env.PW_PORT) || 5199;

// Here the spec files play side by side, PW_WORKERS of them at once (each file that needs a battle
// server starts its own, on a port of its own; the online specs make fresh accounts), and the
// biggest files spread their own tests out too (test.describe.configure). Tests that need the
// machine to themselves, @gpu (frame rates, several game windows, screen capture) and @alone (a
// server stopped and started, a race against the clock), run one at a time.
//
// The whole suite (`npm test`, or `npx playwright test` with no tests picked) plays them after the
// rest, as the other project's teardown: so they run whether or not something before them failed
// (a dependency would be skipped). A run of some of it (files named, -g, --last-failed) plays them
// beside the rest instead, as Playwright runs a teardown project's every test whatever was picked.
// Decided once where the run starts, and handed down to its workers.
const workers = Number(process.env.PW_WORKERS) || 6;
const ALONE = /@gpu|@alone/;
const PICKS = /^(-g|--grep|--grep-invert|--last-failed|--only-changed|--project|--test-list|--test-list-invert|--ui)(=|$)/;
if (process.env.RUINA_WHOLE_SUITE === undefined) {
  const args = process.argv.slice(process.argv.indexOf('test') + 1);
  process.env.RUINA_WHOLE_SUITE = process.argv.includes('test') && args.every((a) => a.startsWith('-') && !PICKS.test(a)) ? '1' : '0';
}
const wholeSuite = process.env.RUINA_WHOLE_SUITE === '1';

// On Windows the tests run in the Edge browser that ships with Windows (no extra download).
// Elsewhere they use Playwright's own Chromium: run `npx playwright install chromium` once.
export default defineConfig({
  testDir: 'tests',
  // CI runners are slower than a desk machine and draw WebGL in software. There the suite is split
  // across runners test by test (.github/workflows/ci-cd.yml), a test gets twice as long, and one
  // that lost a race against the clock gets two more tries; a real failure fails all three.
  // Tests tagged @gpu (several game windows at once, frame rates, screen capture) need a real
  // GPU to keep up, so CI skips them; they run everywhere else.
  timeout: process.env.CI ? 240_000 : 120_000,
  workers: process.env.CI ? 1 : workers,
  fullyParallel: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  grepInvert: process.env.CI ? /@gpu/ : undefined,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    channel: process.platform === 'win32' ? 'msedge' : undefined,
    headless: true,
    viewport: { width: 1280, height: 720 },
    launchOptions: { args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] },
  },
  projects: process.env.CI
    ? undefined
    : [
        { name: 'side by side', grepInvert: ALONE, teardown: wholeSuite ? 'one at a time' : undefined },
        { name: 'one at a time', grep: ALONE, workers: 1 },
      ],
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    // Its first page can take most of a minute when other checkouts' suites are busy on the machine.
    timeout: 180_000,
  },
});
