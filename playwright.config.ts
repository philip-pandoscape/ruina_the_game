import { defineConfig } from '@playwright/test';

// The page the tests play is served by Vite on this port. PW_PORT moves it, so two checkouts can
// run their suites at once without one testing the other's code (TEST_PORT_OFFSET moves the
// battle servers some tests start, tests/testServer.ts).
const port = Number(process.env.PW_PORT) || 5199;

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
  workers: 1,
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
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
