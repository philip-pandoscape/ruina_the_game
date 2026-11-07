# crates/server

The game server, `ruina-server`: accounts and characters, the world played online, and what lasts
in Postgres. It is built in tiers that only send each other messages (`crates/world-api`), all in
one process today; a process of the multi-server version runs a part of them, its messages to the
rest crossing a transport between processes instead of channels, with the tiers none the wiser. How
the pieces fit: `docs/architecture.md` (A Game Online); the world, its channels and copies:
`docs/world.md`.

```text
browser ─WebSocket─▶ gate ──Inputs, Ask──▶ sim (a thread for each region channel and instance copy)
                      ▲  ◀── Tick(Arc<TickOut>): records by 32 m cell, private state per player ──┘
   directory: claims (character epochs), routes between spaces, copies and their owners, leases
   store: lives, builds, residents; every write fenced by its character's epoch
   social: parties and invitations; told who's online and where by the directory
```

| Module | What |
|---|---|
| `main.rs`, `start.rs` | Starting things: the arguments and environment (`main.rs`), and the tiers (`start.rs`: `start` runs them all; `services` and `gate` are the parts a process's role picks) |
| `post.rs` | The post: world-api's `Transport` over channels, a mailbox for the store, social and the directory, and one for each gate and each simulation; mail for an address not held here goes through `set_remote` (crates/link) |
| `gate/` | Players' connections. `socket.rs`: the WebSocket, its way in (`way_in`: the directory's claim, the store's life, the simulation's arrival, the home channel's estates), what the browser sends routed to the simulation it plays in now (or to social), its seat let go however it ends. `mod.rs`: the gate's task (who is connected and where they play, ticks fanned out to them, its questions answered) and the server stopping for an update (`stop_world`). `encode.rs`: the JSON a browser reads, from a tick's records and the tiers' messages: the one place an encoding lives |
| `sim/` | The simulations. `mod.rs`: a space's game (`Game::channel(region, n)`, `Game::copy(instance, n)`): its players and their lives, creatures, bots (`bots.rs`), mini-game tables (`tables.rs`), channels' residents (`channels.rs`), the clock (`clock.rs`), stepping (`stepping.rs`); what it says and wants written waits in its outbox. `host.rs`: its thread (mail at tick boundaries, 20 ticks a second while anyone's there, players handed to and from other simulations, whoever doesn't belong in a copy put out). `publish.rs`: a tick's records for the gates |
| `store/` | What lasts: lives and builds read and written, fenced by the character's epoch (`WHERE epoch = n`), a pot's lives in one transaction; a channel's residents. `db.rs` the pool and the migrations (`migrations/`, applied on start); `memory.rs` the same tables and rules in memory, for the tests |
| `directory/` | Who plays where: claims (`grants.rs`: the character's epoch bumped, their home channel given), routes into copies and home (each a newer epoch), copies and their owners, occupancy, copies closed `COPY_KEPT` after their last player left, the leases of spaces (`leases.rs`: a trait, in memory for one process) |
| `social/` | Parties (`parties.rs`) and invitations; party views from who's online and where (the directory tells it) |
| `accounts/`, `http.rs` | Accounts, sessions and characters; the one port (the API, the game's files, the admins' pages, `/ws/world`) |
| `tests.rs` | The tiers together as players use them (without a socket): claims, moves between simulations, parties across them, copies kept and closed, developer zones |

## Rules

- **Tiers talk only in world-api's messages**, through a `Transport` (`post.rs` in one process). No
  tier holds another's state or a lock another takes. A new kind of message goes in
  `crates/world-api` (its rules: `crates/world-api/AGENTS.md`); its handling in the tier it's for.
- **A simulation owns its space alone** and takes its mail at tick boundaries. Moving a player is a
  message carrying them whole (`ToSim::Transfer`); the directory says where (`ToDirectory::Route`)
  and grants them there under a newer epoch. Never reach into a game from outside its thread.
- **Every write about a character carries its epoch** (`LifeWrite::epoch`), and the store refuses a
  stale one. A life is put away (`sim::island_of`) and taken up (`sim::load_island`) in the
  simulation, read and written in the store (`Db::load_life`, `Db::write_lives`).
- **Nothing a browser says about its own state is believed**: it presses keys and asks.
- **What a tier needs of another comes as a message**: parties (social), who plays where and which
  simulation plays what (the directory), a mini-game's table (the simulation both players are in:
  a challenge needs them a few metres apart, and a seated player can't leave).
- Words: world, region, instance, channel, copy, space, chunk, cell, land, life (`docs/world.md`).

## Tests

- `cargo test -p ruina-server`: each tier's own (the store's fences, the directory's grants and
  leases, the gate's encoding, the post), the games' (`sim/`: builds, swings, riding along, tables,
  bots, a battle's golden hash, the order players step in changing nothing), a slow simulation
  holding up nobody else (`sim/host.rs`), and the tiers together (`tests.rs`). With
  `RUINA_TEST_DATABASE_URL` the fences are checked against Postgres too.
- How long a tick takes with the battlefield's bots, the simulation's part and the gate's apart:
  `cargo test --release -p ruina-server tick_time -- --ignored --nocapture`.
- The online integration specs play it in a browser (`docs/testing.md`, a private rig).
