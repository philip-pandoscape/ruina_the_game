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
