# tests/

Three tiers; the full guide is [docs/testing.md](../docs/testing.md).

| Folder | Tier | Runner | Run |
|---|---|---|---|
| `unit/` | unit: logic without a browser or server | Vitest (`vitest.config.ts`, project `unit`) | `npm run test:unit` (with the Rust tests) |
| `conformance/` | integration: the TypeScript rules against the Rust ones | Vitest (project `conformance`) | `npm run test:conformance` |
| `integration/` | integration: the game in a browser, with its servers | Playwright (`playwright.config.ts`) | `npm run test:integration` |
| `stress/` | stress: speed, crowds, many windows; a real GPU | Playwright (`playwright.stress.config.ts`) | `npm run test:stress` |
| `support/` | helpers: `game.ts` (open the game, wait for it, the typed `window.__game`), `ownServer.ts` (a game server of a spec's own, on a port of its own), `battlefield.ts` (fighters in the battlefield zone) | | |

- Put a test in the lowest tier that can show the thing works.
- `npm run check` before calling a change done; `npm run check:beta` before a push to `beta`;
  `npm run check:release` before a release.
- Integration tests drive the game through the typed `window.__game`, step it a frame at a time, and
  never wait a fixed time. Tag `@gpu` (needs a real GPU; CI skips it) or `@alone` (runs one at a time).
