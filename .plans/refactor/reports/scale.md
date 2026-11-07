# Scale: Proof at Scale (R10.24), Report

The scale workstream of [finish.md](../finish.md): branch `refactor/scale`, worktree
`C:\GitHub\games\ruina-wt-scale`, slot 8 (Postgres `ruina-wt-scale-db` on 5488, world server 7879,
`PW_PORT=5269`, `TEST_PORT_OFFSET=180`, its own servers on 8900-8999).

It builds the measurements every other workstream's claims are held to: a load harness (bots and
virtual clients against the world server), a browser's frames among a crowd, and today's numbers on
this machine as the baseline the wire, the tiers, borders and channels are measured against.

This file is a running report: dated entries at the end, the last one the state of things.

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
