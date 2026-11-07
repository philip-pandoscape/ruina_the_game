# Inventory: the test suite (2026-11-05, beta d49c3b8)

Surveyed read-only before the refactor. Numbers are counts of `test(...)` cases in each file.

**Bottom line:** 395 tests in 41 spec files. **104 already run in Node with no browser** (Playwright
only starts a browser for a test that asks for `page` or `browser`; these import `src/` directly, 60
of them through the Rust check binaries), yet each waits for the Vite web server to start. About **82
more** could run in Node with a headless game harness (the rules without drawing), and about **64
more** with a three.js harness that has no WebGL renderer. So about 250 (63%) can become unit tests,
186 (47%) with only the first two, cheaper steps. All **182 Rust tests** are pure unit tests.

## Every file

Legend: **N** Node, no browser · **B** the game page · **H** a gallery/harness page · **Bs:port** a
battle server from `tests/testServer.ts` · **W** the world server and Postgres on :7777 (`npm run up`)
· **R:bin** a Rust check binary · **V** a Vite dev-server plugin.

| File | Lines | Tests | Tags | Needs | What |
|---|---|---|---|---|---|
| ai-conformance | 335 | 17 | – | N, R:aicheck | 5 behaviours x2, plus 7 packs |
| animation | 600 | 23 | 2 @gpu | H `/animations.html`; 1 N; 2 B `?world&test` | hero pose, gait, IK |
| bugreport | 283 | 3 | 2 @gpu | B `?world&test&bugs`, V `/__bugs`, `tools/bugs.mjs` | bug reporter |
| combat | 374 | 10 | 2 @gpu | B `?yard`; Bs:7794 | marks, damage numbers, aim circle |
| conformance | 344 | 11 | – | N, R:simcheck | 11 builds, player sim |
| creatures | 129 | 7 | – | H `/creatures.html` | rig structure |
| design | 63 | 2 | – | B `/design/` | design pages |
| dungeon-way-in | 243 | 4 | – | B `?world&test`; 1 N | falls, portal |
| game | 328 | 8 | – | B `?test` (yard, paused) | jump, slide, combo, pad, perf |
| goblin | 226 | 8 | – | B `?yard&test` | goblin AI |
| hotbar | 356 | 13 | – | B `?yard` (runs live) | sprint, crouch, slots, MP |
| input | 105 | 3 | – | N (stub window) | key mapping |
| library-review | 80 | 1 | – | H; skipped unless `REVIEW` is set | pose corrections |
| library | 153 | 3 | – | H `/library.html`, V | animation library |
| life-conformance | 594 | 14 | – | N, R:lifecheck (13) | island life rules |
| look | 156 | 5 | 5 @gpu | B `&look=` | 20 scenes x2 looks, GPU ms |
| minigames | 339 | 2 | 1 @gpu | W, 3 windows | Beacons online |
| models | 212 | 16 | – | H `/models.html` | triangle budgets, anchors |
| movement | 426 | 19 | – | B `?yard` | dodge, guard, slide |
| net-actors | 260 | 7 | 2 @gpu | Bs:7791 (600 bots); 1 N | monsters streamed |
| net | 126 | 2 | 2 @gpu | Bs:7793 (10k bots) | battle drawing |
| online-combat | 124 | 1 | @gpu | W | island slimes online |
| online | 672 | 21 | 1 @alone | W (+ API requests) | accounts, channels |
| party | 150 | 3 | – | W, 2 windows | parties, dungeon copies |
| progress | 104 | 6 | – | N | points, levels |
| pvp | 182 | 4 | 3 @gpu | Bs:7792 (2k bots) | PvP, 300 ms lag |
| raid | 74 | 2 | 1 @gpu | B `?raid=N` | crowd fps |
| retarget | 55 | 5 | – | H `/retarget.html` (GLB) | clip retargeting |
| sea | 54 | 2 | 1 @gpu | 1 N; 1 pixel test | sea tiles, foam |
| skills | 611 | 15 | 7 @gpu | B; 9 on Bs:7795 | tree, book, casts |
| skilltree | 336 | 25 | – | N (+R:balance for 1) | skill sets, modifiers |
| slime-pack | 433 | 18 | – | B `?yard&test` | pack AI |
| slime | 165 | 7 | – | B `?yard&test` | slime basics |
| species | 304 | 30 | – | H `/species.html` | crowd baking |
| terrain | 90 | 2 | – | N, R:terraincheck | island bake, ground parity |
| travel | 489 | 11 | – | 3 N; 7 B; 1 W | roads, auto-run |
| ui | 499 | 10 | – | B, DOM | Title Case, bag, minimap |
| update | 225 | 4 | 4 @alone | own server :7786 + DB + own Vite :5290 | deploy, restart |
| village | 149 | 4 | – | 2 N; 2 B | building plans, inn |
| world-conformance | 761 | 17 | – | N, R:worldcheck | traversal |
| world | 1408 | 30 | – | B `?world&test` | open-world features |
| testServer.ts | 48 | – | – | spawns the release server binary | helper |

Totals: 395 tests, 29 @gpu, 5 @alone. 23 need a battle server, 28 the world server and its
database, 4 a server and database of their own.

## Classification

**Already Node (104): only the runner changes.** skilltree 25, ai-conformance 17, world-conformance
17, life-conformance 14, conformance 11, progress 6, input 3, travel 3 (road network, routes,
off-road destination), village 2 (plans fit, rules wall), terrain 2, and one each in sea (tiles),
dungeon-way-in (falls cut), animation (prediction clock) and net-actors (ActorTimeline).

**With a headless game harness (~82)**: `Sim`, actors, the training range, `Life` and `makeZoneWorld`
in Node (the rules half of `stepOnce` and the rules-side `__game` methods):
- movement: all 19. goblin: all 8. slime-pack: 16 of 18 ("winds up, leaps, slams" reads HUD markers:
  assert on events instead). slime: 6 (all but "looks right").
- hotbar: 6 (sprint/crouch speeds, sprint needs stick, crouch eases, eight slots, MP paid, empty slot;
  "a build saved before the hotbar" too once its migration function is pulled out).
- game: 3 (jumps, slide vs run, three-hit combo). skills: 1 (training yard: arrows, Meteor...).
- world: 20 (stand on island, cliffs, swimming, glide, farming plot, pack running, farm cart,
  roadster, boats, mounts, housing, combat on hills x2, ledge climb, shipyard, livestock, contracts,
  storms, glider gust, sloop/donkey/cog; their screenshots are only for a person to look at).
- dungeon-way-in 2 (glide into falls, summit drop), travel 1 (farm cart).

**With a three.js harness without a renderer (~64)**: the harness modules create a `WebGLRenderer`
when imported, so they need splitting first.
- animation: 20 gallery tests (the file says "No GPU needed"). species: 24 (not the 3 "renders" or the
  3 "three calls" tests, which read `renderer.info`). creatures: 6. models: 14 (9 budgets, crop/prop
  instancing, anchor, mount, deck and pack checks).

**Integration (134)**
- In the browser: game load/pad/keyboard (4), hotbar HUD/keys/pad (7), combat (10), skills UI (5),
  ui (10), world (10: loads, flare, plot circles, quests, stone and timber, quest log, merchant,
  panels, saving, full bag), travel (7), village (2), slime-pack (2), one each in dungeon-way-in, slime
  and creatures.
- Pixels, renderer and tools: species (6), models (2: close-up shots, sea inside the hull),
  library/design/bugreport/retarget (14), animation rowing (2), sea foam (1).
- With a server: net-actors 6, pvp 3, skills online 9, online 21, party 3, minigames 2,
  online-combat 1, update 4.

**Stress (11)**: raid (2; "speed at different army sizes" has no @gpu tag, so CI runs it), net (2,
10k bots), look (5), game "performance snapshot", pvp "bots fight real players". The three-window
tests (minigames @gpu, 5 @gpu skills online tests) could move here too.

## Infrastructure

- Boot by URL (read in `src/main.ts` around lines 95-125): `?test` the training yard paused; `?yard`
  live (tests batch their steps into one `evaluate`); `?world&test` the open world offline and paused
  (`&load`, `&look=`, `&bugs`); `?server=ws://...&team=0|1` a battle (`&play=0` to watch, `&lag=ms`);
  `?raid=N`; `?as=<name>&bugs=0` signs in to the world server.
- `window.__game` (`src/main.ts` ~1615) has 94 members. Most used: `state` ~143, `advance` ~133,
  `life` 47, `reset` 46, `ready` 44, `teleport` 40, `online` 38, `setBuild` 36, `setCamera` 32, `net` 31,
  `lifeCommand` 22+, `combat` 17, `pressLife` 16, `ground` 14, `scriptInput` 13,
  `actors`/`events`/`render` 12, `spells` 11, `zone` 11. Gallery pages expose `__anims`, `__species`,
  `__creatures`, `__models`, `__retarget`, `__library`.
- `tests/testServer.ts` spawns `server/target/release/yggdrasil-server --port P` (moved by
  `TEST_PORT_OFFSET`), polls the port up to 15 s; a file skips when the binary isn't built.
- Ports: Vite 5199 (`PW_PORT`); battle servers 7791-7795 (the README's "7791-7794" is out of date);
  world server 7777 (`RUINA_SERVER`); Postgres 5433 locally, 5432 in CI; update.spec's own server
  7786 and Vite 5290.
- Conformance: `execFileSync(<bin>, {input: JSON})` returns JSON frames to compare (64-256 MB
  buffers). Binaries: aicheck, simcheck, worldcheck, lifecheck, terraincheck, balance. `BAKE=1` on
  terrain.spec rewrites `server/data/emberholm.zone`.
- Moving to Vitest: net-actors starts a 600-bot server even for its Node test; Node tests still wait
  for the Vite web server; `test.skip(cond)` inside a test becomes Vitest's `skipIf`.

## Timing evidence

No JSON or HTML reporter is configured, so no per-test durations are kept (task R0.3 adds one).
Two worktree logs ran with 1 worker:
- `world.spec` (30 tests in 5.8 min): ledge climb **35.2 s**, shipyard 25.2, housing 24.1, merchant
  15.9, quest log 15.5, panels 15.0, stone and timber 14.9, livestock 14.2, saving 12.5, pack running
  11.6, combat on hills 11.1, farm cart 11.0; the fastest 4.0 s.
- 50 tests in 2.9 min: life-conformance (Node) 2.1-14.9 s each, ~104 s in all; world-conformance
  59-360 ms each (~2 s for all 17); dungeon glide 9.8; travel map 6.4.
- Commit 3c0dbd1: each test boots the game in about 4 s; the suite went from ~30 min serial to 12 min.
  Commit 310308c: one CI shard (the long open-world walks) ran past 45 min against ~10 for another,
  because shards split by count, not time.
- Long budgets set in specs: library-review 600 s; retarget 5 x 240 s; library, look, raid, party and
  travel-online 240 s; minigames 180/150 s. Fixed waits: raid 17 s plus 5 x 7 s; pvp 9.3 s; net 8 s.

## Rust

182 `#[test]` functions in 32 files under `server/src`; no `server/tests/`. life/ 87 (vehicles 26,
quests 11, farming 9, trade 8, interact 7, progress 5, contracts 4, content 4, weather 3, mod 3,
housing 3, shipyard 2, livestock 2); world_game/tables 14; minigames 20 (beacons 13, mod 7);
world_game, spaces, skills 8 each; parties 6; characters 5; open/* 10; world_socket, http, channels,
accounts 3 each; player 2; protocol, jsmath 1 each. All pure (`db: None`, no sockets). **ai.rs,
sim.rs, actors.rs and game.rs have no Rust tests**: only the TS conformance binaries cover them, so
they need Rust tests of their own before the conformance specs can go.

## Measured on this machine (2026-11-05)

| Step | Time |
|---|---|
| `cargo test --release` | 106 s, of which running the 184 tests 0.26 s |
| `cargo test` (debug, cold) | 114 s to build, 1.96 s to run |
| `cargo test` (debug) after touching one rules file | 51 s (1.75 s of it running) |
| `cargo check` after touching one file | 9.6 s |
| `cargo build --release` after touching one rules file | 1 min 38 s |
| `cargo build --release` (deps cached) | 3 min 26 s; clean (worktree log) 4 min 35 s |
| `npx tsc --noEmit` (TypeScript 7) | ~12 s |
| `vite build` | 2.8 s (12.8 s with start-up) |
| Playwright, whole suite, 6 workers | ~12 min |
