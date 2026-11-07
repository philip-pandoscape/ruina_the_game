# Finishing the Refactor, With the Multi-Server World

Started 2026-11-06 (evening, on the Windows machine), on the user's word: finish the refactor,
**including the multi-server version** (which the plan had put after the merge, D19), with as many
sub-agents as the work needs (D21 in the plan, taking back D20: GitHub issue #4, the multi-server part,
is done here with the rest). This page is how the work is split and how the pieces meet. The plan is
[README.md](README.md), the tasks are [tracker.md](tracker.md), the design behind the world is
[`.plans/world/research.md`](../world/research.md) (sections 3, 5a, 5b and 5d above all).

The orchestrating session keeps `refactor/first` in `C:\GitHub\games\yggdrasil-refactor`, merges each
workstream's branch when it is done and green, and keeps the tracker, the progress report and
`design/status.json`. Workstreams never edit those three files: each writes its report to
`.plans/refactor/reports/<workstream>.md` instead.

## Where It Ends

```text
browser ─WebSocket─▶ gate ×N ──inputs, commands──▶ sim ×M (a region's channel, or an instance's copy)
                       ▲  ◀── records per cell, private state ──┘      ▲ ghosts, handoff, events ▼
                       │                                        neighbouring sim (across a border)
   directory: leases and epochs, which sim plays which space and chunks, who plays where
   store: Postgres (lives, land, plots, the ledger), every write fenced by an epoch
   social: parties (later friends and guilds)
```

- **One binary, several roles.** `ruina-server` runs every tier in one process by default (as
  Railway's beta does today), or one role per process (`--role gate|sim|services` or similar), the
  processes finding each other through the directory and talking over TCP with the same messages.
- **Messages, not shared memory.** The tiers talk only through the message types of
  `crates/world-api` (serde, no I/O). In one process they cross tokio channels; across processes,
  framed TCP. Nothing one tier needs lives only in another's memory.
- **Ids.** A global 64-bit `EntityId` (a kind and an id). Characters keep their database id, placed
  things get theirs from a database sequence, creatures are numbered by spawn and generation. Each
  connection has u16 handles for what it's sent.
- **Epochs.** Every lease the directory grants bumps an epoch; every write carries it; the store
  refuses a stale one. A sim that can't renew its lease stops before it runs out.
- **Ticks.** Numbered from the world's epoch (done, R10.17's clock); messages carry their tick.
- **Borders.** A region's chunks are owned by one sim; neighbours keep ghosts within ~120 m of the
  border, hand over authority 24-32 m past it in two phases with an epoch, and send hits, heals and
  effects across as events checked against the ghost's history. A vehicle crosses with its
  passengers and cargo as one unit. Creatures are leashed to their region.
- **Crowds.** Each client is sent only what's near it (32 m cells, near/mid/far), as compact binary
  deltas within a byte budget. A region past its soft cap opens another channel, placing players by
  party (then friends and guild), and merges it again when quiet.
- **Land.** Houses, farms, ships on slips, things on the ground and parked vehicles are rows keyed by
  space and chunk, the same in every channel; each plot is claimed once in the world, first come,
  and contested; trades, purchases, payouts and pots are idempotent ledger transfers.

## Workstreams

| Id | Scope (tracker) | Branch, worktree (`C:\GitHub\games\…`) | Slot | Wave | Needs |
|---|---|---|---|---|---|
| tiers | R10.20 the server's tiers, `crates/world-api`; R10.2 a sim per region channel and instance copy, found by id; R10.17's ids; a thread per sim; social and directory out of the games | `refactor/tiers`, `ruina-wt-tiers` | 1 | 1 | |
| bigworld | R10.23 the client in a big world; R10.16's rest (growing and dropping regions by need, a region drawn away from the origin); the three-region fixture world | `refactor/bigworld`, `ruina-wt-bigworld` | 2 | 1 | |
| offline | R10.11's rest, R10.4's rest, R10.10's rest: `?test` alone the world, the tests off the old options, the flat yard gone, the yard's rules as engine rules any instance switches on | `refactor/offline`, `ruina-wt-offline` | 3 | 1 | |
| wire | R10.8 the wire for crowds: first the protocol, its codec both ends and far peers drawn by the crowd renderer; then, once tiers is in, the gate and the sims on it, measured | `refactor/wire`, `ruina-wt-wire` | 4 | 1, 2 | tiers (for its second half) |
| land | R10.21 land, plots and the ledger: the engine, content, client and SQL first; the server's side on the store tier once tiers is in | `refactor/land`, `ruina-wt-land` | 5 | 1, 2 | tiers (for the server's side) |
| borders | R10.19 borders: ownership, ghosts, handoff, events across, vehicles crossing, leashing; Emberholm split in two matching one sim bit for bit; the fixture world crossed | `refactor/borders`, `ruina-wt-borders` | 6 | 1, 2 | tiers, bigworld's fixture (for its second half) |
| channels | R10.22 channels that open past a soft cap and merge when quiet, placed by affinity | `refactor/channels`, `ruina-wt-channels` | 7 | 1, 2 | tiers, land (for its second half) |
| multiserver | The multi-server version (research 5b): roles, TCP transport, the directory's leases in Postgres, the gate re-routing across processes, an instance pool, failure tests | `refactor/multiserver`, `ruina-wt-multiserver` | 10 | 1, 3 | tiers, borders, land, channels, wire (for its second half) |
| scale | R10.24 proof at scale: thousands of bots fighting, crossing and crowding, measured; failure tests | `refactor/scale`, `ruina-wt-scale` | 8 | 1, 3 | the rest (for its second half) |
| words | R10.14: "island" out of the code, the wire, the docs and the saves' column | `refactor/words` | 9 | 3 (last) | everything else merged |
| (main) | R9.5's tick, R6.14 the look check, Phase 13 (AGENTS.md, docs, the design bible's tracker, memory notes, close-out), the merge into `beta` | `refactor/first`, `yggdrasil-refactor` | 0 | all | |

**Sped up (the user, 2026-11-06 evening):** borders, channels, multiserver and scale start in wave 1
too, each with a first half that doesn't wait on tiers (engine modules, libraries, policies,
harnesses, measurements), and a second half on the tiers once they land.

## Who Owns What, While Several Run at Once

- **`crates/server`** is restructured by **tiers** in wave 1. Others touch it only to keep it
  compiling and working with their own changes, in small, local edits; anything bigger waits for
  tiers to land and is done on the new layout.
- **`crates/world-api`** is created by **tiers**. Others add their messages to it after it lands.
- **`crates/wire`** (the client protocol: records, handles, deltas, budgets) is created by **wire**,
  with its TypeScript decoder in `src/net/`.
- **The engine:** offline owns `session.rs`'s offline and yard parts, `training.rs`, `yard.rs`,
  `world.rs`; bigworld owns `open/map.rs`'s growing and dropping, and `crates/engine-wasm`'s region
  calls; land owns `life/` (what moves out of a life into land); tiers owns the ids (`actors.rs`'
  numbering). Where two must touch the same file, keep the change small and say so in your report.
- **Migrations** (`crates/server/migrations/`): numbers are reserved so they never clash: tiers
  0004-0009, land 0010-0019, channels 0020-0029, multiserver 0030-0039, words 0040-0049.

## Slots: Ports, Databases, Containers

Everything listens on localhost only. Each workstream uses its slot and nothing else.

| Slot | Postgres container, port | World server | `PW_PORT` | `TEST_PORT_OFFSET` | Free for its own servers |
|---|---|---|---|---|---|
| 0 main | `ruina-refactor-db`, 5461 | 7871 | 5261 | 60 | 8100-8199 |
| 1 tiers, multiserver | `ruina-wt-tiers-db`, 5481 | 7872 | 5262 | 110 | 8200-8299 |
| 2 bigworld | `ruina-wt-bigworld-db`, 5482 | 7873 | 5263 | 120 | 8300-8399 |
| 3 offline | `ruina-wt-offline-db`, 5483 | 7874 | 5264 | 130 | 8400-8499 |
| 4 wire | `ruina-wt-wire-db`, 5484 | 7875 | 5265 | 140 | 8500-8599 |
| 5 land | `ruina-wt-land-db`, 5485 | 7876 | 5266 | 150 | 8600-8699 |
| 6 borders | `ruina-wt-borders-db`, 5486 | 7877 | 5267 | 160 | 8700-8799 |
| 7 channels | `ruina-wt-channels-db`, 5487 | 7878 | 5268 | 170 | 8800-8899 |
| 8 scale | `ruina-wt-scale-db`, 5488 | 7879 | 5269 | 180 | 8900-8999 |
| 9 words | `ruina-wt-words-db`, 5489 | 7880 | 5270 | 190 | 9000-9099 |
| 10 multiserver | `ruina-wt-multiserver-db`, 5478 | 7881 | 5271 | 200 | 9100-9199 |

A slot's rig, for slot *k* (the image `postgres:18` is local; Docker Desktop is running, leave it so):

```sh
docker run -d --rm --name ruina-wt-<id>-db -e POSTGRES_USER=ruina -e POSTGRES_PASSWORD=ruina -e POSTGRES_DB=ruina -p 127.0.0.1:548k:5432 postgres:18
node tools/cargo.mjs build --release            # then copy the binary, so a rebuild never meets a running file (Windows locks it)
mkdir -p scratch/rig && cp target/release/ruina-server.exe scratch/rig/
DATABASE_URL=postgres://ruina:ruina@127.0.0.1:548k/ruina DEV_LOGIN=1 ./scratch/rig/ruina-server.exe --port 787k   # run in the background
PW_PORT=526k TEST_PORT_OFFSET=<offset> RUINA_SERVER=http://localhost:787k RUINA_DATABASE_URL=postgres://ruina:ruina@127.0.0.1:548k/ruina npx playwright test <specs> --output=scratch/pw-out
```

(Slot 0 uses 5461 for Postgres, slots 1-9 use 548*k*, slot 10 uses 5478.) With nine workstreams on
one machine, run Playwright with `PW_WORKERS=3` and only the specs your work touches until your final run. The user's own `ruina` compose project holds
7777 and its database; never touch it, nor any container or process you didn't start. Restart your
rig's server after rebuilding it (copy again first).

## Rules for Every Workstream

- **Work in your own worktree and branch.** Commit often, each commit one thing, its message in the
  repository's own style (read `git log`: plain words, what changed and why, the tracker ids), with
  **no AI attribution and no Co-Authored-By line** (AGENTS.md). Never push; never touch `beta`,
  `production` or Railway.
- **Before your final report:** merge the latest `refactor/first` into your branch, resolve every
  conflict, then run `npm run check` (it must pass) and the integration specs your work touches,
  against your slot's rig; the whole integration tier if your work touches the game broadly. List
  any failure with whether it fails on `refactor/first` too (the known races are listed in the
  tracker's Now section).
- **As you go** (the user, 2026-11-06): commit each meaningful step to your branch, at least every
  30-45 minutes of work; keep `.plans/refactor/reports/<id>.md` as a running report, a dated entry at
  each milestone (what landed with commits, what you ran and how it went, what's next, what blocks or
  what others must know), committed with the work; and send the orchestrator a 1-3 line summary
  after each (SendMessage to "main"). The orchestrator rolls them up into `progress.md`.
- **Your report** goes in `.plans/refactor/reports/<id>.md`, committed: what landed (with commits),
  the numbers, the decisions you made and why, what's left, and anything another workstream must know.
  Don't edit `tracker.md`, `progress.md` or `design/status.json`.
- **Docs move with the code:** the guides your work changes (`docs/*.md`, the AGENTS.md of each
  area, the bible's system pages if a rule changed), in the docs' own style.
- **The world's words** in everything new: world, region, instance, channel, copy, space, chunk,
  cell, land, life (`docs/world.md`). Never a new name with "island" in it. Don't rename old names
  outside your scope: the words workstream sweeps them at the end, and drive-by renames make
  conflicts for everyone.
- **Keep the engine deterministic** (`crates/engine/AGENTS.md`); keep the golden answers unless a
  change is on purpose (then say why in the commit).
- **Tests in the lowest tier that shows the thing works** (`docs/testing.md`); no fixed waits.
- **This machine** (Windows 11, i9, RTX 4090, Git Bash and PowerShell): a Bash heredoc whose body
  has an apostrophe fails, so write scripts with the Write tool and run them; cargo through
  `node tools/cargo.mjs` (or `/c/Users/philip/.cargo/bin/cargo.exe`); Node can't see `/tmp`, so keep
  scratch files in your worktree's `scratch/` (git-ignored). Never do anything that raises a Windows
  prompt (UAC, firewall): bind to localhost, install nothing system-wide.
- **No sub-agents that edit files.** Read-only explorers are fine.
- **When the plan doesn't settle a choice,** make the sensible one, write down why, and carry on.
  Stop and say so only for something destructive or outside this machine.

## Log

| When | What |
|---|---|
| 2026-11-06 | Merged the Mac's last commit (83d60a1, D20 and issue #4); D21 recorded. Integration tier on Windows: 202 passed, the yard spec's count fixed (both machines made the same fix) |
| 2026-11-06 | Picked up on Windows at 5d25daa; `npm run check` green (263 TypeScript, 181 engine, 81 server tests). Wave 1 started: tiers, bigworld, offline, wire, land |
