# Workstream: tiers

R10.20 (the server in tiers, in one process, joined by `crates/world-api`), R10.2 (a simulation for
each region channel and instance copy, found by id), R10.17's ids, a thread per simulation, social
and directory out of the games. Branch `refactor/tiers`, worktree `C:\GitHub\games\ruina-wt-tiers`,
slot 1 (Postgres `ruina-wt-tiers-db` on 5481, world server 7872, `PW_PORT=5262`,
`TEST_PORT_OFFSET=110`).

This file is a running log while the work goes on (dated entries at the end); the summary at the
top is filled in when it's done.

## The Design (as it stands)

```text
browser ─WebSocket─▶ gate ──Inputs, Ask──▶ sim (a thread per region channel / instance copy)
                      ▲  ◀── Tick(Arc<TickOut>): records by 32 m cell + private per player ──┘
   directory: claims (character epochs), routes between spaces, copies and their owners, leases
   store: lives, builds, residents; every life write fenced by its character's epoch
   social: parties and invitations; told who's online and where by the directory
```

- **Messages**: `crates/world-api` (`ToSim`, `ToGate`/`ToConn`, `ToStore`, `ToSocial`,
  `ToDirectory`), all `Serialize + Deserialize`, addressed by `Address` (a sim by `SimId`, a gate by
  `GateId`, a connection by `Conn {gate, character, session}` through its gate).
- **Transport**: the `Transport` trait in `world-api/src/post.rs` (`send(Address, Message)`, with
  typed helpers `sim`, `gate`, `conn`, `store`, `social`, `directory`, `answer`). In one process the
  server implements it over tokio channels (`crates/server/src/post.rs`, to come); a TCP transport
  implements the same trait, carrying `Envelope`s.
- **Epochs**: a character's epoch (`characters.epoch`) is bumped by the directory on every grant (a
  new connection, a move to another simulation); every life write carries it and the store refuses a
  stale one. A space's lease (`space_leases`) has its own epoch, bumped per grant, for land's writes.

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
