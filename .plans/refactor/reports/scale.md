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
