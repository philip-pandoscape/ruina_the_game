# The Offline Workstream: the World or a Copy of an Instance

The `offline` workstream of the finishing push ([finish.md](../finish.md)): R10.11's rest, R10.4's
rest and R10.10's rest. Branch `refactor/offline`, worktree `C:\GitHub\games\ruina-wt-offline`, slot 3
(Postgres `ruina-wt-offline-db` on 5483, world server 7874, `PW_PORT=5264`, `TEST_PORT_OFFSET=130`).
Started from `refactor/first` at 763d6af.

The goal: the offline game is just the world or a copy of an instance; `?test` alone opens the world;
the tests move off `?yard`, `?test` (as the yard), `?yard&test` and `?world&test`; the flat yard goes
(its layout, `Ground::Flat`, its practice, its drawing, its options), and so does `world.rs`'s
battlefield layout, the spawn point coming from data; the yard's own rules (the hit pause, aim
assist) become engine rules an instance switches on in its file.

## 2026-11-06 20:50: The tests off the old options

- **Landed:** 820cbfe. `?test` alone opens the world, paused; `?test=<instance>` and
  `?offline[=<instance>]` as before; `?yard`, `?world` and `?goblins=` are gone
  (`src/app/options.ts`, its unit test). Every test that used them moved (`?world&test` to `?test`,
  `?yard` to `?offline=yard`, the skills spec's `?test` to `?test=yard`).
- **R10.11's leftovers:** the hotbar spec reads health, MP and stamina beside the portrait
  (`#hud-vitals`), the yard instance giving a life; the skills specs count from a developer zone's
  whole tree (`NODES.length`). A build kept in this browser is held to the points of where you start
  (main.ts and the headless harness), so it survives a reload in the yard.
- **Found on the way:** the hotbar spec's controller pressed for a fixed 60 ms, which the yard
  instance's slower first frames (Emberholm loads behind it) missed: it now waits for the game to
  have stepped twice after each press (three runs of the spec, all passing). The title screen stays
  away for `?offline` as it did for `?yard` (it caught the skills spec's clicks).
- **Ran:** the unit tier (264 passing, with the engine as committed); the hotbar, skills, animation,
  bug report, dungeon-way-in, sea, slime-pack, travel, interface, village and world specs.
- **Next:** the flat yard's code goes (the engine's `Ground::Flat`, `yard.rs`, the yard's practice,
  its drawing, the `openWorld` option); then `world.rs`'s battlefield layout; then the practice rules
  in the instances' files.

## 2026-11-06 22:40: The flat yard and the battlefield layout gone

- **Landed:** 9861ec9 (the flat yard goes), 2cb0255 (rustfmt's order for a moved import), 065687b
  (`world.rs`'s battlefield layout goes; where a player gets back up is data).
- **The flat yard:** the session plays the world from its region's spawn, or a copy of an instance;
  `Ground::Flat`, `yard.rs` (its `SpawnPoint` and `island_spawns` moved to `open/spawns.rs`), the
  Engine's `openWorld` and `band`, the session's `world` call, the yard's practice
  (`src/app/yardPractice.ts`), its drawing (`src/render/scene.ts`), the health over the hotbar
  (`#player-hp`) and `trainedBy` (a TypeScript copy of a rule only the practice used) are gone. The
  Engine always has a life.
- **The battlefield layout:** the player rules step a player only in a world (`open::step_player`);
  the world says where they get up (`OpenWorld::spawn_point`: a copy's arrival, else the region's
  spawn). The flat step (`Player::step`, `integrate`, `collide`), `Players::join` and `step` on a
  flat `World`, and `World` itself are gone; `Players::step_in`/`step_by` take the world,
  `Players::join_at` seats a player without an island. Server edits forced by it: `ChannelGame`
  loses its `world` field and its step calls their `World` argument (`play/mod.rs`, `bots.rs`,
  `tables.rs` tests), and `spawn_all` takes `SpawnPoint` from `open::spawns`.
- **Golden answers:** the 11 golden player scenarios moved on purpose: they play in the battlefield
  instance (named in their input), from a spawn moved 80 m north into the arena; the creatures',
  Emberholm's and the crowd's answers and the server's battle hash are unchanged. The balance
  harness fights in the arena its scenario names (`arena`) and writes the same output byte for byte.
- **Ran:** unit tier 263 (one test fewer: `trainedBy`'s); the engine's 181, order 5, WebAssembly 4,
  server 81; clippy, rustfmt, Biome, knip; the balance conformance test; the game, hotbar, combat,
  skills, slime, slime-pack, world, dungeon-way-in, UI gallery, admin, battlefield and online-combat
  specs.
- **Failures seen, not this work's:** `yard.spec.ts:67` counts the yard's spawn entries where it
  should count creatures (fixed on `refactor/first` in f3dfc8a, comes with the merge);
  `battlefield.spec.ts:376` (the interrupted cast, @gpu, two windows racing) passed once and failed
  once alone, the server's rules unchanged. The combat spec's circle tests timed out (2 s) with
  several pages side by side: their waits now allow 15 s, and the left-stick test (`:185`, listed
  among the races under load) waits for frames instead of 500/700/1600 ms; it passes twice over.
- **Next:** the practice rules (hit pause, aim assist) as flags in the instances' files; then the
  docs, the merge of `refactor/first`, and the whole integration tier.
