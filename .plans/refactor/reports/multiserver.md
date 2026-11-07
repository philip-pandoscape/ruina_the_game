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
