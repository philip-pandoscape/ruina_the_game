# Scale: Proof at Scale (R10.24), Report

The scale workstream of [finish.md](../finish.md): branch `refactor/scale`, worktree
`C:\GitHub\games\ruina-wt-scale`, slot 8 (Postgres `ruina-wt-scale-db` on 5488, world server 7879,
`PW_PORT=5269`, `TEST_PORT_OFFSET=180`, its own servers on 8900-8999).

It builds the measurements every other workstream's claims are held to: a load harness (bots and
virtual clients against the world server), a browser's frames among a crowd, and today's numbers on
this machine as the baseline the wire, the tiers, borders and channels are measured against.

This file is a running report: the first half's results first, then dated entries, the last one
the state of things.

## The First Half

### What Landed

| Commit | What |
|---|---|
| 419697c | Measurement hooks in the world server, cheap when unused: `--max-bots` / `MAX_BOTS` (the most bots a game holds; 64, the developer panel's limit, unless a load test asks for more), and the admins' stats carry every tick since the last as its rules and its updates timed apart (`ticks: [[ms, ms], ...]`) |
| 5d9b4f1, a637561, f486cb4 | The load harness, `crates/tools/src/bin/loadtest.rs`, `npm run loadtest` |
| ed647bb | The browser among a crowd: `tests/stress/battlefield.spec.ts` reworked |
| bcb494f | `docs/testing.md`, Measuring at Scale; the tick bench at any size (`RUINA_TICK_BENCH`) |
| with this report | The baseline: `scale-baseline.json` beside this file, explained below |

The edits in `crates/server` are small and local (`main.rs`, `play/bots.rs`, `play/mod.rs`'s
`step` and `send_tick`), and the battle's golden hash is unchanged. Tiers has moved `play/` to
`sim/`: the hooks move with it (see For Other Workstreams).

### The Harness

`loadtest` starts the server afresh for each point (a copy of `target/release/ruina-server`, with
developer sign-in and `--max-bots 4096`), signs in its virtual clients by name, and has each send an
input 60 times a second over the real WebSocket from the welcome on (a metronome thread on the
high-resolution clock keeps the time) and read every update. Battlefield points put every client
in the battlefield and the first fills it with bots, sixteen at a time over both halves of the
arena (a teleport, then `bots`); channel points leave each client in its home channel. It records
every tick's rules and updates (from the stats), the world thread's time over all games, bytes a
second and update sizes per client, peers per update, the time from each input to the first update
that acknowledges it, the gaps between updates, the server's CPU and memory, the machine's load
before and during, and its own CPU. A point is three repetitions on fresh servers, 5 s of warm-up
and 15 s measured, reported as medians. A sweep stops at the first point that doesn't keep up: a
median tick past 50 ms, fewer than 19 updates a second, inputs answered more than 200 ms late at
the median, or no tick measured. How to run it: `docs/testing.md`, Measuring at Scale.

The browser's side is `tests/stress/battlefield.spec.ts` (`@gpu`): an admin at the battlefield's
south end over 0 to 256 bots fighting, its frames timed by `requestAnimationFrame` (300 at each
size). The rules alone, without sockets: the tick bench, now at any size.

### The Baseline on This Machine

Windows 11, i9-14900HX (24 cores, 32 threads), 96 GB, RTX 4090 laptop GPU, 2026-11-06 evening,
`refactor/scale` at bcb494f (today's server, before the tiers and the wire). **The machine was
shared with eight other workstreams**: before and during the points it was 30% to 100% busy, about
two-thirds at the median. The same point's median tick varied by up to 2× between repetitions (128 bots one
after another: 4.4, 7.3, 5.8 ms; 48 clients in channels: 5.4, 6.3, 10.8 ms), and a check of 64 bots
afterwards measured 4.0 ms against the baseline's 2.5. Trust the shapes and the factors of several;
a difference under 2× needs the two runs back to back. All in `scale-baseline.json`
(`loadtest`, `browser`, `bench`); the full run with every repetition is
`scratch/scale/baseline-1.json` on this machine.

**Bots in one game, one client watching** (the battlefield; ms; median of three):

| Bots | Stepped | Tick p50 / p99 | Rules | Updates | Update | KB/s | Input to update p50 / p99 | Keeps up |
|---|---|---|---|---|---|---|---|---|
| 0 | in order | 0.31 / 0.39 | 0.13 | 0.18 | 1.4 KB | 30 | 27 / 44 | yes |
| 32 | in order | 2.05 / 2.58 | 0.49 | 1.56 | 22.4 KB | 449 | 32 / 49 | yes |
| 64 | in order | 2.48 / 4.58 | 0.63 | 1.82 | 43.4 KB | 868 | 23 / 41 | yes |
| 128 | in order | 5.78 / 9.23 | 1.29 | 4.53 | 84.9 KB | 1,698 | 33 / 54 | yes |
| 256 | in order | 14.13 / 18.23 | 2.86 | 11.30 | 169 KB | 3,385 | 40 / 61 | yes |
| 512 | in order | 17.73 / 27.33 | 3.39 | 14.25 | 334 KB | 6,679 | 46 / 82 | yes |
| 1,024 | in order | 54.27 / 67.43 | 11.13 | 42.85 | 659 KB | 12,863 | 4,158 / 12,548 | **no** |
| 32 | all at once | 2.19 / 4.42 | 0.70 | 1.45 | 22.4 KB | 449 | 30 / 48 | yes |
| 64 | all at once | 3.42 / 4.40 | 0.78 | 2.64 | 43.4 KB | 868 | 26 / 44 | yes |
| 128 | all at once | 6.48 / 8.76 | 0.98 | 5.48 | 84.8 KB | 1,698 | 27 / 45 | yes |
| 256 | all at once | 11.04 / 14.91 | 1.27 | 9.76 | 169 KB | 3,384 | 33 / 68 | yes |
| 512 | all at once | 24.54 / 33.19 | 1.90 | 22.47 | 334 KB | 6,680 | 56 / 94 | yes |
| 1,024 | all at once | 42.21 / 64.10 | 2.93 | 39.07 | 658 KB | 13,123 | 499 / 1,078 | **no**: stalls |
| 2,048 | all at once | 96.0 / 111 (1 of 3 measured) | 5.28 | 90.24 | 1,340 KB | | | **no** |

Wanderers (no fighting) cost the same but for their brains: 256 one after another 12.0 ms (rules
1.82), all at once 12.5 (1.18); 1,024: 54.9 (7.37) and 47.9 (2.73), neither keeping up; at 4,000
all at once the server starved while the bots came in (2,368 of them; one repetition measured a
61.8 ms tick, 58 of it updates).

**The rules alone** (the tick bench: a tick of the battlefield's rules, then one admin's update
built and dropped, no sockets; 100 ticks after 40):

| Bots | Rules, in order | Rules, all at once | One admin's update |
|---|---|---|---|
| 64 | 0.39 ms | 0.64 ms | 1.9-2.0 ms |
| 256 | 1.56 | 1.91 | 7.7-7.9 |
| 1,024 | 7.06 | 3.25 | 34-46 |
| 2,048 | 22.40 | 3.97 | 77-92 |
| 4,000 | 50.98 | 9.61 | 159-160 |

A game holds 4,096 players and bots (`MAX_PLAYERS`, `crates/engine/src/combat.rs`), so 4,000 is as
far as one game goes. One after another, the rules cost 6.9 µs a bot at 1,024, 10.9 at 2,048 and
12.7 at 4,000: the brains look at every foe, and that part grows as the square. All at once they
cost 2.4-3.2 µs a bot.

**Clients sharing a game** (the battlefield, one after another; each client sees everyone):

| Bots | Clients | Tick p50 / p99 | Rules | Updates | Update | KB/s a client | Input to update p50 / p99 | Keeps up |
|---|---|---|---|---|---|---|---|---|
| 64 | 1 | 2.48 / 4.58 | 0.63 | 1.82 | 43.4 KB | 868 | 23 / 41 | yes |
| 64 | 5 | 7.46 / 11.00 | 0.80 | 6.64 | 45.8 KB | 920 | 27 / 58 | yes |
| 64 | 10 | 8.41 / 16.57 | 0.49 | 7.89 | 49.0 KB | 980 | 31 / 55 | yes |
| 64 | 20 | 28.40 / 38.23 | 0.89 | 27.43 | 55.3 KB | 1,107 | 47 / 74 | yes |
| 256 | 5 | 31.85 / 47.58 | 2.80 | 28.87 | 172 KB | 3,436 | 54 / 95 | yes |
| 256 | 10 | 46.45 / 76.96 | 2.71 | 43.72 | 175 KB | 2,042 (11.7 updates/s) | 2,026 / 4,911 | **no** |

**A world of channels** (clients in their home channels, 24 live in one, no bots, one after
another; every client sees the 23 others):

| Clients | Channels | One channel's tick p50 | World thread a tick | Updates/s | KB/s a client | Input to update p50 / p95 / p99 | Server cores, MB | Keeps up |
|---|---|---|---|---|---|---|---|---|
| 24 | 1 | 6.95 ms | 7.3 ms | 20.0 | 326 | 37 / 57 / 59 | 0.30, 35 | yes |
| 48 | 2 | 6.31 | 13.9 | 20.0 | 326 | 31 / 53 / 56 | 0.60, 46 | yes |
| 72 | 3 | 11.20 | 34.1 | 20.0 | 326 | 47 / 76 / 83 | 1.09, 57 | yes |
| 96 | 4 | 7.80 | 36.3 | 19.8 | 324 | 70 / 288 / 379 | 1.09, 72 | just |
| 144 | 6 | 8.06 | 50.9 | 18.7 | 306 | 1,869 / 2,049 / 2,190 | 1.26, 105 | **no** |

The rules are 0.3-0.45 ms of a channel's tick; the rest is its 24 updates (16.2 KB each).

**Bandwidth.** An update carries about 1.4 KB of your own (30 KB/s) and 660-670 B of JSON for each
peer (672 B at 32-256 peers, 658 at 1,024): 13.1-13.4 KB/s for every peer in view. With 0, 32, 64
and 256 peers a client receives 30, 449, 868 and 3,385 KB/s; with 1,024, 12.9 MB/s.

**The browser among a crowd** (`tests/stress/battlefield.spec.ts`, Edge headless on the RTX 4090,
1280 × 720, 300 frames at each size):

| Bots | fps (median) | Frame p50 / p95 / p99 / longest | The page's work a frame | GPU a frame | Draw calls | Triangles |
|---|---|---|---|---|---|---|
| 0 | 60 | 16.7 / 16.8 / 17.2 / 17.4 ms | 4.3 ms | 1.9 ms | 58 | 0.26 M |
| 32 | 60 | 16.7 / 16.8 / 16.9 / 17.2 | 8.7 | 5.7 | 196 | 2.5 M |
| 64 | 60 | 16.7 / 33.4 / 33.5 / 34.2 | 20.7 | 8.8 | 326 | 4.6 M |
| 128 | 30 | 33.4 / 50.1 / 66.7 / 66.7 | 27.3 | 10.7 | 563 | 8.9 M |
| 256 | 20 | 50.0 / 50.2 / 66.5 / 83.4 | 44.2 | 12.3 | 1,117 | 17.8 M |

The page's own work (posing and drawing each hero, reading the JSON) grows by about 0.16 ms a peer
and sets the frame; the GPU has room to spare.

**The server's CPU and memory.** One after another the server never used more than about one core
(the world thread: 0.87 cores at 1,024 bots); all at once 1.4-1.6 cores (rayon), and channels 1.1-1.3
(the world thread and the connections). The harness itself used at most 0.55 cores, and every client
sent its 60 inputs a second throughout. One game takes 32-63 MB up to 1,024 bots and a channel about
12 MB. When a client falls behind, memory balloons: a connection's outbox holds up to 256 updates
whatever their size, so at 2,048 bots the server held 426 MB, at 4,000 wanderers 726-755 MB.

### What It Says About the Research's Capacity Math (Section 4)

- **4.1, players per region process.** The research took 38 µs a player a tick (bots and one admin)
  to mean about 650 players at 25 ms. Bots with one client watching measure the same here (53-55 µs
  a bot at 256-1,024, so about 460 at 25 ms on this slower, shared machine). **But a real player is
  also a client, and today each client is sent everyone**, so the updates grow as the square of the
  players: 12-45 µs a peer for each client a tick. A game of real players holds about 40 before its
  updates take half a tick (20 clients and 64 bots: 28 ms), and the whole server, whose one world
  thread steps every channel, about **100-120 players** (four channels of 24 take 36 ms a tick; six
  don't keep up). The rules are not the limit: 7 µs a bot at 1,024 one after another and 2.4-3.2
  all at once, so one simulation's rules carry about 2,200 bots in 25 ms one after another and
  4,000 (a game's limit) in under 10 ms all at once. The research's 1,000 a region is well inside
  the rules' budget; everything turns on the updates, which is what the wire is for (its own
  numbers: 53-440 µs to write a connection's update against JSON's 1.3-107 ms).
- **4.2, bandwidth.** Confirmed: 660-670 B of JSON a peer an update, 13 KB/s for each peer in view;
  64 bots 868 KB/s (the research: 858); a channel of 24, 326 KB/s a client (about 320). Drawing: the
  M4 drew 64 detailed peers at 58 fps with a 16.8 ms 95th percentile; here the median holds 60 fps
  at 64 but the 95th percentile doubles to 33 ms, and 128 halve it. The research's 60-120 detailed
  characters is the ceiling, not a comfortable budget: past about 64, everyone should be the crowd
  renderer's.
- **4.3, the world of 100,000.** It assumes about 1,000 players a region process (140 processes).
  Today's server holds about 100-120 a process, which would be some 900 processes. The gap is the
  per-client JSON and the one world thread and lock, not the rules.
- **Measured on two machines.** The tick bench at 1,024 bots took 2.0 ms of rules one after another
  and 0.8-1.0 all at once on the M4 (R10.18), with 8 ms of updates; here 7.1, 3.3 and 34-46. This
  machine, shared and on Windows' allocator, runs the same code 3.5-5 times slower; the update
  sizes are the same to the byte. Compare a change only with numbers from the same machine.

### Decisions

- **Rust, not Node, for the harness.** At 1,024 bots one client receives 13 MB/s of JSON, and a
  hundred clients in channels 32 MB/s between them; a Node client reading that falls behind, and a
  slow reader makes the server hold or drop its updates, measuring the client. The harness parses
  only what it needs (serde with everything else skipped) and stays under 0.6 cores.
- **A fresh server for every repetition**, started by the harness: known flags (`--parallel`,
  `--max-bots`), nothing left over, and its CPU and memory read from the process itself (Windows'
  process times and memory counters; `/proc` or `ps` elsewhere). `--url`/`--pid` attach to one
  running already.
- **Bots placed with the developer panel's own commands** (a teleport, then `bots`), sixteen at a
  time over both halves of the arena, rather than a new command in the server.
- **Two hooks only** in the server, and the stats as the way out of it, as the browser already
  reads them.
- **Inputs only after the welcome**, as a browser does: early inputs wait in a queue that drains at
  one input a second, which first read as two seconds' latency.
- **Channels' clients come in one at a time, under names of their own** (`loadc0000`...): a home
  channel is the first with room when a character first arrives, and characters arriving together
  race for it (one channel got 38).
- **Above-normal priority** for the harness and its servers on Windows, the machine's load recorded
  before and during each point, three repetitions and medians: the machine is shared.
- **Keeping up** means all of: a median tick within 50 ms, 19 or more updates a second, inputs
  answered within 200 ms at the median. The run first judged by the first two, and so went on past
  1,024 wanderers all at once (a 48 ms median tick and more than 20 updates a second, caught up in
  bursts, but inputs answered 1.8 s late); the baseline file is judged by all three.
- **The browser's spec reworked in place** (`tests/stress/battlefield.spec.ts`, R10.12's), not a
  new file, so merging with tiers' path change in it stays a one-line conflict.
- **No failure scaffolding of my own yet.** Multiserver's `crates/link` already injects faults
  (connections cut and restored, messages written twice, acknowledgements lost) and has a fault
  proxy between processes; what's left for failure tests is load and the checks that nothing was
  duplicated or lost, which need the tiers and land first (the second half).

### For Other Workstreams

- **tiers.** (1) Every input a browser sends takes the world's one lock on a tokio worker, and when
  a tick passes 50 ms the world thread takes the lock again at once: connections starve, updates
  arrive in bursts, inputs wait seconds. The gate must hand inputs to the sims without blocking.
  (2) A connection's outbox is bounded by count (256), not bytes: a slow client held 426 MB at
  2,048 bots. (3) A player runs 61 inputs a second for 60 sent, so a backlog drains at one input a
  second. (4) `bot_name` is a linear search for each bot each tick (quadratic in `send_tick`).
  (5) Please keep the two hooks through the move: `set_bot_limit` with `--max-bots`/`MAX_BOTS`, and
  the stats' `ticks` (each tick's rules and updates apart; after the split, the sim's tick and the
  gate's encoding apart), which the harness reads.
- **wire.** The harness reads today's JSON; it will read the binary updates through `crates/wire`'s
  decoder. It needs the acknowledged input (to time input to update) and the admins' stats, in
  whatever form.
- **channels.** Today's home channels are assigned by the database as characters first arrive, and
  arrivals together overfill one (38 in a channel of 24): the new placement should be immune, and
  the harness will fill a region past its soft cap to watch a channel open.
- **multiserver.** `--url` and `--pid` attach the harness to a running server (one process today;
  several to come). The second half's failure tests put this load on your links' faults and proxy.
- **borders and bigworld.** Crossing needs the fixture world: the harness's clients can walk a
  path across a border; bots need a brain that travels (a route), the engine's.

### The Second Half (When Told)

1. **The harness on the new server:** updates read through `crates/wire`'s decoder; the sim's tick
   and the gate's encoding timed apart; several processes started or attached, each one's CPU and
   memory; the old and new servers run alternately, repetition by repetition, so the machine's
   noise falls on both alike.
2. **At scale, against this baseline:** thousands of bots fighting in one simulation (the rules
   carry 4,000 now that updates no longer grow with everyone); hundreds to a thousand virtual
   clients in one region, each sent what's near it; streams of clients and bots crossing borders
   between simulations; a region crowded past its soft cap until a channel opens, parties kept
   together, and merged when it empties; in one process and across several.
3. **Failure tests under load:** a simulation stopped mid-handoff, messages delivered twice, a lease
   lost (multiserver's faults and proxy), each checked so that no character is in two simulations
   or none, no item or coin is made or lost, and no input is applied twice.
4. **The browser** among the wire's crowds: the spec again with far peers drawn by the crowd
   renderer, at 256 and well past it.

## 2026-11-06 20:45: Started

Read finish.md, the tracker (R10.24, R10.8, R10.12, R10.18, R1.8, R10.5-R10.7), issue #4's
requirement 7, the research's capacity math (4.1-4.3), the testing guide, the stress tier, the
bots (`crates/engine/src/bots.rs`, `crates/server/src/play/bots.rs`), the battlefield, the server's
stats and `--parallel`, the tick-time bench (`tick_time_in_the_battlefield`) and the load test
deleted with the battle server (`git show a975617^:crates/tools/src/bin/loadtest.rs`).

What today's server is, as far as load goes:
- One `world` thread steps every game (channels of Emberholm, copies of instances) under one lock,
  20 times a second; every input message from every browser takes the same lock.
- Each player is sent everyone in their game, every tick, as JSON built once per player (no
  interest management yet: that's the wire's).
- A game holds at most 64 bots (`MAX_BOTS`, the developer panel's limit); a channel 24 residents
  (`CHANNEL_CAP`); the battlefield 20 players.
- The stats an admin gets once a second: the tick's time (smoothed), players, bots, the update's size.

The plan for the first half:
1. **`loadtest`** (`crates/tools/src/bin/loadtest.rs`): starts the server itself (so it knows its
   flags and can read its CPU and memory), signs in virtual clients by developer sign-in, sends
   inputs at 60 a second from each, reads every update; bots set up by a conductor client
   (teleport, then `bots`, a group at a time, spread over the arena). Measures the tick (whole, and
   the rules apart from the updates), bytes per client a second, the time from an input to the
   update that acknowledges it, updates' arrival, the server's CPU and memory, and the machine's
   load. Rust rather than Node: a Node client can't read a few hundred MB/s of JSON without falling
   behind, and a slow reader makes the server drop its updates, which would measure the client.
2. **Measurement hooks in the server**, small and cheap when off: a bot limit raised by a flag for
   load tests (`--max-bots`), and the tick's rules and updates timed apart in the admins' stats.
3. **The browser's side**: the battlefield stress spec reworked to stand a player among 0 to 256
   peers and time frames (median, 95th, 99th percentile).
4. **The baseline on this machine**: bots in one game from 32 up until a tick passes 50 ms, with
   and without `--parallel on`; bytes per client with 0, 32, 64, 256 peers; clients sharing a game;
   a world of channels filled with virtual clients until the world thread runs out of time.

Rig: `ruina-wt-scale-db` started; the release build running.

## 2026-11-06 21:20: The harness, the hooks and the browser's side landed; the baseline running

Landed:
- **419697c** the server's measurement hooks: `--max-bots` / `MAX_BOTS` (the bot limit, 64 unless a
  load test raises it), and every tick's rules and updates timed apart in the admins' stats
  (`ticks: [[ms, ms], ...]`). Small, local edits in `crates/server/src/main.rs`,
  `play/bots.rs` and `play/mod.rs` (tiers moves the last two to `sim/`); the battle's hash unchanged.
- **5d9b4f1, a637561** `crates/tools/src/bin/loadtest.rs` (`npm run loadtest`).
- **ed647bb** `tests/stress/battlefield.spec.ts` reworked: a browser among 0 to 256 bots.
- **bcb494f** `docs/testing.md`, Measuring at Scale; the tick bench takes other sizes
  (`RUINA_TICK_BENCH`).

First looks (one repetition each, the machine busy with the other workstreams):
- 64 skirmishers, one client: a tick 2.3 ms (rules 0.42, updates 1.84), an update 43.3 KB, 865 KB/s,
  input to update 27 ms at the median. The Mac's R10.8 numbers were 2.43 ms and 42.9 KB: the same.
- 1,024 skirmishers, one client: the update is 662 KB (13 MB/s); building it takes 36-50 ms of a
  tick whose rules take 3-12. **The updates, not the rules, are what runs out first.**
- 24 clients in one channel: 9.9 ms a tick, nearly all of it the 24 updates (16 KB each, about
  0.4 ms a client). Four channels of 24 take the world thread 38 ms a tick: **today's server holds
  about 120 real players** before its one world thread runs out of time.
- The browser: 60 fps to 32 bots, the 95th percentile at 33 ms with 64, 30 fps at 128, 20 at 256.

Found on the way (for tiers and wire):
- **Past 50 ms a tick, the server stops serving its clients.** The world thread holds the one lock
  over every game for the whole tick, and when a tick runs over the period it takes the lock again
  at once. Every input a browser sends takes the same lock on a tokio worker, so connection tasks
  stall: updates come in bursts (the median gap 1.8 ms, the 95th percentile 445 ms at 1,024 bots)
  and inputs wait seconds. Once the gate hands inputs to the sims through channels, this goes.
- **An input backlog drains slowly.** A player runs at most 61 inputs a second for the 60 sent, so
  inputs that piled up behind a stall (or were sent before the welcome, as the harness first did)
  wait a long time: two seconds of backlog take two minutes to drain.
- On this machine `--parallel on` once heard nothing for a whole measurement while the machine was
  99% busy (rayon's threads waiting on cores the other workstreams held); the same point measured
  again was fine (40 ms at 1,024 bots). Hence three repetitions, medians, and the machine's load
  recorded with each.

Running now: the baseline (`--plan baseline`, three repetitions of every point). Next: the tick
bench at 64 to 4,000 bots, the numbers into this report and `scale-baseline.json`, then
`refactor/first` merged in and `npm run check`.

## 2026-11-06 22:10: The baseline measured

- The baseline ran from 21:17 to 22:01 (`--plan baseline`: 30 points, three repetitions each, 90
  servers started and stopped), the tick bench at 64 to 4,000 bots after it. The numbers, what they
  say and the decisions are in The First Half above; `scale-baseline.json` holds them for the second
  half (`npm run loadtest -- --compare .plans/refactor/reports/scale-baseline.json`, checked).
- **f486cb4** the harness judges keeping up by inputs too (answered within 200 ms at the median):
  the run went on past 1,024 wanderers all at once, which stalled and caught up in bursts.
- In one line: **the rules carry 4,000 bots in under 10 ms a tick all at once; the JSON updates
  give out first**, at about 1,000 bots with one client watching, 40 real players in one game, and
  100-120 real players in the whole server (its one world thread).

Next: merge `refactor/first`, `npm run check`, and the first half's final word.
