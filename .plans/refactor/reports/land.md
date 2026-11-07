# Workstream: land

R10.21 (land, plots and the ledger; the world's shared state; saves when a life changes), with
R10.17's part for placed things (ids from a database sequence). Branch `refactor/land`, worktree
`C:\GitHub\games\ruina-wt-land`, slot 5 (Postgres `ruina-wt-land-db` on 5485, world server 7876,
`PW_PORT=5266`, `TEST_PORT_OFFSET=150`).

This file is a running log while the work goes on (dated entries at the end); the summary at the
top is filled in when it's done.

## The Design (as it stands)

- **A life and its land.** A character's `Life` keeps what is theirs alone (`LifeState`: coins,
  seals, labor, the bag, quests, skills, contracts, buyback, the glider, home, the gathering spots'
  rest). What they've built and planted is **land** (`crates/engine/src/life/land.rs`, `Land`):
  houses, farms (a scarecrow and its cells), ships on the slipways, packs (on the ground, in a bed,
  or on their back) and vehicles. Land is the world's: the region keeps it whether its owner plays
  or not. Only its owner changes a piece, so while they play their land is **lent to their life**
  (`Life::land`) and changed by the same rules as before; the rest of the world reads it as it
  stood when the phase began. This keeps the tick that splits (R10.18): a player's step changes
  only their own life and land, so players still step in any order or all at once.
- **Kept by where it stands.** Each piece is a row of its own (`Land::rows`): its id, its kind
  (house, farm, ship, pack, vehicle), the 256 m chunk it stands in (a pack on its owner's back has
  none: it goes where they go), and the piece. `Land::from_rows` reads them back.
- **Ids.** A holding gives what's placed ids from a run (`Ids {next, end}`): offline its own, counted
  from one past the highest it has; online (the second half) runs the server reserves from the
  database's `land_ids` sequence, so no two pieces in the world share one. A run used up refuses
  ("Not just now - try again in a moment") rather than make an id up. Contracts, private, keep the
  life's own counter.
- **The land's clock.** Land's times (a house's tax paid until, an animal fed until, a pack made at)
  are on the land's clock, `land::now(life)`: online the world's (set every tick), offline the life's
  own (the browser's session is the whole world then). So taxes fall due while you're away.
- **What the keeper hears.** A step's `Change`s (`Life::take_changes`): a plot claimed, a plot let go
  (a house taken down), a pack sold. The keeper of the world's land and market (the server's game;
  offline the session) applies them after the phase.
- **Plots, contested.** One claim per plot in the world, first come, held by the registry (the
  database online). Online a claimed house waits, `pending`, until the registry confirms it
  (`housing::confirm_claim`); if someone else's claim got there first it comes down and the
  blueprint is back in the bag (`housing::lose_claim`). Taxes as before (50c a day for the cottage,
  paid a week at a time, the first 7 days free); a house whose tax goes unpaid **14 days** past what
  was paid comes down, chest and all, and its plot is free for anyone (`housing.json`'s
  `neglect.demolishAfterDays`; `housing::demolish_neglected`, run by the owner's life while they
  play and by the region's keeper while they're away). 14 days is ArcheAge's "about two weeks"
  (`design/research/land.md` 4.4): long enough that nobody loses a house to a holiday, short
  enough that a plot abandoned for a month goes back to the world.
- **The world's market.** Each trading post's demand for each pack is the world's
  (`crates/engine/src/life/market.rs`, `Market`): kept as it stood at a moment on the land's clock,
  and worked out from there (it recovers by the clock, so nothing steps it). A life reads it as the
  step began and lowers it at once for itself; the keeper applies every sale (`Change::Sold`) and
  hands the market back to everyone.
- **The weather** is no longer kept with a life: it's worked out from the world's clock every step
  (`Life::weather`), the same for everyone at the same moment.

## Log

## 2026-11-06 21:45: the engine's land, the market, taxes and demolition

- **Engine** (`crates/engine/src/life/`): `land.rs` (Land, the pieces moved out of `state.rs`, rows by
  chunk, ids, `read_saved` for saves of either shape, `rebase` for land times kept on a life's
  clock, `Change`, `now`), `market.rs` (Market), `Life` with `land`, `market`, `weather`,
  `claims_wait` and `take_changes`; every rule that read `life.state.{houses,scarecrows,ships,packs,
  vehicles}` reads `life.land` (a mechanical move); land's times on `land::now`; housing's claims
  waiting for the registry, `confirm_claim`, `lose_claim`, `neglected`, `demolished_at`,
  `demolish_neglected`, `step_housing` taking a neglected house down; the plot's tax prompt says
  when an overdue house comes down; a pending site says it's waiting for the Land Registry.
  `LIFE_VERSION` 4 (3 and before kept the land inside the life: read apart by `read_saved`).
- **Content**: `content/housing.json` `neglect.demolishAfterDays: 14`.
- **Golden answers**: before the move, the crowd scenario written in the old shape (the land put
  back into the state) gave the kept hash: the rules didn't change. Then two changes on purpose,
  kept with `RUINA_GOLDEN=1`: the crowd's answer names each life and its land apart, and a vehicle's
  id comes from the land's run, so the contracts (the life's own counter) are numbered from 1 rather
  than after the cart. The creatures', player and Emberholm scenarios are unchanged.
- **Server** (small, local edits in `play/`): a save is `{state, land, player}` (the land beside the
  life); an older one is read apart and its land's times moved onto the world's clock
  (`land.rebase(saved_at - clock)`); residents' estates read from the land; a game keeps a market
  (its lives read it, its sales lower it) and rebuilds what's solid when a house comes down.
- **Ran**: `cargo test --release --workspace` (engine 187, server 81), clippy, fmt. The browser is
  next (it still reads land from the state, so the page is broken at this commit).
- **Fixtures**: `scratch/fixtures-763d6af.json` (five lives made by today's rules: everything built,
  a plot two channels both hold, a sloop, a stake, a long-neglected house) and
  `scratch/fixtures-rig-763d6af.json` (six real rows the base server wrote during `online.spec` and
  `minigames.spec`, 23 passed against it), for the save migration's tests.
- **For tiers**: the store's land writes will be fenced by whose grant is current (the character's
  epoch for a holding written with its owner's life; the region's lease for the keeper's
  demolitions and claims), not by comparing epochs across kinds of grant. Land ids are the numbers
  of `EntityKind::Placed`.
