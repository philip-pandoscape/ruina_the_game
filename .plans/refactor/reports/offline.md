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
