# The Wire for Crowds (R10.8): Report

Workstream **wire** (`refactor/wire`, worktree `C:\GitHub\games\ruina-wt-wire`, slot 4), started
2026-11-06 from `refactor/first` at 763d6af. The plan: [finish.md](../finish.md). The first half (the
protocol, its codec both ends, the feed's adapter, far peers as crowd bodies) goes ahead of the
server's tiers; the second half (the gate and the sims on it, measured) waits for them.

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
