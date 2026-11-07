# Borders (R10.19): the Workstream's Report

The borders workstream of the finishing push ([finish.md](../finish.md)): one world played by several
simulations, each owning a set of 256 m chunks, its borders crossed as if they weren't there. Branch
`refactor/borders`, worktree `C:\GitHub\games\ruina-wt-borders`, slot 6.

- **First half** (now): the engine's border module (ownership, ghosts with their history, the
  handoff's state machine with epochs, blows and heals across, a vehicle with its passengers as one
  unit, creatures leashed) and a harness stepping several simulations of one world in lockstep in one
  process, trading plain serializable messages. Proved two ways: Emberholm split in two matches one
  simulation bit for bit (a golden test), and the fixture world's borders crossed on foot, by cart
  with a passenger, by boat and by glider.
- **Second half** (waiting on tiers): the messages into `crates/world-api`, region sims on the tiers'
  sim layer trading them through its transport, the gate re-routing inputs by sequence number across a
  handoff, the directory recording who owns which chunks, and the online game crossing a border
  between two sims of one process.

## Running Log

## 2026-11-06 21:40: Started; the phased tick taken in parts

- **Merged tiers' first cut of `crates/world-api` (86d6055)** into `refactor/borders` (ed02f7d), at
  the orchestrator's word, so the border code is written against the engine's `EntityId` (Players
  keyed by it since fb87743) and the server's new layout. The one conflict, `design/status.json`, kept
  both sides (refactor/first's four entries, tiers' path `sim/clock.rs`).
- **The phased tick in parts (80e02a0),** a small change to `combat.rs` and `actors.rs`, so several
  simulations can trade what crosses between them inside a tick:
  - ghosts: a slot can hold a player another simulation owns (`Players::ghost`), seen, swung at and
    healed like anyone but never stepped, their vehicles solid; `Actors::ghosts` holds creatures seen
    across a border, which players' swings, arrows and blasts reach;
  - a phase in parts: worked out (`work_out`, `fly_effects`), sent away (`send_away`: blows and heals
    on what's owned elsewhere), landed (`land`, with what other simulations dealt this one's own,
    merged in the global order), told (`settle`: numbers and credits, in the order the blows landed
    wherever they landed). `step_by` and `step_effects` still do all three at once;
  - every order that decides anything is global: a blow's source is a slot or when and by whom an
    arrow or meteor was loosed (`Loosed`, the order the list kept them in), slams and creatures'
    blows say who dealt them.
  - No golden answer moved: the engine's 183 tests pass, the crowd's sixteen shuffles too; clippy
    clean over the workspace.
- **Design so far** (to be written up in full at the end): exactness needs an exchange at each phase
  boundary, not just once a tick, because R10.18 lands each phase's events at the end of that phase
  (no tick of delay). The barriers per tick: ghosts at the start; blows and heals out after the
  inputs, what's told of them back; ghosts again before arrows and meteors; their blows out and told
  back; ghosts again before the creatures; creatures' slams and blows out; ghosts again for the
  history. Creatures' families (ladders, bands) are counted per simulation: exact while a family
  stands on one side, which regions keep (creatures spawn away from borders and never cross).
- **Next:** the border module itself (`crates/engine/src/border/`), the lockstep harness, the
  golden split test, the fixture crossings.
