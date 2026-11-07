import { defineConfig } from 'vitest/config';

// The tests that need no browser, run by Vitest in Node (tests/AGENTS.md has the tiers):
//   unit         tests/unit: the rules, content, tools and anything else that runs without a page.
//                Fast, no server, no drawing: `npm run test:unit` (with the Rust tests).
//   conformance  tests/conformance: the engine's WebAssembly and the browser's ground sampling held
//                to the native engine, and the balance harness, through the programs in
//                target/release (build them first); part of the integration tier.
// Each test file runs in a worker of its own, side by side with the others: the rules are
// deterministic and keep no state between files.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/support/engineSetup.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'conformance',
          include: ['tests/conformance/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/support/engineSetup.ts'],
          // Some cases walk the world for minutes of game time in both languages.
          testTimeout: 300_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
