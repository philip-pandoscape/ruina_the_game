# Refactor Progress Report

What has landed on `refactor/first`, phase by phase, newest last. Each entry says what changed, the
numbers against the [baseline](inventory/baseline.md), decisions made on the way, problems, and
what's next. The work doesn't wait for this to be read; read it whenever suits you. The full task list
is in [tracker.md](tracker.md), the plan in [README.md](README.md).

## At a Glance

| Phase | State |
|---|---|
| 0 Prepare and Measure | done |
| 1 Test Tiers | done |
| 2 Clear Out Dead Code | in progress |
| 3 Admin Menu | to do |
| 4 The /find-assets Skill | to do |
| 5 The Rust Workspace | to do |
| 6 The Client in Areas | to do |
| 7 Content in Folders | to do |
| 8 One Copy of the Rules | to do |
| 9 Content as Data, Finished | to do |
| 10 Zones, Developer Zones and Bots | to do |
| 11 Bigger Than 64 MB | to do |
| 12 The Design Bible as a Knowledge Base | to do |
| 13 AGENTS.md, the Docs and the Merge | to do |

## 2026-11-05: The Survey and the Review

- **Surveyed the whole codebase** with five read-only explorers (one round was cancelled by an
  interrupt and rerun): the test suite, content and data, the rules in TypeScript and Rust, dead code
  and tech debt, and the architecture with accounts and developer pages. Six inventory files hold what
  they found; the plan and tracker cite them line by line.
- **Measured the starting point** ([baseline](inventory/baseline.md)): 395 Playwright tests (~12 min
  here), 182 Rust tests that run in 2 s but take 51 s (debug) to 106 s (release) to rebuild after
  touching one rules file, a 15 MB game sent all at once, a 31.8 MB public repository.
- **Findings worth knowing beyond the plan:**
  - Every player on beta can use the developer commands (grant, warp, teleport): beta runs with
    `DEV_TOOLS=1`. Phase 3 closes this; until the merge it stays as it is on beta.
  - The battlefield's socket (`/ws/battle`) checks neither sign-in nor origin (the battlefield is off
    on Railway, so nothing is exposed today).
  - The TypeScript and Rust rules agree only to about a millionth, not bit for bit, and one server loop
    (`rebuild_world`) walks a randomly ordered map, so colliders go in a different order each run.
  - CI renders in software, which switches the game to the old toon look and the box hero, so CI has
    been testing different code from what players see.
- **Your review** (canvas round 1): the plan approved with changes, recorded as decisions D0 to D14 in
  the plan. The big ones: run every phase to the end and merge into `beta` once; the yard and the
  battlefield become developer zones with bots as a core engine feature (a new Phase 10); the design
  bible becomes a knowledge base anyone can read (a new Phase 12); the toon look is retired; one
  Content Library page; `philip` is the admin; the server becomes `ruina-server`; big files go to Git
  LFS.
- **Optional for you, nothing waits on it:** play the five recent pushes on beta (Lanternwick's
  buildings, Goblin's Dread's way in and a party, `?yard&goblins=6`, the painted icons, the animation
  library locally), so a bug found later isn't blamed on the refactor.
- **Next:** the rest of Phase 0: the timing reporter, the baseline run, tidying branches and
  worktrees, Git LFS.

## 2026-11-05: Phase 0, Prepare and Measure: done

- **The baseline.** The whole suite passes on this branch before any change: **395 passed, 1 skipped
  (by design), 0 failed, 10.8 minutes on the clock** (1,848 s of test time on 6 workers). Every test
  now records its time (`test-results/timings.json`; `node tools/tests/timings.mjs` prints the
  slowest), and the baseline's are kept in `inventory/baseline-tests.csv`. Online play (351 s) and
  the open world (303 s) are two thirds of all test time; the slowest test, riding along in a
  friend's cart, takes 58 s.
- **No more Windows prompts.** You asked why a UAC prompt came up whenever I started a server: the
  server listened on every network address, and Windows' firewall asks once for each new program
  path (this branch's build and a copy for the tests were new). It now listens on this machine only
  (`127.0.0.1` and `::1`) unless started with `--listen all` or `LISTEN=all`, which the Docker image
  sets for Railway and `npm run up`. Checked: only the two local addresses hold the port, and
  `localhost`, `127.0.0.1` and `::1` all reach it. This goes to `beta` with the final merge; until then
  your own servers built from `beta` still listen everywhere.
- **Git LFS.** 243 binaries (models, pictures, icons and their sheets, fonts, the baked island) are LFS
  pointers from this branch on, without rewriting history. New files of those kinds go to LFS by
  themselves. CI fetches them through a small action that caches them by id, so runs don't spend
  the account's LFS allowance (GitHub Free: 10 GiB stored and 10 GiB downloaded a month; ours is
  ~31 MB). The objects reach GitHub with the first push, at the merge.
- **Tidied** (as agreed): the merged worktrees `yggdrasil-improve-animations`, `yggdrasil-look`,
  `yggdrasil-trees`, `yggdrasil-dungeon` and the locked agent worktree are gone. The locked one's
  23 uncommitted changes were checked three-way against `beta`: `beta` already had all of it, and
  more. Every worktree's `scratch/` (6,784 files: the overnight Meshy and Gemini output, concept art,
  screenshots, scripts) was moved first to `C:\GitHub\games\yggdrasil\scratch\from-<worktree>\`,
  with the dungeon session's loose logs. Branches deleted, all fully in `beta`: locally the merged
  ones; on GitHub `main` (was 33eb2f6), `feature/improve-animations` (2edf82f) and
  `feature/improve-ui` (b1089bc), so any can be restored from those commits. Left alone: the dungeon
  session's Postgres container `ruina-dungeon-db`.
- **A slip, owned:** stopping the leftover dungeon Vite, my filter on the command line also caught my
  own background size check and two old `tail` watchers on the dungeon's logs; nothing else was
  touched, and my test run and server carried on.
- **The design bible** shows the refactor as a feature in progress, with its next step and a session
  entry.
- **Next:** Phase 1, the test tiers.

## 2026-11-05: Phase 1, Test Tiers: done

| | Before | After |
|---|---|---|
| A quick check after a change | the whole suite, ~11 min | `npm run check`: typecheck (~12 s), 54 TypeScript unit tests (~3 s), the Rust tests (~12 s) |
| Rust: edit a rules file, test it | 51 s debug, 106 s release | **7 s** (the library), 12 s (everything); the tests run in 0.25 s |
| TypeScript against Rust | in Playwright, life-conformance alone 64 s | `npm run test:conformance`: all 63 in 39 s, no browser |
| The integration tier | (the whole suite) 395 tests, 10.8 min | 281 tests, 8.7 min, all pass (the rest now in seconds in the unit tier) |
| The island's bake | `BAKE=1 npx playwright test ...` | `npm run bake`, 7 s |

- **Tiers in folders:** `tests/unit` and `tests/conformance` on Vitest, `tests/integration` on
  Playwright, `tests/stress` on a Playwright config of its own (one test at a time, a real GPU),
  `tests/support` for helpers. Scripts: `npm run check` (after every change), `check:beta` (before a
  push to `beta`), `check:release` (before a release); `test:unit`, `test:rust`, `test:conformance`,
  `test:integration`, `test:stress`, `test:all`, and `npm test` is now the unit tier.
- **Typed tests:** `window.__game` is typed for the tests from `src/main.ts` (526 calls, which were
  all `any`), so when Phase 6 reshapes `main.ts`, a test calling something renamed fails the
  typecheck instead of failing at run time. One shared wait for the game (38 copies) and one for
  online play (5).
- **CI:** the unit tier on every push (Vitest in the client job; Rust tests in debug, no longer a
  release test build); the release build only where the integration tier runs.
- **The moves tool** (pulled forward from Phase 5): `tools/refactor/moves.mjs` moved the tests and
  rewrote every path to them (docs, skills, the design bible, the library's prompts). The first
  integration run caught one thing it missed (template-string URLs in two specs); fixed, with a test.
- **Changed on the way:** the headless harness for ~82 rules tests and renderer-free model builders
  for ~64 gallery tests move to the start of Phase 6 (R6.2a). Both need `main.ts`'s rules half as a
  module of its own, which is Phase 6's first step; doing it now would mean doing it twice. The pvp
  "bots fight real players" test waits for Phase 10, which replaces the battlefield's bots.
- **Docs:** `docs/testing.md` (the tiers, where a new test goes, the helpers, running, ports, a
  private rig), `tests/AGENTS.md`, and AGENTS.md's commands and test rules.
- **Next:** Phase 2, clearing out dead code (and retiring the toon look).
