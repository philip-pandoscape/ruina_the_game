# Refactor Tracker

Every task of [the plan](README.md), in order. A task is ticked only when it is done **and**
verified as its line says; each landing is logged at the bottom with its commit, and each phase gets
an entry in [progress.md](progress.md).

Key: `[ ]` to do · `[~]` in progress · `[x]` done and verified · `[-]` dropped (say why) ·
`(you)` needs your answer or your hands · `(parallel)` can run beside the main line.

## Now

- **Phase:** 1, Test Tiers.
- **Next:** R1.1.
- **Test rig for this branch:** Postgres container `ruina-refactor-db` on 127.0.0.1:5461; the
  world server copied to `scratch/server-run/` on 7871 (`DATABASE_URL=postgres://ruina:ruina@127.0.0.1:5461/ruina
  DEV_LOGIN=1 ./yggdrasil-server.exe --battle off --port 7871`); the suite with `PW_PORT=5261
  TEST_PORT_OFFSET=60 RUINA_SERVER=http://localhost:7871
  RUINA_DATABASE_URL=postgres://ruina:ruina@127.0.0.1:5461/ruina`. Servers listen on localhost only:
  never start one that listens everywhere on this machine (it raises a Windows prompt).
- **Plan reviewed 2026-11-05:** approved with changes (decisions D0-D14 in the plan). Run every phase
  to the end, one merge into `beta` at the end, progress report along the way, no waiting.

## Phase 0: Prepare and Measure

- [x] **R0.1** Branch `refactor/first` and worktree `C:\GitHub\games\yggdrasil-refactor` from `beta`
  at d49c3b8. *Verified:* `git worktree list`.
- [x] **R0.2** Survey the code into `inventory/`: baseline, tests, content, rules-map, debt,
  architecture. *Verified:* six files, each folded into the plan and tracker.
- [x] **R0.3** Per-test timings: a JSON reporter beside the list reporter in `playwright.config.ts`,
  writing `test-results/timings.json`, and `node tools/tests/timings.mjs` to print the slowest files
  and tests. *Verified:* the baseline run printed its slowest tests and files (942d980).
- [x] **R0.4** Baseline run on this branch: 395 passed, 1 skipped, 0 failed, 648 s on the clock
  (1,848 s of test time). *Verified:* `inventory/baseline.md`, every test in
  `inventory/baseline-tests.csv` (942d980).
- [x] **R0.4b** (found on the way) The server listens on localhost only unless `--listen all` /
  `LISTEN=all` (the Docker image sets it): Windows' firewall prompt came up for every new server
  path, and the user is often away. *Verified:* netstat shows only 127.0.0.1 and ::1; all three
  local names answer (e483b4b).
- [ ] **R0.5** (you, optional) Play the five recent pushes on beta (Lanternwick's buildings, Goblin's
  Dread's way in and a party, `?yard&goblins=6`, the painted icons, `/library.html` locally). Listed
  in the progress report; nothing waits for it.
- [x] **R0.6** Tidy (agreed): stopped the leftover Vite on 5242; the locked agent worktree's 23
  changes checked three-way against `beta` (nothing it had was missing from `beta`); the worktrees
  `yggdrasil-improve-animations`, `yggdrasil-look`, `yggdrasil-trees`, `yggdrasil-dungeon` and the
  agent worktree removed, their `scratch/` work (6,784 files) and the dungeon's logs moved first to
  the main checkout's `scratch/from-<worktree>/`; merged local branches deleted; the remote `main`
  (was 33eb2f6), `feature/improve-animations` (2edf82f) and `feature/improve-ui` (b1089bc) deleted,
  all fully in `beta`. *Verified:* `git worktree list` shows the main checkout and this one; branches
  `beta`, `refactor/first`, `origin/beta`, `origin/production`. Left alone: the dungeon session's
  Postgres container `ruina-dungeon-db` (not ours).
- [x] **R0.7** Record the review's answers in the plan's Decisions table (D0-D14).
- [x] **R0.8** Design bible: the refactor as a `tech` feature (building), a `next` entry and a session
  entry. *Verified:* 115 features, every file path present.
- [x] **R0.9** Git LFS (decided): `.gitattributes` tracks models, pictures, fonts, sound, the baked
  island and zips; 243 files converted at HEAD with `git add --renormalize` (no history rewrite, no
  force push); CI fetches them through `.github/actions/lfs`, cached by their ids; GitHub Free
  includes 10 GiB of LFS storage and 10 GiB of downloads a month. *Verified:* `git lfs ls-files` 243,
  `git lfs fsck` OK (08bd2b9). Still to see: a fresh clone after the first push (R13.8).
- [x] **R0.10** `progress.md` started; an entry per phase from here on.

## Phase 1: Test Tiers

- [ ] **R1.1** Vitest 4.1 (`vitest.config.ts`): Node, `tests/unit/**/*.test.ts`, resolves `src/` and
  JSON imports as Vite does. `npm run test:unit` runs it with `cargo test`.
- [ ] **R1.2** Folders: `tests/unit/`, `tests/integration/`, `tests/stress/`, `tests/support/`
  (`testServer.ts` and shared helpers). Pure moves first.
- [ ] **R1.2b** Shared test helpers in `tests/support/`: one way to boot a page and wait until the game
  is ready (18 specs write their own; the ready wait is copied 38 times), and a typed `window.__game`
  (586 `as any` casts in 30 test files today).
- [ ] **R1.3** Move the browserless tests to Vitest: skilltree 25, progress 6, input 3, travel 3,
  village 2, sea 1, dungeon-way-in 1, animation 1, net-actors 1. *Done when* Playwright no longer
  lists them and Vitest runs them green.
- [ ] **R1.4** The conformance specs (simcheck, worldcheck, lifecheck, aicheck, terraincheck,
  balance: 61 tests) run under Vitest too, in a `conformance` group of the integration tier (they
  need the release check programs). They are deleted in R8.13.
- [ ] **R1.5** A headless game harness: the rules half of `stepOnce` and the rules side of
  `window.__game` (`state`, `advance`, `reset`, `teleport`, `setBuild`, `life`, `lifeCommand`,
  `actors`, `events`, `ground`, `zone`...) callable in Node for the yard and the island.
- [ ] **R1.6** Move the ~82 rules tests onto that harness: movement 19, goblin 8, slime-pack 16, slime
  6, hotbar 6, game 3, skills 1, world 20, dungeon-way-in 2, travel 1. Tests that read HUD markers
  assert on events instead. Screenshots kept for people move to an integration "looks" test.
- [ ] **R1.7** Model and rig builders that don't make a WebGL renderer when imported; move the ~64
  gallery tests (animation 20, species 24, creatures 6, models 14) to Vitest.
- [ ] **R1.8** Playwright projects: `integration` (default) and `stress`. The 11 stress tests move
  (raid 2, net 2, look 5, game "performance snapshot", pvp "bots fight real players"), and the
  three-window tests (minigames, five skills-online) are considered for it. `@gpu`/`@alone` keep
  their meaning.
- [ ] **R1.9** Scripts: `test:unit`, `test:rust`, `test:integration`, `test:conformance`,
  `test:stress`, `test:all`; `check` (typecheck + unit), `check:beta` (+ integration),
  `check:release` (+ stress).
- [ ] **R1.10** Rust tests in debug with optimized dependencies (`[profile.dev.package."*"]`), not
  `--release`. *Done when* an edit-and-test loop is measured and recorded.
- [ ] **R1.11** Faster integration: boot once per worker and reset between tests where safe; keep each
  worker's browser profile (shader cache); measure each change, keep what helps.
- [ ] **R1.12** CI: the unit tier on every push, before the beta deploy; integration on pull requests
  to `production` and manual runs, sharded by time; stress on request (`workflow_dispatch` input)
  and before releases.
- [-] **R1.13** A `pre-push` hook: not asked for; the full tiers run before the one merge anyway.
- [ ] **R1.14** `docs/testing.md` and the AGENTS.md test section: the tiers, where a new test goes,
  tags, ports, private servers.
- [ ] **R1.15** Measure and log: unit tier time (target: about a minute), integration tier time
  (target: under today's 12 minutes), against R0.4.

## Phase 2: Clear Out Dead Code

- [ ] **R2.1** `knip` configured with every entry (the 9 HTML pages, configs, tests, tools,
  `import.meta.glob` users) and run with `node_modules` installed; `cargo clippy` (installed here, not
  in CI) with dead-code lints. Merge with `inventory/debt.md` section 1; each entry re-checked by grep.
- [ ] **R2.2** Remove the unused TypeScript: the 42 exports in `inventory/debt.md` section 1,
  `src/species/index.ts`, the unused `hero` and `quadruped` species (if nothing will use them), the
  never-built imported-species path (`registerSpecies`, `bakeImported`, `restClip`), the
  `render/models/index.ts` re-exports nothing uses. One commit per area; suite green after each.
- [ ] **R2.3** Remove the unused Rust: `terrain.rs`; the unused `pub` items (`FACTION_*`, `new_band`,
  `live_positions`, `recipes_at`, `has_crop_def`, `has_rideable`, `has_glider`, `slots_used`,
  `cell_size`, `hour_of_day`, `remove_box`, `remove_obstacle`, `surface::ROCK`); `CAST_HEAL`/`CAST_METEOR`.
  Test-only and aicheck-only items stay, marked `#[cfg(test)]` or moved beside their user.
- [ ] **R2.4** Dead data and stale words: `tuning.json` `slide.frames` (and the `tuning.rs:83` claim);
  stale comments (`character.ts:595`, `sim/types.ts:128`, `emberholm.json:2`, `tuning.rs:83`); the
  skill-tree tool's fallback to `tuning.skills.nodes`; README ports (7791-7795) and commands. The
  unused behaviours `skittish-hopper` and `prowler` stay (data future creatures can take up; the AI
  tests exercise them).
- [ ] **R2.5** `src/util/`: one `esc`, `TAU`, `clamp`, `lerp`, `angleDiff` (10, 20, 10, 7 and 2 copies
  today). `render/models/data.ts` uses the content modules instead of reading the JSON again;
  `ui/icons.ts`'s old emoji tables (`ABILITY_ICONS` copying `tuning.json`, `WEAPON_NAMES` copied again
  in `library/subjects/hero.ts:22`) go.
- [ ] **R2.6** Small fixes: `npm run server` off port 7777 (it clashes with `npm run up`); declare the
  `tools/models/` packages (`@gltf-transform/*`, `meshoptimizer`, `sharp`) as dev dependencies;
  `.dockerignore` the icon sheets, `design/goblins/` and `.plans/`; the root `balance.json` to
  `tools/balance/`; document `BALANCE_TRACE` and `LIFE_SUMMARY`.
- [ ] **R2.7** Browser storage: `yggdrasil.build`, `yggdrasil.skillxp`, `yggdrasil.untracked.*` move
  to `ruina.*` with a one-time migration on load (a test proves a saved build survives).
- [ ] **R2.8** Retire the toon look (decided): the 75 `NEW_LOOK` branches in 16 files, the CLASSIC
  palette, `OUTLINES`, the toon ramp, `?look=classic`; the box hero kept only as the stand-in while (or
  if) `hero.glb` fails to load. Tests that assumed the toon look under software WebGL updated.
- [ ] **R2.8b** Quality settings for weaker GPUs: a `low` setting of the new look (no screen effects,
  simpler materials and shadows, shorter view distance, fewer trees and props) picked automatically
  for software WebGL and integrated graphics, beside today's `medium` and `high`; measured in
  SwiftShader (CI's renderer) and recorded in the progress report.
- [-] **R2.9** The older galleries: became the Content Library, R6.15 (decided: one page for everything).
- [ ] **R2.10** Untested flags, one decision each, kept only with a test or a documented reason:
  `softlock=0`, `heroModel`/`heroHeight`/`heroGait`, `heroWeapons`, `sword=`, `?goblins` (keep, gets a
  test), `--virtual-clients`; the two `lag=ms` implementations made one option.
- [ ] **R2.11** Lint and format: rustfmt and clippy (`-D warnings` in CI); Biome for TypeScript with a
  light rule set. The one formatting commit lands at the start of Phase 5's move window, recorded in
  `.git-blame-ignore-revs`.
- [ ] **R2.12** Guards: `knip` in the unit tier (new dead code fails it); clippy in CI.

## Phase 3: Admin Menu

- [ ] **R3.1** Migration `0004`: `accounts.role` (`player` | `admin`, default `player`).
- [ ] **R3.2** `ADMIN_USERS` (usernames, comma-separated; decided: `philip`) applied at start-up,
  parsed beside the dev flags (`main.rs:76-81`), kept in AppState (`http.rs:44-58`), matched against
  `username_key`; locally for `?as=` accounts. Beta's variable is set with the final merge.
- [ ] **R3.3** `/api/me` returns `admin`: a field on `Account` (`accounts.rs:29-34`) filled in
  `signed_in` (114-124), `account_by_id` (150), `create_account` (147); the client's `Account`
  (`net/account.ts:6-9`). Tests for a player and an admin.
- [ ] **R3.4** Developer commands (grant, warp, teleport; seeded and timed mini-game challenges)
  require an admin, in every environment: `world_socket.rs:521` and `:541` become
  `dev_tools && account.admin`, so the checks at `world_game.rs:560` and `tables.rs:220` follow.
  Today beta's `DEV_TOOLS=1` gives them to every player. Tests: a player's command is refused.
- [ ] **R3.4b** The other open doors: `/api/dev/stop` (`http.rs:154`) checks for an admin session;
  `/ws/battle` (`http.rs:162`) checks sign-in and origin until Phase 10 deletes it; "start the island
  over" (`world_socket.rs:593`, `&fresh`) becomes an admin tool.
- [ ] **R3.5** The developer pages built into `dist` under `/dev/` (multi-page build); the server
  sends `/dev/*` only to an admin's session (sign-in is a cookie already, `server/src/http.rs`) and
  "not found" to anyone else.
- [ ] **R3.6** `src/dev/pages.ts`: one entry per page or developer zone (title, URL, what it's for,
  whether it needs the dev server or a server flag).
- [ ] **R3.7** The Admin menu (Title Case, design system), admins only: a card on the title screen
  (`splash.layer`, `splash.ts:60`), a button in character select's account row
  (`characterSelect.ts:71`), a menu-bar button in the open world (`addMenuButton`, `lifeUI.ts:235`,
  as Party does at `main.ts:367`: a new press, `Panel` kind and view), and a HUD button in the yard
  and on the battlefield (`render/hud.ts:143`). It also opens the developer panel, which today only
  the backquote key reaches.
- [-] **R3.8** A battlefield on demand: replaced by the battlefield developer zone, R10.7 (decided).
- [ ] **R3.9** Pages that save through Vite plugins (library notes, bug reports) explain themselves
  on beta instead of failing.
- [ ] **R3.10** Integration tests: menu shown and hidden, `/dev/` and commands refused to players.
- [ ] **R3.11** Docs: `docs/admin.md`, the AGENTS.md entry, the design bible.

## Phase 4: The /find-assets Skill (parallel)

- [ ] **R4.1** `.claude/skills/find-assets/SKILL.md`: when to use it, free first, the licence rules
  for a public repository, sources by kind, judging a find, showing you, importing, crediting,
  checking in the game, paid makers last with costs agreed.
- [ ] **R4.2** `tools/assets/search.mjs`: Poly Haven (models, textures, skies), ambientCG (textures;
  its v3 API, as v2 gets no more updates), Sketchfab (CC0/CC-BY, downloadable), Freesound
  (`license:"Creative Commons 0"` or Attribution; needs `FREESOUND_API_KEY`; previews come with the
  key, original files need its OAuth2 sign-in, so the user's hands), listed with licence, author,
  size and preview.
- [ ] **R4.3** `tools/assets/fetch.mjs`: downloads into a fresh `scratch/assets/<source>/<id>/` with a
  `credit.json` (what, where, author, licence) ready for `CREDITS.md`; the itch.io free-download
  steps for Quaternius and Kenney packs.
- [ ] **R4.4** Notes for sound (formats, loudness, length) and effects: the game has no sound yet, so
  the skill says what an audio engine part will need.
- [ ] **R4.5** Proven end to end: a prop, a texture, a sound and an animation found and fetched (not
  committed).
- [ ] **R4.6** AGENTS.md "Art and assets" points to the skill; `CREDITS.md` format checked; new
  binaries go through Git LFS.

## Phase 5: The Rust Workspace

- [ ] **R5.0** The moves script, `tools/refactor/moves.mjs`, reading `.plans/refactor/moves.tsv`
  (old path, new path) and fixing every reference: TypeScript imports; tests' path strings
  (`models.spec:192-193`, `village.spec:100-102`, `update.spec:209`, `library.spec:117`); the 41 source
  paths the library's subjects embed; `include_str!`/`include_bytes!` (18 point at `shared/`);
  Dockerfile, CI, `package.json`, `vite.config.ts` (the `src/app/bugs/logs.ts` regex); AGENTS.md,
  `docs/`, the skills, `design/status.json`. It can replay the same moves on any other branch.
- [ ] **R5.0b** The one formatting commit (rustfmt, Biome), listed in `.git-blame-ignore-revs`.
- [ ] **R5.1** Root `Cargo.toml` workspace with `crates/engine`, `crates/server`, `crates/tools`;
  one `target/` at the root.
- [ ] **R5.2** Move the pure rules modules into `crates/engine` (`inventory/rules-map.md` section 1:
  actor, actors, ai, pack, missiles, content, creatures, tuning, skills, jsmath, player, world, sim's
  `Battle`, open/\*, life/\*, minigames/\*); the engine depends on serde, serde_json and libm only.
  First cut the couplings: game.rs's combat rules from its protocol encoders and client slots;
  world.rs's use of sim.rs only for `Rng`; the lifecheck binary's use of
  `world_game::{load_island, player_state_json}` (island loading is a rule, so it moves); the loops
  `open`/`life` and `skills`/`tuning` (shared helpers such as `js_hypot`, `js_round`, `carry` into a
  module of their own).
- [ ] **R5.2b** One of each helper: one mulberry32 `Rng` (today in sim.rs, `Life::rand`, ai.rs `draw`,
  beacons.rs), one `len` (six copies), one set of `js_*` maths helpers.
- [ ] **R5.3** Server areas: `net/`, `db/`, `world/`, `battle/`, `admin/`; `main.rs` only starts things;
  `lib.rs`'s flat list of 30 modules becomes a few public areas.
- [ ] **R5.3b** Cut the battlefield loose from the open world: `world_game.rs:31,206` makes an empty
  `Battle` per channel; `game.rs:19-29` uses `protocol`, `sim` and `world`; `world::{World, Spawn}` are
  used by `player.rs`, `open/mod.rs`, `world_game.rs:33`. Shared types to the engine; the
  battlefield's own code fenced into `battle/` with no new work, until R10.10 deletes it.
- [ ] **R5.4** `crates/tools`: balance, loadtest (taking `tokio-tungstenite`, today compiled into every
  server build for a tool run by hand); the check programs until R8.13. `rayon` stays with the
  battlefield's loop only (until R10.8 brings parallel stepping to every zone).
- [ ] **R5.5** Determinism lints in the engine (`clippy.toml`): no `std` `HashMap`/`HashSet`, no
  `f64::sin`/`cos`/`tan`/`exp`/`ln`/`powf`/`atan2`/`hypot`... (use `libm`), no clocks, no `rand`. Fix
  the ~40 calls listed in `inventory/rules-map.md` section 2 (actors, ai, game, life/interact x11,
  farming, vehicles `powf`, minigames, world, sim, world_game, tables), checked against the
  TypeScript results (the conformance tolerance should shrink, not grow).
- [ ] **R5.5b** Bug: `world_game.rs:754` `rebuild_world` walks the estates `HashMap` (random order) and
  so inserts colliders in a different order each run. Walk them in a fixed order; a test proves two
  runs agree.
- [ ] **R5.6** Rust tests for `ai.rs`, `sim.rs`, `actors.rs`, `game.rs`: golden scenarios checked
  against today's TypeScript results.
- [ ] **R5.7** Build speed: dev-profile settings, linker trial on Windows, `cargo build --timings`
  report; Docker caching for a workspace (`cargo-chef` or stub crates).
- [ ] **R5.8** Paths: Dockerfile, CI, `package.json`, `tests/support/testServer.ts`, README,
  AGENTS.md, the design bible, memory notes (the live battle server's path).
- [ ] **R5.9** Rename the crate and binary `yggdrasil-server` to `ruina-server` (decided), with every
  `yggdrasil_server::` import, the Dockerfile, CI and scripts.
- [ ] **R5.10** Measure and log: engine edit-and-test, server-only edit, clean build.

## Phase 6: The Client in Areas

- [ ] **R6.0** Fix the boundary breaks first (`inventory/architecture.md` section 2): the network
  code stops building bodies and island views (`netPlayer.ts` makes `Hero`s, `worldPeers.ts` makes
  `Hero` + `LifeView` per player: it hands out state, rendering makes the views); the sign-in,
  character, party and mini-game windows stop calling the network directly (28 `link.*` calls, the
  account API) and go through app services; `content/creatures/hero.ts` stops importing three.js; the
  `content/actors.ts`/`sim/actor.ts` cycle and the seven two-way folder dependencies go.
- [ ] **R6.0b** Changes to the rules' state from outside become named calls on the bridge: `main.ts`
  375-391, 499-521, 1760-1955, 2387-2431; `app/dungeonVisit.ts` 38-39, 58-59; `app/save.ts` 62-87;
  `net/netPlayer.ts` 108-124 (swaps `sim.player`); `net/worldPeers.ts` 195, 202, 264 (colliders,
  movers).
- [ ] **R6.1** `src/app/options.ts`: every URL option in one list (name, what it does, developer or
  not), read once.
- [ ] **R6.2** `src/main.ts` into `src/app/`: start-up, a module per mode, the loop, wiring, along the
  seams in `inventory/architecture.md` section 1. Its 30 top-level variables become one game context
  the modes share; the use-before-declare closures (`prediction`, `frozen`, `ahead`), the patched
  `life.command` and the twice-chained `lifeUI.intercept` go.
- [ ] **R6.3** `src/app/testApi.ts`: `window.__game` in a module of its own, typed.
- [ ] **R6.4** `src/engine/`: the one bridge to the rules; everything else imports it, not `src/sim/`.
- [ ] **R6.5** `src/ui/components/`: window, tabs, item slot and grid, list, tooltip, context menu,
  bars, buttons, per the design system.
- [ ] **R6.6** `src/ui/life/lifeUI.ts` into one module per window on those components.
- [ ] **R6.7** `src/library/app.ts` split by concern.
- [ ] **R6.8** `src/dev/` and `dev/*.html`: every developer page; the admin list (R3.6) updated.
- [ ] **R6.9** A UI gallery (a Content Library subject or `/dev/ui.html`): every window with made-up
  state.
- [ ] **R6.10** Creature bodies into `src/render/creatures/` (from `src/species/`, `src/creatures/`,
  `src/crowd/`, `src/content/creatures/`).
- [ ] **R6.11** Root files to their areas: `src/skills.ts`, `src/tuning.ts`, `src/build.ts`,
  `src/rng.ts`. Names that say what they are: today there are 5 `index.ts`, 4 `types.ts`, 3 each of
  `pose.ts`/`hero.ts`/`harness.ts`, `sim/world.ts` beside `sim/zone/world.ts`, and
  `content/creatures.ts` beside a `content/creatures/` folder.
- [ ] **R6.11b** Workarounds out: the 15 `tryBuild(...) ?? standIn` fallbacks for a models folder that
  can't be missing (or real lazy loading, R11.2); `worldPeers.ts:258`'s fake `Sim`; the library's and
  `animations.ts:650`'s reaching into the hero's private fields; `main.ts:505` (the TypeScript command
  list lacks Rust's `teleport`: generated from Rust in Phase 8).
- [ ] **R6.12** The boundary test (unit tier): allowed imports per area; known exceptions listed with a
  reason.
- [ ] **R6.13** An AGENTS.md (and a CLAUDE.md that imports it) in `src/render`, `src/ui`, `src/net`,
  `src/app`, `src/dev`.
- [ ] **R6.14** Look check: `tests/look.spec.ts` before and after, no change.
- [ ] **R6.15** The Content Library (decided: one page for everything): the animation library grows
  subjects for models (`models.html`: categories, anchors, budgets), buildings (`buildings.html`:
  plans, cut-away, colliders, night), species and creatures, retargeted clips beside their sources
  (`retarget.html`), and the scenarios of `animations.html`; those six pages and their `window.__x`
  APIs go, their tests moved to the library or the unit tier. Later phases add a subject per content
  kind (R9.13).

## Phase 7: Content in Folders

- [ ] **R7.1** The layout (decided): `content/` with a folder per kind and a file or folder per thing.
- [ ] **R7.2** `contentc` (engine types, a `crates/tools` binary): read folders, join multi-file
  things, reject unknown keys and missing fields, check every cross-reference, write bundles.
- [ ] **R7.3** Bundles in today's shapes: the TypeScript imports and the server's reads point at them;
  the game unchanged (suite green).
- [ ] **R7.4** Move the files: `shared/*.json` split into `content/<kind>/...` (pure moves and
  splits, script-checked to be the same data).
- [ ] **R7.5** The dev server rebuilds content on a change; Docker and CI build it before the client
  and the server.
- [ ] **R7.6** JSON Schemas generated into `content/_schemas/`; files name their schema for editors.
- [ ] **R7.7** Unit tests: every file valid; a bad field and a broken reference each fail.
- [ ] **R7.8** `content/AGENTS.md`: the layout and how to add each kind (today's recipe, with the code
  steps that Phase 9 removes marked).

## Phase 8: One Copy of the Rules

- [ ] **R8.1** Toolchain: `rustup target add wasm32-unknown-unknown`, `wasm-bindgen-cli` pinned to
  the crate's version, `npm run engine` (and a dev-server watch), Vitest and Vite loading, Docker and
  CI.
- [ ] **R8.2** Spike: ground height and collider queries end to end through `crates/engine-wasm`
  (the render reads ground height every frame for the shadow), measured per frame, before the
  interface is settled.
- [ ] **R8.3** The interface (`docs/engine.md`): step with inputs (~17 action fields), commands in,
  events and commands out; named calls for every write JavaScript makes into the rules today
  (`inventory/rules-map.md` section 3: the server's player at reconcile, island state from ticks,
  movers, colliders, respawn point, dungeon, levels); views: typed arrays over WebAssembly memory for
  what each frame reads (~100 fields: the player's ~27, ~10 per actor, vehicles, packs, animals) and
  versioned snapshots for what changes rarely (the island's state, read by the UI); TypeScript types
  generated from Rust.
- [ ] **R8.3b** The rules' calls back into JavaScript become inputs and outputs: the world clock
  (read every step today, replays included; set once per step instead), `othersVehicles` and
  `othersAround` (set per frame), `plotOwner` (set on change), `remote` (commands returned after the
  step).
- [ ] **R8.4** Determinism test (unit tier): the same scenario natively and in WebAssembly ends in the
  same state hash, bit for bit.
- [ ] **R8.5** Shadow mode: in dev and tests, the engine runs beside the TypeScript rules and every
  step is compared; any difference fails the test.
- [ ] **R8.6** Switch the ground, colliders and dungeons. Port the island's generator
  (`zone/generate.ts` 710, `zone/buildings.ts` 207, TS-only today) to Rust: the server makes the island
  at start, the browser through the engine; delete the bake step and `server/data/emberholm.zone`.
  Delete the TypeScript copies and the terrain conformance cases.
- [ ] **R8.7** Switch the island's life systems (life, state, trade, farming, housing, shipyard,
  livestock, vehicles, contracts, quests, progress, weather, interact: ~3,500 TS lines, 1:1 with
  `life/`). The UI and `render/open/life.ts` read versioned snapshots; `life.command` goes in as
  commands. Delete the copy and life-conformance.
- [ ] **R8.8** Switch creatures: actor, actors/step, brain, pack, senses, missiles, hit, deal (offline
  yard and offline monsters; online, `netMonsters.ts`'s `coneHits` and `behaviour()`). Delete the copy
  and ai-conformance.
- [ ] **R8.9** Switch the player step: locomotion, abilities, attacks, vitals, traverse, `sim.ts`
  with its training branch (hit-stop, the dummy, auto-aim, pushing against actors) and `training.ts`
  (the yard's arrows, meteors and heal, ported from TypeScript), skills and builds. Prediction's
  reconcile-and-replay runs inside the engine, one call per snapshot. Delete the copy, conformance and
  world-conformance.
- [-] **R8.10** The raid's crowd: not ported; bot players replace it (R10.5, R10.10).
- [ ] **R8.11** Mini-game rules in the browser from the engine (the board shows what the same rules
  allow).
- [ ] **R8.12** Road routing (`zone/roads.ts`, `zone/localPath.ts`, TS-only, browser-only) reads the
  island through the bridge; it stays TypeScript unless the server needs it.
- [ ] **R8.13** Delete `src/sim/`, the check programs and the conformance specs.
- [ ] **R8.14** Measure against the baseline: frame time, start-up, download size, memory. Log it.
- [ ] **R8.15** `crates/engine/AGENTS.md`: determinism rules, adding a system, testing it.

## Phase 9: Content as Data, Finished

- [ ] **R9.1** Saved builds by id (weapons, abilities, movement skills, skill-tree nodes); a migration
  converts existing saves; tested on copies of real saves.
- [ ] **R9.2** Wire indexes from the compiled bundle; the connection compares bundle hashes.
- [ ] **R9.3** Spawns in zone and dungeon data; the built-in `slimes`/`dummy` keys go; `?goblins=`
  becomes a developer option on top of data.
- [ ] **R9.4** NPCs in `content/npcs/`; `FACES`, `GREETINGS`, `BENCH_OF` out of the UI.
- [ ] **R9.5** Weapons and abilities from data (icons, moves, models, stowing); causes on the wire by
  kind and id.
- [ ] **R9.6** Quest markers from quest data; no place ids in the UI.
- [ ] **R9.7** Item behaviours from data: placeables, rare drops, default craft place, the labor cap
  from `LABOR.max`, categories and their labels.
- [ ] **R9.8** Dungeons from their folder (no lists in code); each dungeon's dressing in data.
- [ ] **R9.9** Looks from data (made model with fit and clips, or a built-in body with settings);
  builders by id become fallbacks; the prose `look` fields become real ones.
- [ ] **R9.10** Zones: the generator's special cases by id become data flags; more than one zone can
  load.
- [ ] **R9.11** Mini-games: a game is a rules module plus a board view; the table framework reads the
  list from content.
- [ ] **R9.12** A test that no content id appears in code, with an allowlist of reasons.
- [ ] **R9.13** Templates per kind (`content/_templates/`) and fixture tests that add a creature, an
  NPC, an item, a quest and a vehicle as data only and play them; a Content Library subject per kind.
- [ ] **R9.14** `docs/content.md`: a recipe per kind, data files only.

## Phase 10: Zones, Developer Zones and Bots

- [ ] **R10.1** A zone is a content folder (`content/zones/<id>/`): its recipe or layout, spawns, rules
  flags (PvP, developer, instanced), ways in and out. The engine loads any zone; the generator builds
  any recipe (after R9.10).
- [ ] **R10.2** The server hosts any zone as channels and copies (today's `spaces.rs` handles channels
  and dungeon copies: generalized), with travel between zones and where each character is saved.
- [ ] **R10.3** Developer zones: a `developer` flag; only admins may enter (the server checks); the
  admin menu lists them from the zone list.
- [ ] **R10.4** The training yard as a zone (`content/zones/yard/`): its layout (today's `makeWorld`),
  the dummy, targets and slimes (and goblins) as spawns. The yard's own rules (hit-stop, auto-aim, the
  dummy) are engine rules any zone can switch on.
- [ ] **R10.5** Bots in the engine: a bot is a player whose inputs and commands come from a brain
  (brains are data, as creatures' are), stepped by the server like a player without a socket and
  marked as a bot on the wire. First brains: a skirmisher (find a foe, fight, retreat when hurt) and
  a wanderer.
- [ ] **R10.6** Zones spawn bots from data: how many, which sides, which brain, where.
- [ ] **R10.7** The battlefield as a zone (`content/zones/battlefield/`): today's `makeBattlefield`
  layout, two sides, armies of bots. It runs only while an admin is inside: the first admin in starts
  it and spawns its bots; when the last admin leaves, it stops and its bots go (decided).
- [ ] **R10.8** Crowds at scale in every zone: the interest grid (each client is sent what's near it,
  far things coarser), compact snapshots for many entities, players and bots stepped in parallel
  (`rayon`). Measured: server tick time and bandwidth for N bots.
- [ ] **R10.9** One world client for every zone: the battle client path (`?server=`, `netCrowd.ts`'s
  battle parts, RemotePlayers) goes; far bodies drawn by the crowd renderer.
- [ ] **R10.10** Delete the battlefield's own code: `sim.rs` (its bots), its loop in `main.rs`,
  `interest.rs` (moved into the world server), `net.rs` and `/ws/battle`, its protocol, `world.rs`'s
  layout (now data), the flags `--battle`, `--bots`, `--virtual-clients`; on the client
  `crowd/crowdSim.ts`, `?raid`, `?server=`, `?yard` and `?test`'s yard; `loadtest` drives bots or
  virtual clients against a zone instead.
- [ ] **R10.11** Offline: the browser's engine runs any zone locally for tests and development (one
  option for tests in place of `?yard`/`?test`/`?world&test`).
- [ ] **R10.12** Tests: unit (zone loading, bot brains); integration (an admin enters the yard and the
  battlefield from the menu, a player is refused, the battlefield starts and stops with an admin
  inside); stress (thousands of bots in the battlefield: frame time, tick time, bandwidth).
- [ ] **R10.13** `docs/zones.md`: adding a zone, a developer zone, bots.

## Phase 11: Bigger Than 64 MB

- [ ] **R11.1** The asset manifest: id, hashed file, size, kind, zones; built with the client.
- [ ] **R11.2** The loader: the first download carries the title screen and start; the rest streams by
  zone and distance, low detail first, with progress. Today (`inventory/architecture.md` section 7)
  models are eager URL globs, the hero and its four weapons (~1.9 MB) load with character select's
  preview, the village kit (3.8 MB) and ground textures (2.4 MB) when the island builds, and the
  `models` chunk is only partly lazy (`models/kit.ts` and `models/glb.ts` are in the main bundle).
- [ ] **R11.3** Caching: `immutable` for hashed files, revalidation for pages and the manifest, brotli.
- [ ] **R11.4** Optional: a service worker that keeps assets and prefetches the next zone.
- [ ] **R11.5** KTX2 textures where they save size or GPU memory.
- [x] **R11.6** Where big files live: Git LFS (decided; done in R0.9). A CDN in front later is a
  manifest setting.
- [ ] **R11.7** A first-download budget the integration tier enforces.
- [ ] **R11.8** `docs/assets.md`: the pipeline from a find to the manifest.

## Phase 12: The Design Bible as a Knowledge Base

- [ ] **R12.1** The design: sections (what Ruina is; systems; the world; things; development), where
  the written explanations live (beside the content they describe; system pages in the bible's own
  folder), and how numbers get in (taken from the compiled content when the page is built, never
  copied into prose by hand).
- [ ] **R12.2** The page: `/bible/` in the built game, open to players, linked from the title screen and
  the admin menu; navigation, search, links between pages.
- [ ] **R12.3** A page per system, written from the engine's rules, with the formulas and numbers:
  moving and climbing, swimming and gliding, combat, skills and builds, creatures and their AI,
  farming and gathering, livestock, trade and pack running, contracts, housing, vehicles and the
  shipyard, quests and progress, weather and the clock, the world and its places, parties and
  dungeons, mini-games, economy and labor.
- [ ] **R12.4** A page per thing, generated: items, recipes, vendors, creatures, NPCs, quests, skills
  and the skill tree, weapons and abilities, vehicles, mounts and gliders, buildings, crops, animals,
  zones, dungeons.
- [ ] **R12.5** The completeness test (unit tier): every system and every piece of content has its
  page and its explanation.
- [ ] **R12.6** The Development tab: today's tracker view of `design/status.json`, for admins.
- [ ] **R12.7** Docs: how to keep the bible current when adding a system or content (AGENTS.md).

## Phase 13: AGENTS.md, the Docs and the Merge

- [ ] **R13.1** AGENTS.md rewritten (map, boundaries, recipes, commands, tiers, rules, assets,
  deploys, other sessions), linking to `docs/` and the area AGENTS.md files.
- [ ] **R13.2** `docs/`: architecture, engine, content, zones, testing, assets, deploys, admin.
- [ ] **R13.3** The design bible's tracker: every moved path updated (moves script), the refactor's
  features done, a session entry per phase.
- [ ] **R13.4** The path check (unit tier): every path named in AGENTS.md, `docs/`, the skills and
  `design/status.json` exists.
- [ ] **R13.5** README: a quick start that points to AGENTS.md and `docs/`.
- [ ] **R13.6** Memory notes on this machine updated (paths, ports, commands).
- [ ] **R13.7** Close-out: the plan's goals checked one by one with numbers against the baseline.
- [ ] **R13.8** The merge: `beta` merged into the branch; every tier green (unit, integration, stress);
  merged into `beta` and pushed; `ADMIN_USERS=philip` on Railway beta; CI and the deploy watched; the
  feature marked done in the design bible; the last progress entry.

## Every Phase Ends With

- The tiers green on `refactor/first` (the full suite until Phase 1 lands).
- `beta` merged into the branch (conflicts resolved, green again).
- AGENTS.md and `design/status.json` say what changed; `moves.tsv` has every move.
- A progress entry and a log line below.

## Log

| Date | Task | What landed | Commit |
|---|---|---|---|
| 2026-11-05 | R0.1 | Branch and worktree made from `beta` d49c3b8 | (none) |
| 2026-11-05 | R0.2 | Survey of the whole codebase in six inventory files; plan and tracker written | (see next) |
| 2026-11-05 | R0.7 | Review answers recorded (D0-D14); plan revised: one merge at the end, Phase 10 zones and bots, Phase 12 knowledge base | c7f1e57 |
| 2026-11-05 | R0.9 | Binaries in Git LFS, CI fetching them from a cache | 08bd2b9 |
| 2026-11-05 | R0.4b | The server listens on localhost only unless `--listen all` | e483b4b |
| 2026-11-05 | R0.3, R0.4 | Timing reporter; the baseline (395 pass, 10.8 min) | 942d980 |
| 2026-11-05 | R0.6, R0.8, R0.10 | Worktrees and branches tidied; the refactor in the design bible; Phase 0 done | (next commit) |
