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
