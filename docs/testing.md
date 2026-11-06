# Testing

Ruina's tests come in three tiers, by what they need and when they run. Run the quick one all the
time, the middle one before every push to `beta`, the slow one before a release.

| Tier | What | Needs | Run | When |
|---|---|---|---|---|
| **Unit** | `tests/unit/` (Vitest, in Node) and the Rust tests (`cargo test`) | nothing: no browser, no server, no drawing | `npm run test:unit` (TypeScript and Rust), `npm run check` (typecheck too) | after every change |
| **Integration** | `tests/conformance/` (Vitest: the TypeScript rules against the Rust ones) and `tests/integration/` (Playwright: the game in a browser) | the release Rust programs (built by the script), a world server with Postgres for the online specs | `npm run test:conformance`, `npm run test:integration`; `npm run check:beta` runs everything up to here | before every push to `beta` |
| **Stress** | `tests/stress/` (Playwright, `playwright.stress.config.ts`, one test at a time) | a real GPU | `npm run test:stress`; `npm run check:release` runs every tier | before a release to `production` |

## Where a new test goes

- **It checks logic: rules, content, maths, a tool, text.** A unit test, `tests/unit/<area>.test.ts`.
  Import the module and call it. No `window`, no WebGL, no server, no waiting on time. The rules are
  deterministic, so a unit test is too.
- **It checks the TypeScript rules give what the Rust ones do.** `tests/conformance/` (these go away
  when the rules are one copy: `.plans/refactor`, Phase 8). The engine keeps its own guard for
  then: the golden tests (`crates/engine/src/checks/mod.rs`) run every creature, player and
  open-world scenario the conformance tier proves and hold the Rust to those answers bit for bit, by
  a hash of each kept in `crates/engine/tests/golden/`. After a change both sides make on purpose (a
  rule changed in TypeScript and Rust, the island rebaked), `RUINA_GOLDEN=1 npm run test:conformance`
  writes the new answers, once the comparison has passed on them. The server's fighting, which has no
  TypeScript twin, has a golden battle of its own (`a_battle_plays_out_as_it_always_has` in
  `crates/server/src/play/bots.rs`).
- **It needs the game running in a page: the HUD, windows, input, drawing, online play.** An
  integration test, `tests/integration/<area>.spec.ts`.
- **It measures speed, or needs the machine to itself (frame rates, thousands of fighters, several
  windows).** A stress test, `tests/stress/`.

Prefer the lowest tier that can show the thing works: a unit test runs in milliseconds, an
integration test boots the game in about four seconds before it even starts.

## Writing an integration test

- Open the game with the shared helpers in `tests/support/game.ts`: `openGame(page, url)` returns the
  console errors seen (expect none), `gameReady(page)` waits for the game, `onlineReady(page)` for
  play online.
- Drive it through `window.__game` (built in `src/main.ts`), which is typed for the tests: a renamed
  or reshaped call fails `npm run typecheck`. Step the game a frame at a time with `__game.advance`;
  never wait a fixed time for the game to notice something.
- `/?world&test` opens the island offline and paused, `/?test` the training yard paused, `/?yard` the
  yard running.
- A spec whose tests share nothing says so: `test.describe.configure({ mode: 'parallel' })`.
- Tags: `@gpu` for tests that need a real GPU to keep up (CI skips them); `@alone` for tests that race
  the clock in a way other pages drawing would upset (they run one at a time, after the rest).
- A spec that starts a game server of its own (`tests/support/ownServer.ts`) gives it a port no
  other file uses. Online specs make fresh accounts on the world server (`?as=<name>` signs in where
  `DEV_LOGIN=1`).

## Running

```sh
npm run check                          # typecheck + unit tier (TypeScript and Rust)
npx vitest run --project unit          # the TypeScript unit tests alone (seconds)
npx vitest run tests/unit/roads.test.ts   # one file
npm run test:conformance               # builds the Rust check programs, then compares
npx playwright test                    # the integration tier (needs servers for the online specs)
npx playwright test tests/integration/ui.spec.ts -g "title"   # some of it
npx playwright test --last-failed      # what failed last time
npm run test:stress                    # the stress tier, one at a time
node tools/tests/timings.mjs           # the last Playwright run's slowest tests and files
npm run bake                           # rebake crates/engine/data/emberholm.zone after changing the island
```

Every Playwright run writes each test's time to `test-results/timings.json`. The refactor's baseline
(395 tests, 10.8 minutes before the tiers) is in `.plans/refactor/inventory/baseline-tests.csv`.

Switches for looking closer when something disagrees:

| Variable | What it prints |
|---|---|
| `LIFE_SUMMARY=1` | `tests/conformance/life.test.ts`: each case's island at the end (modes, coins, bag, packs, vehicles, crops, houses, quests, toasts) |
| `BALANCE_TRACE=1` | `npm run balance` (`crates/tools/src/bin/balance.rs`): every duel's fighters every half second (positions, distance, health, mode, cooldowns) |
| `BAKE=1` | `tests/conformance/terrain.test.ts` writes the island's bake instead of only checking it (`npm run bake` sets it) |
| `RUINA_GOLDEN=1` | `tests/conformance/` (ai, player, world) writes each scenario it proves, with a hash of the Rust's answer, for the engine's golden tests (`crates/engine/tests/golden/`) |

### Ports and a private test rig

Several checkouts and sessions run suites on one machine, so a run can be moved off the shared ports:

| Setting | Default | What |
|---|---|---|
| `PW_PORT` | 5199 | the Vite server the integration tests play |
| `TEST_PORT_OFFSET` | 0 | added to the ports of the game servers some specs start of their own (`tests/support/ownServer.ts`: admin, update, download, battlefield) |
| `PW_WORKERS` | 6 | pages side by side |
| `RUINA_SERVER` | http://localhost:7777 | the world server the online specs and the dev server use |
| `RUINA_DATABASE_URL` | none | the database update.spec starts its own server on |

A private rig for the online specs, clear of `npm run up`'s ports:

```sh
docker run -d --rm --name ruina-<you>-db -e POSTGRES_USER=ruina -e POSTGRES_PASSWORD=ruina -e POSTGRES_DB=ruina -p 127.0.0.1:5461:5432 postgres:18
DATABASE_URL=postgres://ruina:ruina@127.0.0.1:5461/ruina DEV_LOGIN=1 target/release/ruina-server --port 7871
PW_PORT=5261 TEST_PORT_OFFSET=60 RUINA_SERVER=http://localhost:7871 RUINA_DATABASE_URL=postgres://ruina:ruina@127.0.0.1:5461/ruina npx playwright test
```

Run the server from a copy of the binary (in `scratch/`) if you'll rebuild while it runs. Servers
started on a development machine listen on localhost only, so Windows never asks to let them through
its firewall; `--listen all` opens one to other machines.

## In CI

`.github/workflows/ci-cd.yml`: every push runs the unit tier (the TypeScript unit tests in the client
job, the Rust tests in the server job, in debug with the dependencies optimized). The integration
tier (conformance once, then Playwright in four shards, drawing in software) runs on pull requests
to `production` and on manual runs, not on a push to `beta`: run it locally before pushing. The
stress tier needs a real GPU and runs locally before a release.
