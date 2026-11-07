# Borders (R10.19): the Workstream's Report

The borders workstream of the finishing push ([finish.md](../finish.md)): one world played by several
simulations, each owning a set of chunks, its borders crossed as if they weren't there. Branch
`refactor/borders`, worktree `C:\GitHub\games\ruina-wt-borders`, slot 6.

**First half: done.** **Second half: waiting** (tiers has landed on `refactor/first` and is merged
here; the orchestrator's word starts it). `npm run check` passes after the merge (263 TypeScript
tests; the engine's 200, the order test's 5, the WebAssembly's 4, the server's 90, world-api's 6).
The guides (`docs/world.md` Borders, `crates/engine/AGENTS.md`) wait for the end's one pass, at the
user's word.

## What Landed

| Commit | What |
|---|---|
| ed02f7d | tiers' first cut of `crates/world-api` merged in (86d6055), to build on `EntityId` |
| 80e02a0 | The phased tick in parts (`combat.rs`, `actors.rs`, small and local): ghosts, a phase worked out, sent away, landed, told |
| f34d5a5 | `crates/engine/src/border/`: ownership, messages, one simulation's part, the lockstep harness; `checks/border.rs` |
| 4463367 | The golden split test (`tests/golden/bordercheck.json`) |
| 730c4bb | The crossings (`border/crossings.rs`), the gate's part, resends, epochs |
| c5e29af | `refactor/first` merged in (tiers' server; no conflicts) |
| a927fb5 | What borders cost (measured), `Owners` faster on fine grids, the unit tier's checks on the new files |

- **`border/mod.rs`:** `Owners`, the directory's table of which simulation owns each chunk (256 m;
  finer for tests: `Owners::grid`), with distances to a simulation's ground; `HANDOFF` 28 m past the
  border, `BAND` 120 m of ghosts; `SimId`, `Epoch`.
- **`border/messages.rs`:** every message serde: ghosts of players (whole, with their vehicles) and
  creatures, their history the first time a neighbour sees them; blows, heals and what's told of them
  (combat's `Across`); creatures' slams and blows (`Struck`, keyed so they land in the global order);
  handoffs (`Moving`: a player's slot whole, life as `LifeForm`, queue, budget, history, bot), `Taken`,
  inputs sent on.
- **`border/sim.rs`:** one simulation's part: what it owns, the ghosts it sees (refused under an older
  epoch), its bots and their views, handing over at the end of a tick (a driver with their passengers
  as one unit, the vehicle and cargo in the driver's life; a passenger whose driver is elsewhere goes
  to them), taking over (idempotent by epoch), inputs queued once in order, sent on, or kept for a
  player on their way.
- **`border/split.rs`:** steps several simulations in lockstep, trading at every phase boundary (below);
  `Gate` holds a player's inputs during a handoff and routes them to the taker from the input it runs
  next; a gate that hears late sends them to the old owner, which sends them on. `wire` writes every
  post out as JSON and reads it back, as between processes.
- **Engine changes outside the module:** `combat.rs` (ghost slots; `work_out`/`fly_effects`,
  `send_away`, `land`, `settle`; a blow's `Source` is a slot or when and by whom an arrow or meteor was
  loosed; `join_open_at`, `depart`, `arrive`, histories), `actors.rs` (`ghosts`, read by players' hit
  queries; slams and creatures' blows say who dealt them), `missiles.rs` (a hit names its missile),
  serde on `Player` (skipping what a step keeps for itself; `Player::resolve` after reading), `Actions`,
  `Bot`, `Rng`; the crowd check's types shared and fighters that walk.

## Proved

- **Bit for bit (golden):** `bordercheck.json` keeps one simulation's answer for two crowds; every split
  each lists gives it too, all ticks (`checks/mod.rs` `a_world_split_between_simulations_plays_as_one`,
  half of them with every post written out and read back): the crowd's scenario at x = 0, round the
  origin, and along a line through the fight; two sides fighting across x = 0 (healers, meteors, bows,
  a wanderer on the line, slimes west and a goblin band east), a walker each way and a farm cart with
  a passenger handed over, at x = 0, round the origin and four ways through the fight. The harness
  with one simulation is the crowd's check hash for hash (`play_tick`'s tick).
- **Crossings:** the fixture worlds (map.rs's mainland and archipelago, copied into
  `crossings.rs` until bigworld's three-region world is used) split at the border between their
  regions: on foot, by cart with a passenger, by glider (open across the handoff) over a land border,
  by rowboat with a passenger over the sea. Each the same to the bit as one simulation, handed over
  28 to 31 m past the border, every input run once, everyone and every vehicle held once. Also: a late
  gate (strays sent on, still exact), a handoff said twice (taken once, exact), one lost (sent again,
  a tick on the way, nothing lost or run twice), a ghost or handoff under an older epoch refused.

## Numbers

`cargo test --release -p ruina-engine what_borders_cost -- --ignored --nocapture` (posts written out as
JSON; a binary form takes fewer):

| | The crowd, a line through the fight | Two sides across x = 0 |
|---|---|---|
| A tick, one simulation / split in two, in one process | 0.59 / 0.78 ms | 0.49 / 0.66 ms |
| Ghosts a tick | 37 KB (24 player and 14 creature ghosts sent) | 60 KB (39 and 14) |
| A ghost player / with its history (first sight) / a ghost creature | 1.45 KB / 4.0 KB / 0.15 KB | the same |
| Blows, heals and what's told of them across, a tick | 142 B | 115 B |
| Handoffs | none | 4, 26.5 KB in all; the cart with its passenger (two players, two lives) 10.9 KB |

A ghost goes four times a tick (each phase boundary that reads it), whole. A compact ghost (what the
others read: about 100 B binary) sent once and changed parts after would cut the ghosts' bytes about
tenfold; a handoff is rare and can stay whole.

## Decisions

- **Exactness needs a trade at each phase boundary, not once a tick.** R10.18 lands each phase's
  events at that phase's end, so a phase reads what the one before changed. Eight barriers a tick:
  blows and heals out, what's told back (inputs); ghosts; the same for arrows and meteors; ghosts;
  creatures' slams and blows out; ghosts (for the history); and ghosts at the start of a tick after a
  handoff. In one process that's free. Across processes it's eight round trips a tick in lockstep
  (sub-millisecond each in a datacentre, but the slowest simulation sets everyone's pace), or ghosts a
  tick late with one trade a tick, correct but no longer bit for bit (research 3.8). For multiserver
  to choose; the messages are the same either way.
- **Slots are the order.** The tick orders everything by slot (blows, heals, arrows, foes), so a split
  world gives a player the same slot in every simulation and a handoff keeps it. Across processes the
  slot must become a global key (the `EntityId`'s order), with `Players` keyed by it.
- **What a simulation counts over all it owns stays its own:** a creature family's caps and respawns
  (ladders, bands), and the numbers of what's born in a fight (pieces of a burst, missiles, arrows'
  ids). Exact while each family stands on one side, as regions keep them; creatures are owned by
  their home's simulation and never handed over (the leash). A creature's nearest foe has no range
  limit in its brain, so one beyond the band sees differently: a sight cap would close that.
- **Ghosts are whole players** (simple, exact); a compact ghost (what others read: where, team, down,
  facing, the foe's few numbers, vehicles' circles) is the saving when bandwidth counts.
- **A handoff freezes at a tick's end and is taken at the next start:** no tick lost or doubled;
  sent again until taken; an epoch refuses anything stale.

## What Others Must Know

- **offline (065687b)** changes `step_by` to `(actors, tick, &mut OpenWorld, drive)`: at that merge,
  `work_out` takes the same and `settle` an `&mut OpenWorld`; `Sim::flat` goes.
- **tiers:** `Player` reads and writes whole now, so `records::PlayerState` and `Carried` could carry it;
  a border handoff needs more than `Carried` (queue, budget, history, bot): `border::messages::Moving`.
  `border::{SimId, Epoch}` are `world-api`'s shapes (transparent u64): world-api can take the engine's.
- **land:** `LifeForm` carries a life whole for a handoff; what's built is made solid per simulation, so
  houses near a border need land's rows on both sides.
- **multiserver:** the posts are serde and proved written out and read back; the barrier choice above.

## Second Half (when told)

The messages into `crates/world-api` (a `ToSim::Border` post); region simulations on the tiers' sim
layer owning their chunks and trading through the post; the gate's `Heard::Moving`/`Taken` in the
gate tier, buffering and re-routing by sequence number; the directory keeping `Owners`; an
integration spec crossing between two simulations of one process, and the server's tests.
