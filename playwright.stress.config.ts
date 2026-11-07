import { defineConfig } from '@playwright/test';
import integration from './playwright.config';

// The stress tier (tests/stress): frame rates and what each look costs the graphics card, the
// battlefield's thousands of fighters, the raid, many windows at once. Run before a release to
// production (`npm run test:stress`), never as part of a push to beta. One test at a time, so each has
// the machine to itself and its numbers mean something; a real GPU, so CI doesn't run it.
export default defineConfig({
  ...integration,
  testDir: 'tests/stress',
  workers: 1,
  fullyParallel: false,
  projects: undefined,
  grep: undefined,
  grepInvert: undefined,
  reporter: [['list'], ['json', { outputFile: 'test-results/stress-timings.json' }]],
});
