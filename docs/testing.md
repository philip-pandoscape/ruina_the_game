# Testing

Ruina's tests come in three tiers, by what they need and when they run. Run the quick one all the
time, the middle one before every push to `beta`, the slow one before a release.

| Tier | What | Needs | Run | When |
|---|---|---|---|---|
| **Unit** | `tests/unit/` (Vitest, in Node) and the Rust tests (`cargo test`) | nothing: no browser, no server, no drawing | `npm run test:unit` (TypeScript and Rust), `npm run check` (typecheck too) | after every change |
| **Integration** | `tests/conformance/` (Vitest: the WebAssembly and the browser's ground sampling against the native engine; the balance harness) and `tests/integration/` (Playwright: the game in a browser) | the release Rust programs (built by the script), a world server with Postgres for the online specs | `npm run test:conformance`, `npm run test:integration`; `npm run check:beta` runs everything up to here | before every push to `beta` |
| **Stress** | `tests/stress/` (Playwright, `playwright.stress.config.ts`, one test at a time) | a real GPU | `npm run test:stress`; `npm run check:release` runs every tier | before a release to `production` |

## Where a new test goes

- **It checks logic: rules, content, maths, a tool, text.** A unit test, `tests/unit/<area>.test.ts`.
  Import the module and call it. No `window`, no WebGL, no server, no waiting on time. The rules are
  deterministic, so a unit test is too.
- **It checks the rules' answers.** A Rust test beside the rule (`#[cfg(test)]` in
  `crates/engine`): the rules are one copy, the engine's. A scenario stepped through the rules goes
  in `crates/engine/src/checks/`, and the golden tests (`checks/mod.rs`) hold its answer bit for bit
  by a hash kept in `crates/engine/tests/golden/`. After a change made on purpose,
  `RUINA_GOLDEN=1 cargo test --release -p ruina-engine golden` keeps the new answers. The order
  players, creatures and missiles are stepped in must change nothing (`crates/engine/AGENTS.md`): the
  creatures' and the crowd's scenarios (`checks/ai.rs`, `checks/crowd.rs`: players and bots
  fighting, creatures among them, a passenger riding along) are run again shuffled with sixteen
  seeds and held to the same answers. The server's fighting has a golden battle of its own
  (`a_battle_plays_out_as_it_always_has` in `crates/server/src/sim/bots.rs`), and a melee there
  is stepped in shuffled orders and all at once on threads, the same game each way. How long a tick
  takes with 64, 256 and 1024 bots, one after another and all at once:
  `cargo test --release -p ruina-server tick_time -- --ignored --nocapture`. `tests/conformance/`
  holds the WebAssembly to the native engine and the browser's ground sampling to the engine's.
- **It plays the game: you, the island, creatures, stepping frame by frame, but nothing drawn.** A
  rules test, `tests/unit/rules/<area>.test.ts`: written as for a page (`page.goto('/?test=yard')`, then
  `page.evaluate` over `window.__game`), it runs headless in Node (`tests/support/headless.ts`): the
  rules, the island's life, auto-walk and the camera's maths for real, the step and the test API as
  the page runs them, drawing and windows standing in. Its `test` gives each test a `page` as
  Playwright's does, so moving a test between this tier and the next is moving it between files
  (`tools/refactor/port-spec.mjs`, `split-specs.mjs`). What only a page has (the windows, the
  keyboard or a controller, the scene, the server) throws when reached, naming it.
- **It needs the game running in a page: the HUD, windows, input, drawing, online play.** An
  integration test, `tests/integration/<area>.spec.ts`.
- **It measures speed, or needs the machine to itself (frame rates, thousands of fighters, several
  windows).** A stress test, `tests/stress/`.

Prefer the lowest tier that can show the thing works: a unit test runs in milliseconds (the 77 rules
tests together in about a second), an integration test boots the game in about four seconds before
it even starts.

## Writing an integration test

- Open the game with the shared helpers in `tests/support/game.ts`: `openGame(page, url)` returns the
  console errors seen (expect none), `gameReady(page)` waits for the game, `onlineReady(page)` for
  play online.
- Drive it through `window.__game` (built in `src/main.ts`), which is typed for the tests: a renamed
  or reshaped call fails `npm run typecheck`. Step the game a frame at a time with `__game.advance`;
  never wait a fixed time for the game to notice something.
- `/?test` opens the world offline and paused. `/?test=<instance>` opens a copy of that instance
  offline and paused, as if you'd come through its door (`?test=yard`, the training yard;
  `?test=goblinCamp`, the goblin camp's war-band: its pieces, and the creatures it brings on its
  floor). `/?offline` or `/?offline=<instance>` plays the world or a copy offline, running.
  `&fixture=world` plays the tests' fixture world of three regions in place of the shipped one, and
  `&fixture=far` one with a region 102 km out (`tests/fixtures/world/`, `docs/world.md` Testing);
  `__game.regionsReady(x, z)` waits for the regions near a place as if you'd come from afar. The
  options are listed in `src/app/options.ts`.
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
npm run test:conformance               # builds the engine natively and as WebAssembly, then holds one to the other
npx playwright test                    # the integration tier (needs servers for the online specs)
npx playwright test tests/integration/ui.spec.ts -g "title"   # some of it
npx playwright test --last-failed      # what failed last time
npm run test:stress                    # the stress tier, one at a time
node tools/tests/timings.mjs           # the last Playwright run's slowest tests and files
```

Every Playwright run writes each test's time to `test-results/timings.json`. The refactor's baseline
(395 tests, 10.8 minutes before the tiers) is in `.plans/refactor/inventory/baseline-tests.csv`.

Switches for looking closer when something disagrees:

| Variable | What it prints |
|---|---|
| `BALANCE_TRACE=1` | `npm run balance` (`crates/tools/src/bin/balance.rs`): every duel's fighters every half second (positions, distance, health, mode, cooldowns) |
| `RUINA_GOLDEN=1` | `cargo test --release -p ruina-engine golden` keeps the golden scenarios' new answers (`crates/engine/tests/golden/`) after a change made on purpose |

### Ports and a private test rig

Several checkouts and sessions run suites on one machine, so a run can be moved off the shared ports:

| Setting | Default | What |
|---|---|---|
| `PW_PORT` | 5199 | the Vite server the integration tests play |
| `TEST_PORT_OFFSET` | 0 | added to the ports of the game servers some specs start of their own (`tests/support/ownServer.ts`: admin, update, battlefield) |
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
