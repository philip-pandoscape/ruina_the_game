# Workstream: multiserver

The multi-server version (`.plans/world/research.md` 5b; GitHub issue #4, requirement 6): the
world's tiers in processes of their own, finding each other through the directory and talking over
TCP with the messages they pass in one process; leases with epochs in Postgres saying which process
plays what; failure tests. Branch `refactor/multiserver`, worktree
`C:\GitHub\games\ruina-wt-multiserver`, slot 10 (Postgres `ruina-wt-multiserver-db` on 5478, world
server 7881, `PW_PORT=5271`, `TEST_PORT_OFFSET=200`, ports 9100-9199 for the processes its tests
start). Migrations 0030-0039 are this workstream's.

The first half (now) doesn't wait on the tiers: the transport, the leases, the roles' scaffolding,
a harness for several processes. The second half (once tiers and borders land on
`refactor/first`) carries the tiers' messages between processes.

This file is a running log while the work goes on (dated entries at the end); the summary at the
top is filled in when it's done.

## Summary: the first half (2026-11-06, done)

What landed (the log below has each commit's detail):

| What | Where | Commits |
|---|---|---|
| TCP links between processes: once and in order across lost connections, at least once across a restart, back-pressure, requests, faults and a fault proxy; world-api's `Transport` over them (`LinkPost`) | `crates/link` | 9855f9f, fa9f5ea (proxy's cuts counted), c33c546 (links from any thread) |
| The directory in Postgres: `nodes`, `sim_ids`, `space_leases` (epochs), `space_snapshots`; grant, renew, release, owner, the fence; a sim's lease keeper; the processes' heartbeats | migration 0030, `crates/server/src/cluster/{leases,keeper,nodes}.rs` | eb88eca |
| Roles: `--role all\|gate\|sim\|services` (all by default, unchanged), each role's scaffolding and `/api/cluster` | `crates/server/src/main.rs`, `cluster/roles.rs` | eb88eca |
| A harness of several processes: kill a process, cut a link, double what passes, cut a sim off from the directory | `crates/server/tests/cluster.rs`, `npm run test:cluster` | fa9f5ea |
| The guides | `docs/architecture.md`, `docs/deploys.md`, `docs/testing.md` (Several Processes), `crates/link/AGENTS.md` | c33c546 |

The numbers: MessagePack with field names against JSON on world-api's own messages, 17-42% smaller
and read 20-55% faster; 1.38 million small messages a second on one link; ticks' records (28 KB)
at 235 MB/s; a request answered in 70 µs (p50), 196 µs (p99). A killed sim's space taken over in
1.7-2.1 s under the next epoch (2 s leases); a sim cut off from the directory stops 0.4-0.7 s before
another is granted its space.

Checks, after merging `refactor/first` (12b3946, 09cc4aa): typecheck, biome, knip and the Rust
lints pass; the Rust tests 300 passed (17 ignored: measurements and the 13 database tests); `npm run
test:cluster` (the 13, against slot 10's Postgres) green, three runs each before; the TypeScript unit
tier 262 of 263. The one failure is `tests/unit/paths.test.ts`, on five paths that came with the
tiers' 86d6055 (merged here to build against world-api): `docs/engine.md` and `src/net/AGENTS.md`
name `crates/server/src/play/` (moved away in b5df031, there again at the tiers' tip), and
`crates/world-api/AGENTS.md` names `crates/server/src/post.rs` and the tiers' report (both written
after 86d6055). It passes on `refactor/first` and at the tiers' tip, so it goes once tiers lands
and is merged here. Also formatted `tests/unit/bible.test.ts` as biome has it (the same merge had
left it long), and the Dockerfile's dependency layer lists `crates/link` and `crates/world-api`
(checked: that layer's workspace resolves with the committed lock).

## The Second Half

**Where it stands (2026-11-06, 23:05; the log's last entry has it all):** the code is in (b4e8034):
the roles start the tiers, one post over channels and links, Postgres leases behind the tiers'
`Leases` trait, the instance pool, players sent back in when a space is lost, both fences, `npm
run cluster`. It has 11 new unit tests. Handoffs across processes wait for borders' second half.
The integration, cluster and failure runs wait until everything is merged; the log's last entry
lists them for the end agent. Below is the plan as it was written before the tiers landed (kept for
the record; the tiers' side of it is done).

What it does: the tiers' messages over the links between processes; gates routing players to sims
in other processes, re-routing a player's inputs across a handoff by sequence number and buffering
during it; sims exchanging ghosts and handoffs across processes; the directory's leases deciding
which process plays what; an instance pool (sims without spaces standing for the copies the
directory places by load); the failure tests end to end (a sim killed mid-handoff, a message
delivered twice, a lease lost); the online specs against a gate and two sims; a local way to run it
(an npm script or a compose file); `docs/deploys.md` as a service per role.

What it needs:

- **From tiers** (as at `refactor/tiers` f7e134c):
  - **The post.** `crates/server/src/post.rs` (world-api's `Transport` in one process) and
    `LinkPost` behind one post: addresses in this process over channels, the rest over links. The
    book is filled from the directory: a sim by `space_leases.sim` (its node and address), a gate,
    the store, social and the directory by `nodes`. A `GateId` must be unique across processes (a
    `gate_ids` sequence in 0031, or drawn from the gate's row).
  - **The leases.** Tiers' `directory::leases::Leases` trait (e7c28bd) gets a Postgres
    implementation over `cluster::leases`. Its `grant` must be able to fail (another process
    holds the space; the in-memory one never does). Its `renew` becomes one statement for all a
    process holds. Its `until` is measured from when the renewal was *sent*, as the keeper's
    deadline is, with the sim checking it each tick (`Keeper::holding`) as well as heeding
    `LeaseNote::Lost`.
  - **Fenced life writes.** `LifeWrite` carries the writing sim's lease fence (space and epoch)
    beside the character's epoch, and the store calls `cluster::leases::check(&mut tx, &fence)` in
    the transaction that checks `characters.epoch` (agreed with the orchestrator).
  - **Fenced ticks.** `TickOut` carries its lease's epoch, so a gate keeps the highest epoch it has
    seen per space and drops a tick from a deposed sim.
  - **Starting by role.** The tiers' `start.rs` is where the roles plug in: a process starts the
    tiers its role names, and a `LinkPost` for the others.
- **From borders:** ghosts, handoffs and events across borders as `ToSim` messages (they cross the
  links as they are). The handoff's commit is a fenced write (the new owner's claim in the store,
  under its lease and the character's next epoch), so a sim killed between its phases leaves one
  owner. The harness kills the sending or the receiving process mid-handoff (`Proc::kill`,
  proxies between them).
- **From the wire:** the packed records travel inside `TickOut` as bytes. Mark them
  `#[serde(with = "serde_bytes")]` (or a bytes type): serde writes a plain `Vec<u8>` as a list of
  numbers, which MessagePack keeps at one or two bytes each, where bytes marked so go as one blob.

## Log

## 2026-11-06 21:10: the link (`crates/link`)

- **27eb6bc** merged the tiers' world-api first cut (86d6055, with the server's files moved into
  its tiers, b5df031), as the orchestrator allowed, to build against world-api's `Transport`.
  `design/status.json`'s one conflict: refactor/first's session lines kept, the clock's path as moved.
- **9855f9f** `crates/link`: serde messages between processes over TCP.
  - Framed (u32 length, a kind byte, LEB128 numbers): hello, welcome, message, ack, ping, refuse
    (`frame.rs`). A small message costs 6 bytes round its body.
  - Each message numbered on its link and kept until acknowledged; every new connection starts
    with a handshake saying what the peer delivered, and everything after that is written again;
    the peer drops what it has (per peer: its start and the last number delivered, under a lock
    held while delivering, so two connections from one peer can't deliver out of turn). So: once
    and in order across lost connections; at least once across a peer's restart (its new start is
    sent what it never acknowledged), every message with an id (`MsgId`: the sender's start and the
    number) for what must stay idempotent.
  - Back-pressure: `send` waits for room in the window (4096), `try_send` refuses, `push` never
    waits (world-api's `Transport::send`) up to a limit (65536); a full inbox stops its links being
    read. Requests and answers; pings when quiet, a connection silent for 10 s dialled again;
    doubling backoff (50 ms to 2 s) with jitter; events (up, down, restarted, refused); the
    handshake refuses another protocol or encoding.
  - Faults for tests (`Fault`: cut and restore, write twice, lose acks) and `proxy::Proxy`, a TCP
    proxy that cuts, restores and writes every n-th message twice between processes.
  - `post.rs`: world-api's `Transport` over links (`LinkPost`, a `Book` of which node takes each
    `Address`), and `deliver`, handing what arrives to the process's own post.
- **Decision, the encoding:** MessagePack with field names (rmp-serde `to_vec_named`), JSON as the
  other choice. World-api's messages hold `serde_json::Value`s, an internally tagged enum and
  fields skipped when empty, made for the browser's JSON as much as for links; a format without
  field names (postcard, bincode) misreads skipped fields and refuses values and tags, at run time,
  and only between processes. Measured on world-api's own messages (release, i9; `tests/numbers.rs`):

  | Message | MessagePack: bytes, write, read | JSON: bytes, write, read |
  |---|---|---|
  | A player's inputs (3 frames) | 148 B, 0.5 µs, 0.4 µs | 257 B, 0.4 µs, 0.9 µs |
  | A life to write | 623 B, 1.4 µs, 4.6 µs | 716 B, 1.2 µs, 5.5 µs |
  | A tick for a gate (40 players in 6 cells, 8 private, one life) | 28,247 B, 33.7 µs, 57.3 µs | 34,045 B, 42.0 µs, 94.1 µs |
  | A player handed between sims, with their life | 1,547 B, 2.9 µs, 10.8 µs | 1,895 B, 3.2 µs, 13.8 µs |

  MessagePack is 17-42% smaller and reads 20-55% faster, and keeps infinities and NaN, which JSON
  turns into null (and then can't read back). Postcard on the inputs alone: 51 B, 0.24 µs, 0.13 µs;
  worth it only for messages made for it (say the wire's packed records, which travel as bytes
  anyway).
- **Numbers** (release, one link on this machine): 1.38 million small messages a second; ticks'
  records (28 KB each) 8,300 a second, 235 MB/s; a request and its answer p50 70 µs, p99 196 µs,
  p99.9 842 µs.
- **Tests:** `cargo test -p ruina-link`: 9 unit (frames, codecs, backoff, the queue), 11 over real
  sockets: 5,000 once and in order; 200 requests at once and answers both ways; 20,000 through ten
  cuts mid-stream, exactly once and in order; every message written twice, taken once; lost
  acknowledgements sent again and dropped; a full window holding the sender back and `push` stopping
  at its limit; a restarted receiver sent what it never acknowledged (with the `Restarted` event); a
  restarted sender numbering afresh; another protocol refused, and a node that isn't the one dialled;
  world-api's messages through `LinkPost`; a JSON link.
- **Next:** the leases in Postgres (migration 0030: `space_leases`, `nodes`, `sim_ids`), the fence
  check, a sim's lease keeper; then the roles in `main.rs` and the harness of several processes.
- **For tiers:** `ruina_link::post::LinkPost` implements world-api's `Transport`; a process's
  inbox goes to its own post through `post::deliver(inbox, &local)`. Keep world-api's messages
  serde-only and self-describing-friendly as they are; `Encoding::MessagePack.round_trip(&msg)`
  holds one to crossing whole (a test over every message would catch a change that can't cross).

## 2026-11-06 21:35: the leases, the roles and the harness of several processes

- **eb88eca** The directory's leases in Postgres and the roles' scaffolding.
  - **Migration 0030** (`the_directory.sql`): `nodes` (every process: id, role, link address,
    incarnation, seen); the `sim_ids` sequence (world-api's `SimId`); `space_leases` (key
    `(space, part)`: world-api's `SpaceId` key, part 0 a whole space, others a region split along
    `chunks`; `sim`, `node`, `address`, `epoch`, `expires_at`); `space_snapshots` (a space's moving
    state, fenced, for whoever takes it over).
  - **`crates/server/src/cluster/leases.rs`**: `acquire` (one `INSERT ... ON CONFLICT DO UPDATE ...
    WHERE nobody holds it or it ran out`, the epoch bumped: in READ COMMITTED the conflicting row is
    locked and its WHERE checked as it is now, so two can't both win), `renew` (only its own,
    unexpired lease), `release` (keeps the epoch, holder NULL), `owner`/`owners`, `check` (the
    fence), `write_snapshot`/`read_snapshot`, `new_sim`.
  - **`keeper.rs`**: renews every fifth of the lease, stops a fifth before it runs out (10 s, 2 s,
    2 s by default), its deadline measured from when the last good renewal was *sent* (the
    database ran it later, so the lease lasts at least that long by any clock); `holding()` reads
    the deadline against the clock itself, so a sim checking it every tick stops in time even if
    the keeper's task is starved. What it says maps onto world-api's `LeaseNote`.
  - **`nodes.rs`**: register, heartbeat (2 s; false once another start of the same id has the
    row), alive, leave, sweep.
  - **`main.rs`**: `--role all|gate|sim|services` (`ROLE`; `all` by default, the server as it
    always ran, untouched), `--node`, `--link`, `--advertise` (`RAILWAY_PRIVATE_DOMAIN` on
    Railway), `--spaces`, `--lease-ms`. **`roles.rs`**: every role starts its links, registers,
    beats, answers `Status`, counts numbered messages, serves `/api/health` and `/api/cluster`;
    a sim stands for its spaces and plays each as a stand-in while it holds the lease (the world's
    ticks, a fenced snapshot every second, carried on from the last); a gate keeps a link to every
    sim in the directory and asks each how it is every second; the services sweep. Stopped, a sim
    lets its leases go and every role leaves the directory.
- **fa9f5ea** The harness (`crates/server/tests/cluster.rs`): `ruina-server` started several times
  in its roles, the test a process on the links, `ruina_link::proxy::Proxy` between processes to
  cut and double what passes (and in front of a sim's database to cut it off from the directory).
- **Decisions:**
  - **Lease timings**: 10 s, renewed every 2 s, a sim stopping 2 s before it runs out (research 5b),
    proportional for tests (`--lease-ms 2000`: 0.4 s, 0.4 s). Each renewal gets 1.5 s; failures
    retry every 0.5 s until the deadline.
  - **The sim renews its own lease, directly in Postgres** (the directory's table is the arbiter),
    rather than the directory process renewing for it: a sim cut off from the database stops,
    which is the partition that matters, and a directory process failing stops no sim. The
    directory tier decides placement (who should stand for what) and its in-memory leases (tiers')
    become these in the second half.
  - **The holder is its simulation** (`SimId`, never reused), so a process's restart is a new
    holder whatever its node id.
  - **The fence is the epoch, checked in the write's transaction with the lease's row FOR SHARE**
    (FOR KEY SHARE wouldn't block a grant, which changes no key). A write under the space's current
    epoch passes even if the lease has run out but no one has taken it yet (Kleppmann's fencing
    tokens: the store checks the token, the lease service decides time); once a newer grant is made
    or the lease is let go, it's refused. The grant waits for writes in flight, so the next holder
    reads after them (tested).
  - **Life writes check both** the character's epoch (tiers' `characters.epoch`) and the writing
    sim's space-lease epoch (agreed with the orchestrator): a sim that lost its space can't write
    a life even if that character wasn't granted anew.
  - **The roles' traffic today is `cluster::Msg`** (status, counted messages) on protocol
    `cluster/1`; world-api's messages cross as `world-api/1` once the tiers run apart.
- **Tests** (all against slot 10's Postgres, three runs each, all green):
  - `crates/server/tests/leases.rs` (8): one of sixteen granted at once, five times over; epochs
    bumped and only the holder renewing; a lease run out taken over (not before its TTL); stale
    writes refused (and the check alone, and a let-go lease); a grant waiting for a write under the
    old epoch to commit; a keeper cut off from the database through a proxy stopping 1.5-1.6 s after
    the cut and 0.41-0.47 s before the takeover (margin 0.4 s), its late write refused; a keeper
    letting go; the processes' heartbeats and sweep.
  - `crates/server/tests/cluster.rs` (5 tests, 2-4 processes each, 6-14 s together): a gate, two
    sims and the services finding each other; a sim killed outright, its space taken over under the
    next epoch 1.7-2.1 s later (2 s leases) and carried on from its snapshot; a link between
    processes cut three times mid-stream (6,000 messages once and in order, 1,800-4,000 written
    again); every third message doubled by the proxy (each taken once); a sim cut off from the
    directory stopping 1.3-1.6 s after the cut, before the other was granted its space (0.5-0.7 s
    later), and standing by once back.
- **Next:** the docs (`docs/architecture.md` Several Processes, `docs/deploys.md` Several Processes,
  `docs/testing.md`), merge `refactor/first`, `npm run check`, then the first half's summary.

## 2026-11-06 21:50: the first half done

- **c33c546** the guides (`docs/architecture.md` and `docs/deploys.md`, Several Processes;
  `docs/testing.md`, `npm run test:cluster`), a node making its links' connections on the runtime
  it started on (so a simulation's thread, outside tokio, can make a link and send: tested), the
  link crate's AGENTS.md naming its tests from the root, `tests/unit/bible.test.ts` formatted.
- **09cc4aa** merged `refactor/first` (12b3946: progress and finish.md only).
- **Checks** (summary above): all green but `tests/unit/paths.test.ts`, on five paths from the
  tiers' 86d6055, which pass at the tiers' tip. `npm run test:cluster` green.
- **Next:** the second half, once tiers and borders are on `refactor/first` (above).

## 2026-11-06 23:05: the second half, the code (integration runs wait until everything is merged)

- **0de78c5** merged `refactor/first` 33ead3b (the tiers, bigworld); **d5a7184** merged f0ae550
  (offline, borders' engine half). Both conflicts were `main.rs` (refactor/first's `--max-bots`
  under the roles' options).
- **b4e8034** the tiers across processes:
  - **Roles** (`cluster/roles.rs`): `--role services` starts the store, social and the directory
    (Postgres leases, lives fenced by the writer's lease too); `--role gate` a gate with an id from
    `gate_ids` (migration 0031) and the server's one port; `--role sim` the simulations the
    directory starts there. `--role all` (the default) is unchanged. `npm run cluster`
    (`tools/cluster/run.mjs`) runs the services, two sims and a gate on `DATABASE_URL`, the gate
    on 7790. `--spaces` and the first half's stand-in simulation are gone.
  - **One post** (`cluster/process.rs`): the tiers' `Post` keeps its mailboxes, and `set_remote`
    sends the rest through a `LinkPost<Wire>` whose book comes from the directory's tables (a sim
    by `space_leases`, a gate by `nodes.gate`, the services by `nodes`). Mail for an address not
    yet known is parked and looked up at once; mail parked 10 s comes back, and a player on their
    way into a simulation nobody has is `Returned` to where they came from. What arrives is given
    to `Post::here` (this process's mailboxes only, so two processes can't bounce a message).
  - **Leases** (`cluster/pg.rs`): `PgLeases` behind the tiers' `Leases` trait. `grant` places a new
    simulation on the sim process with the fewest live leases (the instance pool: channels and
    copies alike) and takes as it is a space a live simulation still plays (a directory started
    again). `renew` only checks: each sim's own process renews (a `Keeper` per hosted simulation,
    its word passed in as `LeaseNote`). `RemoteSims` starts a simulation where it was placed
    (`Wire::Spawn`).
  - **Losing a space**: a simulation among several stops when its lease is lost
    (`Sim::stop_when_lost`). The directory lets the space go and sends its players `ToConn::Rejoin`
    (new in world-api): the gate closes them as a deploy does (1012), and the browser comes back in
    under the next epoch, wherever the space is played now, to its life as last written.
  - **Fences**: the store checks a life's writer lease (`LifeWrite::writer`) with
    `cluster::leases::check` beside `characters.epoch`, once leases are Postgres's
    (`store::fence_by_leases`). The gate drops ticks under an older lease than it has seen for
    their space.
  - **Small edits in the tiers' files**: `post.rs` (`here`, `holds`), `start.rs` (`services_with`),
    `directory/mod.rs` (adopting, `let_go`), `sim/host.rs` (`stop_when_lost`), `store/mod.rs` (the
    fence), `gate/mod.rs` and `gate/socket.rs` (the tick fence, `Rejoin`), `gate/encode.rs` (one
    arm), `http.rs` (`stopped` public to the crate).
- **Unit tests** (11 new, no database, no second process): what the links carry crosses whole; a
  simulation among several stops when its lease is lost (one alone carries on); mail from another
  process is delivered here or nowhere; leases lost once run out, let go or granted again; a
  simulation started in the process it was placed on; a keeper that can't reach the directory stops
  at its deadline, before the lease could run out, and reads its deadline from the clock; a player
  sent into a missing simulation goes back; roles by name.
- **Not done, and why:**
  - **Handoffs across processes** wait for borders' second half. The clean place: a handoff is a
    `ToSim::Transfer` across links (`Moving` serializes whole; a missing receiver bounces it). The
    epoch is granted by the directory as a portal's is, and inputs for someone handed on are sent
    on by the old simulation. Borders' exactness needs a trade at about 8 phase boundaries a tick.
    Across processes that's 8 round trips a 50 ms tick (70 µs each on one machine, milliseconds
    between machines). My call: **ghosts a tick late across processes**, with the two-phase handoff
    exact under epochs; bit-exactness stays a one-process golden test.
  - **Re-routing inputs by sequence number through a move**: the gate can resend its recent inputs
    to the new simulation once `Moving` carries the player's last applied input (the slot's
    `last_seq`), so the receiver drops what was already run. That's borders' handoff message; today
    the old simulation sends on what reaches it, and a portal move resets the browser's inputs.
  - **Docs**: `docs/deploys.md` and `docs/architecture.md` still describe the first half's stand-in
    and `--spaces`; the final docs pass updates them.
- **For the orchestrator**: refactor/first's `Dockerfile` doesn't list `crates/world-api` in its
  dependency layer (a workspace member since the tiers), so its image wouldn't build. This branch
  lists it, and `crates/link`.

### Tests for the End Agent to Run or Write

With `RUINA_DATABASE_URL` on a database of the run's own (the harness lets go of every lease and
forgets every process there before each playing test):

| Test | Where | What it proves |
|---|---|---|
| `npm run test:cluster`: the 8 lease tests | `crates/server/tests/leases.rs` | Ran green in the first half: one grant among sixteen racing, epochs bumped, stale writes refused, a grant waiting for a write under the old epoch, a keeper cut off from the database stopping 0.4 s before the takeover |
| `processes_find_each_other_through_the_directory` | `crates/server/tests/cluster.rs` (written, never run) | The services, two sims and a gate in the directory; each sim answers on its link |
| `a_player_plays_on_simulations_in_other_processes` | same | A player over the gate's WebSocket plays on a sim in another process (a grant there and back); a developer zone's copy is placed on the other sim process and the player is handed across |
| `a_sim_killed_with_a_player_in_it_and_they_come_back_on_another` | same | A sim killed outright: its player is closed with 1012, comes back on the other sim under the next epoch with their coins as written (nothing lost, nothing twice), and plays on |
| `a_sim_cut_off_from_the_directory_stops_and_its_player_comes_back_on_another` | same | A lease lost: the cut-off sim stops before the other is granted the space; the player comes back with their life |
| `every_message_to_a_sim_written_twice_and_each_command_applied_once` | same | A message delivered twice end to end: three grants, each applied once; the sim's link drops the copies |
| `a_link_between_processes_cut_and_doubled_loses_and_repeats_nothing` | same | Three cuts, then every third message doubled: 6,000 messages once and in order |
| To write: a sim killed mid-handoff | after borders' second half | The two-phase handoff across processes: one owner after a kill at each phase, nothing duplicated |
| To run: the online Playwright specs against `npm run cluster` | `RUINA_SERVER=http://localhost:7790` | online, party, dungeon-way-in (copies across processes), minigames (pots written together), update (a gate stopped: `SaveAll` across processes) |
| To write: a services process restarted, a gate killed | the harness | Spaces still played are adopted, not started twice; players reconnect through another gate |
