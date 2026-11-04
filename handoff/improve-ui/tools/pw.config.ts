import base from '../../../playwright.config';
import { defineConfig } from '@playwright/test';
// This worktree's own Vite on its own port, so a run never reuses another checkout's server.
//   npx playwright test -c handoff/improve-ui/tools/pw.config.ts look-windows        (the specs here)
//   SUITE=1 npx playwright test -c handoff/improve-ui/tools/pw.config.ts skills.spec (the real tests)
const PORT = 5299;
export default defineConfig({
  ...base,
  testDir: process.env.SUITE ? '../../../tests' : '.',
  timeout: 180_000,
  use: { ...base.use, baseURL: `http://localhost:${PORT}` },
  webServer: { command: `npx vite --port ${PORT} --strictPort`, url: `http://localhost:${PORT}`, reuseExistingServer: false, timeout: 60_000, cwd: process.cwd() },
});
