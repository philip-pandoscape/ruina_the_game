# Workstream: land

R10.21 (land, plots and the ledger; the world's shared state; saves when a life changes), with
R10.17's part for placed things (ids from a database sequence). Branch `refactor/land`, worktree
`C:\GitHub\games\ruina-wt-land`, slot 5 (Postgres `ruina-wt-land-db` on 5485, world server 7876,
`PW_PORT=5266`, `TEST_PORT_OFFSET=150`).

This file is a running log while the work goes on (dated entries at the end); the summary at the
top is filled in when it's done.

## Where It Stands (the first half, 2026-11-06)

**Done, on `refactor/land`:** the engine's land apart from a life (lent to its owner's life while
they play, kept as rows by chunk, ids from a run, on the land's clock), contested plots (claims
confirmed or lost through the registry, taxes on the world's clock, a neglected house taken down
after 14 days), the world's market, the weather out of the life, the ledger's entries; the browser
reading all of it; the content's `neglect`; migrations 0010-0013 and the store's queries
(`crates/server/src/land/`: fenced saves with land, plot claims, transfers, market sales, the keeper's
reads and demolitions, ids by block, the save migration), tested against a real Postgres (the plot
race, a transfer twice, land by chunk, demolition, two servers' sales, today's saves migrated with
everything back); the docs and the bible. The server plays as before in small edits (land beside the
life in its save, read apart from older saves with times moved onto the world's clock; a market per
game).

**Waiting on tiers (the server's side, the second half):** the server onto the store and sims:
lives saved alone when they change, land in rows lent and returned, claims through the registry,
the keeper (demolitions, absent owners' farms), one market for the world, pots through the ledger,
residents and each channel's plots gone, the migration run at start, the region's land in the
welcome and updates; then the integration tier whole.

**For other workstreams:**
- *tiers*: each function in `crates/server/src/land/` is one transaction, to become one `ToStore`
  message (listed under the design's last point). Land writes are fenced by whose grant is current
  (`land::Fence`): the character's epoch for a holding written with its owner's life, the region
  lease's for the keeper's demolitions; not by comparing epochs across kinds of grant. A
  character's writes must reach the store in the order they were made (a save made before a claim
  would take the claimed house down). `LifeWrite.life` becomes `{state, player}` with the land
  beside it in rows; `Resident.state` goes (the region's land replaces residents). Land ids are
  `EntityKind::Placed` numbers.
- *channels*: land is one per region, the same in every channel; what moves (a vehicle being
  driven, a pack being carried) is its owner's channel's until it stops (parked, set down), then the
  region's. Changing channel needs nothing of land: the holding goes with the life.
- *multiserver*: the store's tables need nothing per process; `land_blocks` hands out ids to every
  process; `plots`' primary key and `ledger`'s key are what keep two servers honest.
- *words*: new names use life and land; `characters.island` still holds the life (`{state,
  player}`), for the words workstream to rename.

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
  from one past the highest it has; online (the second half) a block of 1024 the store reserves from
  the database's `land_blocks` sequence (hi/lo: block b is b * 1024 up to (b + 1) * 1024), so no two
  pieces in the world share one and placing one needs no trip to the database. A run used up
  refuses ("Not just now - try again in a moment") rather than make an id up. Contracts, private,
  keep the life's own counter.
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
  (`Life::weather`), the same for everyone at the same moment. (Each region's own weather, with its
  own dice, is left: there is one region, and the browser's `rainAt` would need it too.)
- **The ledger.** A row is one character's side of a transfer (what they gained, negative for what
  they gave, and who with: `vendor:mara`, `post:westwatch`, `registry`, `character:42`), keyed by
  which transfer and whose side, so one sent twice is written once. A life keeps what it moves with
  the world (purchases, sales, buybacks, payouts, contract bonuses, workbench fees, crafting coin,
  taxes, quests' rewards, grants) in `state.ledger`, numbered by its own count, until the store
  writes them with its next save in the same transaction (`life:<character>:<n>`), then forgets
  them (`Life::recorded`). A pot is a transfer of its own: both sides and both lives, one
  transaction, one key.
- **Saves**: a save is the life alone (`{state, player}`), its land in rows beside it, written in one
  transaction with the land lent to it and its ledger entries, fenced by the grant it's made under
  (`land::Fence`: today `characters.live_session`; tiers' character epochs and region leases next).
  Saves from before are moved by `land::migrate::run` at start (below).
- **Store functions as messages.** Each function in `crates/server/src/land/` is one transaction, so
  each becomes one `ToStore` message when the server is in tiers: `save` (WriteLives with land),
  `plots::claim`, `plots::take_down`, `ledger::transfer`, `market::sold`, `reserve_ids`, `load_land`
  (a region's chunks), `load_holding` (a character's land), `migrate::run` (at start).

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

## 2026-11-06 22:40: the browser, the store's tables and queries, the save migration

- **5ab4285** The browser reads land where it now is: `src/engine/life/land.ts` (Land, the pieces,
  Market), the island view's `land`, `market`, `weather` and `now` (the land's clock, which the
  engine's view now carries), the tick's life with land and market, every reader moved
  (drawing, HUD, windows, peers' estates, online wiring), saves `{state, land, player}`. The bible:
  housing (plots claimed once in the world, the Land Registry's confirmation online, tax on the
  world's clock, a neglected house coming down after `neglect.demolishAfterDays`), trade (demand is
  everyone's; packs age by the world's clock), weather (which clock counts what).
- **b8bbdba** The test API's `life()` gives each post's demand as it stands now. Against the land
  server on this slot's rig (PW_WORKERS=3): world.spec, online.spec and minigames.spec, 38 passed.
- **6150196** Migrations 0010-0013 (land, plots, ledger, market) and `crates/server/src/land/`
  (`mod.rs`: Fence, save, write_holding, load_land, load_holding, reserve_ids; `plots.rs`; `ledger.rs`;
  `market.rs`; `migrate.rs`), the engine's ledger entries. Tests (`crates/server/tests/land.rs`,
  beside the crate so the content-id scan of `src/` leaves their ids alone) against a database of
  each test's own (`RUINA_TEST_DATABASE_URL`; without it they note it and pass), all 7 passing on
  the rig:
  - a plot claimed once with both claims racing, on every plot (the loser's house never reaches the
    world; a stale grant writes nothing);
  - a pot's transfer sent twice applied once (the second, with other lives, changes nothing); a
    life's ledger entries written once however often the save is;
  - land read back by chunk (a region's keeper), a holding whole (its owner), pieces gone when the
    life no longer has them, a replaced window writing nothing;
  - a neglected house taken down by the keeper with the engine's rule, its plot claimed again;
  - two servers' sales at once both lowering demand, as the engine works it out to the bit;
  - today's saves (6 rows written by 763d6af's server during online.spec and minigames.spec on this
    rig, 5 made by its rules: everything built, one plot built on in three channels, a sloop, a stake,
    a long-neglected house) moved into rows: every character back with everything (the life as it
    was, the land as it was but its ids, times on the world's clock with as much left as before),
    rise-1 kept by the first-made (12), the others' houses moved whole to rise-2 and rise-4 (rise-3
    stays 105's), a second start finding nothing to move.
- **The migration's plot rule**: plots are worked out for everyone first (the registry's claims
  stand, then the first-made character with a house on each), then each other house on one goes to
  the first plot nobody holds, in the order its owner was made; with none free it's taken down into
  its owner's bag (what doesn't fit is named in the log and the report). Two channels both building
  on one plot needed 25 characters on a server (24 to a channel), so beta likely has none.
- **Engine**: `farming::grow_land` (the farms of someone away, for the region's keeper).
- **Docs**: `docs/world.md` (Land, Plots, the Ledger, What the World Shares, Saves; the channels as
  they are until the server moves onto the store), `docs/architecture.md` (what lasts, saves),
  `docs/content.md` and `content/AGENTS.md` (`neglect`; a plot's id is its claim), `docs/testing.md`
  (`RUINA_TEST_DATABASE_URL`), `crates/engine/AGENTS.md`, `src/engine/AGENTS.md`.
- **Merged** `refactor/first` (3c9c040): no conflicts.
- **What's left, waiting on tiers** (the server's side): lives saved alone when they change (a
  command run, land or ledger changed: within a second; otherwise at most a minute) with their land
  in rows and their ledger entries, through the store; `migrate::run` at start; land loaded by a
  region's keeper and lent to lives as they arrive (ids from `reserve_ids`); claims through
  `plots::claim` with `claims_wait` on (confirm or lose); the keeper taking down neglected houses
  of owners away and growing their farms; the market through `market::sold` and shared by every
  channel; pots through `ledger::transfer`; residents and each channel's plots gone; the welcome
  and updates carrying the region's land.

## 2026-11-06 23:20: the first half, tested; the server's side waits on tiers

- **4f93b5d** The docs (world.md's Land, Plots, the Ledger, What the World Shares, Saves; the
  architecture's saves; content's `neglect`; testing's `RUINA_TEST_DATABASE_URL`; the engine's and
  the bridge's AGENTS.md) and the store's tests beside the crate (`crates/server/tests/land.rs`).
- **Ran** on this slot's rig (the server built from this branch, migrations 0010-0013 applied to
  its database), `PW_WORKERS=3`: world.spec, online.spec, minigames.spec, village.spec, sea.spec and
  update.spec, **46 passed** (farming, livestock, pack running, carts, boats, mounts, the
  shipyard's and the house's quests offline; houses, carts and plots online; pots; a server update
  bringing everyone back with their land). Before any change, today's server passed online.spec and
  minigames.spec (23) on the same rig. The store's tests: 7 passed against the rig's Postgres.
  `npm run check` passes: typecheck, biome, knip, rustfmt, clippy, the TypeScript unit tier (263),
  the engine's 188 and its order test's 5, the WebAssembly's 4, the server's 81 and the store's 7
  (which, given no database there, say so and pass).
- **Golden answers**: the creatures', player's and Emberholm's unchanged; the crowd's re-kept on
  purpose (first entry: its answer names each life and its land apart, and its contracts are
  numbered on their own; the old-shaped answer matched the kept hash before the move).
- **Decisions** (and why):
  - *Land is lent to its owner's life* rather than changed in place by a region-wide store: only
    the owner changes their pieces today, so a player's step still changes only their own, the
    tick still splits, and a life and its land are saved in one transaction (no duplication
    between them). Anyone else's interaction with your land (a public farm, a guild's house) would
    be a `Change` for the keeper, as a sale is.
  - *Land's times on the world's clock*: taxes must fall due while you're away, and everyone looking
    at a house must agree whether it's overdue. Old saves' times are moved onto it from the moment
    they were saved, keeping what was left of each.
  - *14 days, then demolished, chest and all*: ArcheAge's two weeks; the plot prompt counts the days
    down; nothing comes back (no mail yet: a refund would need deliveries to an absent life, which
    the ledger could carry later). The design tracker's "freed plots by lottery" is left for later:
    the plan says first come.
  - *The ledger records a character's side of every transfer* (life↔world and character↔character)
    so its keys make each idempotent; a life's own entries ride its save.
  - *Market demand recovers by the clock* (kept as value and moment) so no keeper steps it and a
    sale is one SQL statement from any server, worked out exactly as the engine does.
  - *Ids by block (hi/lo, 1024)*: a holding places things without a database round trip; a used-up
    run refuses for a moment rather than inventing an id.
  - *The migration's plot rule*: the first-made character keeps a plot several channels built on;
    others move whole to the first free plot, or (none free) are taken down into their owner's bag.

