import { defineConfig } from '@playwright/test';
import base from '../../../playwright.config';

// Playwright on a port of its own. playwright.config.ts uses 5199 with reuseExistingServer, so if
// another checkout (another session, the main repo) already has a dev server there, a plain
// "npx playwright test" silently tests THAT checkout. Use this instead:
//   npx playwright test -c handoff/improve-animations/tools/pw.config.ts tests/animation.spec.ts
// PW_PORT changes the port; RUINA_SERVER points the dev proxy (and online.spec) at a game server.
const PORT = Number(process.env.PW_PORT ?? 5299);
export default defineConfig({
  ...base,
  testDir: '../../../tests',
  use: { ...base.use, baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    cwd: '../../..',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
