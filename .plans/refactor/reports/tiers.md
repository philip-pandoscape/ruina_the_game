# Workstream: tiers

R10.20 (the server in tiers, in one process, joined by `crates/world-api`), R10.2 (a simulation for
each region channel and instance copy, found by id), R10.17's ids, a thread per simulation, social
and directory out of the games. Branch `refactor/tiers`, worktree `C:\GitHub\games\ruina-wt-tiers`,
slot 1 (Postgres `ruina-wt-tiers-db` on 5481, world server 7872, `PW_PORT=5262`,
`TEST_PORT_OFFSET=110`).

The summary first; the running log, dated, after it.

## What Landed

```text
browser ─WebSocket─▶ gate ──Inputs, Ask──▶ sim (a thread for each region channel and instance copy)
                      ▲  ◀── Tick(Arc<TickOut>): records by 32 m cell, private state per player ──┘
   directory: claims (character epochs), routes between spaces, copies and their owners, leases
   store: lives, builds, residents; every write fenced by its character's epoch
   social: parties and invitations; told who's online and where by the directory
```

| Commit | What |
|---|---|
| fb87743 | Global ids in the engine (`crates/engine/src/ids.rs`): `EntityId`, a kind in the top 8 bits (character, bot, creature, placed) and a number below. `combat.rs`'s `Players` keyed by `EntityId` (no `character as u32` inside the engine or the server); a creature numbered by spawn and generation (`actors.rs`: the low 16 bits the spawn, the generation above, bumped when the spawns come round, where numbers used to wrap and be reused). Golden answers and the battle's hash unchanged |
| b5df031 | The moves alone: `play/socket.rs` → `gate/socket.rs`, `combat.rs` → `gate/encode.rs`, `play/mod.rs` → `sim/mod.rs` (bots, channels, clock, stepping, tables beside it), `play/spaces.rs` → `directory/mod.rs`, `play/parties.rs` → `social/parties.rs`, `db.rs` → `store/db.rs` (`.plans/refactor/moves.tsv`) |
| 86d6055, 1e20d92, 7beee2d | `crates/world-api`: ids, the post (`Address`, `Message`, `Envelope`, `Reply`, `Answer`, `Transport`), input bytes, a tick's records, every tier's messages |
| e7c28bd | The server on its tiers (below), migration 0004 |
| a7d1a83, 31af399, f7e134c | The tiers' tests; the bible follows the files |
| 99f90c5 | For the multi-server version's second half: `TickOut::lease`, `Post::set_remote`, `start.rs` in parts |
| e951352, 7157b0d, 2014767 | `crates/server/AGENTS.md` (+ CLAUDE.md), the guides (architecture, world, engine, admin, AGENTS.md's row, world-api's AGENTS.md); the slow simulation's test made steady |
| 8a41626 | refactor/first merged (only `design/status.json` conflicted: theirs, with the moved paths rewritten) |

**The server's pieces now** (`crates/server/AGENTS.md` has them all):

- `post.rs`: world-api's `Transport` in one process: a mailbox for the store, social, the
  directory, each gate and each simulation (std channels for simulations, which wait for mail with a
  timeout while idle; tokio's for the rest). `send` hands the message back if nobody's there
  (`transfer` gives back the player it carried, who is put back). Addresses not held here go to
  `set_remote`'s transport.
- `gate/`: `socket.rs` the WebSocket and `way_in` (the directory's `Claim`, the store's
  `LoadLife`, the simulation's `Arrive`, the home channel's `Estates` when arriving in a copy), then
  inputs and asks to the simulation the connection plays in now (it learns of moves from `Moved`),
  parties to social; its `Seat` departs, releases and closes however it ends. `mod.rs` the gate's
  task (who is connected, by character and session, and where each plays; ticks fanned out as one
  `Arc`; answers to its questions) and `stop_world` (updating, `SaveAll` through the directory,
  1012). `encode.rs` builds a connection's update from a `TickOut` and its `Private`, and encodes
  every `ToConn`: the one place the JSON lives, two functions for the wire to swap (`tick`,
  `message`).
- `sim/`: `mod.rs` the game of one space (`Game::channel(sim, region, n)` found through the world's
  map; `Game::copy(sim, instance, n, owner)`, its lives the region's its door stands in), its outbox
  (`said`, `writes`); `host.rs` its thread: mail drained at each tick's boundary, 20 ticks a second
  while anyone's in it or a mini-game goes on, `Route` to the directory and `Transfer` on its
  answer, `Returned` when a copy is full, mail for whoever left sent on for 30 s, the copy's sweep
  (whoever doesn't belong warned, then routed home), occupancy to the directory, a panic in a tick
  caught; `publish.rs` a tick's records.
- `store/`: `Db` (Postgres, or the same tables and rules in memory: `memory.rs`), `load_life`,
  `residents`, `write_lives` (`WHERE id = $1 AND epoch = $2`, several in one transaction),
  `write_build`; the store's task takes its messages in order.
- `directory/`: claims (`grants.rs`: one statement bumps `characters.epoch`, sets `live_session`
  and `last_played_at`, gives the home channel), the arrival space (the copy they were in if it's
  still running and theirs, else home), `ensure` (a simulation started for a space under a lease,
  with its region's chunks), routes (a copy found or made for their owner; home; each a bumped
  epoch), `Placed`, occupancy, parties and copies handed between owners, copies closed `COPY_KEPT`
  empty with nobody on the way in, leases renewed every 2 s (`leases.rs`, a trait).
- `social/`: parties and invitations; who's online, through which connection, where (from the
  directory); each party's copies; party views; `Parties` changes to the directory.
- `start.rs`: `start` (every tier), `services`, `gate`.

**Migration 0004**: `characters.epoch BIGINT NOT NULL DEFAULT 0`, `characters.space TEXT`,
`CREATE SEQUENCE copy_numbers`. No `space_leases` and no `sim_ids` sequence: the multi-server
workstream's 0030 creates those (the orchestrator's call); one process keeps leases in memory.

## Numbers

The battlefield's bots, `cargo test --release -p ruina-server tick_time -- --ignored --nocapture`,
this machine (i9, nine workstreams running; one admin connected, receiving every update):

| Bots | Before: the rules + the updates (one world thread) | After: the simulation's tick (rules + records) | After: the gate's update for the admin | Update |
|---|---|---|---|---|
| 64, one after another | 0.27 + 1.44 = 1.71 ms | 0.26 + 0.02 = 0.27 ms | 0.08 ms | 44.0 KB |
| 64, all at once | 0.42 + 1.41 = 1.84 ms | 0.57 + 0.03 = 0.60 ms | 0.13 ms | 44.0 KB |
| 256, one after another | 1.54 + 7.46 = 9.00 ms | 1.15 + 0.08 = 1.23 ms | 0.36 ms | 171 KB |
| 256, all at once | 2.08 + 8.31 = 10.39 ms | 0.87 + 0.10 = 0.96 ms | 0.37 ms | 171 KB |
| 1024, one after another | 8.05 + 37.21 = 45.26 ms | 4.84 + 0.43 = 5.27 ms | 1.25 ms | 670 KB |
| 1024, all at once | 3.97 + 31.39 = 35.36 ms | 1.71 + 0.37 = 2.07 ms | 1.11 ms | 670 KB |

The split costs nothing: a simulation's tick builds its records once (typed copies, no JSON), and
the JSON moved to the gate's connections on tokio's threads, written by serde from typed records
where `json!` built `Value`s, so the admin's update is 17 to 30 times cheaper than before, and off
the simulation's thread. (The rules' own numbers vary run to run with the machine's load.) The
bytes sent are what they were (64 bots: 44.0 KB; the M4 baseline said 42.9 KB): the wire workstream
cuts those.

`npm run check` passes after the merge: 263 TypeScript tests; the engine's 183 (181 + the ids' 2),
the order test's 5, the WebAssembly's 4, the server's 90 (81 before; the spaces' 17 rewritten on the
tiers, and new ones), world-api's 6. The Postgres fence test passes with
`RUINA_TEST_DATABASE_URL=postgres://ruina:ruina@127.0.0.1:5481/ruina`.

## Decisions, and Why

- **One simulation per space, a thread each.** A channel or a copy is a `Sim` on its own OS thread
  (`sim-<id>`), which owns its `Game` alone. Idle ones (nobody in, no table) block on their mailbox
  with a 1 s timeout, so an empty copy kept 30 minutes costs nothing. Rayon's pool (`--parallel
  on`) is shared by them.
- **The entity id lives in the engine** (`ruina_engine::ids::EntityId`) and world-api re-exports it:
  the engine keys its players by it, and world-api depends on the engine (messages carry `Command`,
  `LifeState`, `Player`), so the engine can't depend on world-api.
- **Creatures by spawn and generation without moving the goldens**: the number's low 16 bits are the
  spawn counter as before, the generation is new bits above it (capped at 14 so an arrow's hit list,
  which marks creatures with bit 30, stays right). Below 65,535 spawns nothing changes.
- **Bots** are `EntityId::bot(sim, n)`; the rules still know them by their old negative `owner`
  number (`FIRST_BOT - n`), and the gate sends that number to the browser (`encode::wire_id`), so
  the browser sees what it saw. The wire workstream replaces that with handles.
- **A character's epoch is bumped by every grant**: each claim (a new window) and each move between
  simulations (the directory's `Route`), so whatever held them before can't write. A life written by
  a simulation whose player left while a route was pending is held until the directory answers, then
  written under the new grant (`host.rs`, `held`).
- **`live_session` stays written** (it says which session holds a character) but writes check
  `epoch`. A build's write is the simulation's now (`ToStore::WriteBuild`), fenced the same way; a
  refused one is logged (the takeover itself is the directory's `Kicked`).
- **Leases behind a trait, in memory** (`directory/leases.rs`): grant bumps the space's epoch and can
  fail; renew finds the lost ones (the simulation hears `LeaseNote::Lost` and, in one process, says
  so and carries on: stopping is the multi-process behaviour, for roles); release; owner; next_sim.
  The table is multiserver's (0030).
- **Parties live in social's memory**, as before (a restart ends them). Social learns who's online,
  where and through which connection from the directory (`Online`, `Offline`, `Placed`, `Copy`,
  `CopyClosed`) and keeps its own view; it tells the directory every change (`Parties { changed,
  hand }`), which passes each simulation its part in one message, so a copy's owner and its players'
  parties are never seen half changed.
- **Mini-game challenges and tables stay in the simulation** where both players are: a challenge
  needs them within a few metres (one space, one simulation), a seated player can't leave (not
  free), and a pot's two lives go to the store in one transaction. Across a border (borders' work)
  the table would be the challenged player's simulation's, with the other's handoff held.
- **Request and answer** go as addressed messages: a connection's way in waits for its own
  `ToConn` replies (keeping whatever else comes, delivered after the welcome); the gate's questions
  (`IsPlaying`, `SaveAll`) carry a `Reply { to, id }` answered with `Answer`.
- **The gate routes a connection's mail by (character, session)** and ticks by the simulation it
  plays in now (from `Claimed` and `Moved`), so a replaced window still hears `Kicked`, and a tick
  from where someone was a moment ago is dropped (the connection checks too).
- **The deploy path**: `stop_world` tells every connection `updating`, asks the directory to have
  every simulation write everyone's life (`SaveAll`, answered once the store has written them all),
  prints "saved N islands", then closes with 1012. update.spec.ts passes.
- **A copy's region** is the one its door stands in (`zone_at(door.outside)`), not `emberholm()`.
- **The tick rate** is world-api's (`TICK_HZ`); the bible reads it there.

## What's Left

- **Wire's second half**: binary records, handles per connection, interest tiers. `TickOut::cells`
  is the JSON path's; `gate/encode.rs` is where the encoding swaps (`tick`, `message`). The entity
  records (`PresenceRecord`, `CreatureRecord`, `ArrowRecord`, `MeteorRecord`, `EffectRecord`) go
  when wire's packed cells replace them; `Private` and `TableRecord` stay (the orchestrator's note).
- **Land**: lives still carry estates; `store` keeps `load_life` and `write_lives`, the simulation
  takes a life up in `sim::load_island` and puts it away in `sim::island_of` (both in
  `sim/mod.rs`), and a channel's residents come from `ToStore::LoadResidents` → `ToSim::Residents`.
- **The browser-facing ids** are still character ids, bots' `FIRST_BOT - n` and creatures' numbers
  (`encode::wire_id`).
- **Production `emberholm()`**: none in the server; `crates/engine/src/session.rs` (offline's) and
  `crates/engine-wasm/src/lib.rs` (bigworld's) still call it.
- **The offline workstream's 065687b** (Players' step without a World) isn't on refactor/first yet:
  merging it will touch `sim/mod.rs` (the `world` field and `step_by`'s arguments), small edits.

## For the Next Workstreams

- **Messages**: `crates/world-api` (its AGENTS.md lists them). Add variants and fields; the shapes
  others built on are noted here when they change. Changes since the first cut (86d6055):
  `ToSim::Inputs { conn, inputs }` and `ToSim::Depart { conn }` (were character and session);
  `ToSim::Parties { changed, owner }` and `ToDirectory::Parties { changed, hand }` (were `PartyOf`,
  `Owner`, `HandCopies`); `ToConn` is `Clone`; `Transport::send` returns `Result<(), Message>` and
  `transfer` gives a player back; `LifeWrite::writer: Option<Writer { sim, space, epoch }>`;
  `TickOut::lease`.
- **The transport**: `Transport` (world-api/src/post.rs). In one process `crates/server/src/post.rs`;
  `Post::set_remote(Arc<dyn Transport>)` sends what isn't held here through another (crates/link).
- **Borders**: a simulation knows its chunks (`Lease::chunks`, a region's channel all its region's).
  Ghosts, handoffs and events across a border are new `ToSim` variants; a handoff is a `Transfer`
  (`Moving` already carries the player whole, `Carried` serializes as their state), granted by the
  directory under a new epoch as a portal's is today (`Route`). Inputs for someone handed on are
  already sent on (`host.rs`, `gone`), by connection.
- **Channels**: the directory gives homes (`grants::claim`, the first channel with room) and starts
  a channel's simulation on first need (`Directory::ensure`); placement by affinity goes there, the
  social tier can say who a character's party is (`Social::parties`), and a new channel is a new
  `SpaceId::Channel { region, n }`.
- **Land**: the store tier (`store/mod.rs`) is where land's tables are read and written; a write
  carries its writer's lease (`LifeWrite::writer`), the directory's grants and leases fence it; the
  simulation's hooks are `load_island` and `island_of`.
- **Multiserver**: roles from `start.rs` (`services`, `gate`; simulations through a `Spawner`, which
  the directory takes); `Leases` (the trait) for its Postgres table; `Post::set_remote` for its
  links; `TickOut::lease` for the gates to fence ticks by. The directory is one task today;
  `ToDirectory` is all it's asked through. world-api's JSON is self-describing (`Value` inside some
  messages, `skip_serializing_if`, tagged enums): its codec between processes is too.
- **Scale**: a simulation can't block the gate or another simulation
  (`a_slow_simulation_holds_up_nobody_else`); the gate's tasks only forward. `tick_time` prints the
  simulation's and the gate's parts apart.

## Log

## 2026-11-06 21:10: the ids, the moves, and world-api's first cut

- **fb87743** Global ids in the engine: `crates/engine/src/ids.rs` (`EntityId`: kind in the top 8
  bits, number below; characters by database id, bots by simulation and count, creatures by spawn
  and generation). `combat.rs` `Players` keyed by `EntityId` (no more `character as u32` inside);
  creatures' numbers wrap into a generation (the low 16 bits the spawn) instead of reusing numbers.
  Golden answers and the battle's hash unchanged (183 engine tests, 81 server tests).
- **b5df031** The moves: `play/socket.rs` → `gate/socket.rs`, `combat.rs` → `gate/encode.rs`,
  `play/mod.rs` → `sim/mod.rs` (with bots, channels, clock, stepping, tables in `sim/`),
  `play/spaces.rs` → `directory/mod.rs`, `play/parties.rs` → `social/parties.rs`, `db.rs` →
  `store/db.rs`; in `.plans/refactor/moves.tsv`. Paths rewritten by `tools/refactor/moves.mjs` (the
  content's comments too, so `shared/hash.json` was made again).
- **86d6055** `crates/world-api` first cut: ids, the post (`Address`, `Message`, `Envelope`,
  `Transport`, `Reply`, `Answer`), input bytes, tick records by cell and private state, and every
  tier's messages. 6 tests (a player and their life carried through text whole). The engine's `Mode`
  and `V3` got serde derives (player.rs, a small change).
- **Measured before** (release, `cargo test --release -p ruina-server tick_time -- --ignored`, the
  base 763d6af): 64 bots 0.27 ms rules + 1.44 ms updates a tick; 256 bots 1.54 + 7.46 ms; 1024 bots
  8.05 + 37.2 ms one after another, 3.97 + 31.4 ms all at once. The updates (JSON for one admin's
  connection, built on the world thread) are most of it.
- **Next**: the in-process post, the store (fenced writes, Postgres and memory), the directory
  (claims, routes, copies, leases in a table), social (parties), the sims on threads publishing
  records, the gate building updates from cells; migrations 0004+.
- **For the other workstreams**: world-api's shapes are the ones to build against; changes from here
  are noted below. Ghosts, handoffs and events across borders are not in it yet (borders adds them
  to `ToSim`); placement by affinity is not either (channels adds it to `ToDirectory`).

## 2026-11-06 22:40: the server on its tiers, tested, and the online specs green

- **1e20d92, 7beee2d** world-api: inputs and departures carry their `Conn`; parties reach the
  directory and each simulation as one message (`ToDirectory::Parties`, `ToSim::Parties`); the
  entity records by cell are the JSON path's (the wire's packed cells replace `TickOut::cells` later;
  `Private` and `TableRecord` stay).
- **e7c28bd** The server on its tiers. `crates/server/src/`: `post.rs` (world-api's `Transport` over
  channels), `gate/` (the way in, inputs and asks routed to the simulation a connection plays in now,
  updates built per connection from the tick's records: `encode.rs`), `sim/` (`mod.rs` the game,
  `host.rs` its thread, `publish.rs` its records), `store/` (fenced writes; Postgres or memory),
  `directory/` (claims, routes, copies, occupancy, `leases.rs` behind a trait, `grants.rs` the
  characters' epochs), `social/` (parties), `start.rs`. Hub, Spaces and the world thread are gone.
  Migration 0004: `characters.epoch`, `characters.space`, `copy_numbers`. No `space_leases` table:
  the multi-server workstream's 0030 has it (the orchestrator's call); one process keeps leases in
  memory behind `directory::leases::Leases`.
- **a7d1a83, 31af399** The tiers' tests (`crates/server/src/tests.rs`, 16): every old spaces test on
  the tiers, plus a second window under a newer grant, inputs following a player into their copy, a
  party across simulations, 20 ticks a second; a slow simulation holds up nobody else
  (`sim/host.rs`); the fences against Postgres (`directory/grants.rs`, with
  `RUINA_TEST_DATABASE_URL`).
- **99f90c5** For multiserver's second half: `TickOut::lease`, `Post::set_remote` (addresses not held
  here go through another transport), `start.rs` split into `services` and `gate`.
- **Ran**: `cargo test` (server 90 + world-api 6 + engine 183, goldens and the battle hash
  unchanged); against the rig (7872, PW_WORKERS=3): online (21), party (3), dungeon-way-in, minigames
  (2), travel (7), online-combat, battlefield (15), admin (5), update (5, alone) pass; yard.spec.ts:67
  fails (it counts the yard's spawn entries, 2, where c4904b1 made them 6 creatures; the same on
  refactor/first, to confirm).
- **Next**: the tick-time measurement after, the docs, `npm run check`, merging refactor/first.
