# Refactor Tracker

Every task of [the plan](README.md), in order. A task is ticked only when it is done **and**
verified as its line says; each landing is logged at the bottom with its commit, and each phase gets
an entry in [progress.md](progress.md).

Key: `[ ]` to do · `[~]` in progress · `[x]` done and verified · `[-]` dropped (say why) ·
`(you)` needs your answer or your hands · `(parallel)` can run beside the main line.

## Now

- **Phase:** 8 (one copy of the rules: the browser plays on the engine's) and 10 (one world: its
  foundations, decided 2026-11-06, D16-D19), with 9's rest beside them; 7, 11 and 12 done.
- **Next:**
  1. Delete `src/sim/` (R8.13). Its read side moves into `src/engine/` under the world's words
     (R10.14).
  2. Measure (R8.14).
  3. Phase 10's foundations, in order:
     - R10.14 the words;
     - R10.15 spaces;
     - R10.1 and R10.16 the world as data and the world map;
     - R10.17 ids and the clock;
     - R10.18 the tick that splits;
     - R10.19 borders;
     - R10.20 the server's tiers;
     - R10.21 land and the ledger;
     - R10.8 the wire;
     - R10.2 and R10.22 hosting and channels;
     - R10.23 the client;
     - R10.24 proof at scale;
     - R10.25 the guide.
  4. Phase 13 and the merge.

  The multi-server version follows the merge (`.plans/world/`).
- **How:** one session does the work, with at most two sub-agents beside it, on Opus 5.5 at max
  effort, each in a worktree of its own with its own ports and database (the user's call on
  2026-11-06: three at once used tokens too fast; one was allowed, then a second). They did the
  mini-games (R9.11, R8.11) and the UI gallery (R6.9); now the bible's reading of the engine's Rust
  (R8.13's part) and saved builds by id with the bundle's hash on the wire (R9.1, R9.2).
- **Races under load (the Mac, four workers):** these lose a race now and then and pass alone:
  `online.spec.ts:50`, `:109`, `:258`, `:617`, `party.spec.ts:121`, `combat.spec.ts:185`; and
  `game.spec.ts:43` and `dungeon-way-in.spec.ts:50` when Vite reloads the page at the start of a run
  as it optimizes its dependencies. To look at with R1.11. The battlefield's `Cleave hits both` and
  `battlefield.spec.ts:375` weren't races: the battlefield takes 20 and keeps a player who has left
  for a minute, so the spec's fresh fighters filled it a few tests in. They leave through its way out
  now, and the spec passes whole.
- **Where:** from 2026-11-06 the work goes on on the Mac laptop, in the main checkout
  (`~/Documents/GitHub/games/ruina_the_game`, branch `refactor/first`; Git LFS installed with
  Homebrew). The Windows worktree `C:\GitHub\games\yggdrasil-refactor` was the first machine; its last
  state is a975617.
- **Test rig for this branch (the Mac):** Postgres container `ruina-refactor-db` on 127.0.0.1:5461
  (`docker run -d --rm --name ruina-refactor-db -e POSTGRES_USER=ruina -e POSTGRES_PASSWORD=ruina
  -e POSTGRES_DB=ruina -p 127.0.0.1:5461:5432 postgres:18`); a world server on 7871 run as a
  background task from a copy of the release binary, so a rebuild doesn't pull it out from under the
  tests (`cp target/release/ruina-server scratch/rig/ && DATABASE_URL=postgres://ruina:ruina@127.0.0.1:5461/ruina
  DEV_LOGIN=1 ./scratch/rig/ruina-server --port 7871`); the suite with `PW_PORT=5261
  TEST_PORT_OFFSET=60 RUINA_SERVER=http://localhost:7871
  RUINA_DATABASE_URL=postgres://ruina:ruina@127.0.0.1:5461/ruina` and `--output=scratch/pw-*`.
  Servers listen on localhost only.
- **Decided 2026-11-06 (D15):** the client will be packaged as a desktop app later, so the work
  that only keeps a browser's download small is out: R11.4 and R11.5 dropped, the first-download
  budget test (R11.7) removed, R8.14 measures no download size.
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

- [x] **R1.1** Vitest 4.1.12 (`vitest.config.ts`): projects `unit` (`tests/unit`) and `conformance`
  (`tests/conformance`), Node. *Verified:* 57bbd61.
- [x] **R1.2** Folders: `tests/unit/`, `tests/conformance/`, `tests/integration/`, `tests/stress/`,
  `tests/support/`; moved with the moves script (pulled forward from R5.0), the specs' paths rewritten
  everywhere; Playwright plays `tests/integration`, `playwright.stress.config.ts` plays
  `tests/stress`. *Verified:* 1e0bf67; the moves script missed template-string URLs
  (``new URL(`../shared/${f}`, import.meta.url)``) in two specs, found by the first integration run,
  fixed in the specs and in the script with a test.
- [x] **R1.2b** Shared test helpers (`tests/support/game.ts`): `openGame`, `gameReady` (38 copies
  replaced), `onlineReady` (5); `window.__game` typed from `src/main.ts`'s `GameApi` for the tests
  (526 calls; nothing "possibly null" to a test, names and arguments checked; the specs' command and
  key helpers take the game's own `Command` and `LifePress`). *Verified:* typecheck clean (cd3081b).
- [x] **R1.3** The browserless tests on Vitest: progress, skill tree, keyboard (whole files) and the
  Node tests cut out of travel (roads), village (buildings), sea, dungeon-way-in (falls), animation
  (prediction) and net-actors (timeline): 53 unit tests in 3.3 s (0c60593, ad6b747).
- [x] **R1.4** The conformance specs on Vitest (`tests/conformance`: player, world, life, ai, terrain,
  and the balance check cut out of the skill tree): 63 tests in 39 s, where life-conformance alone
  took 64 s under Playwright. `npm run bake` replaces `BAKE=1 npx playwright test ...` (7 s).
- [-] **R1.5, R1.6, R1.7** The headless game harness (~82 rules tests) and renderer-free model
  builders (~64 gallery tests) moved to Phase 6 as R6.2a: both need `main.ts`'s rules half pulled out
  into a module of its own, which is the first step of splitting `main.ts`; doing it here would mean
  doing that surgery twice.
- [x] **R1.8** The stress tier: `playwright.stress.config.ts` plays `tests/stress` one test at a time:
  raid, net and look (whole files) and the yard's live performance snapshot (cut out of game.spec).
  pvp's "bots fight real players" (already `@gpu`) moves in Phase 10, which replaces the
  battlefield's bots. The three-window tests stay integration (`@gpu`, one at a time): they test
  behaviour, not speed. *Verified:* perf.spec passes from the stress config.
- [x] **R1.9** Scripts: `test` (= unit), `test:unit`, `test:rust`, `test:conformance` (builds the check
  programs first), `test:integration`, `test:stress`, `test:all`, `check`, `check:beta`,
  `check:release`, `bake`; cargo through `tools/cargo.mjs` where the PATH lacks it.
- [x] **R1.10** Rust tests in debug with optimized dependencies and line-table debug info: a real edit
  to a rules file tested in 7 s (library) / 12 s (all), from 51 s debug / 106 s release; one-off
  110 s to optimize the dependencies (c85dfb3).
- [-] **R1.11** Faster integration (boot once per worker, keep the shader cache): moved after R6.2a,
  when ~82 rules tests and ~64 gallery tests have left the integration tier and what remains is
  mostly UI and online play; measure then, and keep what helps.
- [x] **R1.12** CI: the unit tier on every push (Vitest in the client job, Rust tests in debug); the
  release build, conformance (shard 1) and Playwright only where the integration tier runs (pull
  requests, production, manual); stress stays local (it needs a real GPU). Time-based sharding not
  needed while CI plays the integration tier only for releases. *To verify:* the first CI run after
  the merge (R13.8).
- [-] **R1.13** A `pre-push` hook: not asked for; the full tiers run before the one merge anyway.
- [x] **R1.14** `docs/testing.md`, `tests/AGENTS.md` (and `tests/CLAUDE.md` importing it), AGENTS.md's
  commands, test rules and layout row (4183398).
- [x] **R1.15** Measured against R0.4: unit tier ~3 s (TypeScript, 54 tests) + 12 s (Rust, after an
  edit), conformance 39 s (63), integration 281 tests in 8.7 min all passing (from 395 in 10.8 min),
  stress 10 tests. Targets met (a minute for the unit tier; under 12 minutes for integration) except
  "at least 230 TypeScript unit tests", which moved with R6.2a.

## Phase 2: Clear Out Dead Code

- [x] **R2.1** `knip` configured with every entry (the 9 HTML pages, configs, tests, tools,
  `import.meta.glob` users) and run with `node_modules` installed; `cargo clippy` (installed here, not
  in CI) with dead-code lints. Merge with `inventory/debt.md` section 1; each entry re-checked by grep.
  Done (5307934): `knip.json`; clippy installed with rustfmt.
- [x] **R2.2** Remove the unused TypeScript: the 42 exports in `inventory/debt.md` section 1,
  `src/species/index.ts`, the unused `hero` and `quadruped` species (if nothing will use them), the
  never-built imported-species path (`registerSpecies`, `bakeImported`, `restClip`), the
  `render/models/index.ts` re-exports nothing uses. One commit per area; suite green after each.
  Done (5307934): 48 exports and the barrel file. The `hero` and `quadruped` species stay: the
  library and the species harness show them as test subjects. `render/models/index.ts` is used.
- [x] **R2.3** Remove the unused Rust: `terrain.rs`; the unused `pub` items (`FACTION_*`, `new_band`,
  `live_positions`, `recipes_at`, `has_crop_def`, `has_rideable`, `has_glider`, `slots_used`,
  `cell_size`, `hour_of_day`, `remove_box`, `remove_obstacle`, `surface::ROCK`); `CAST_HEAL`/`CAST_METEOR`.
  Test-only and aicheck-only items stay, marked `#[cfg(test)]` or moved beside their user.
  Done (560ce2b): 16 items; `surface::ROCK` stays, part of the surface table shared with TypeScript.
- [x] **R2.4** Dead data and stale words: `tuning.json` `slide.frames` (and the `tuning.rs:83` claim);
  stale comments (`character.ts:595`, `sim/types.ts:128`, `emberholm.json:2`, `tuning.rs:83`); the
  skill-tree tool's fallback to `tuning.skills.nodes`; README ports (7791-7795) and commands. The
  unused behaviours `skittish-hopper` and `prowler` stay (data future creatures can take up; the AI
  tests exercise them). Done (034dc6e).
- [x] **R2.5** `src/util/`: one `esc`, `TAU`, `clamp`, `lerp`, `angleDiff` (10, 20, 10, 7 and 2 copies
  today). `render/models/data.ts` uses the content modules instead of reading the JSON again;
  `ui/icons.ts`'s old emoji tables (`ABILITY_ICONS` copying `tuning.json`, `WEAPON_NAMES` copied again
  in `library/subjects/hero.ts:22`) go. Done (ac2ac82, 712c5e9; the combat rules' own `angleDiff`
  with the Admin menu's commit). `render/models/data.ts` moves to Phase 7 (R7.4), where the content
  modules are rebuilt anyway.
- [x] **R2.6** Small fixes: `npm run server` off port 7777 (it clashes with `npm run up`); declare the
  `tools/models/` packages (`@gltf-transform/*`, `meshoptimizer`, `sharp`) as dev dependencies;
  `.dockerignore` the icon sheets, `design/goblins/` and `.plans/`; the root `balance.json` to
  `tools/balance/`; document `BALANCE_TRACE` and `LIFE_SUMMARY`. Done (5307934, e0a106b, b09b6f5).
  The `npm run server` port item is dropped: Phase 10 removes the battle server it starts.
- [x] **R2.7** Browser storage: `yggdrasil.build`, `yggdrasil.skillxp`, `yggdrasil.untracked.*` move
  to `ruina.*` with a one-time migration on load (a test proves a saved build survives). Done (e0c94a8).
- [x] **R2.8** Retire the toon look (decided): the 75 `NEW_LOOK` branches in 16 files, the CLASSIC
  palette, `OUTLINES`, the toon ramp, `?look=classic`; the box hero kept only as the stand-in while (or
  if) `hero.glb` fails to load. Tests that assumed the toon look under software WebGL updated.
  Done (e97d392, 3100d2b) by a background agent: one look; the box hero stands in only until
  `hero.glb` loads, or for good if it can't.
- [x] **R2.8b** Quality settings for weaker GPUs: a `low` setting of the new look (no screen effects,
  simpler materials and shadows, shorter view distance, fewer trees and props) picked automatically
  for software WebGL and integrated graphics, beside today's `medium` and `high`; measured in
  SwiftShader (CI's renderer) and recorded in the progress report. Done (e97d392): `GRAPHICS` in
  `look.ts`; in SwiftShader low draws a frame in 285-367 ms (the toon look 235-597, high 2092-3529);
  on Intel UHD at 1080p the square costs 14.4 ms of GPU at low (the toon look 14.6, high 51.6).
  Left: at low, tree tops on the far ridge drawn without haze (the agent is on it).
- [-] **R2.9** The older galleries: became the Content Library, R6.15 (decided: one page for everything).
- [x] **R2.10** Untested flags, one decision each, kept only with a test or a documented reason:
  `softlock=0`, `heroModel`/`heroHeight`/`heroGait`, `heroWeapons`, `sword=`, `?goblins` (keep, gets a
  test), `--virtual-clients`; the two `lag=ms` implementations made one option. Decided:
  `?goblins` kept, with a test (goblin.spec); `heroModel`, `heroHeight`, `heroGait`, `heroWeapons`,
  `sword=` and `swordMoves=` kept, documented where they're read: they're the animation work's
  switches for trying a body, a weapon or a set of moves without shipping it (that code is the
  animation session's); `softlock=0` kept, documented in the option list (comparing targeting feel);
  all of them listed with R6.1's options module. `--virtual-clients` and the battle server's own
  `lag` go with the battle server in Phase 10 (R10.7), leaving `?lag=` one option.
- [~] **R2.11** Lint and format: rustfmt and clippy (`-D warnings` in CI); Biome for TypeScript with a
  light rule set. The one formatting commit lands at the start of Phase 5's move window, recorded in
  `.git-blame-ignore-revs`. Clippy done (d158ac1); rustfmt and Biome with Phase 5's formatting commit.
- [x] **R2.12** Guards: `knip` in the unit tier (new dead code fails it); clippy in CI. Done: both in
  `npm run check` and CI (5307934, d158ac1).

## Phase 3: Admin Menu

- [-] **R3.1** Migration `0004`: `accounts.role` (`player` | `admin`, default `player`). Dropped: the
  server checks `ADMIN_USERS` at sign-in and on each request, so nothing needs storing; a role column
  can come with an admin-management screen, if one is ever wanted.
- [x] **R3.2** `ADMIN_USERS` (usernames, comma-separated; decided: `philip`) applied at start-up,
  parsed beside the dev flags (`main.rs:76-81`), kept in AppState (`http.rs:44-58`), matched against
  `username_key`; locally for `?as=` accounts. Beta's variable is set with the final merge. Done
  (8ee8144). On a development server everyone is an admin unless `ADMIN_USERS` names someone (so a
  test, or a developer, can be a player).
- [x] **R3.3** `/api/me` returns `admin`: a field on `Account` (`accounts.rs:29-34`) filled in
  `signed_in` (114-124), `account_by_id` (150), `create_account` (147); the client's `Account`
  (`net/account.ts:6-9`). Tests for a player and an admin. Done (8ee8144; `admin.spec.ts`).
- [x] **R3.4** Developer commands (grant, warp, teleport; seeded and timed mini-game challenges)
  require an admin, in every environment: `world_socket.rs:521` and `:541` become
  `dev_tools && account.admin`, so the checks at `world_game.rs:560` and `tables.rs:220` follow.
  Today beta's `DEV_TOOLS=1` gives them to every player. Tests: a player's command is refused.
  Done (8ee8144; `DEV_TOOLS` is gone; `admin.spec.ts` sends a player's grant).
- [x] **R3.4b** The other open doors: `/api/dev/stop` (`http.rs:154`) checks for an admin session;
  `/ws/battle` (`http.rs:162`) checks sign-in and origin until Phase 10 deletes it; "start the island
  over" (`world_socket.rs:593`, `&fresh`) becomes an admin tool. Done (8ee8144) but `/ws/battle`,
  which Phase 10 deletes (R10.7): its tests run battle servers with no database to sign in to.
- [x] **R3.5** The developer pages built into `dist` under `/dev/` (multi-page build); the server
  sends `/dev/*` only to an admin's session (sign-in is a cookie already, `server/src/http.rs`) and
  "not found" to anyone else. Done: the guard (8ee8144, asked by `admin.spec.ts`); the pages in
  `dev/` and every page in `dev/` and `design/` built with the game (9d9a9d7).
- [x] **R3.6** `src/dev/pages.ts`: one entry per page or developer zone (title, URL, what it's for,
  whether it needs the dev server or a server flag).
- [x] **R3.7** The Admin menu (Title Case, design system), admins only: a card on the title screen
  (`splash.layer`, `splash.ts:60`), a button in character select's account row
  (`characterSelect.ts:71`), a menu-bar button in the open world (`addMenuButton`, `lifeUI.ts:235`,
  as Party does at `main.ts:367`: a new press, `Panel` kind and view), and a HUD button in the yard
  and on the battlefield (`render/hud.ts:143`). It also opens the developer panel, which today only
  the backquote key reaches. `src/ui/admin/`: the card (character select's account row; the
  title screen shows character select once you're signed in), the world's Admin window with
  Developer Tools at its top (the menu bar's Admin button), and a corner button in the yard and on
  the battlefield for an account the server calls an admin. Done (6542f7d).
- [-] **R3.8** A battlefield on demand: replaced by the battlefield developer zone, R10.7 (decided).
- [x] **R3.9** Pages that save through Vite plugins (library notes, bug reports) explain themselves
  on beta instead of failing. The library already kept its notes in the browser and now says the
  dev server keeps them as files; the bug reporter, in a built game, says the dev server keeps
  reports instead of asking whether `npm run dev` is running.
- [x] **R3.10** Integration tests: menu shown and hidden, `/dev/` and commands refused to players.
  `tests/integration/admin.spec.ts` (a server of its own with `ADMIN_USERS`; the helper
  `tests/support/ownServer.ts`, which `update.spec.ts` now uses too): both halves pass; the Admin
  window's labels are held to the writing rule in `ui.spec.ts`.
- [x] **R3.11** Docs: `docs/admin.md`, the AGENTS.md entry, the design bible. Done.

## Phase 4: The /find-assets Skill (parallel)

- [x] **R4.1-R4.6** Done (de8fd77): the skill; `tools/assets/sources.mjs`, `search.mjs` (Poly Haven,
  ambientCG v3, Sketchfab with a face limit that leaves out museum scans, Freesound) and `fetch.mjs`
  (those, Kenney's pages through their signed download link, itch.io's free downloads, any URL;
  a fresh folder per fetch with `credit.json` and the `CREDITS.md` row); sound notes (the game has
  no audio engine yet: the first sound brings it); AGENTS.md points to the skill. Proven by fetching
  a Poly Haven model (Barrel_01) and texture (rock_pitted_mossy), an ambientCG texture (Rock064),
  Kenney's 130 impact sounds and Quaternius' Universal Animation Library (Standard, 15 MB). Not yet
  proven: Sketchfab and Freesound downloads, which need the user's `SKETCHFAB_TOKEN` and
  `FREESOUND_API_KEY` (searches work; they say what's missing). ElevenLabs (its key is in `.env`)
  listed as the paid maker for sounds.
- [x] **R4.1** `.claude/skills/find-assets/SKILL.md`: when to use it, free first, the licence rules
  for a public repository, sources by kind, judging a find, showing you, importing, crediting,
  checking in the game, paid makers last with costs agreed.
- [x] **R4.2** `tools/assets/search.mjs`: Poly Haven (models, textures, skies), ambientCG (textures;
  its v3 API, as v2 gets no more updates), Sketchfab (CC0/CC-BY, downloadable), Freesound
  (`license:"Creative Commons 0"` or Attribution; needs `FREESOUND_API_KEY`; previews come with the
  key, original files need its OAuth2 sign-in, so the user's hands), listed with licence, author,
  size and preview.
- [x] **R4.3** `tools/assets/fetch.mjs`: downloads into a fresh `scratch/assets/<source>/<id>/` with a
  `credit.json` (what, where, author, licence) ready for `CREDITS.md`; the itch.io free-download
  steps for Quaternius and Kenney packs.
- [x] **R4.4** Notes for sound (formats, loudness, length) and effects: the game has no sound yet, so
  the skill says what an audio engine part will need.
- [x] **R4.5** Proven end to end: a prop, a texture, a sound and an animation found and fetched (not
  committed).
- [x] **R4.6** AGENTS.md "Art and assets" points to the skill; `CREDITS.md` format checked; new
  binaries go through Git LFS.

## Phase 5: The Rust Workspace

- [x] **R5.0** The moves script, `tools/refactor/moves.mjs`, reading `.plans/refactor/moves.tsv`
  (old path, new path) and fixing every reference: TypeScript imports; tests' path strings
  (`models.spec:192-193`, `village.spec:100-102`, `update.spec:209`, `library.spec:117`); the 41 source
  paths the library's subjects embed; `include_str!`/`include_bytes!` (18 point at `shared/`);
  Dockerfile, CI, `package.json`, `vite.config.ts` (the `src/app/bugs/logs.ts` regex); AGENTS.md,
  `docs/`, the skills, `design/status.json`. It can replay the same moves on any other branch.
  Done in Phase 1 (57bbd61, 1e0bf67), with template-string URLs since (4183398).
- [x] **R5.0b** The one formatting commit (rustfmt, Biome), listed in `.git-blame-ignore-revs`.
  Rust done (440a861: 160 columns, Max heuristics, the closest to how it was written; checked by CI
  and `npm run check`). Biome (160 columns too; about 8,700 lines change) once the toon-look agent
  has committed its TypeScript.
  Done: Biome too (cf22932: 160 columns, a light rule set, 177 files), in CI and `npm run check`.
- [x] **R5.1** Root `Cargo.toml` workspace with `crates/engine`, `crates/server`, `crates/tools`;
  one `target/` at the root.
  Done (8030f44).
- [x] **R5.2** Move the pure rules modules into `crates/engine` (`inventory/rules-map.md` section 1:
  actor, actors, ai, pack, missiles, content, creatures, tuning, skills, jsmath, player, world, sim's
  `Battle`, open/\*, life/\*, minigames/\*); the engine depends on serde, serde_json and libm only.
  First cut the couplings: game.rs's combat rules from its protocol encoders and client slots;
  world.rs's use of sim.rs only for `Rng`; the lifecheck binary's use of
  `world_game::{load_island, player_state_json}` (island loading is a rule, so it moves); the loops
  `open`/`life` and `skills`/`tuning` (shared helpers such as `js_hypot`, `js_round`, `carry` into a
  module of their own).
  Done (8030f44): the engine compiles to wasm32 unchanged. The server re-exports its modules, so
  `crate::player` and the rest still read as before. Left for Phase 8: island loading
  (`load_island`, `player_state_json`) is still the server's, which the lifecheck tool uses.
- [x] **R5.2b** One of each helper: one mulberry32 `Rng` (today in sim.rs, `Life::rand`, ai.rs `draw`,
  beacons.rs), one `len` (six copies), one set of `js_*` maths helpers. Done (f1ec903): `rng.rs`
  and `jsmath.rs`; all 63 TypeScript-against-Rust checks unchanged.
- [x] **R5.3** Server areas: `net/`, `db/`, `world/`, `battle/`, `admin/`; `main.rs` only starts things;
  `lib.rs`'s flat list of 30 modules becomes a few public areas.
  Done (04da4b6): `accounts/`, `play/`, `battle/`, with `combat.rs`, `protocol.rs`, `db.rs`, `http.rs`;
  `main.rs` 123 lines (was 394).
- [~] **R5.3b** Cut the battlefield loose from the open world: `world_game.rs:31,206` makes an empty
  `Battle` per channel; `game.rs:19-29` uses `protocol`, `sim` and `world`; `world::{World, Spawn}` are
  used by `player.rs`, `open/mod.rs`, `world_game.rs:33`. Shared types to the engine; the
  battlefield's own code fenced into `battle/` with no new work, until R10.10 deletes it.
  The battlefield's loop and networking are fenced in `battle/` (04da4b6); `combat.rs` still
  writes its protocol and steps an empty `Battle` per channel, which Phase 10 removes with it.
- [x] **R5.4** `crates/tools`: balance, loadtest (taking `tokio-tungstenite`, today compiled into every
  server build for a tool run by hand); the check programs until R8.13. `rayon` stays with the
  battlefield's loop only (until R10.8 brings parallel stepping to every zone).
  Done (8030f44).
- [x] **R5.5** Determinism lints in the engine (`clippy.toml`): no `std` `HashMap`/`HashSet`, no
  `f64::sin`/`cos`/`tan`/`exp`/`ln`/`powf`/`atan2`/`hypot`... (use `libm`), no clocks, no `rand`. Fix
  the ~40 calls listed in `inventory/rules-map.md` section 2 (actors, ai, game, life/interact x11,
  farming, vehicles `powf`, minigames, world, sim, world_game, tables), checked against the
  TypeScript results (the conformance tolerance should shrink, not grow).
  Done (598820c): `crates/engine/clippy.toml`; maps and sets are B-trees; hypot is V8's. The
  tolerances stay: V8's sin and cos aren't fdlibm's, so the TypeScript and the Rust can't agree to
  the bit until both run the engine (Phase 8).
- [x] **R5.5b** Bug: `world_game.rs:754` `rebuild_world` walks the estates `HashMap` (random order) and
  so inserts colliders in a different order each run. Walk them in a fixed order; a test proves two
  runs agree. Done (f8a7187): the test failed three times out of three before the fix.
- [x] **R5.6** Rust tests for `ai.rs`, `sim.rs`, `actors.rs`, `game.rs`: golden scenarios checked
  against today's TypeScript results. Planned as hashes: each conformance scenario's Rust output
  hashed bit for bit and kept beside it, recorded while the conformance checks still prove it
  matches the TypeScript, so the engine keeps its own guard when Phase 8 deletes them.
  Done (5b339a8, a background agent): `crates/engine/tests/golden/` (17 brains and packs, 11 builds,
  18 walks on Emberholm; 139 KB), written on a run where the TypeScript agreed with every one and held
  bit for bit by the engine's golden tests (`crates/engine/src/checks/`, 0.3 s in debug), which run
  the check programs' own scenario code. After a change both sides make on purpose,
  `RUINA_GOLDEN=1 npm run test:conformance` writes the new answers. The server's fighting, which has
  no TypeScript twin, has a golden battle: the battlefield's 32 bots, 400 ticks of
  `ChannelGame::play_tick`, everyone's state hashed every tick (0.7 s).
- [x] **R5.7** Build speed: dev-profile settings, linker trial on Windows, `cargo build --timings`
  report; Docker caching for a workspace (`cargo-chef` or stub crates).
  Done: the dev profile (Phase 1); Docker caches the dependencies with stand-in crates; `rust-lld`
  tried and dropped (the workspace's edit-and-test 14.9 s with it, 15.3 s without).
- [x] **R5.8** Paths: Dockerfile, CI, `package.json`, `tests/support/testServer.ts`, README,
  AGENTS.md, the design bible, memory notes (the live battle server's path).
  Done (8030f44, and the memory notes).
- [x] **R5.9** Rename the crate and binary `yggdrasil-server` to `ruina-server` (decided), with every
  `yggdrasil_server::` import, the Dockerfile, CI and scripts.
  Done (8030f44).
- [x] **R5.10** Measure and log: engine edit-and-test, server-only edit, clean build.

  Done: an engine edit tested in 5.2 s (`cargo test -p ruina-engine`; 7 s in one crate before),
  a server edit in 8.7 s, everything in 15.4 s; the release server rebuilt in 40-55 s; a clean
  build of every test 119 s.
## Phase 6: The Client in Areas

- [x] **R6.0** Fix the boundary breaks first (`inventory/architecture.md` section 2): the network
  code stops building bodies and island views (`netPlayer.ts` makes `Hero`s, `worldPeers.ts` makes
  `Hero` + `LifeView` per player: it hands out state, rendering makes the views); the sign-in,
  character, party and mini-game windows stop calling the network directly (28 `link.*` calls, the
  account API) and go through app services; `content/creatures/hero.ts` stops importing three.js; the
  `content/actors.ts`/`sim/actor.ts` cycle and the seven two-way folder dependencies go.
  Done: the network keeps everyone else's state and
  `src/render/open/peersView.ts` draws them (1acd45f, begun by an agent as 235bc19); the windows
  declare what they show and the calls they make, and the app hands them the account API and the
  world connection (465e613); the hero's close-up body is render's (R6.10). The two-way
  dependencies went: content/sim (`ActorKind` is content's), app/net (the link is handed what to do
  before a reload), app/ui (the build's rules to `src/content/build.ts`, 37ac866; the saved build the
  app's; auto-run to `src/input/`, eb11517), render/ui (the HUD to `src/ui/hud.ts`, dae798f; the hero
  preview handed the UI's scale), net/render (1acd45f), render/species and species/creatures (one
  area since R6.10); 2ed6607. The boundary test forbids net and render importing each other, the UI
  importing the network or the app, and drawing importing the UI, and lists no exceptions. *Verified:*
  `npm run check`; the integration tier 241 of 245 (7eb599f): `online.spec.ts:109` and `:258` lost
  races under four workers and pass alone, `ui.spec.ts:405` needs pointer lock, which macOS's
  headless browser doesn't give, one skipped.
- [x] **R6.0b** Changes to the rules' state from outside become named calls on the bridge: `main.ts`
  375-391, 499-521, 1760-1955, 2387-2431; `app/dungeonVisit.ts` 38-39, 58-59; `app/save.ts` 62-87;
  `net/netPlayer.ts` 108-124 (swaps `sim.player`); `net/worldPeers.ts` 195, 202, 264 (colliders,
  movers).
  Done: putting you somewhere, your build, a dungeon's floors and walls, an island loaded (6553617);
  the server's word on you, solid houses, scarecrows and others' vehicles, and the test API's writes
  (89ace09); the island online, taken from ticks, commands run ahead and run again, and your levels
  (9a319e4). The prediction, the peers, the online wiring and the test API write nothing of the
  rules' own. Left to their tasks: the rules' hooks back into JavaScript (`worldClock`,
  `othersVehicles`, `othersAround`, `plotOwner`, `remote`: R8.3b) and the patched `life.command`
  (R6.2). *Verified:* the integration tier 241 of 245 (the races under load, macOS's pointer lock).
- [x] **R6.2a** (from R1.5-R1.7) The game core: `main.ts`'s rules half (the world, the rules, the
  yard, the island's life, stepping, events) in `src/app/` as a module with no drawing, used by the
  page and by a headless harness for Node; move the ~82 rules tests onto it (movement 19, goblin 8,
  slime-pack 16, slime 6, hotbar 6, game 3, skills 1, world 20, dungeon-way-in 2, travel 1; tests that
  read HUD markers assert on events instead). Model and rig builders that don't make a WebGL
  renderer when imported; the ~64 gallery tests (animation 20, species 24, creatures 6, models 14) to
  Vitest. Target from Phase 1: at least 230 TypeScript unit tests.
  Done (eda3f19): the rules half is the engine (`src/engine/engine.ts`), the step (`src/app/step.ts`)
  and the yard's practice (`src/app/yardPractice.ts`), none of which draws; `tests/support/headless.ts`
  starts them in Node as `main.ts` does offline, with drawing and windows standing in, and runs the
  test API on them unchanged. A spec's tests move as they are (`tools/refactor/port-spec.mjs`, then
  `split-specs.mjs` sends each test to the tier it runs in): 77 rules tests now run headless in
  `tests/unit/rules/` in about a second; 43 need a page (windows, keyboard and controller, the scene,
  the server) and stay. The gallery tests were already in Vitest (animation 20, species 13, creatures
  6, models 1); the model geometry specs (5, measured through the gallery page) stay in a page.
  *Verified:* the unit tier has 236 TypeScript tests (`npm run check`); the page-tier remainder of
  the split specs passes (43).
- [x] **R6.1** `src/app/options.ts`: every URL option in one list (name, what it does, developer or
  not), read once.
  Done (138706b, ec69498): `src/app/options.ts`, with a unit test keeping the list honest.
- [x] **R6.2** `src/main.ts` into `src/app/`: start-up, a module per mode, the loop, wiring, along the
  seams in `inventory/architecture.md` section 1. Its 30 top-level variables become one game context
  the modes share; the use-before-declare closures (`prediction`, `frozen`, `ahead`), the patched
  `life.command` and the twice-chained `lifeUI.intercept` go.
  Begun: the test API, the bug reporter's wiring and online play's are out (e5a6253, 586f27e), with the
  scripts that move main.ts out region by region (`tools/refactor/`); main.ts is 1,900 lines (2,566).
  The modes, the loop, aiming and drawing are left.
  Then frame stats (367a883) and aiming (017c79e) out, and the engine bridge in its place for the
  rules (6553617): main.ts is 1,518 lines. The modes, the loop and drawing are left.
  The named tangles are gone (e94c533): the island's commands come through the app (no patched
  `life.command`), one composed `lifeUI.intercept`, and `prediction`, `frozen` and the feed declared
  before the closures that use them. Left: drawing a frame and the loop (lines 831-1262 take 51 names
  from the rest of main.ts), which want the game context the modes share rather than more getters.
  Done: drawing a frame and the loop (4fcf879), the step and the camera's rig (9cf24d7, and the
  commit after). `main.ts` is 951 lines and is the start-up: it builds the game's parts, then `refs`,
  the context the modules share (a getter for each part, declared before the first module built
  from it), then the modules that run on them: the drawing, the step, the loop, the test API, the bug
  reporter, online play. A module that keeps what the rest uses gives it out through what it returns
  (`drawing.showEvent`, `loop.paused`; `move-region.mjs` does this now). Each mode's own code is a
  module (online play, a dungeon's copy; the developer zones are content, Phase 10), and the island
  offline is the start-up's default. *Verified:* `npm run check`; the world, hotbar, combat, online,
  goblin, movement, yard, slime, game, online-combat, dungeon, bug report, village and sea specs (158).
- [x] **R6.3** `src/app/testApi.ts`: `window.__game` in a module of its own, typed.
  Done (e5a6253).
- [x] **R6.4** `src/engine/`: the one bridge to the rules; everything else imports it, not `src/sim/`.
  Done: `src/engine/engine.ts` holds the rules for the page with every outside write a named call
  (6553617, 89ace09, 9a319e4), and `rules.ts`, `zone.ts`, `island.ts` and `creatures.ts` name what
  the rest takes from them, 111 names by Phase 8's domains (56ad5ee); the boundary test forbids
  importing `src/sim/` anywhere else (the bible may read its source as text). `src/engine/AGENTS.md`.
  `engine.sim` and `engine.life` stay public for the island's UI and drawing and the test API, which
  take the rules whole until R8.7 hands them snapshots.
- [x] **R6.5** `src/ui/components/`: window, tabs, item slot and grid, list, tooltip, context menu,
  bars, buttons, per the design system.
  Done (7de96ec, a background agent): `src/ui/components/`.
- [x] **R6.6** `src/ui/life/lifeUI.ts` into one module per window on those components.
  Done (49f62b4, a background agent): lifeUI.ts 600 lines (2,328), a module per window in
  `windows/` and per widget in `hud/`; the same DOM in 89 states, checked by a harness.
- [x] **R6.7** `src/library/app.ts` split by concern.
  Done (7ff6dea, a background agent): `src/dev/library/app.ts` 343 lines (2,316), what is open and
  opening it; the parts reach each other through it: `layout.ts`, `prefs.ts`, `playback.ts`,
  `posing.ts`, `notes.ts`, `prompts.ts`, `modals.ts`, `input.ts`, `address.ts`, `api.ts`
  (`window.__library`, unchanged) and `panels/`. The library's specs pass as before (38).
- [x] **R6.8** `src/dev/` and `dev/*.html`: every developer page; the admin list (R3.6) updated.
  `dev/` holds the content library alone now (R6.15); the admin list has the zones from their files
  and the pages from `src/dev/pages.ts` (777949b). `src/library/` moving under `src/dev/` is left.
  Done (81df3de): `src/library/` is `src/dev/library/`.
- [x] **R6.9** A UI gallery (a Content Library subject or `/dev/ui.html`): every window with made-up
  state.
  Notes from the library's split: draw the windows in a page of their own (`dev/ui.html`, framed by
  the library), as the game's theme sets `--accent` on `:root`, the library's `.note`, `.center` and
  `.empty` would restyle them, and tooltips and menus need a document of their own; run a real
  offline island (the zone's world, the rules, the island's life and its UI) and step it; made-up
  states picked from content, never ids in code; an entry per state, `#/ui/<window>/<state>`, listed
  as plain data so the library doesn't import `src/ui`.
  Done (f9517ba, a background agent): the UI gallery, `/dev/ui.html#/<window>/<state>`
  (`src/dev/ui/`), framed by the content library as `#/ui/<window>/<state>` (`galleries/ui.ts`): 32
  made-up states of 17 windows on a real offline island, made up from the content by what things
  are, never ids, the entries plain data (`entries.ts`) so the library doesn't import `src/ui`.
  `uiGallery.spec` holds each state to no error, drawn and labelled in Title Case; it found three
  quest names out of Title Case ("over", "from"), renamed in content. Not in it yet: the screens
  before the world (title, sign-in, character select) and the combat HUD.
- [x] **R6.10** Creature bodies into `src/render/creatures/` (from `src/species/`, `src/creatures/`,
  `src/crowd/`, `src/content/creatures/`).
  Done (9317ff3): `src/render/creatures/` holds the species format (`species.ts`), its registry,
  baked clips (`clips.ts`), the crowd, jelly and proxies, the built-in species, the goblin's body, the
  bodies with folders of their own (`folders.ts`), the hero's close-up body (`heroBody.ts`, no longer
  content importing three.js) and the list of close-up bodies (`closeUps.ts`).
- [~] **R6.11** Root files to their areas: `src/skills.ts`, `src/tuning.ts`, `src/build.ts`,
  `src/rng.ts`. Names that say what they are: today there are 5 `index.ts`, 4 `types.ts`, 3 each of
  `pose.ts`/`hero.ts`/`harness.ts`, `sim/world.ts` beside `sim/zone/world.ts`, and
  `content/creatures.ts` beside a `content/creatures/` folder.
  Moved (5de387d): `rng.ts` to `src/util/`, `tuning.ts` and `skills.ts` to `src/content/` (the typed
  readers of tuning.json and skilltree.json, which outlast `src/sim/`), `build.ts` to `src/app/`,
  `src/sim/world.ts` to `src/sim/yard.ts`. The other names that don't say what they are come with
  the splits that touch them.
- [ ] **R6.11b** Workarounds out: the 15 `tryBuild(...) ?? standIn` fallbacks for a models folder that
  can't be missing (or real lazy loading, R11.2); `worldPeers.ts:258`'s fake `Sim`; the library's and
  `animations.ts:650`'s reaching into the hero's private fields; `main.ts:505` (the TypeScript command
  list lacks Rust's `teleport`: generated from Rust in Phase 8).
- [x] **R6.12** The boundary test (unit tier): allowed imports per area; known exceptions listed with a
  reason.
  Done (ec3051e): `tests/unit/boundaries.test.ts`.
- [x] **R6.13** An AGENTS.md (and a CLAUDE.md that imports it) in `src/render`, `src/ui`, `src/net`,
  `src/app`, `src/dev`.
  Done: `src/app/AGENTS.md` and `content/AGENTS.md` first, `src/net/AGENTS.md` (37afeca), then
  `src/render`, `src/ui` and `src/dev`, each with its boundaries as the test holds them.
- [ ] **R6.14** Look check: `tests/look.spec.ts` before and after, no change.
- [x] **R6.15** The Content Library (decided: one page for everything): the animation library grows
  subjects for models (`models.html`: categories, anchors, budgets), buildings (`buildings.html`:
  plans, cut-away, colliders, night), species and creatures, retargeted clips beside their sources
  (`retarget.html`), and the scenarios of `animations.html`; those six pages and their `window.__x`
  APIs go, their tests moved to the library or the unit tier. Later phases add a subject per content
  kind (R9.13).

  Done by a background agent: models (1894d4a), buildings (2803a97), species (cc7ef82), creature rigs
  (232e1bb), retargeting (a496998), the hero's animations (12a0573). The six pages and their
  `window.__x` APIs are gone; 83 checks kept and 6 added, the data-only ones (20 films, 24 species, 6
  rigs) in the unit tier. The film checks always measure the box hero now, which ends "turning on the
  spot" failing now and then.
## Phase 7: Content in Folders

- [x] **R7.1** The layout (decided): `content/` with a folder per kind and a file or folder per thing.
  Done (80ffc5a).
- [x] **R7.2** `contentc` (engine types, a `crates/tools` binary): read folders, join multi-file
  things, reject unknown keys and missing fields, check every cross-reference, write bundles.
  Done (80ffc5a), in Node rather than Rust: `tools/content/contentc.mjs`. The engine's types only know
  the fields the rules read, so they couldn't reject the browser's; schemas per kind do (R7.6), and the
  engine still reads every bundle at start and in its tests.
- [x] **R7.3** Bundles in today's shapes: the TypeScript imports and the server's reads point at them;
  the game unchanged (suite green).
  Done: the bundles keep their paths, `shared/*.json`, so no import changed.
- [x] **R7.4** Move the files: `shared/*.json` split into `content/<kind>/...` (pure moves and
  splits, script-checked to be the same data).
  Done (80ffc5a): `tools/content/split.mjs`, checked bundle by bundle to give the same data.
- [x] **R7.5** The dev server rebuilds content on a change; Docker and CI build it before the client
  and the server.
  Done: the dev server rebuilds on a change (`tools/contentBundles.ts`); the bundles are committed,
  so Docker needs no step, and the unit tier fails while one is behind.
- [x] **R7.6** JSON Schemas generated into `content/_schemas/`; files name their schema for editors.
  Done: `content/_schemas/` (`npm run content:schemas`).
- [x] **R7.7** Unit tests: every file valid; a bad field and a broken reference each fail.
  Done: `tests/unit/content.test.ts`.
- [x] **R7.8** `content/AGENTS.md`: the layout and how to add each kind (today's recipe, with the code
  steps that Phase 9 removes marked).

  Done: `content/AGENTS.md`.
## Phase 8: One Copy of the Rules

- [x] **R8.1** Toolchain: `rustup target add wasm32-unknown-unknown`, `wasm-bindgen-cli` pinned to
  the crate's version, `npm run engine` (and a dev-server watch), Vitest and Vite loading, Docker and
  CI.
  Begun (2ff8375): the wasm32 target, `crates/engine-wasm`, `npm run engine`, CI; the browser's loader
  waits for the first switch.
  Done with R8.6 (ba9c87a): no binding generator (plain C functions, text through memory, so no
  `wasm-bindgen-cli` to pin); the browser's loader (`src/engine/load.ts`, Vite's `?url`), Vitest's
  (`tests/support/engineSetup.ts`), `npm run dev`, `build`, the unit tier and Playwright's server build
  it first, and CI's client job and Docker build it.
- [~] **R8.2** Spike: ground height and collider queries end to end through `crates/engine-wasm`
  (the render reads ground height every frame for the shadow), measured per frame, before the
  interface is settled.
  Begun (2ff8375): ground height, standing ground and surface through the WebAssembly in Node: the
  island ready 10 ms after the first call, a query about 45 ns.
- [~] **R8.3** The interface (`docs/engine.md`): step with inputs (~17 action fields), commands in,
  events and commands out; named calls for every write JavaScript makes into the rules today
  (`inventory/rules-map.md` section 3: the server's player at reconcile, island state from ticks,
  movers, colliders, respawn point, dungeon, levels); views: typed arrays over WebAssembly memory for
  what each frame reads (~100 fields: the player's ~27, ~10 per actor, vehicles, packs, animals) and
  versioned snapshots for what changes rarely (the island's state, read by the UI); TypeScript types
  generated from Rust.
  Begun (see R8.5): the session's interface (`crates/engine-wasm/src/session.rs`, `src/engine/session.ts`):
  a step takes the actions as numbers (the six buttons as bits); you, the creatures, what happened and
  the island come back as JSON in the TypeScript's shapes; every other write the Engine makes is one
  named call (`session_call`). Left: what each frame reads as typed arrays rather than JSON, if R8.14
  shows JSON costs a frame anything; `docs/engine.md`.
- [x] **R8.3b** The rules' calls back into JavaScript become inputs and outputs: the world clock
  (read every step today, replays included; set once per step instead), `othersVehicles` and
  `othersAround` (set per frame), `plotOwner` (set on change), `remote` (commands returned after the
  step).
  Done: the hooks are the Engine's (`engine.worldClock`, `othersVehicles`, `othersAround`,
  `plotOwners`, `remote`; `src/main.ts` and `src/app/onlineWiring.ts` set them there), asked once
  before each step and before inputs run again, and handed to the rules as values. The engine's
  session takes them as inputs (`session_world_clock` each step; `others` and `movers` when they
  change). Its island has a remote mode (`Life::remote`: commands are the server's, nothing is said,
  a step moves on only the clock, labor, weather and vehicles) and its prompt the online offers
  (riding along in someone's vehicle, challenging someone: `Life::others_vehicles`, `others_around`).
  The session takes the server's word on you (`take_player`, `replay`), your island as sent
  (`session_take_island`, `run_ahead`, `replay_island`) and what's solid on the server (houses,
  scarecrows, others' vehicles). *Verified:* `tests/unit/shadow.test.ts` (online, 160 lagged frames
  matched bit for bit), `npm run check`, the online and mini-game specs (23).
- [x] **R8.4** Determinism test (unit tier): the same scenario natively and in WebAssembly ends in the
  same state hash, bit for bit.
  Done (2ff8375): `tests/conformance/engine.test.ts`, 60,000 ground queries' fingerprint, native and
  WebAssembly, to the bit.
- [x] **R8.5** Shadow mode: in dev and tests, the engine runs beside the TypeScript rules and every
  step is compared; any difference fails the test.
  Offline done: the engine plays the browser's offline game (`crates/engine/src/session.rs`: you, the
  creatures, the island, the copies of dungeons, the Engine's named calls; `training.rs`: a swing's
  blow with its hit pause and auto-aim, damage and what it shows, the yard's arrows, meteors and
  heals; `yard.rs`: the yard's layout and who stands about it; `event.rs`: what happened, raised
  where the TypeScript raises it, by the player, the creatures (`Actors::step_with`, blows handed over
  in order) and the training layer). `src/engine/shadow.ts` runs it beside every Engine's TypeScript
  rules in the tests, mirrors each named call, and compares you, the creatures, the missiles, every
  event and the island (its state, prompt, placing) after each step and call. On for the headless
  rules tests (`tests/support/engineSetup.ts`; `SHADOW=report` lists each test's first difference,
  `SHADOW=0` turns it off), where all 77 match bit for bit; `tests/unit/shadow.test.ts` holds it to
  failing. While shadowing, the TypeScript's sine, cosine, atan2, exp and pow are the engine's: V8's
  sine and cosine are glibc's and differ from libm's in the last bit on about 1% of inputs (after the
  switch the server and the browser both run libm, so they agree to the bit, which they don't today).
  Found and fixed on the way: the engine's prompts had drifted from the TypeScript's (sentence case
  where the UI's labels are Title Case, no dungeon portals, a workbench's line, the needs' places);
  getting off a vehicle reset where you are drawn from only in the TypeScript. Online too (with
  R8.3b): an online Engine's shadow takes the server's word on you, your island as it comes, commands
  run ahead and the page's hooks, and `tests/unit/shadow.test.ts` plays 160 frames a round trip behind
  an engine standing in for the server, matching bit for bit (`shadowRules` now swaps the maths in
  itself). The page too: the dev server started with `SHADOW=1` runs it in every page it serves and
  keeps each page's first difference in `scratch/shadow-page.txt` (`tools/shadowReports.ts`). The
  whole integration tier played that way (163 passed; the rest are the known races, slower with
  twice the rules in every page, and the pointer lock macOS's headless browser lacks) found one
  difference, twice: the prediction's input rounding made a stick nudged left of straight back -0,
  which the server, rebuilding it from a byte, has as 0, so turning to face straight back went the
  other way (fixed in `quantize`, with a unit test). Also found: the design bible grew its island
  without loading the engine (since R8.6), and the shadow was handed a save after the TypeScript had
  moved its clock on in place. *Verified:* the travel and yard specs shadowed again (12, no
  differences), `npm run check`.
- [x] **R8.6** Switch the ground, colliders and dungeons. Port the island's generator
  (`zone/generate.ts` 710, `zone/buildings.ts` 207, TS-only today) to Rust: the server makes the island
  at start, the browser through the engine; delete the bake step and `server/data/emberholm.zone`.
  Delete the TypeScript copies and the terrain conformance cases.
  Ported (3ec5d83, a background agent): `crates/engine/src/open/generate.rs`, `noise.rs` and
  `buildings.rs`, the recipe taking any zone. Emberholm comes out equal to the bake, held by a Rust
  test: none of 591,361 heights differ, and the surfaces, kept-clear cells, 2,054 obstacles, 275 boxes
  and 346 decks are identical; 98 ms in release. About 1.5% of the generator's sines and cosines
  differ from V8's in the last bit with libm, which the f32 heights absorb. Left: the conformance
  check over the whole output (roads, placements, falls, buildings); the island through
  `crates/engine-wasm`; generating on first use and deleting the bake (`crates/engine/data/emberholm.zone`,
  `parse()`, `tools/tests/bake.mjs`, `npm run bake`, the bake test), then AGENTS.md and the docs.
  Done: the engine grows Emberholm from its recipe on first use and the bake is gone (dafec37: 3.6 MB
  of island, its reader, `npm run bake` and its test; the WebAssembly 4.1 MB to 0.7); the browser grows
  its island through the engine's WebAssembly and the TypeScript generator is gone (ba9c87a:
  `generate.ts` and `buildings.ts`, 917 lines; `src/engine/wasm.ts` and `load.ts`, loaded at the start
  of the game, the bible and the library, and from the file in the tests). The island grows in
  90-145 ms (the TypeScript took 330-810). `terraincheck --zone` holds the WebAssembly's island to
  the native one, all of it. CI's client job and the image build the WebAssembly; the image also
  gained the bible and the crates it reads (missing since Phase 12) and engine-wasm's stand-in.
  Decided: the ground's sampling, the colliders and the dungeons' floors switch with their caller,
  the player step (R8.9): moved alone they would be TypeScript calling into the engine for every
  query only until the step itself moves. *Verified:* conformance (64), `npm run check`, the game,
  bible, library, village, sea, travel, online and dungeon specs (63).
- [x] **R8.7** Switch the island's life systems (life, state, trade, farming, housing, shipyard,
  livestock, vehicles, contracts, quests, progress, weather, interact: ~3,500 TS lines, 1:1 with
  `life/`). The UI and `render/open/life.ts` read versioned snapshots; `life.command` goes in as
  commands. Delete the copy and life-conformance.
  How (decided 2026-11-06, with R8.8 and R8.9: the session steps all three together, so they switch
  together): the Engine answers from the engine's session, and after each step or call the page's
  snapshots are read back from it: you (`engine.player`), the creatures and the yard's arrows and
  meteors (offline), and the island as an `IslandView` with the read surface the page uses (its
  zone, state, prompt, placing, resting, revision, the dungeon you're in, item counts, its events,
  commands). `engine.sim` stays as a view object with what 24 files read (you, the frame, your
  skills' numbers, levels, the creatures, the world, the hit pause, the log) until they move to the
  Engine's own names. The camera's and the drawing's copy of the colliders (`world.index`, the clear
  cells) is read back from the session whenever what's solid changes (`session_solid_key`,
  `session_colliders`, `session_clear_ptr`), so the geometry has one copy too. The island's helpers
  the page calls (prices, freshness, quests at a giver, house stages, the weather's hour...) move
  out of `src/sim/` as views over the snapshots, typed to what they read; the steppers go.
  Done (with R8.8 and R8.9): the Engine (`src/engine/engine.ts`) is the session's, through
  `crates/engine-wasm`. After each step or call one `session_view` reads back you, your levels (the
  island raises them), the creatures, the yard's arrows and meteors, the island's state, prompt,
  placing and resting, what it said, and a key that changes with what's solid; `src/engine/views.ts`
  (`SimView`, `ActorsView`, `RangeView`) and `src/engine/islandView.ts` (`IslandView`) hold them for
  the page, under the names it read before. Commands go in as commands (online, to the server). The
  island's helpers the page calls (prices, quests at a giver, house poses, the weather's hour...)
  take the read interfaces `IslandRead` and `SimRead`, so they serve the snapshots until R8.13 moves
  them out; the TypeScript steppers no longer run. Each Engine has its own copy of what's solid and
  the cleared cells (`islandWorld()`), read back from the session when its solid key changes, so the
  camera and the drawing see the engine's geometry. The shadow went with the TypeScript it compared
  (`src/engine/shadow.ts`, its test, `tools/shadowReports.ts`, the dev server's `SHADOW=1`);
  `tests/unit/online.test.ts` keeps its online scenario against an engine standing in for the
  server. The golden hashes can be kept from Rust (`RUINA_GOLDEN=1 cargo test --release -p
  ruina-engine golden`). The integration tier found two slips, fixed: a reset clears the log, and
  the levels the island raises reach the page. A step costs 0.03 ms online and 0.3 ms offline on the
  island (reading 18 KB of view back as JSON; 0.1 ms in the yard). Left for R8.13: the read helpers
  out of `src/sim/`, and the online guess at a blow (`coneHits`, `behaviour()` in `netMonsters.ts`).
  *Verified:* `npm run check` (238 TypeScript tests, 144 engine and 73 server tests); the integration
  tier, 163 passed, the three that failed with two suites sharing the machine passing alone, and the
  pointer-lock test failing as it did before (macOS headless).
- [x] **R8.8** Switch creatures: actor, actors/step, brain, pack, senses, missiles, hit, deal (offline
  yard and offline monsters; online, `netMonsters.ts`'s `coneHits` and `behaviour()`). Delete the copy
  and ai-conformance.
  Done with R8.7 (the session steps them). The online guess's `coneHits` and `behaviour()` go with
  R8.13, as do the copy and ai-conformance.
- [x] **R8.9** Switch the player step: locomotion, abilities, attacks, vitals, traverse, `sim.ts`
  with its training branch (hit-stop, the dummy, auto-aim, pushing against actors) and `training.ts`
  (the yard's arrows, meteors and heal, ported from TypeScript), skills and builds. Prediction's
  reconcile-and-replay runs inside the engine, one call per snapshot. Delete the copy, conformance and
  world-conformance.
  Done with R8.7: the session steps you, and a correction is one `takePlayer` and one `replay` of
  the unanswered inputs inside the engine. The copy and the conformance specs go with R8.13.
- [-] **R8.10** The raid's crowd: not ported; bot players replace it (R10.5, R10.10).
- [x] **R8.11** Mini-game rules in the browser from the engine (the board shows what the same rules
  allow).
  Done (dabea21, a background agent): the browser works out none of a game's rules. A rules module
  says what a player may do from what they see (`RulesModule::options`; Beacons' `Seen` shares the
  server's checks of every move), asked through the WebAssembly (`minigame_options`,
  `minigameOptions`); the view no longer carries legal moves (WORLD_PROTOCOL 10). Moves aren't shown
  before the server answers: turns wait on a player, the answer comes within a tick, and draws come
  off a deck the browser doesn't see.
- [ ] **R8.12** Road routing (`zone/roads.ts`, `zone/localPath.ts`, TS-only, browser-only) reads the
  island through the bridge; it stays TypeScript unless the server needs it.
- [~] **R8.13** Delete `src/sim/`, the check programs and the conformance specs.
  What the page still reads (the shapes of the rules' state, the ground's sampling, the island's read
  helpers, the roads) moves into `src/engine/` under the world's words (R10.14): no new "island"
  names. The unit tests that drive the TypeScript rules move to the engine: through an `Engine`, or
  as Rust tests beside the rules they test. `newContent.test.ts` needs the engine to take content
  bundles at run time. The bible reads the engine's Rust source rather than `src/sim/`.
  The check programs (`aicheck`, `simcheck`, `worldcheck`, `lifecheck`) and the conformance specs that
  ran them went, with `golden.ts`: the engine's golden tests hold the answers they proved
  (`RUINA_GOLDEN=1 cargo test --release -p ruina-engine golden` keeps new ones), and the conformance
  tier holds the WebAssembly to the native engine, the browser's ground sampling and the balance
  harness. The docs, CI and the engine's comments say the rules are one copy. The bible's part is a
  background agent's.
- [ ] **R8.14** Measure against the baseline: frame time, start-up, memory. Log it. (The download's
  size dropped, D15.)
- [x] **R8.15** `crates/engine/AGENTS.md`: determinism rules, adding a system, testing it.
  Done (33bf4ea): `crates/engine/AGENTS.md`.

## Phase 9: Content as Data, Finished

- [ ] **R9.1** Saved builds by id (weapons, abilities, movement skills, skill-tree nodes); a migration
  converts existing saves; tested on copies of real saves.
- [ ] **R9.2** Wire indexes from the compiled bundle; the connection compares bundle hashes.
- [~] **R9.3** Spawns in zone and dungeon data; the built-in `slimes`/`dummy` keys go; `?goblins=`
  becomes a developer option on top of data.
  Dungeons and zones have `spawns` (b318daf, 777949b: one of a kind, or a war-band of `count`); the
  island's `slimes`/`dummy` keys are left.
- [x] **R9.4** NPCs in `content/npcs/`; `FACES`, `GREETINGS`, `BENCH_OF` out of the UI.
  Done (f6055e7): a file each in `content/npcs/`, with their place, look, portrait, greeting and
  bench; `FACES`, `GREETINGS`, `BENCH_OF` and `windows/townsfolk.ts` gone.
- [ ] **R9.5** Weapons and abilities from data (icons, moves, models, stowing); causes on the wire by
  kind and id.
- [x] **R9.6** Quest markers from quest data; no place ids in the UI.
  Done (2ca47bf): an objective's `marker` in its quest's file; `src/ui/life/hud/goal.ts` names no
  place; the same goal in 1,200 states before and after (`tests/unit/questGoal.test.ts`).
- [x] **R9.7** Item behaviours from data: placeables, rare drops, default craft place, the labor cap
  from `LABOR.max`, categories and their labels.
  Done (5d0712d): `placeOn` and `hint` on placeables, rare finds with their own toast and effect,
  a pack's maker, labor topped up to `labor.max`, category names in `shared/items.json`; both sides
  (`tests/unit/items.test.ts`).
- [~] **R9.8** Dungeons from their folder (no lists in code); each dungeon's dressing in data.
  From their folder (777949b): `content/dungeons/` built into one bundle both sides read; the goblin
  camp was added as a file alone. Goblin's Dread's dressing (`dungeonView.ts`) is still code.
- [ ] **R9.9** Looks from data (made model with fit and clips, or a built-in body with settings);
  builders by id become fallbacks; the prose `look` fields become real ones.
- [~] **R9.10** Zones: the generator's special cases by id become data flags; more than one zone can
  load.
  Done but the waterfall (c37c9ef, a background agent): a structure says whether its ground is
  levelled (`pad`), whether it stands at sea level (`seaLevel`), how far round it trees and rocks are
  kept off (`clearMargin`) and what the ground under it is (`surface`); a flatten whether its ground
  is kept clear (`keepClear`). Both generators read them, the bake came out byte for byte the same,
  and the generator's allowance left `tests/unit/contentIds.test.ts`. Left: the waterfall's landing
  and totem made optional (`src/render/open/grotto.ts` reads them unconditionally).
- [x] **R9.11** Mini-games: a game is a rules module plus a board view; the table framework reads the
  list from content.
  Done (0e918b8, a background agent): a mini-game is its file (`content/minigames/<id>.json`, its own
  settings under `rules`), its rules module (`crates/engine/src/minigames/games/<id>.rs`, found by the
  engine's build script) and its boards (`src/ui/minigames/boards/<id>.ts`,
  `src/render/open/gameBoards/<id>.ts`, found by the game's id), with no list of games in code on
  either side; a game travels as its index in `shared/minigames.json` (WORLD_PROTOCOL 9); the board's
  layout comes from the engine through the WebAssembly (`minigame_layout`); the mini-games' content-id
  allowance is gone; `docs/content.md` says how to add a game.
- [x] **R9.12** A test that no content id appears in code, with an allowlist of reasons.
  Done (41395e6): `tests/unit/contentIds.test.ts` (`tools/content/ids.mjs`), with allowances that
  each name the task that removes them, and fail once they allow nothing.
- [~] **R9.13** Templates per kind (`content/_templates/`) and fixture tests that add a creature, an
  NPC, an item, a quest and a vehicle as data only and play them; a Content Library subject per kind.
  Done (fef19c5) but the library subject per kind: `content/_templates/` (a thing of each kind),
  `tests/unit/templates.test.ts`, and `tests/unit/newContent.test.ts` adding a townsperson with wares
  and a quest, an item, a vehicle and a creature as files alone and playing them. Creatures came from
  their folder first (3d84597: `content/creatures/_order.json`, no list in code).
- [x] **R9.14** `docs/content.md`: a recipe per kind, data files only.
  Done (5e23680): `docs/content.md`, with what still needs code listed by the task that makes it
  data.

## Phase 10: One World: Regions, Channels, Instances and Bots

**How (one world, decided 2026-11-06: D16-D19; the research is `.plans/world/research.md`):** the
main world is one seamless world of regions defined by data, meeting across sea or land.

This phase lays its foundations in one process: every boundary a multi-server world needs, crossed
by in-process calls. The multi-server version comes after the merge (gateways, region processes, a
directory of leases, an instance pool, large-scale PvP, hosting at scale), and it then changes
transports, not designs.

- **Borders are fixed:** each region is owned by one simulation. Ghosts and a two-phase handoff make
  the borders seamless.
- **Crowds:** an overcrowded region opens another channel, placing players by party, friends and
  guild.
- **Land:** houses, farms and plots (scarce and contested, as in ArcheAge) are the same in every
  channel.
- **Splitting a region's own area** waits until content needs it. The 256 m chunk is the unit of
  authority, so it can come without a rewrite.

The order is in Now, above.

**How (developer zones, 2026-11-06):** the developer zones ride on the dungeon copies, which already do what they
need: a place of its own, solid and drawn only there, players moved in and out mid-connection,
saved as standing outside. The yard and the battlefield become places like Goblin's Dread's
grotto (floors and walls round an origin, spawns), flagged `developer` (admins only, entered from
the Admin menu) and drawn as open arenas; the battlefield's copy is one for every admin, with two
sides of bots, started by the first admin in and stopped when the last leaves. Bots are players
without a socket whose inputs a brain fills each tick (the engine's `bots`), shown to browsers as
peers marked as bots. Today's battle server, its loop and the `?server=`, `?yard`, `?raid` pages go
once these stand. The island's generator for any zone (R10.1) waits for its port to Rust (R8.6).

- [ ] **R10.1** The world is data.
  - **The world:** `content/world.json` places regions on a grid of 256 m chunks (Emberholm is 6 × 6
    round the origin).
  - **Regions:** a region is a folder, `content/regions/<id>/` (from `content/zones/emberholm`): its
    recipe, places, plots, nodes, outposts and the rest.
  - **Instances:** an instance (a dungeon or developer zone) is a file, `content/instances/<id>.json`
    (from `content/dungeons/`): its spawns, bots, ways in and out, and its flags (developer, shared).
  - **Ids:** unique across the world, checked by contentc. That covers plots, places, and nodes, which
    get a stable id rather than their index.
  - **The engine** loads any region and any instance.
- [ ] **R10.2** The server hosts the world and its instances: a simulation for each region channel
  and each instance copy, found by id (no `emberholm()` outside tests). Players travel between them,
  and every character is saved with its space.
- [x] **R10.3** Developer zones: a `developer` flag; only admins may enter (the server checks); the
  admin menu lists them from the zone list.
  Done: the server's half (acaf9b5); the Admin window's zone buttons (8d1722f); the Admin menu lists
  the zones from their files, at character select too, and an admin goes from one zone straight into
  another (777949b).
- [~] **R10.4** The training yard as a zone (`content/zones/yard/`): its layout (today's `makeWorld`),
  the dummy, targets and slimes (and goblins) as spawns. The yard's own rules (hit-stop, auto-aim, the
  dummy) are engine rules any zone can switch on.
  The server's half (acaf9b5): `content/dungeons/yard.json`, a copy each with wandering bots as moving
  targets. Its dummy and slimes (b318daf), standing on its floor, with combat measured from it, and the
  server's dummy drawn online. Left: the offline yard's own rules (hit-stop, auto-aim) as engine rules
  any zone switches on, with R10.11; the goblin band is the goblin camp's (777949b).
- [x] **R10.5** Bots in the engine: a bot is a player whose inputs and commands come from a brain
  (brains are data, as creatures' are), stepped by the server like a player without a socket and
  marked as a bot on the wire. First brains: a skirmisher (find a foe, fight, retreat when hurt) and
  a wanderer.
  Done (03e5a4c, 3c1c4ca): `crates/engine/src/bots.rs` (a skirmisher, a wanderer) and
  `crates/server/src/play/bots.rs` (bots in a channel or a copy, on the wire as peers marked as bots);
  an admin's `Command::Bots`. Fighting across sides now works on any ground.
- [x] **R10.6** Zones spawn bots from data: how many, which sides, which brain, where.
  Done (acaf9b5): a zone's file lists its bots by side and brain.
- [~] **R10.7** The battlefield as a zone (`content/zones/battlefield/`): today's `makeBattlefield`
  layout, two sides, armies of bots. It runs only while an admin is inside: the first admin in starts
  it and spawns its bots; when the last admin leaves, it stops and its bots go (decided).
  The server's half (acaf9b5): one copy for every admin, sixteen skirmishers a side, in with the first
  admin and gone with the last. The browser's arena (157e823). The old battle server's removal is
  R10.10.
- [ ] **R10.8** The wire for crowds.
  - **Interest:** each client is sent only what's near it, on 32 m cells, in near, mid and far tiers.
    The design comes from the old battle server's `interest.rs` (`git show 04da4b6`).
  - **Encoding:** compact binary records with deltas against what the client acknowledged, priority
    accumulators, and a byte budget per client. Entities go by per-connection handles, and positions
    as i32 centimetres.
  - **Who builds what:** the simulation packs the records once per cell and tick; the gate assembles
    them for each client.
  - **Drawing:** far players are drawn by the crowd renderer.
  - **Measured:** server tick time and bandwidth for N bots, against the baseline.
  Measured before (2026-11-06, `scratch/stress-battlefield-before.json`): 32 bots, a tick 1.09 ms,
  an update 22.3 KB, 53 fps, the 95th-percentile frame 33.3 ms; 64 bots, 2.43 ms, 42.9 KB, 58 fps,
  16.8 ms. Far peers drawn by the crowd renderer (R10.9's last part) go with it.
- [x] **R10.9** One world client for every zone: the battle client path (`?server=`, `netCrowd.ts`'s
  battle parts, RemotePlayers) goes; far bodies drawn by the crowd renderer.
  Done (da8fb15): `src/net/worldFeed.ts` in place of the battle client (NetCrowd); RemotePlayers,
  the raid's crowd and `?raid`, `?server=`, `?team`, `?play` gone; the battlefield's fifteen fights
  play in the developer zone (d0014e8, `tests/integration/battlefield.spec.ts`).
- [~] **R10.10** Delete the battlefield's own code: `sim.rs` (its bots), its loop in `main.rs`,
  `interest.rs` (moved into the world server), `net.rs` and `/ws/battle`, its protocol, `world.rs`'s
  layout (now data), the flags `--battle`, `--bots`, `--virtual-clients`; on the client
  `crowd/crowdSim.ts`, `?raid`, `?server=`, `?yard` and `?test`'s yard; `loadtest` drives bots or
  virtual clients against a zone instead.
  The client's half (da8fb15) and the server's (a975617): `sim.rs`, `battle/` (its loop,
  `interest.rs`, `net.rs`, `/ws/battle`), `protocol.rs`, the `--battle`, `--bots`, `--hz`, `--slimes`
  and `--virtual-clients` flags and `loadtest` are gone. Left: `world.rs`'s battlefield layout (used
  only by tests now; its `World` is the spawn point the player rules respawn at) and the offline
  `?yard`/`?test` yard, which R10.11 replaces.
- [ ] **R10.11** Offline: the browser's engine runs any region or instance locally, for tests and
  development (one option for tests in place of `?yard`/`?test`/`?world&test`).
- [~] **R10.12** Tests: unit (zone loading, bot brains); integration (an admin enters the yard and the
  battlefield from the menu, a player is refused, the battlefield starts and stops with an admin
  inside); stress (thousands of bots in the battlefield: frame time, tick time, bandwidth).
  Rust: zones load, stand where players may go and apart, have ways out; bots' brains; copies,
  admins, bots coming and going, spawns, zone to zone. Integration (`admin.spec.ts`): the battlefield
  from the world, the yard from character select, the goblin camp from the Admin window, a player kept
  out. The stress test is left (R10.24).
- [x] **R10.13** `docs/zones.md`: adding a zone, a developer zone, bots.
  Done (777949b).
- [ ] **R10.14** The words.
  - **World:** the one open world.
  - **Region:** a world zone.
  - **Instance:** a closed zone, a dungeon or developer zone.
  - **Channel:** a copy of a region, opened for crowds.
  - **Copy:** a copy of an instance, for a party.
  - **Space:** the world, or one copy of an instance.
  - **Chunk:** 256 m, the unit of authority.
  - **Cell:** 32 m, the unit of interest.
  - **Land:** what's built and planted in the world, shared by a region's channels.
  - **Life:** a character's own state (bag, coins, quests, skills, labor).

  "Island" leaves the code, the wire and the docs (`IslandView`, `takeIsland`, `islandData`,
  `Saved`, and `characters.island` by a migration). Each name changes as its area is touched, and the
  bible and the design pages say the same.
- [ ] **R10.15** Spaces.
  - Every position the server, the browser or a save keeps carries its space.
  - Each instance has a frame of its own: its world is built from its file, not from pieces added
    high in Emberholm's sky. That means `open/dungeon.rs`, `OpenWorld::make_dungeon`,
    `ChannelGame::copy` and the browser's dungeon visit.
  - The "within 760 m, apart from the others" rule goes.
- [ ] **R10.16** The world map in the engine.
  - **Queries:** height, surface, water and colliders are answered across regions, by chunk.
  - **Growing:** a region is grown from its recipe when it's first needed, and dropped when it no
    longer is. The server grows its own chunks and a band round them; the browser grows what's near
    the player.
  - **Borders:** neighbours across land meet with no seam; their recipes share edge constraints and
    blend across a band. Wherever no region stands is sea.
  - **The rules:** `Life` and the player rules take the world, not one zone.
  - **A fixture world for the tests:** Emberholm, a region across a land border, and one across the
    sea.
- [ ] **R10.17** Ids and the clock.
  - **Ids:** global 64-bit entity ids (a kind and an id) in the engine and the server.
    - Characters keep their database id.
    - Placed things get theirs from a database sequence.
    - Creatures are numbered by spawn and generation.
    - On the wire, each connection has u16 handles, so `character as u32` goes.
  - **The clock:** ticks are numbered from a world epoch at 60 Hz, and given to the engine as an
    input, as the world clock already is.
- [ ] **R10.18** The tick that splits.
  - **The rule:** within a step, an entity reads others only as they stood at its start, and affects
    them only through events applied at the next step.
  - **Already so:** vehicles, and player hits and heals.
  - **To join them:** creature hits in `swing_actors`, slams, area effects, ride-alongs, and the
    island's interactions between players.
  - **What it buys:** stepping order stops mattering, so players, creatures and bots step in parallel
    by cell (`rayon`) with the same result.
  - **History:** everything that can be hit keeps the position history that lag compensation
    rewinds.
- [ ] **R10.19** Borders, in one process.
  - **Ownership:** a simulation owns its chunks.
  - **Ghosts:** neighbours exchange read-only copies of what's within about 120 m of the border, every
    tick.
  - **Handoff:** authority passes 24-32 m past the border, in two phases with an epoch; inputs are
    re-routed by sequence number.
  - **Across the border:** hits, heals and effects are events checked against the ghost's history, so
    PvP across a border works as it does anywhere.
  - **Vehicles** cross with their passengers and cargo as one unit.
  - **Creatures** stay leashed to their region.

  Proved two ways: Emberholm split into two simulations matches one simulation bit for bit (a golden
  test), and the fixture world's borders are crossed on foot, by cart with a passenger, by boat and by
  glider.
- [ ] **R10.20** The server's tiers, in one process.
  - **`crates/world-api`** holds the messages and ids, with no I/O:
    - inputs with sequence numbers, and commands;
    - records per cell, and private state;
    - ghosts, handoffs, and events across borders;
    - fenced writes, and ledger transfers.
  - **`crates/server`** splits along those messages, joined by channels:
    - **gate:** connections, sign-in, handles, interest and budgets, encoding;
    - **sim:** region channels, instance copies, borders;
    - **store:** fenced writes, land, plots, the ledger;
    - **social:** parties now; friends and guilds later;
    - **directory:** which simulation owns which chunks and channels, with leases and epochs in a
      table (one simulation today).
  - **Threads:** a thread per simulation.
  - **Shared state:** nothing one tier needs lives only in another's memory: parties, who plays where,
    mini-game tables.
- [ ] **R10.21** Land and the ledger.
  - **Land:** what's built and planted (houses, farms, ships on slips, things left on the ground,
    parked vehicles) moves into tables of its own.
    - Each row is keyed by world, space and chunk, with an owner and an epoch.
    - One authority per region changes it, and every channel shows it.
  - **Plots:** the database holds them, one claim per plot in the world, first come. They're
    contested: taxes fall due, and neglected houses are demolished, freeing the land. This replaces
    channels' residents and their eight plots.
  - **The ledger:** trades, purchases, payouts and pots are idempotent transfers, each in one
    transaction.
  - **Shared state:** what the world shares (the time of day, each region's weather, trading posts'
    demand) is kept in one place.
  - **Saves:** a character's own life is saved when it changes, and existing saves are migrated.
- [ ] **R10.22** Channels on their own.
  - **Opening and merging:** a region runs as channels. Another opens when the region passes its soft
    cap, and a quiet one merges.
  - **Placement:** players are placed by affinity: party first, then friends, guild and language as
    the social tier learns them. A party is kept together.
  - **Land:** the same in every channel.
  - **Changing channel:** not while carrying a pack, not in combat, and not more than once in a few
    minutes.

  Played with bots in one process: a crowd fills a region, a channel opens, parties stay together, and
  a quiet channel merges.
- [ ] **R10.23** The client in a big world.
  - **Regions:** grown in a Web Worker ahead of you, and dropped behind you.
  - **Precision:** the scene's origin moves with you, keeping the world-space shaders (`ground.ts`,
    `water.ts`) precise.
  - **Assets:** fetched by region (`src/assets/catalog.ts`).
  - **The map:** shows the world's regions.

  Crossing a border loads nothing.
- [ ] **R10.24** Proof at scale.
  - **Stress tier:** thousands of bots fight, cross borders and crowd regions on the world server,
    measured against R10.8's baseline (tick time, bandwidth, frame time).
  - **Failure tests, in one process:** a simulation stopped mid-handoff, a message delivered twice, a
    lease lost. Nothing is duplicated or lost.
- [ ] **R10.25** `docs/world.md`, in place of `docs/zones.md`: the world, regions, instances, channels,
  borders and land, and how to add a region or an instance.

## Phase 11: Assets

- [x] **R11.1** The asset manifest: id, hashed file, size, kind, zones; built with the client.
  Done (a975617): `tools/assets/manifest.ts` (a Vite plugin) writes `/asset-manifest.json`; kinds
  and zones from `src/assets/catalog.ts`, held complete by `tests/unit/assets.test.ts`.
- [x] **R11.2** The loader: the first download carries the title screen and start; the rest streams by
  zone and distance, low detail first, with progress. Today (`inventory/architecture.md` section 7)
  models are eager URL globs, the hero and its four weapons (~1.9 MB) load with character select's
  preview, the village kit (3.8 MB) and ground textures (2.4 MB) when the island builds, and the
  `models` chunk is only partly lazy (`models/kit.ts` and `models/glb.ts` are in the main bundle).
  Done (a975617): `src/assets/loader.ts` (front, zone, near; six at once, nearest first) through
  `src/render/assets.ts`; `src/app/boot.ts` is the first download, the rest of the game is fetched once a
  character is chosen; the title screen shows what has arrived.
- [x] **R11.3** Caching: `immutable` for hashed files, revalidation for pages and the manifest, brotli.
  Done (740f845): `/assets/` a year and immutable, everything else `no-cache` (a 304 unless
  changed), brotli beside gzip; tested on a built game's files. The manifest comes with R11.1.
- [-] **R11.4** Optional: a service worker that keeps assets and prefetches the next zone.
  Dropped (D15): the desktop app will have the files on disk.
- [-] **R11.5** KTX2 textures where they save size or GPU memory.
  Measured (a975617, `docs/assets.md`): the ground as ETC1S first (smaller and 47 MB less on the
  GPU). Waits on KTX-Software's `toktx`, which wasn't installed on the Windows machine.
  Dropped from the refactor (D15): the download's size no longer counts; the graphics memory it
  would save is in `docs/assets.md` for a later performance pass.
- [x] **R11.6** Where big files live: Git LFS (decided; done in R0.9). A CDN in front later is a
  manifest setting.
- [-] **R11.7** A first-download budget the integration tier enforces.
  Done (a975617): `tests/integration/download.spec.ts`, 2.4 MB to character select, 0.75 MB to
  sign-in, nothing of the world before a character is chosen; passing on the Mac too.
  Removed (D15): with a desktop app coming the download isn't held to a budget; what loads first
  (`src/app/boot.ts`, the catalogue's `front` zone) stays, for start-up.
- [x] **R11.8** `docs/assets.md`: the pipeline from a find to the manifest.
  Done (a975617): `docs/assets.md`.

## Phase 12: The Design Bible as a Knowledge Base

- [x] **R12.1** The design: sections (what Ruina is; systems; the world; things; development), where
  the written explanations live (beside the content they describe; system pages in the bible's own
  folder), and how numbers get in (taken from the compiled content when the page is built, never
  copied into prose by hand).
- [x] **R12.2** The page: `/bible/` in the built game, open to players, linked from the title screen and
  the admin menu; navigation, search, links between pages.
- [x] **R12.3** A page per system, written from the engine's rules, with the formulas and numbers:
  moving and climbing, swimming and gliding, combat, skills and builds, creatures and their AI,
  farming and gathering, livestock, trade and pack running, contracts, housing, vehicles and the
  shipyard, quests and progress, weather and the clock, the world and its places, parties and
  dungeons, mini-games, economy and labor.
- [x] **R12.4** A page per thing, generated: items, recipes, vendors, creatures, NPCs, quests, skills
  and the skill tree, weapons and abilities, vehicles, mounts and gliders, buildings, crops, animals,
  zones, dungeons.
- [x] **R12.5** The completeness test (unit tier): every system and every piece of content has its
  page and its explanation.
- [x] **R12.6** The Development tab: today's tracker view of `design/status.json`, for admins.
- [x] **R12.7** Docs: how to keep the bible current when adding a system or content (AGENTS.md).

  Phase 12 done by a background agent (738e040, 6b45e97, 5594678): `/bible/`, open to players, 461
  pages, every number from the content or the rules; `tests/unit/bible.test.ts` fails on any system,
  thing, rules file or content key without its page. Linking it from the title screen and the Admin
  menu is left (they were other agents' files then).
## Phase 13: AGENTS.md, the Docs and the Merge

- [ ] **R13.1** AGENTS.md rewritten (map, boundaries, recipes, commands, tiers, rules, assets,
  deploys, other sessions), linking to `docs/` and the area AGENTS.md files.
- [ ] **R13.2** `docs/`: architecture, engine, content, zones, testing, assets, deploys, admin.
- [ ] **R13.3** The design bible's tracker: every moved path updated (moves script), the refactor's
  features done, a session entry per phase.
- [x] **R13.4** The path check (unit tier): every path named in AGENTS.md, `docs/`, the skills and
  `design/status.json` exists.
  Done (9a34c1b): `tests/unit/paths.test.ts`.
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
| 2026-11-05 | R1.1-R1.15 | Test tiers: Vitest unit and conformance, integration and stress folders, typed test API, CI, docs; Rust tests 7 s | 57bbd61..c85dfb3 |
| 2026-11-05 | R1 close | Phase 1 measured: unit in seconds, Rust edits tested in 7 s, integration 281 tests in 8.7 min | 3fdaeaa |
| 2026-11-05 | R2.1-R2.3, R2.12 | Dead TypeScript and Rust out (48 exports, terrain.rs, 16 items); knip and clippy as guards | 5307934, 560ce2b, d158ac1 |
| 2026-11-05 | R2.4-R2.7 | Dead data, one copy of each helper (src/util), weapon names in data, small fixes, storage keys under ruina.* | 034dc6e..e0c94a8 |
| 2026-11-05 | R4.1-R4.6 | The find-assets skill | de8fd77 |
| 2026-11-05 | R3.2-R3.4b | Admins: ADMIN_USERS on the server, the developer commands and pages kept from players | 8ee8144, ee702b5 |
| 2026-11-06 | R5.0b, R2.11 | Rust formatted once (rustfmt.toml) and blame told to look through it | 440a861, 2078180 |
| 2026-11-06 | R5.5b, R5.2b | Starting an island over rebuilt solids in a HashMap's order; one mulberry32 | f8a7187, f1ec903 |
| 2026-11-06 | R2.8, R2.8b | The toon look retired; quality settings in its place | e97d392 |
| 2026-11-06 | R3.5-R3.11 | The Admin menu; the developer pages in dev/, built with the game | 6542f7d, 9d9a9d7 |
| 2026-11-06 | R2, R3 close | Phases 2 and 3 done, with the quality settings' numbers | c443aa2 |
| 2026-11-06 | R5.1-R5.5, R5.9 | The Rust in a workspace of three crates; the server renamed ruina-server; the server in areas; determinism lints | 8030f44, 598820c, 04da4b6 |
| 2026-11-06 | R5.0b, R2.11 | The TypeScript formatted once (Biome) and checked | cf22932, 1841a64, cf09432 |
| 2026-11-06 | R5 close | Phase 5 done, with build and test times | 0b89335 |
| 2026-11-06 | R6.1, R6.3 | Every URL option in one list (and its test); the test API in its own module | 138706b, ec69498, e5a6253 |
| 2026-11-06 | R8.1, R8.2, R8.4 | The engine compiled to WebAssembly: ground queries, the same to the bit natively and in the browser | 2ff8375 |
| 2026-11-06 | R6.2 | The bug reporter's and the server's wiring out of main.ts | 586f27e |
| 2026-11-06 | R6.12 | The areas' boundaries as a unit test | ec3051e |
| 2026-11-06 | R10.5 | Bots in the engine and the world server | 03e5a4c, 3c1c4ca |
| 2026-11-06 | R6.5, R6.6 | The UI's components; lifeUI.ts a module per window | 7de96ec, 49f62b4 |
| 2026-11-06 | R6.15 | The content library holds the galleries: models, buildings, species, rigs, retargeting, the hero's animations | 1894d4a..12a0573 |
| 2026-11-06 | R10.3, R10.4, R10.6, R10.7 | The developer zones on the server: the yard and the battlefield as copies, bots from their files | acaf9b5 |
| 2026-11-06 | R12.1-R12.7 | The Ruina Bible at /bible/, open to everyone; the design page its Development tab | 738e040, 6b45e97, 5594678 |
| 2026-11-06 | R7.1-R7.8 | Content in folders: content/, contentc, schemas, cross-references | 80ffc5a |
| 2026-11-06 | R7, R12 close | Phases 7 and 12 done; the rules issues the knowledge base found | f291a84 |
| 2026-11-06 | R10.7 | The developer zones in the browser: an arena under the sky, bots drawn as players | 157e823 |
| 2026-11-06 | R10.3 | The Admin window's zone buttons | 8d1722f |
| 2026-11-06 | R11.3 | Caching and brotli | 740f845 |
| 2026-11-06 | R10.4 | The yard's dummy and slimes on its floor; combat measured from a copy's floor | b318daf |
| 2026-11-06 | R9.8, R10.3, R10.13 | Zones are content (one bundle, no lists in code); the goblin camp; the Admin menu's zones from character select; zone to zone; docs/zones.md | 777949b |
| 2026-11-06 | (log) | The tracker brought up to date | 1646629 |
| 2026-11-06 | R9.4 | The island's people are content (`content/npcs/`) | f6055e7 |
| 2026-11-06 | R9.6 | Quest markers from the quests' data | 2ca47bf |
| 2026-11-06 | R10.7, R10.9 | The battlefield's fights in the world: sides, lag compensation (WORLD_PROTOCOL 8), the old battle server's fifteen fights | d0014e8 |
| 2026-11-06 | R9.7 | Item behaviours from the items' data | 5d0712d |
| 2026-11-06 | R9.12 | No content id in code, but for the reasons allowed | 41395e6 |
| 2026-11-06 | R10.4, R10.12 | The yard's monsters on the world server (`tests/integration/yard.spec.ts`) | 98049ae |
| 2026-11-06 | R9.13 | Creatures from their folder (`content/creatures/_order.json`) | 3d84597 |
| 2026-11-06 | R10.9, R10.10 | The browser's battle server path and the raid gone; WorldFeed | da8fb15 |
| 2026-11-06 | R13.4 | Every path the docs name is there | 9a34c1b |
| 2026-11-06 | R6.13 | `src/net/AGENTS.md` | 37afeca |
| 2026-11-06 | R9.13 | Templates and new content as data alone, played | fef19c5 |
| 2026-11-06 | R8.15 | `crates/engine/AGENTS.md` | 33bf4ea |
| 2026-11-06 | R6.2 | `main.ts` by concern: the drawing, the step, the loop, the camera rig | (R6.2's commits) |
| 2026-11-06 | R6.2a | The rules tests play the game headless: 77 move from Playwright to `tests/unit/rules` | eda3f19 |
| 2026-11-06 | R8.6 | The engine grows Emberholm from its recipe, no bake; the browser's island is the engine's, the TypeScript generator gone | dafec37, ba9c87a |
| 2026-11-06 | R8.1, R8.6 | The image builds the game again (the bible and the crates it reads, the engine's WebAssembly) | 50d91ef |
| 2026-11-06 | R8.5 | The engine's player and creatures say what happened (events) | 15a7ff9, 6ed236a |
| 2026-11-06 | R8.5, R8.3 | The engine plays the browser's offline game (the session, the training layer, the yard), and the shadow holds it to the TypeScript in the 77 headless rules tests, bit for bit | ac7e7ed |
| 2026-11-06 | R8.3b, R8.5 | The session online: the server's word on you, the island as sent, commands run ahead, the page's hooks as inputs; shadowed online | d250c74 |
| 2026-11-06 | R8.5 | The shadow in the page; the whole integration tier played with it; the prediction's -0 fixed; the design bible loads the engine | 2e4fc44 |
| 2026-11-06 | R8.7, R8.8, R8.9 | The switch: the Engine answers from the engine's session (you, the creatures, the yard, the island), the page reading snapshots; the shadow gone with what it compared | 8ea8ece |
| 2026-11-06 | R9.11, R8.11, R6.9 | Mini-games from their files with the engine's rules on the board; the UI gallery (a background agent, merged) | 0e918b8, dabea21, f9517ba |
| 2026-11-06 | D16-D19, Phase 10 | One world: seamless regions with fixed borders, channels opened by crowding, contested land; the research (`.plans/world/research.md`) and the plan revised for the foundations | c3d19c3 |
| 2026-11-06 | R8.13 | The check programs and the conformance specs that held the TypeScript rules to the Rust go; the docs say the rules are one copy; the battlefield spec's fighters leave through its way out | (this commit) |
| 2026-11-06 | R9.14 | `docs/content.md` | 5e23680 |
| 2026-11-06 | R10.10, R11.1, R11.2, R11.7, R11.8 | Snapshot to move machines: the battle server's Rust gone; the asset manifest, loader and first-download budget, `docs/assets.md` | a975617 |
| 2026-11-06 | R6.10, R6.11, R6.8 | The client's moves: creature bodies into src/render/creatures/, the root files to their areas, the library under src/dev/ | 9317ff3, 5de387d, 81df3de |
| 2026-11-06 | R6.4, R6.0b | The engine bridge begins: `src/engine/engine.ts`; taking an island up from a save is the rules' | 6553617 |
| 2026-11-06 | R6.2 | Frame stats in `src/app/perf.ts` | 367a883 |
| 2026-11-06 | | `prune-imports.mjs` leaves unused locals alone | 903765f |
| 2026-11-06 | D15, R11.4, R11.5, R11.7, R8.14 | A desktop app later: the browser's download work out | fa14dcd |
| 2026-11-06 | R6.2 | Aiming in `src/app/aiming.ts` | 017c79e |
| 2026-11-06 | R9.10, R8.6 | The generator names no structure; the island's generator in Rust, equal to the bake (a background agent) | 27e7cba, c37c9ef, 3ec5d83 |
| 2026-11-06 | R6.7 | The library's `app.ts` by concern (a background agent) | 7ff6dea |
| 2026-11-06 | R5.6 | The engine's golden tests (a background agent) | 5b339a8 |
| 2026-11-06 | R6.0 | Everyone else drawn by the drawing (1acd45f); the windows don't call the network (465e613); areas that leaned on each other both ways, one way (37ac866, 2ed6607, dae798f, eb11517, 7eb599f) | 1acd45f..7eb599f |
| 2026-11-06 | R6.13 | `src/render`, `src/ui` and `src/dev` guides | 6ae1345 |
| 2026-11-06 | R6.0b | The server's word on you, solid things and the test API's writes as calls; the island online | 89ace09, 9a319e4 |
| 2026-11-06 | R6.4 | The bridge is the one way to the rules | 56ad5ee |
