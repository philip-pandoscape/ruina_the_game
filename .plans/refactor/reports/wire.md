# The Wire for Crowds (R10.8): Report

Workstream **wire** (`refactor/wire`, worktree `C:\GitHub\games\ruina-wt-wire`, slot 4), started
2026-11-06 from `refactor/first` at 763d6af. The plan: [finish.md](../finish.md). The first half (the
protocol, its codec both ends, the feed's adapter, far peers as crowd bodies) goes ahead of the
server's tiers; the second half (the gate and the sims on it, measured) waits for them.

## The First Half, in Short (done; the second half waits on the tiers)

**What landed** (each its own commit on `refactor/wire`; `refactor/first` merged in at a25ce4d):

| Commit | What |
|---|---|
| 7a243c9 | `crates/wire`: records per 32 m cell, a `Viewer` per connection (u16 handles, deltas against what was acknowledged, tiers as priority rates, a 64 KB/s budget), the acknowledgement, the browser's side in Rust; 22 tests over a lossy, shuffling road |
| 0476309 | A tick's cells Serialize and Deserialize (for world-api's tick out); packing the engine's things behind the default `engine` feature; the benchmark against today's JSON |
| 2ecbef3 | `src/net/wire` (the browser's decoder and what it's heard), golden fixtures from the Rust (`tests/fixtures/wire/`), `tests/unit/wire.test.ts`; the viewer's removals in handle order (the same game writes the same bytes) |
| 3cf8a43 | Each connection's update 2-3 times cheaper (same bytes); what one gate core carries |
| b72af2a | The feed through one adapter (`src/net/feedTick.ts`: `feedFromJson` today, `WireFeed` for the wire), entities refreshed at their own rates (WorldPeers, a timeline per creature, arrows as of their own tick) |
| e82b13d | Far peers as crowd bodies (past 42 m, back to heroes within 38 m, a 0.35 s dithered crossfade); `tests/integration/crowd-bodies.spec.ts` |
| 645c6c5 | A cell crosses between processes as one blob (bytes; MessagePack's `bin`), 14 bytes for a creature alone |
| 0f2b49c | The world link ready for binary updates (heard, acknowledged, handed on as the world), dormant until the server sends them |
| 1cf834e | The guides: `crates/wire/AGENTS.md` (the protocol byte by byte, and why), `src/net/AGENTS.md`, `docs/architecture.md` (what a page hears, changing), `src/render/AGENTS.md`, `AGENTS.md`, `docs/testing.md` |

**The numbers.** Today's JSON on this machine: 22.3-23.5 KB an update with 32 bots, 43.5-44.4 KB
with 64 (the Mac's 22.3 and 42.9). The wire in `crates/wire/tests/bench.rs`, a player in the middle of
a crowd, acknowledgements back 200 ms later: 33 players 22.9 KB → 424 B (54×); 65, 44.0 KB → 780 B;
257, 175 KB → 2.0 KB; 1,025, 682 KB → 2.6 KB (the budget's); 4,097, 2.7 MB → 3.2 KB. Writing one
connection's update: about 30 µs for 40 in sight, 120-160 µs for 1,100, 180-270 µs for 1,500 (JSON
1.3 ms to 107 ms). One gate core at 20 updates a second: 1,650-2,150 connections in a wilderness (6.8
KB/s each), about 300 in a busy town (45.7 KB/s), 260-400 at a world boss (61.8 KB/s).

**Decisions, and why** (the protocol's own reasons are in `crates/wire/AGENTS.md`):
- *Deltas against what was acknowledged, each record naming its baseline* (a base byte: tier << 6 |
  updates back, at most 63). With priorities an entity isn't in every update, so one baseline for a
  whole update (Quake 3) won't do; the server keeps each update's records until acknowledged. The
  browser keeps an entity's states from the newest baseline the server has used: baselines only move
  on. Found by the tests: a whole record says nothing of which baselines remain (an earlier whole one
  may be acknowledged first), and a repeated introduction is the same entity (its states kept).
- *Tiers as rates of an accumulated priority*, near 40 m every tick (120), mid 120 m every fourth
  (400), far 250 m about once a second (1000); a budget that runs short slows the furthest first. 40 m
  rather than the old battle server's 30: a hero is drawn up close out to there.
- *A tier refreshes some fields*: far, where it is and its side, health and being down; mid, what a
  crowd body needs; near, everything. First sight is whole.
- *Frame counters measured against where they'd have run to*, so a swing in progress costs nothing,
  and an entity that only ran on isn't sent (the browser runs it on). Counters for a swing, a cast and
  a movement skill are packed as -1 outside their mode (the drawing reads them only then).
- *Handles*: 0 nobody, 1 you; an introduction sent with every record until acknowledged; given again
  only after a removal is acknowledged, the freed longest ago first, a generation guarding what's on
  its way. Ids cross only in introductions.
- *Updates applied whole and in order*: a stale one dropped and never acknowledged; a reference
  resolved to the handle it had as the update began.
- *Vehicles go with their owners* (the same updates, so both are drawn from the same moment); a
  carried pack and a cargo slot are fields; a pack on the ground is an item of its own, so a parked
  cart or a dropped crate is seen where it is, whoever owns it.
- *What stays JSON*: your own player (exact, for the prediction), your life, tables, notices,
  estates, admins' numbers: private, rare or exact. The world near you goes on the wire.
- *Cells as one blob between processes*, and nothing of the engine's needed on a gate (the
  orchestrator's ask, for the multi-server version's MessagePack).
- *A quick hash* (FxHash) for the server's own keys; *removals in handle order* for determinism.
- *Far peers*: switch at 42/38 m around the wire's 40 m, a 0.35 s crossfade (the crowd's own dither,
  the hero's alpha hash; the made body's shared materials copied for a fading hero), riders and those
  at a table stay heroes, far heroes aren't posed.
- *Small edits outside my area*: the engine gained `rideable_index` and `glider_index`
  (`crates/engine/src/life/content.rs`, land's area; additive); the content-id guard allows the wire's
  record kind `meteor`.

**For the second half** (from the tiers' layout; the pieces are ready):
- *In the sim, each tick*: a `Frame` from its players (`pack::player`: their key, character id, name,
  bot, the carried pack's id, their host's key), creatures, vehicles and packs on the ground (with
  their owner's key and life's packs), arrows (their shooter's key), meteors, and effects shown
  (`Frame::event`); effects told go in each player's private part. Keys are world-api's `EntityId`
  words; vehicles and packs on the ground need ids of their own from land (`pack::owned_key` stands
  in). `TickOut.cells` carries `Vec<ruina_wire::CellRecords>`; tiers' structured records go.
- *In the gate*: a `Viewer` per connection (`me` = the player's key); each tick
  `Frame::from_cells` once (shared), `viewer.update(&frame, view, &told)` per connection on the
  gate's threads, sent as a binary message beside a JSON tick without peers, actors, arrows, meteors
  or events; a binary message from the browser starting with 8 is `Ack::read` into `viewer.ack`; an
  update the outbox drops is `viewer.lost(seq)`; going to another space, the JSON `space` message then
  `viewer.reset()`. `WORLD_PROTOCOL` up on both sides.
- *Measured* with N bots on the battlefield (tick time, bytes a client, the browser's frames) against
  the before numbers; the online specs and the whole integration tier.
- *Still open*: encoding introductions and whole records once a tick per entity rather than per
  connection; skipping the middle and far tiers' work on ticks none is due; the crowd body baked from
  the made body rather than the box hero, so the switch is subtler still.

## 2026-11-06 20:47: The Before Numbers, and `crates/wire`

**The before numbers on this machine** (Windows 11, i9, RTX 4090; `tests/stress/battlefield.spec.ts`
against today's JSON, two runs, the second warm; `scratch/stress-battlefield-before-windows*.json`):

| Bots | Tick (ms) | Update (KB) | fps | Frame (ms) | p95 frame (ms) |
|---|---|---|---|---|---|
| 32 | 1.69, 1.06 | 23.5, 22.3 | 27, 45 | 36.8, 22.0 | 100, 83.4 |
| 64 | 3.62, 1.90 | 44.4, 43.5 | 43, 58 | 23.3, 17.2 | 83.3, 16.8 |

The update sizes match the Mac's (22.3 KB and 42.9 KB): about 670 B of JSON per peer per update.

**Landed (7a243c9): `crates/wire`**, the protocol with no I/O. A sim packs each entity's record once a
tick into its 32 m cell (`Frame`); the gate keeps a `Viewer` per connection, whose `update(frame,
view, told)` returns that connection's bytes and whose `ack` takes what the browser sends back. Handles
(u16, 0 nobody, 1 you) come with an introduction on first sight and are given again only after a
removal is acknowledged; records are deltas against the newest acknowledged state (field masks,
zigzag varints, frame counters measured against where they'd have run to); three tiers on rates of an
accumulated priority (near 40 m every tick, mid 120 m every fourth, far 250 m about once a second,
capped 120/400/1000); a 64 KB/s budget. 22 Rust tests pass, among them a Viewer and the browser's
side in Rust talking over a road that loses 20%, holds back 15% and acknowledges every other tick,
every heard state checked against the world and everything near settling to it exactly; a crowd of
4000 over a bad road; the budget held with 2000 in reach.

Decisions so far (the full list goes in the final report):
- **Deltas against acknowledged states, per entity**, as the plan says, with the server keeping each
  update's records until acknowledged (about 6 updates in flight at a 300 ms round trip). The
  alternative, absolute values with change masks resent on loss (Tribes, Unreal), keeps less on the
  server; noted for later if the gate's memory grows.
- **The engine gained two lookups** (`rideable_index`, `glider_index` in `crates/engine/src/life/content.rs`):
  a vehicle and a glider go on the wire as their places in the content's lists. Land owns `life/`;
  the change is additive and small.
- **No serde in `crates/wire` yet**: records are 40-field arrays, which serde can't derive for; in one
  process they cross threads as they are. The multi-server transport chooses their form later.

**Next:** benchmarks against today's JSON, the golden fixtures and the TypeScript decoder, the feed's
adapter, far peers as crowd bodies.

## 2026-11-06 21:00: Measured Against Today's JSON; the Browser's Decoder

**Landed:**
- 0476309: a tick's cells cross between processes (`Record`, `CellRecords`, `Frame` are Serialize
  and Deserialize, fields trimmed of trailing zeros; `Frame::from_cells`/`add_cells`/`into_cells`
  for world-api's tick out; packing behind the default `engine` feature, so a gate needs nothing of
  the engine's), as the orchestrator asked; and the benchmark.
- 2ecbef3: `src/net/wire` (bytes, schema, decode, heard: the browser's side, the Rust's twin), golden
  fixtures from four scenes (`tests/fixtures/wire/`, written by `crates/wire/tests/golden.rs`), and
  `tests/unit/wire.test.ts` hearing every scene to the same states, acknowledgements and drops (7
  tests, green first time). The Viewer now says what's gone in handle order: the same game writes
  the same bytes (found by the fixtures, which came out different run to run).

**Bytes and time per update** (`cargo test --release -p ruina-wire --test bench -- --ignored
--nocapture`; the engine's players moved by a script, creatures, a player in the middle, its
acknowledgements back 200 ms later; JSON is today's `presence_json` and `actors_json` field for field,
each client's own state left out as it's the same either way):

| Players | Creatures | Spread (m) | JSON B/update | Wire B/update | Smaller | First update | Pack µs/tick | Write µs/connection | JSON µs/connection | In sight |
|---|---|---|---|---|---|---|---|---|---|---|
| 33 | 8 | 80 | 22,875 | 424 | 54× | 2,051 | 16 | 53 | 1,348 | 40 |
| 65 | 8 | 80 | 43,958 | 780 | 56× | 3,883 | 25 | 76 | 2,308 | 72 |
| 257 | 32 | 120 | 174,729 | 2,042 | 86× | 6,540 | 51 | 126 | 5,763 | 288 |
| 1,025 | 128 | 300 | 681,710 | 2,614 | 261× | 6,530 | 210 | 270 | 24,907 | 1,143 |
| 4,097 | 512 | 600 | 2,717,371 | 3,181 | 854× | 6,545 | 870 | 440 | 107,457 | 1,465 |

The JSON replica lands on the battlefield's measured 22.3 KB with 32 bots, so the comparison is fair.
Past about 250 players the update is the budget's (3.2 KB a tick); the first update is two ticks'
worth, the most a connection may save up. Writing one connection's update costs 53 to 440 µs: at a
thousand connections in one crowd that's a few cores' work for the gate (JSON would be 25 s a tick),
so the second half spreads connections over threads; ideas to make it cheaper are in the final report.

**Next:** the feed's adapter (one place where decoded records become what the feed draws), the feed
taking entities refreshed at different rates, far peers as crowd bodies.

## 2026-11-06 21:25: A Cheaper Update, and What a Gate Core Carries

**Landed (3cf8a43):** the orchestrator asked about the per-connection cost (440 µs with ~1,500 in
sight). Measured inside `Viewer::update` first: choosing tiers and what's due was the most of it, then
writing out due records that then didn't fit, then the map lookups. Now the lists are kept between
ticks, keys and cells hash quickly, tiers come from one pass with each distance judged once, vehicles'
owners are looked for only among vehicles, and the writing stops after 32 misfits in a row. Same bytes
(the golden fixtures hold); about a third to a half of the time: 1,025 in reach 270 → ~120 µs, 4,097
440 → ~180 µs.

**What one gate core carries** (writing every connection's update 20 times a second, nothing else;
`what_one_gate_core_carries` in `crates/wire/tests/bench.rs`; times vary by half as other suites share
the machine):

| Place | Bytes an update | KB/s a client | µs a client | Clients a core |
|---|---|---|---|---|
| Wilderness (10 players and 20 creatures near, 20 mid, 30 far) | 346 | 6.8 | 23-30 | 1,650-2,150 |
| Busy town (80 near, 300 mid, 600 far) | 2,339 | 45.7 | 150-165 | 300-330 |
| World boss (500 within 50 m) | 3,165 | 61.8 | 125-190 | 260-400 |

The bandwidth lands on the research's estimates (about 12, 46 and 62 KB/s). Still open, for the
second half once the real gate measures it: encoding each entity's introduction and whole record once
a tick for every connection that needs it (they don't depend on the connection but for the handle),
skipping the middle and far tiers' work on ticks none of them is due, and spreading connections over
the gate's threads (each Viewer is independent; the Frame is shared read-only).

**Next:** the feed's adapter, then far peers as crowd bodies.

## 2026-11-06 21:55: The Feed's Adapter, and Far Peers as Crowd Bodies

**Landed:**
- b72af2a, the feed through one adapter: `src/net/feedTick.ts` is all the feed takes from a tick (players
  and creatures with a fresh state, those in sight that weren't refreshed, arrows and meteors each as
  of its own tick, effects); `feedFromJson` makes one from today's JSON tick, `WireFeed`
  (`src/net/wire/feed.ts`) from the wire's updates. WorldPeers and the actor timeline now take
  entities refreshed at their own rates (a timeline per creature; someone further off drawn further
  behind; as still as they were until just before a quiet spell ends); an arrow says if it's yours and
  the tick it flies on from. Unit tests play the golden scenes into the feed (a fifth scene added: a
  cart whose owner is away).
- e82b13d, far peers as crowd bodies: past 42 m someone is drawn by the crowd renderer (one instanced
  draw), within 38 m a hero again, a 0.35 s dithered crossfade between (the crowd's own fade, the
  hero's alpha hash); riders and those at a table stay heroes; far heroes aren't posed.
  `tests/integration/crowd-bodies.spec.ts` (an admin's wanderers seen from 70 m, then from among them)
  passes; pictures in `scratch/look-*.png` looked right (on the ground, their sides' colours,
  mid-stride; mid-fade both show).

**Ran:** the unit tier (276 tests) green; integration against my rig (PW_WORKERS=3): online,
online-combat, yard, battlefield, party and crowd-bodies, all passing but `yard.spec.ts:67`, which
fails on `refactor/first` too: it counts the yard's spawn entries (2) where c4904b1 gave one of them
`count: 5` (the server spawns 6). `online-combat.spec.ts:29` failed once beside other suites and
passes alone (its smoothness check is timing-bound).

**Next:** the link ready for binary updates (dormant until the server sends them), the docs, then
merge `refactor/first` and the first half's final checks.
