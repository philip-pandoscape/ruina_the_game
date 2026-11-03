import { defineConfig } from '@playwright/test';

// On Windows the tests run in the Edge browser that ships with Windows (no extra download).
// Elsewhere they use Playwright's own Chromium: run `npx playwright install chromium` once.
export default defineConfig({
  testDir: 'tests',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5199',
    channel: process.platform === 'win32' ? 'msedge' : undefined,
    headless: true,
    viewport: { width: 1280, height: 720 },
    launchOptions: { args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: 'npx vite --port 5199 --strictPort',
    url: 'http://localhost:5199',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
