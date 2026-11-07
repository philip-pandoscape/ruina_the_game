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
| 2 Clear Out Dead Code | done (Biome with Phase 5) |
| 3 Admin Menu | done |
| 4 The /find-assets Skill | done |
| 5 The Rust Workspace | done |
| 6 The Client in Areas | nearly done: the library's reach into the hero (after R9.5's client part) and the look check (R6.14) left |
| 7 Content in Folders | done |
| 8 One Copy of the Rules | done |
| 9 Content as Data, Finished | nearly done: the skill tree's numbers by id (R9.5's rest) left |
| 10 One World: Regions, Channels, Instances and Bots | about half: the world map, borders with no seam, the rules taking the world, instances in spaces of their own, the content as regions and instances, spawns as data and the tick that splits are in; growing and dropping regions, ids and the clock, borders between simulations, the server's tiers, land, channels, the wire, the big-world client and proof at scale are left |
| 11 Assets | done; the browser's download work dropped (D15) |
| 12 The Design Bible as a Knowledge Base | done |
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

## 2026-11-05: Phase 4, the /find-assets Skill: done

- `.claude/skills/find-assets/SKILL.md`: free first, the licences a public repository can carry
  (CC0, CC-BY with a credit), where to look for each kind of asset (models, textures, skies,
  animations, sounds, music, effects, fonts), judging candidates in the game's look, showing you,
  fetching, bringing them in, crediting them, and paid makers (Meshy, Gemini) last, with their cost
  said first.
- `tools/assets/search.mjs` searches Poly Haven, ambientCG, Sketchfab (light models only, unless
  asked) and Freesound; `tools/assets/fetch.mjs` fetches from those, Kenney's pages and itch.io's
  free downloads into a fresh folder of its own, with a `credit.json` and the `CREDITS.md` row.
  Proven on a Poly Haven model and texture, an ambientCG texture, Kenney's impact sounds and
  Quaternius' animation library. Sketchfab downloads want your API token and Freesound's API a key
  (`SKETCHFAB_TOKEN`, `FREESOUND_API_KEY` in `.env`); without them those two only search.

## 2026-11-06: Phase 2, Clearing Out Dead Code: done

- **Out:** 48 TypeScript exports nothing used and a barrel file; `terrain.rs` and 16 Rust items;
  `tuning.json`'s `slide.frames`; comments about files long gone. `knip` now reports nothing and,
  with clippy (every lint an error), guards `npm run check` and CI.
- **One copy each:** `TAU`, `clamp`, `lerp`, `esc`, `angleDiff` in `src/util/`; weapons' names and
  icons in `tuning.json`, read by the UI, the library and the poses, which each had a copy.
- **Under the game's name:** the browser's saved build, the yard's skill experience and the quest
  tracker's hidden quests move from `yggdrasil.*` to `ruina.*` once, without anyone losing them.
- **Flags:** `?goblins` has a test; the hero's comparison switches (`heroModel`, `heroWeapons`,
  `swordMoves`...) stay, documented, as the animation work's; the battle server's own options go with
  it in Phase 10.
- **The toon look, retired** (a background agent, e97d392): one look, at three qualities, picked by
  the graphics chip or `?quality=`. **Low** is new, for software WebGL (CI's browsers) and no WebGL2:
  of the screen effects only the haze and the grade, the frame at three quarters size, plain ground,
  far-shape trees with half the clumps, a 1,200 m view. Time per frame in SwiftShader at 1280 x 720:

  | Place | Toon look (before) | Low | High |
  |---|---|---|---|
  | The square | 485 ms | 367 ms | 2,564 ms |
  | The isle from the air | 597 ms | 285 ms | 3,529 ms |
  | The fields | 235 ms | 332 ms | 2,092 ms |

  On Intel UHD graphics at 1080p the square costs 14.4 ms of GPU a frame at low (the toon look
  14.6), 33.1 at medium, 51.6 at high. Screenshots: `screenshots/look-<place>-<quality>.png`. Left:
  at low, a few tree tops on the far ridge show without haze (being fixed); the fields at low are
  slower than the toon look was, because of the tree crowns.
- **Left:** Biome for the TypeScript, with Phase 5's formatting (the Rust's is done).

## 2026-11-06: Phase 3, the Admin Menu: done

- **Who:** `ADMIN_USERS` names the admins (on beta: `philip`, set with the final merge). On a
  development server everyone is one unless `ADMIN_USERS` names someone, so you (or a test) can see
  the game as a player does. The server says so in `/api/me`, at sign-in and in the world's welcome.
- **Closed to players:** the developer commands (gifts, island time, teleports, seeded mini-game
  challenges, starting the island over). Until now beta's `DEV_TOOLS=1` gave them to every player.
  The developer pages, `/dev/` and `/design/`, answer anyone else "not found"; stopping the server
  wants an admin.
- **The menu:** a button beside Sign Out on character select opens a card of every developer zone
  and page (`src/dev/pages.ts`), each opening in a new tab; in the world, an Admin window with
  Developer Tools at its top (until now only the backquote key reached it), opened from the menu
  bar's Admin button; a corner button in the yard and on the battlefield.
- **The pages on beta:** the developer pages moved into `dev/` and, with the design pages, are now
  built with the game, so beta serves them (to admins only).
- **Beta explains itself:** the bug reporter says reports need the dev server, instead of asking
  whether `npm run dev` is running; the library says the dev server would keep its notes as files.
- **Tests:** `admin.spec.ts` runs a server of its own with `ADMIN_USERS` set: a player gets no menu,
  their commands are ignored, the pages are not found and stopping the server is refused; an admin
  has the card, the window, a page in a tab and Developer Tools, and their commands work.

## 2026-11-06: Phase 5, the Rust Workspace: done

| | Before | After |
|---|---|---|
| Layout | one crate, `server/`, 30 modules in a flat list | `crates/engine` (the rules), `crates/server` (`ruina-server`, in areas), `crates/tools` |
| Edit a rules file, test it | 7 s (one crate) | **5.2 s** (`cargo test -p ruina-engine`) |
| Edit the server, test it | 12 s | 8.7 s |
| Edit anything, test everything | 12 s | 15.4 s (three crates and the tools' binaries) |
| Release server after an edit | 1 min 38 s | 40-55 s |
| A clean build of every test | | 119 s |

- **The engine** holds the rules with serde, serde_json and libm only: no clocks, threads or I/O.
  It compiles to WebAssembly as it is (Phase 8's start). Clippy keeps it deterministic: the
  browser's maths (`hypot` is now V8's, as the TypeScript's is), no hash maps (their order differs
  between native code and WebAssembly), no clocks.
- **The server** is `ruina-server`, in areas: `accounts/`, `play/` (Emberholm online), `battle/`
  (the battlefield, fenced in until Phase 10 replaces it), `combat.rs`, `http.rs`, `db.rs`.
- **One format:** rustfmt and Biome (160 columns), checked by CI and `npm run check`.
- **A bug fixed:** starting an island over rebuilt everyone's solids in a random order.
- **Tried and dropped:** the `lld` linker (no faster here).
- **Waiting:** golden results for the engine's own tests (before Phase 8 deletes the comparisons
  with the TypeScript), and untangling combat from the battlefield (Phase 10 deletes it).
- **Next:** Phase 6, the client in areas.

## 2026-11-06: Phases 6 to 12, Side by Side

Three background agents took the parts that touch nothing else (the island's windows, the galleries,
the knowledge base) while the main line went on.

- **Phase 6, the client in areas (under way).** The island's windows on shared components
  (`src/ui/components/`), `lifeUI.ts` from 2,328 lines to 600 with the same DOM in 89 states; every
  URL option in one documented module; the test API, the bug reporter's and online play's wiring
  out of `main.ts` (2,566 lines to 1,900); a unit test that fixes which areas may import which. Left:
  the rest of `main.ts`, the bridge to the rules, the Content Library (an agent is on it).
- **Phase 7, content in folders (done).** `content/`: a file per thing (330 files), built into the
  bundles the game reads (`shared/`, the same data, so nothing that reads them changed) by
  `npm run content`, and checked: each kind's schema, every cross-reference, nothing unlisted.
  `content/AGENTS.md` says how to add each kind.
- **Phase 8, one copy of the rules (begun).** The engine compiles to WebAssembly as it is, and its
  ground and colliders answer exactly as natively: 60,000 queries' fingerprint, to the bit, in a test.
  A query costs about 45 ns from JavaScript. The rules' tolerances can't reach zero while the browser
  runs the TypeScript (V8's sin and cos aren't fdlibm's): the switch to the engine settles that.
- **Phase 10, zones, developer zones and bots (server done).** Bots are players whose inputs a brain
  decides (a skirmisher, a wanderer), stepped by the same rules. The yard and the battlefield are
  developer zones built like Goblin's Dread's copies: admins only; the battlefield one copy for every
  admin, sixteen bots a side, there only while an admin is. A bug fixed on the way: in the open world
  nobody could land a blow on another player, because a swing ignored anyone standing more than 2 m
  above zero. Left: entering them from the Admin menu and drawing them as arenas.
- **Phase 12, the knowledge base (done).** `/bible/`, open to players: 461 pages, a page per system
  written from the rules with every number taken from the content or the rules, a page per thing, a
  test that fails on any gap. Linking it from the title screen and the Admin menu is left.

**Found while writing the knowledge base: rules issues, yours to decide** (nothing changed for them):
- Resting (`{t:"rest"}`) is accepted without a bed, in both TypeScript and Rust: three times the
  labor regeneration anywhere.
- F on a fruit tree in its last stage fells it, so one press destroys a picked apple tree.
- The labor tonic caps labor at a hard-coded 1,000 instead of the content's maximum.
- Content fields no rule reads: `plantLabor`, `witherAfterRipe`, `rain.boost`, `swim.splashSpeed`,
  `glide.crashSpeed`, `perks.restLaborMultiplier`.
- The yard's arrows (`training.ts`) disagree with the server's (`combat.rs`).
- Trees block gliders at any height.
- `design/goblins.md` is stale: its poise and stone damage don't match the data.

**Flaky, not this branch:** `net-actors.spec.ts` "drawn moving, not jumping" (@gpu) and the animation
test "turning on the spot" fail now and then under load and pass alone, as before the refactor.

## 2026-11-06: The Content Library, and the Developer Zones in the Game

- **The Content Library (R6.15, done).** The six gallery pages are one page, `/dev/library.html`:
  every animated thing frame by frame, library clips on the hero beside their source, close-up rigs,
  every model, the buildings cut open, crowds with their cost. Each old URL option is a hash option
  there. Their tests moved with them (83 kept, 6 added), the checks that need no page to the unit
  tier (the hero's 20 film checks in 9 seconds). Two bugs found on the way: the retargeting page's
  mixer left bones up to 90 degrees out when a frame was shown from a kept copy, and it never drew the
  source's skeleton at all. "Turning on the spot" no longer fails now and then: the checks measured
  whichever body loaded first; they always measure the box hero now.
- **The developer zones, in the game (R10.3, R10.4, R10.7, R10.13).** The Admin menu lists the yard,
  the battlefield and a new goblin camp, and takes an admin into one from the world or straight from
  character select, and from one zone into another. The yard has its training dummy and slimes, and
  blows land on them: a copy's creatures, and every height in a fight, are measured from its floor, not
  the island's ground 400 m below. Online the server's dummy is drawn (the island's one was solid and
  invisible online). The old zone pages (`?yard`, `?server=`, `?raid`) are off the menu.
- **Zones are content (R9.8, first half).** `content/dungeons/` is a folder of files built into one
  bundle both sides read: a new dungeon or zone is a file, with no list in code. The goblin camp was
  made that way, a file alone: a war-band of six round their fire (a zone's spawns can be a band). The
  engine checks every zone stands where players may go and apart from the others. `docs/zones.md`
  says how to add one.
- **Caching (R11.3).** Files the build names after their contents are kept a year; pages are asked
  about each time; brotli beside gzip.
- **The tracker's log** was behind since Phase 1; it now lists every landing with its commit.
- **Tests:** unit 126, conformance 64, Rust 205, all passing; the admin spec 5 (the battlefield, the
  yard from character select, the goblin camp from the Admin window, a player kept out, the menu); the
  specs the library agent saw fail (combat, skills, PvP, net actors: 35) pass, as their failures were
  its stopped server.

**Next:** the old battle server and its client paths out (R10.10, R10.9), so the battlefield is only
the developer zone; then the engine bridge (R6.4) and Phase 8's switches.

## 2026-11-06: On the Mac, the Engine Bridge, and a Desktop App Later

- **Picked up on the Mac** (c2d6394). The Windows machine's last snapshot (a975617) is checked out here
  with Git LFS, and its unchecked work verified: 243 of the integration tier pass. Of the three that
  don't, two pass alone (they lose races under load) and one needs pointer lock, which macOS's
  headless browser doesn't give. The tracker is up to date with every landing, and this machine has
  a test rig of its own (Postgres on 5461, a world server on 7871).
- **The client's files where they belong (R6.8, R6.10, R6.11).** Creature bodies are in
  `src/render/creatures/`, the root files in their areas, and the content library under `src/dev/`,
  all moved by the moves script.
- **The engine bridge begins (R6.4, R6.0b; 6553617).** `src/engine/engine.ts` is how the page
  reaches the rules, and what changes them from outside is a named call: putting you somewhere, your
  build, a dungeon's floors and walls, an island loaded. Taking an island up from a save belongs to the
  rules (`src/sim/life/island.ts`, the twin of the server's `load_island`).
- **`main.ts`'s split goes on (R6.2).** Frame stats are in `src/app/perf.ts`, and aiming (the mark,
  the ground-aimed circle, aim assist, the combat stance) is moving to `src/app/aiming.ts`.
- **Decided: a desktop app later (D15).** The client will be packaged as a desktop app, though not
  in this refactor, so the work that only keeps a browser's download small is out. The service
  worker (R11.4) and KTX2 textures (R11.5) are dropped, the first-download budget test is removed
  (R11.7), and R8.14 measures no download size. What was built stays: the asset catalogue and
  manifest, the loader (nearest first, which still serves start-up time and graphics memory), and the
  cache headers for the browser game until then. That makes Phase 11 done.
- **Three agents run alongside,** each in a worktree of its own: the island's generator in Rust
  (R8.6), the network and drawing split with crowds at scale (R6.0, R10.8), and the library's split
  with a UI gallery (R6.7, R6.9).
- **Fixed on the way.** `tools/refactor/prune-imports.mjs` took an unused local for part of an
  import and cut everything between it and the last import (511 lines of `main.ts`, caught before
  anything was committed). It now leaves locals alone and handles `x as y`. The docs' path test no
  longer reads the agents' worktrees.

## 2026-11-06: The Bridge Is the One Way to the Rules

- **The agents' work is in (R5.6, R6.7, R8.6 ported, R9.10 but the waterfall).** Three background
  agents stopped at the user's word, and what they had finished is merged. The engine has golden
  tests that keep its answers bit for bit once the TypeScript goes, and the content library's
  2,316-line `app.ts` is split by concern. The island's generator runs in Rust and matches the bake:
  none of 591,361 heights differ. Their unfinished work (the network/drawing split) was finished
  here. From now on one session does the work, without agents.
- **The client's areas lean one way (R6.0).** The network keeps everyone else's state and the
  drawing draws them. The sign-in, character, party and mini-game windows declare what they show and
  call, and the app hands them the connection. The build's rules moved to content and auto-run to
  input, the HUD moved to the UI, and drawing no longer imports the windows. The boundary test now
  forbids every crossing the survey found, and it lists no exceptions.
- **Only the bridge touches the rules (R6.0b, R6.4).** Every write from outside the rules is a named
  call on `src/engine/engine.ts`: the server's word on you, solid houses and vehicles, your island
  online (taken from ticks, commands run ahead and run again), levels, commands, and the test API's
  hooks. Four facades name the 111 things the rest of the client reads from the rules, by the domains
  Phase 8 switches. Nothing else imports `src/sim/`, so Phase 8 can answer the bridge from the Rust
  engine with no change outside it.
- **`main.ts`'s tangles undone (R6.2).** There is no patched `life.command`, the key intercept is
  composed once, and nothing is used before it's declared. `main.ts` is 1,518 lines (2,566 at the
  start). Drawing a frame and the loop are left to split, along with the game context they need.
- **Guides:** `src/render`, `src/ui`, `src/dev` and `src/engine` have their AGENTS.md (R6.13).
- **Tests:** `npm run check` and conformance (64) pass. The integration tier passes 241 of 245. Of
  the rest, three are races under load that pass alone and one needs pointer lock, which macOS's
  headless browser doesn't give. The races are listed in the tracker.

## 2026-11-06: The Island Grows in the Engine, and the Engine Plays the Browser's Game

- **The island grows in the engine alone (R8.6, done).** The server grows Emberholm from its recipe
  the first time anything asks, and the bake (3.6 MB of island, its reader and `npm run bake`) is
  gone. The browser grows the same island through the engine's WebAssembly, so the TypeScript
  generator (917 lines) is gone too. The island grows in 90-145 ms where the TypeScript took 330-810,
  and the engine's file shrank from 4.1 MB to 0.7. The Docker image builds the WebAssembly, and it
  regained the bible's pages, which it had been missing since the bible came in.
- **`main.ts` gave up its last tangles (R6.2, R6.2a).** It is in modules now (the drawing, the
  loop, a step, the camera rig, the online wiring), reached through one set of game references.
- **The engine says what happened.** Its player, its creatures and the yard's training layer raise
  the events the browser draws (a jump, a landing, a swing, an arrow loosed, a blow, a burst, a
  splash), in the TypeScript's order and shapes.
- **The engine plays the browser's game, offline and online (R8.3, R8.3b, R8.5).**
  `crates/engine/src/session.rs` is the game as the Engine runs it: you, the creatures, the island,
  the copies of dungeons, and every named call the Engine takes. Online, it takes the server's word
  on you and replays your unanswered inputs, takes your island as the server sends it, and runs
  commands ahead of the server. Its island gained the online prompts it lacked: riding along in
  someone's vehicle, and challenging someone. The page's hooks into the rules (the world's clock,
  others' vehicles and players, the plots they hold, where commands go) are the Engine's now, asked
  once a step.
- **The shadow holds it to the TypeScript.** In the tests, every Engine runs the engine's session
  beside its TypeScript rules and compares you, the creatures, what happened and the island after
  every step and call. The 77 headless rules tests and an online test (160 frames a round trip
  behind a server) match bit for bit. On the way it found that the engine's prompts had drifted
  from the TypeScript's, that getting off a vehicle was handled differently in each, and that V8's
  sine and cosine differ from the engine's in the last bit on about 1% of inputs. After the switch
  the server and the browser will run the same maths, which they don't today. The shadow can now
  run in the game's page too (`SHADOW=1` on the dev server), so the whole integration tier can be
  played with the two compared.
- **A sub-agent is back, one at a time** (the user's word), on Opus 5.5 at max effort in a worktree
  of its own. It has the mini-games (the board shows what the engine's rules allow), then the UI
  gallery.
- **The page shadow found one difference, and it was real.** Played with the shadow on, the whole
  integration tier found one difference, twice: the prediction rounded a stick nudged just left of
  straight back to -0, which the server, rebuilding it from a byte, has as 0, so turning to face
  straight back went the other way in the browser. Fixed, with a unit test.
- **The switch (R8.7-R8.9, done).** The browser plays on the engine's rules: the Engine answers
  every step and call from the engine's session, and the page reads snapshots back after each one
  (you, your levels, the creatures, the yard's arrows and meteors, the island, its prompt and what it
  said). The page's names stayed (`engine.sim`, `engine.life`), as views, so the windows and the
  drawing didn't change. What's solid has one copy too: the camera's and the drawing's colliders are
  read back from the engine whenever they change. The shadow went with the TypeScript it compared;
  its online scenario stays as a test against an engine standing in for the server. The
  integration tier found two slips (a reset kept the old log; levels the island raised didn't reach
  the page), both fixed. A step costs 0.03 ms online and 0.3 ms offline on the island, most of it
  reading the island back.
- **The sub-agent's work, merged (R9.11, R8.11, R6.9).** A mini-game is now its file, its rules
  module in the engine and its board views, with no list of games anywhere in code; the board offers
  just what the server would take, asking the same rules through the WebAssembly. The UI gallery
  (`/dev/ui.html`, framed by the content library) draws 32 made-up states of 17 windows on a real
  offline island; it found three quest names out of Title Case, renamed ("Wings Over the
  Windspire", "Stone From Stonebreak", "Timber From Thornwood"; the user may prefer "over" and
  "from" kept small).
- **Next:** delete `src/sim/` (9,668 lines, R8.13), keeping only what the page reads as views
  (types, the ground's sampling, the roads, the island's read helpers), and the conformance checks
  with it; then measure frame time, start-up and memory against the baseline (R8.14).

## 2026-11-06: One World

- **The question.** Ruina's main world is to be one seamless open world made of regions defined by
  data, with Emberholm as the first. The code had grown round one zone: `emberholm()` everywhere,
  saves and placed things with no zone, the word "island" for both the region and a character's
  state. The user asked how the world grows, at up to 100,000 players on one world.
- **The research** (`.plans/world/research.md`, about 75 sources, the key ones checked by hand):
  - **Nobody runs 100,000 players in one undivided space.** The big worlds split twice: by area
    (New World's grid of hubs at 2,500 a world, EVE's systems, Albion's clusters) and by crowd (WoW's
    layers, Guild Wars 2's megaserver, Black Desert's channels).
  - **Splitting a region automatically by load has a poor recent record.** Star Citizen's shards
    still run a set number of servers (August 2026).
  - **At scale, bandwidth costs more than CPU.** Sending each player only what's near them, in compact
    binary, is the biggest single win.
- **Decided (D16-D19):**
  - **The world:** one seamless world of regions, meeting across sea or land, and massive.
  - **Splitting it:** fixed borders, with regions placed on servers automatically.
  - **Crowds:** an overcrowded region opens another channel, grouping players by friends, party and
    guild.
  - **Housing:** plots in the shared open world, scarce and contested, as in ArcheAge.
  - **Scope:** the foundations in this refactor; the multi-server version after the merge, with
    large-scale PvP and hosting at scale, on foundations that need no second refactor.
- **The plan.** Phase 10 became One World, and is next after `src/sim/` goes (R8.13). It builds, in
  one process:
  - the world's words, and spaces for instances;
  - regions placed on a world map by data;
  - global ids and a world clock;
  - a tick in which order doesn't matter;
  - borders with ghosts and handoff, proved by Emberholm split into two simulations matching one bit
    for bit;
  - the server in tiers (gate, simulations, store, social, directory);
  - land, plots and a ledger in the database;
  - the wire for crowds;
  - channels that open and merge by affinity;
  - the client in a big world;
  - a proof with thousands of bots.
- **Merged on the way:** the switch (8ea8ece) and the sub-agent's mini-games and UI gallery (31657d3).

## 2026-11-06: The TypeScript Copy Gone (R8.13, R8.12)

- **The comparisons went first** (39e253b). The check programs and the conformance specs held the
  TypeScript rules to the Rust; with one copy there is nothing to compare. The engine's golden tests
  keep the answers they proved, and the conformance tier now holds the WebAssembly to the native
  engine and the browser's ground sampling to the engine's. The battlefield spec failed whole runs
  because fighters whose windows closed lingered a minute in a battlefield that takes 20; they now
  leave by its way out.
- **The bible reads the Rust** (a background agent, 5c0fd0c, merged in dae2724). Every number a
  system page reads from the rules' source comes from `crates/`; all 461 pages were rendered before
  and after, and only the housing page's house limit reads differently.
- **The tests that drove the TypeScript rules drive the engine** (94ed5c6). Their rules became Rust
  tests beside the code they test; `newContent.test.ts` plays a new townsperson, item, vehicle,
  quest and creature through an `Engine`, which needed the engine to take content at run time
  (`crates/engine/src/bundles.rs`: built in, or given before anything is read).
- **The move.** What the page reads went into `src/engine/`, 30 files: the shapes of the rules'
  state (`shapes.ts`), the ground, regions, dungeons and roads (`world/`), the island's read helpers
  (`life/`) and creatures as read back (`actors/`). Whatever nothing read was cut, 188 declarations
  (the steppers, the generator's TypeScript, the island's Life, the ground's integration), found by
  a tree-shaker over the TypeScript (oxc) and checked by tsc and knip. `src/sim/` is gone. Outside
  code reaches the folder only by its seven front doors (`tests/unit/boundaries.test.ts`, which was
  shown to catch a back-door import). Road routing came along into the bridge, which was all R8.12
  asked. The moved files' comments now say which Rust runs each rule.
- **Verified:** `npm run check` (240 TypeScript tests, 157 engine and 73 server tests); the
  conformance tier (4); the integration tier on the rig (201 passed; the pointer-lock test fails on
  macOS as before). Committed as ce064cc.

## 2026-11-06: Measured (R8.14)

- **How.** `tools/perf/measure.mjs` opens any build in Chromium, times every animation frame round
  the page's own callbacks (so it needs nothing from the game but `__game.ready`), and reads the
  heap after a garbage collection. Where the refactor started (beta d49c3b8, checked out and built
  for production beside this branch's build) and this branch, three runs each, alternated, on the
  Mac's Apple M4 at 1920 x 1080.
- **What it found.** Start-up and frames are no worse (the island ready 19 ms sooner; 60 fps and a
  16.8 ms 99th-percentile frame either way). Memory is a little up (the heap 1.3 MB, array buffers
  12 MB: the engine's WebAssembly memory holds its own island). The page's work in a frame was 0.3
  ms more, and timing an offline step's parts showed why: the rules take 3 microseconds, but the
  engine built its 18 KB view of the step as JSON values before writing it out, 0.23 ms of a 0.28 ms
  step.
- **Fixed.** The view is written straight from the session's values (`Session::view_text`): a step
  on the island costs 0.085 ms (3.3 times less), in the yard 0.031. Typed arrays in place of JSON
  (R8.3's last open question) aren't needed.
- **Also.** The Rust comments that described a TypeScript twin (some seventy places: "the
  TypeScript would throw", "follows it line for line", "mirrors X in actor.ts") now say what the
  Rust does, or where the page reads it. One rule still has a TypeScript copy for what the page shows: the skill
  tree's fold (`src/content/skills.ts`), now R8.16.

## 2026-11-06: The World Map (R10.16, R10.1)

- **What.** The engine knows the world as a map of regions, not one island. `content/world.json`
  places each region on a grid of 256 m chunks (Emberholm is 6 x 6 round the origin); wherever no
  region stands is open sea. `crates/engine/src/open/map.rs` reads it into a `WorldMap` that answers
  height, slope, surface and depth anywhere, growing each region from its recipe the first time
  anything asks. `OpenWorld` stands on the map, with every region's colliders; a region's terrain
  has an `origin`, so its recipe is written in world coordinates.
- **What moved.** The edge of the world is now the edge of the map's chunks, a square, where it was
  a circle of 760 m round Emberholm. That is the one golden answer that changed ("swimming to the
  edge of the world"), kept on purpose. Every other answer on Emberholm is the same bit for bit.
- **Proved.** A fixture world of two regions, Emberholm and an islet four chunks east across open
  sea: each stands where the map puts it, both are solid at once, and a player swims from one to the
  other. contentc refuses a region whose grid doesn't cover its chunks, two regions on one chunk, and
  a region with no recipe (`tests/unit/content.test.ts`).
- **Left for R10.16.** Land borders (edge constraints and a blend), growing and dropping regions by
  need, `Life` across regions, and the browser drawing a region placed away from the origin (R10.23).

## 2026-11-06: Saved Builds by Id, and the Content's Hash on the Wire (R9.1, R9.2)

- **What.** A background agent's branch, merged. A build is kept by id (`{"weapon":"club","skills":[...],
  "abilities":[...],"movement":[...]}`) in the database and the browser; indexes stay at run time and on
  the wire, where both ends now read them from the same bundles. `shared/hash.json` hashes every
  bundle; the server sends its own in the welcome, and a page built from other content reloads into
  the new build (`WORLD_PROTOCOL` 11). Damage numbers' causes go as a type and a place in
  `tuning.json`, where they were codes in code (part of R9.5).
- **Migration.** Builds kept by index are read through the order they were kept in, frozen in
  `shared/buildsByIndex.json`, and the server rewrites them by id as it starts, a row only if it still
  holds what was read. Tested on saves written by c3d19c3's own server and browser. Left for the
  user: the same on a copy of beta's database.
- **Verified.** On its branch: `npm run check` and the integration tier (202 passed; the pointer-lock
  test fails on macOS as before). Merged: `npm run check` (247 TypeScript tests; 168 engine, 4
  WebAssembly and 75 server tests).

## 2026-11-06: Borders With No Seam (R10.16)

- **How.** Near a chunk's edge the ground is shared with what's across it: weights step smoothly
  from one chunk to the next over 64 m either side and always sum to one, and the ground there is each
  side's as its recipe grew it (a region's held at its edge past it, the open sea's its floor),
  weighed together. Where every weight is one region's, its ground is its own to the bit. A region
  bakes this into its grid as it grows, and the browser's grid and the conformance tool's come from the
  same call, so what's drawn is what's walked on. Since the ground at a point is the same sum
  whichever side works it out, two regions' edges are the same heights; the open sea near a region
  slopes to meet it.
- **Proved.** A fixture of two regions across a land border, one island grown half by each from its
  own recipe (they differ by more than half a metre along the border grown alone): blended, the
  border's heights are the same numbers on both sides, the ground never jumps, and a player walks
  from one into the other. A region meets the open sea with no seam.
- **What moved.** Emberholm's outer 64 m band, where its edge was as shallow as 6.8 m beside the
  open sea's 30 m floor (an underwater cliff of up to 23 m): it slopes down to meet it now. One
  golden answer moved, the edge scenario again.

## 2026-11-06: The Rules Take the World, and Instances in Spaces of Their Own (R10.16, R10.1, R10.15)

- **The rules take the world.** What can be near you (townsfolk, benches, gathering spots, slipways,
  plots, portals, the places quests send you, updrafts) comes from the regions of the space you're
  in; what's found by id comes from the whole world. Gathering spots have ids, and their time to come
  back is kept by id (old saves' timers by index are dropped: the spot is simply back); contentc
  holds every placed thing's id to one thing in the world. No golden answer moved.
- **Instances in spaces of their own.** A dungeon or developer zone is no longer pieces high in
  Emberholm's sky but a space of its own round its own origin, over nothing, with no region or sea
  in its map. The server's copy plays it; the browser's session plays it in place of the world while
  you're inside and takes the world back after. The page's ground there is the engine's for that space,
  so the camera, shadows and effects don't meet Emberholm's hills where the cave now stands.
  Saves made in a copy keep the spot outside its door. The rule that kept instances within 760 m of the
  island and apart went with it.
- **Moved on purpose.** The battlefield's replay hash in the server's tests (everyone round its own
  origin now).

## 2026-11-06: The Content as the World Has It (R10.1)

- **Regions and instances.** A region is its recipe, `content/regions/<id>.json`, and the folder of
  what it places beside it; an instance is a file in `content/instances/`. The bundles follow
  (`shared/regions/<id>.json`, `shared/instances.json`), and the words with them: the bible's Zones
  are Regions, and the templates are a region's lists and an instance.
- **Doors.** The doors into a region's dungeons are its `doors.json`, each named for the instance it
  opens into (contentc holds it to one). The server finds a door in whichever region it stands, where
  it looked in Emberholm alone.
- **Every region's ids.** contentc's references and the content-ids tool read the ids of every
  region the world places, not Emberholm's alone, so a second region's townsfolk, places and benches
  are found by the content that names them.

## 2026-11-06: Looks From Data (R9.9), and a Race Found (a background agent's branch)

- **Looks.** What a thing is drawn as is its `look`, in its content file: a body built into the
  game, by name, and a made model fitted over it. Structures, props, crops, packs, farm animals,
  vehicles, mounts, gliders, townsfolk (colours, build, hair and an outfit) and creatures (the slimes'
  jelly, what floats in it, the monarch's crown, the dummy's straw) all name theirs; the drawing
  chooses nothing by id, and a thing with no look gets its kind's plain body. Every model's
  fingerprint was the same before and after, and the island's pictures differ only by the run-to-run
  noise.
- **The party spec's race** was a real glitch: moving between games, a tick from the game you'd left,
  heard just before the move, was taken as the server's word on you and put you back at its spot for
  a tick. The feed forgets it now.

## 2026-11-06: The Engine's Guide, the Skill Tree's Numbers, and the Last Casts (R8.3, R8.16, R9.13, R6.11b)

- **`docs/engine.md`** says how the engine is one copy of the rules (determinism, the golden tests,
  conformance, content as data), how the server steps it, and how the browser reaches it, export by
  export and call by call, with how to add a write, a read or a system. Phase 8 is done with it.
- **The skill tree's numbers** (what a build's skills make of its attacks, spells and movement) are
  the engine's own fold, asked through the WebAssembly when a build or its levels change; the
  TypeScript copy of it went.
- **The library's crowd subjects** come from the creatures' registry, so a creature added with a body
  of its own is there with no line of the library's code (the goblin's, missing before, now is).
- **The casts round the rules' types** went: the developer panel's teleport and bots are in the
  page's command list, the island's drawing takes the player whose island it draws (the others' had
  been handed a made-up sim), and the library reads Emberholm's people typed. The library's reach
  into the hero's private parts waits for R9.5's client part.

## 2026-11-06: The Tick That Splits, Spawns as Data, and Phase 9's Client Leftovers (R10.18, R9.3, R9.10, R9.8, R9.5)

- **The tick that splits (R10.18, a background agent).** The order a channel steps its players,
  bots, creatures, arrows and meteors in changes nothing: a tick goes in phases, each thing reads the
  others as the phase began, and what it does to anyone lands once all have gone. So the server can
  step its players all at once (`--parallel on`). The rules' time a tick on an Apple M4, before, one
  after another, all at once: 64 bots 0.17, 0.11, 0.13 to 0.16 ms; 256 bots 0.60, 0.41 to 0.46, 0.26
  to 0.32 ms; 1024 bots 3.3, 2.0 to 2.3, 0.8 to 1.0 ms. All at once is slower at today's channel
  sizes, so it's off by default. Sending the updates is now the bigger cost (8 ms a tick at 1024 bots):
  R10.8's.
- **Merging it** took the server's battle hash to a third value, both sides having moved it for their
  own reasons (everyone round the battlefield's own origin; the browser's sine, cosine and atan2). With
  the platform's maths swapped back in, the merged code gives this branch's old hash exactly, so
  nothing else changed.
- **Spawns as data (R9.3).** Emberholm's slimes and training dummy are its recipe's `spawns`, as an
  instance's are, and one engine module places them for every game. The server had its own copy of
  the slimes' layout, on the platform's maths; it's gone. The dummy's body now stands where the dummy
  creature is, offline as online.
- **Phase 9's client leftovers (a background agent).** A waterfall's landing stage and totem only
  where it has them (the engine too, now); Goblin's Dread's dressing as data, so another cave is a
  file; the browser knows weapons by id, and a test reorders them to prove it. What still knows
  weapons by place is the skill tree's numbers (R9.5's rest), which the engine reads.
- **Guides.** `docs/world.md`, `docs/deploys.md`, and the README as a quick start.


## 2026-11-06: The Library's Last Casts, One Guide to the World, and the Whole Tier Again (R6.11b, R6.11, R10.25, R10.16)

- **The content library's last casts (R6.11b).** The hero shows what the library needs through a
  small public surface: the weapon held, putting it somewhere, the pose's feedback for a kept frame,
  hiding the trails, the feet's holds. The library no longer casts the hero to a shape of its private
  parts. With the names settled (R6.11), Phase 6 is done but for the look check (R6.14), which needs
  a real GPU and a baseline from `beta`.
- **One guide to the world (R10.25).** `docs/zones.md` is folded into `docs/world.md`: the regions,
  the instances and their copies, bots, and adding a region or an instance, on one page.
- **One step for a player in an open world (R10.16).** The last thin wrapper went.
- **The whole integration tier** on the merged tree: 199 passed, 4 failed. One is the pointer-lock
  test, which always fails on macOS. The other three ran while files were being edited, so the
  dev server reloaded their pages; they pass alone.
- **Under way:** the skill tree by id (R9.5's rest), in a background agent's worktree. Next, the
  offline yard as the yard instance (R10.11), once that branch is in, since both touch the rules tests.

## 2026-11-06: Offline Copies, the Yard Instance in the Yard's Layout, and the World's Clock (R10.11, R10.17, R13.2)

- **Offline, a copy of any instance (R10.11).** `?test=<instance>` opens one paused for tests, and
  `?offline=<instance>` plays it running, as if you'd come through its door. A copy played offline
  brings the creatures its file spawns, standing on its floor, while the world's wait outside.
- **The yard instance in the training yard's layout.** You come in facing the dummy, with five
  slimes about it, as the offline yard has them. So the rules tests moved onto the yard instance
  with nothing changed but their address: 77 of 78 at once, the last (the goblin war-band) now the
  goblin camp's. Most yard specs moved too.
- **Left of R10.11**, after the skill tree by id: the hotbar's health bar and three skills specs
  (the yard's 30 practice points and the build it kept, where a developer zone gives the whole tree
  and a life); `?test` alone becoming the world; the flat yard's code gone.
- **The world's clock (R10.17).** Every game numbers its ticks from the world's epoch, so a tick is
  the same moment in every channel and copy, and a browser's timelines run on across moves and
  restarts. The ids wait for the wire for crowds and land (R10.8, R10.21), which change what they
  are.
- **`docs/architecture.md`**: the map of the pieces, a game online and offline, the client's areas
  and content's ids.
- **A slip:** the clock's commit was pushed with the Rust tests and the online specs run, but not
  the TypeScript unit tier; the bible's test wanted the new file named. Fixed in the next commit.

## 2026-11-06: The Skill Tree by Id, the Multi-Server Issue, and Where the Work Stands (R9.5, D20)

- **The skill tree by id (R9.5's rest, a background agent; merged in 5d25daa).** The tree, the
  levels, the tests and the balance harness name weapons, abilities and movement skills by id. So
  `content/weapons/_order.json` and the abilities' and movement skills' orders can change freely,
  but for the order things are listed in, and the golden player and crowd scenarios, which hold
  builds by place as the wire does and are kept anew after a change of order. A new character's
  build now holds the weapon Sword Training grants, where the engine's held the first in the list.
  No golden answer moved, and the balance harness writes the same byte for byte. What's left of
  R9.5: a new weapon still needs code for its moves, films and attachments.
- **The multi-server part is GitHub issue #4 (D20).** It covers R10.2, R10.8, R10.19, R10.22, R10.23
  and R10.24, with R10.17's wire handles and R10.12's stress test. It ships as its own update to
  `beta` after this refactor's merge.
- **Where it stands.** `refactor/first` is pushed with everything in it, and `beta` is untouched and
  not ahead of it. The checks on the merged branch:
  - `npm run check` passes: 263 TypeScript tests, and the engine's 181, the order test's 5, the
    WebAssembly's 4 and the server's 81.
  - The conformance tier passes.
  - The whole integration tier: 201 passed, 2 failed. One is the pointer-lock test, which always
    fails on macOS. The other, `yard.spec.ts:67`, counted the yard's spawn entries rather than the
    creatures they bring once the yard took the old yard's layout (c4904b1, after which only
    `admin.spec.ts` had been rerun). It's fixed, and the yard spec passes (4).
- **Next, in order:**
  1. **R10.11's rest.** Four specs still open the flat yard:
     - `hotbar.spec.ts:77` looks for health over the hotbar, which shows only where you have no
       life, so it shows nowhere once the flat yard goes;
     - `skills.spec.ts:51`, `:122` and `:302` count on the yard's 30 practice points and the build
       it kept, where a developer zone gives you the whole tree and a life.

     Then `?test` alone becomes the world (drop `?world`, `?yard` and `?goblins`,
     `src/app/options.ts`), and the flat yard goes: `yard.rs`'s layout, `Ground::Flat`, the yard's
     practice (`src/app/yardPractice.ts`), its drawing in `src/render/scene.ts`, and `SKILL_POINTS`.
  2. **Phase 10's open foundations:** R10.21 (land and the ledger), R10.20 (the server's tiers),
     R10.17's ids, R10.14 (the words) and R10.16 (regions grown and dropped by need). They're bigger
     than first priced. Narrow versions come to about 12 to 15 hours; as the tracker writes them,
     about 25, with taxes and demolition, a coin ledger, shared weather and a thread per simulation.
  3. **The close-out:** R13.1, R13.3, R13.6 and R13.7, then the merge into `beta` (R13.8, with
     R6.14's look check), which waits for the go-ahead.
- **Running the tests elsewhere.** Use the private rig (`docs/testing.md`), and run one Playwright
  suite at a time. Rebuild the server after a content change, since the content's hash is in its
  welcome. `ui.spec.ts:377` (pointer lock) fails on macOS anyway, and the battlefield's Healing
  Circle test can fail under load and pass alone.

## 2026-11-06, Evening: Finishing, With the Multi-Server World (D21)

- **The user's word, on Windows again:** finish the refactor including the multi-server support
  (GitHub issue #4, which D20 had put after the merge), with as many sub-agents as it needs, and as
  fast as it can go. Recorded as D21. How the work is split: [finish.md](finish.md).
- **Picked up** at the Mac's last commits (5d25daa, 83d60a1, merged in f3dfc8a). On this machine
  `npm run check` passes (263 TypeScript, 181 engine, 81 server tests), the conformance tier too,
  and the integration tier ran 202 passed with one failure, the yard spec's count, which both
  machines fixed the same way.
- **Nine workstreams** run side by side, each on a branch and worktree of its own with its own ports
  and database. Each commits as it goes and keeps a running report in
  `.plans/refactor/reports/<id>.md` (on its branch until merged); this page rolls them up.

### Workstreams

| Workstream | Tracker | State | Latest |
|---|---|---|---|
| tiers | R10.20, R10.2, R10.17's ids | merged (9cbe98f) | The server in tiers in one process: a gate, simulations (a thread per region channel and instance copy), a store, a social tier and a directory, joined only by crates/world-api's messages; writes fenced by characters.epoch; global EntityIds. A sim's tick with 64 bots 1.71 ms before, 0.27 ms after; 1,024 bots 45.3 to 5.3 ms (2.1 stepped all at once) |
| bigworld | R10.23, R10.16's rest | merged (1415807) | Regions grown by need and dropped, the same to the bit; the page grows regions in a Web Worker ahead and drops them behind, its origin moving with you (a region 102 km out drawn precisely), assets by region, a World Map; farms in their region's climate; the fixture world crossed in Rust on foot, swimming, gliding and by cart with a passenger |
| offline | R10.11, R10.4, R10.10's rest | merged (1f7a2a5) | ?test alone the world, every test off the old options; the flat yard and world.rs's battlefield layout gone, respawn from data; the hit pause and aim assist as instance practice rules (offline only: online unchanged, as the server can't pause a shared world for one blow); the 11 golden player scenarios moved on purpose into the battlefield instance, the balance output byte for byte the same. The whole integration tier passed on its rig before the tiers landed (203) |
| wire | R10.8 | merged (a6aec8d) | Sims pack a Frame once a tick into the cells; the gate's encoder per connection writes binary deltas within a 64 KB/s budget; the browser plays on them; far peers as crowd bodies; a slow connection gets only the newest tick; WORLD_PROTOCOL 13. A connection's tick with 64 bots 1,443 B (was 43.5-44.4 KB of JSON); 1,024 bots 3,982 B; writing an update 0.03-0.19 ms a connection |
| land | R10.21 | merged (5aa30cb) | Land in tables of its own (space and chunk, owner, epoch, ids from the database), the same in every channel; a life saved a second after it changes; one authority per piece at a time (lent to its owner's life while they play, carried across a border; afterwards the first take wins); plots claimed once in the world; taxes and 14-day demolition, never while the owner plays; trades, purchases, payouts and pots as idempotent ledger transfers; one world market; old saves moved into land rows as the server starts. 456 Rust tests with the store's 7 against Postgres |
| borders | R10.19 | merged | Its last round stopped at the user's word; the gaps it listed are in end-pass.md, fixed here at the end |
| channels | R10.22 | merged (ba5f4d0) | The directory places everyone by the policy (arrivals together fill channels in turn), opens a channel past the soft cap (1,000), warns and moves a quiet channel's players and closes it; changing channel refused with a pack, in combat, riding, in the air, at a table or within the cooldown; a party invitation moves you to your leader's channel; the Channels window; migration 0020 drops home_channel; WORLD_PROTOCOL 12. Server tests 95 (a 150-bot crowd against the real directory; ten arrivals at once; changes, invitations and merges on real sims) |
| multiserver | issue #4, requirement 6 | merged | Roles, one post over TCP links, Postgres leases, the instance pool, fenced writes, npm run cluster. Its last round stopped at the user's word; handoffs across processes and the channel guards are in end-pass.md, fixed here at the end |
| scale | R10.24 | first half merged (a797e74); second half after the rest | The load harness (npm run loadtest), the browser among 0-256 bots, and the baseline before the tiers: ~100-120 real players a server, 512 bots with one client watching, the JSON updates the limit, not the rules. Found for others: outboxes bounded by count not bytes (to wire), arrivals racing for a channel (to channels), a backlog of inputs draining at one a second (for the end pass), a quadratic bot-name lookup (to wire) |
| words | R10.14 | last, once the rest are in | |


### Beta's Saves, Tried on a Copy

At the user's word, beta's database was copied (read-only, through a TCP proxy on beta's Postgres
that was made for the minute the dump took and deleted after; nothing written there) and restored on
this machine. Its 11 characters, two of them played for real (one with a cottage, four vehicles, 19
kinds of things in the bag and 19 quests done), were taken up by the server as `refactor/first`
stood after the channels and the wire (19b2630): the tiers' and channels' migrations ran, both real
builds were kept anew by id ("kept 2 builds by id"), and every character came in, welcome and
ticks, with nothing lost: the same coins, bag and quests, the cottage on its plot with what it
stores, the vehicles and the claim. The land migration is tried the same way once land is merged.
The copy stays on this machine only, in `scratch/` (never committed), and goes once the merge is done.

With land merged (8f3d419), beta's copy was restored afresh and taken up again: every migration
applied in order (0001-0004, 0010-0014, 0020, 0030-0031), the builds were kept by id, and the land of
9 saves moved into rows ("8 pieces, 1 plots claimed; 0 houses moved to a free plot, 0 taken down").
All 11 characters came in, welcome, ticks and binary updates, with no error and the same coins, bag
and quests; the one with a cottage has it lent back to their life as they come in, with what it
stores, their farm and its sheep, a pack on the ground and four vehicles, and their plot's claim.
