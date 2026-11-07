# Architecture

Ruina is a browser game on a Rust game server, with one copy of the rules in a Rust engine that both
of them run, content kept as data, and Postgres for what lasts. This page is the map: what each piece
is, how they talk, and which guide says more. The root `AGENTS.md` lists the folders in detail.

## The Pieces

| Piece | Where | What | More |
|---|---|---|---|
| The rules | `crates/engine` | Every rule of the game, deterministic: movement, combat, creatures, the world's ground, the life systems, mini-games | [engine.md](engine.md), `crates/engine/AGENTS.md` |
| The browser's rules | `crates/engine-wasm` | The engine compiled to WebAssembly, with the browser's game (`session.rs`) | [engine.md](engine.md) |
| The client | `src/` | Three.js and TypeScript, built by Vite: the way in, the game's wiring, drawing, the interface, input, the connection, the developer pages and the bible | Each area's `AGENTS.md` |
| The server | `crates/server` | `ruina-server` on one port (axum): the accounts API, the game's files, the admins' pages and the world's WebSocket, and the games it plays | [world.md](world.md), [admin.md](admin.md) |
| Content | `content/` built into `shared/` | Every kind of thing as files, checked and built into the bundles both sides read | [content.md](content.md) |
| Assets | `src/render/assets/`, `src/ui/theme/` | Models, textures, sounds and icons, listed in a manifest and loaded by need | [assets.md](assets.md) |
| What lasts | Postgres, `crates/server/migrations/` | Accounts, sessions, and characters: each one's life (estate included), build and home channel | `crates/server/src/store/db.rs` |
| Tools | `crates/tools`, `tools/` | The conformance programs and the balance harness; contentc, the asset and icon tools, bug reports | `tools/` |
| Tests | `tests/` | The unit, integration and stress tiers | [testing.md](testing.md) |
| The bible | `bible/`, `src/bible/` | How the game works, exactly, from its own rules and content | `src/bible/` |
| Deploys | `Dockerfile`, `railway.json`, CI | `beta` and `production` on Railway | [deploys.md](deploys.md) |

## One Copy of the Rules

A rule lives in the engine alone (`crates/engine`). The server runs it natively, and the browser runs
the same code compiled to WebAssembly. The engine uses no clocks, threads or I/O, and the browser's
random numbers and maths, to the bit, so both sides reach the same answers.
- **The golden tests** hold the answers of its scenarios (`crates/engine/tests/golden/`).
- **The conformance tier** holds the WebAssembly to the native engine.
- **Content is data.** The engine reads its kinds, creatures, items and places from the bundles.

How each side reaches it: [engine.md](engine.md).

## A Game Online

1. **The way in.** `index.html` loads `src/app/boot.ts`, which carries only the title screen,
   sign-in and character select (`src/app/online.ts`, the accounts API). The rest of the game is
   fetched once a character is chosen.
2. **The connection.** The page opens `/ws/world?character=<id>`. The server's welcome says:
   - the protocol and the content's hash, so a page built from other content reloads;
   - the account and character, the channel and space you're in, and your build;
   - the estates and plots in your channel, and whether you're an admin.
3. **Inputs and commands.** The page sends what you press 60 times a second, as small binary frames:
   a sequence number, the tick it drew everyone else at, and the keys packed. Commands (buy, plant,
   build, enter a dungeon) go as JSON. Nothing a browser says about its own state is believed.
4. **The tick.** One thread, `world`, steps every game 20 times a second, three of the rules' frames
   each (`crates/server/src/gate/socket.rs`, `spawn_world`). A game is a channel of the world or a
   copy of an instance (`play/spaces.rs`). Each tick it:
   - runs each player's inputs as real time allows;
   - steps their lives, the creatures, arrows and meteors, the tables and the bots;
   - checks hits where the attacker saw their target (lag compensation).

   The tick goes in phases, so the order things are stepped in changes nothing
   (`crates/engine/AGENTS.md`). Ticks are numbered from the world's epoch (`play/clock.rs`).
5. **What a page hears.** Each tick, each player is sent:
   - their own player, to check the page's guess against;
   - everyone else in their channel, and the creatures;
   - arrows, meteors, and what happened.

   Their life (bag, coins, quests, estate) is sent when it changes.
6. **Prediction.** The page runs your moves through the same rules at once, without waiting
   (`src/net/netPlayer.ts`). When the server's word on you arrives, it starts from there and runs
   again the inputs the server hadn't seen yet. Everyone else and the creatures are drawn a little in
   the past, between two ticks (`worldPeers.ts`, `actorTimeline.ts`).
7. **Saves.** Lives are saved to Postgres in batches by a task beside the world thread. A save is
   fenced: only the session that holds the character may write (`characters.live_session`). A deploy
   tells every page, saves everyone, and closes; pages reload into the new build ([deploys.md](deploys.md)).
8. **Spaces.** Going through a portal, or into a developer zone from the Admin menu, moves you to
   another game mid-connection, your life and all ([world.md](world.md)).

## A Game Offline

Without the server, the browser's session plays everything: you, the creatures, your life, and
copies of instances (`crates/engine/src/session.rs`). Offline, the session also stands in for the
server's combat (`training.rs`): blows with their hit pause and aim assist, arrows, meteors and
heals. The tests play this way: paused and stepped a frame at a time with `?test`, or in a copy of
an instance with `?test=<instance>`. So does development, running, with `?offline`. The rules tests
play it in Node, with no page (`tests/support/headless.ts`).

## The Client's Areas

| Area | What | Never imports |
|---|---|---|
| `src/app/` | Start-up and wiring: `src/main.ts` builds the game and hands its modules what they need | (where the areas meet) |
| `src/engine/` | The bridge to the rules: the only way to them, and the views read back after each step | Drawing, the interface, the network, the app, input, the developer pages, the bible |
| `src/render/` | Drawing: it reads the rules' state and never changes it | The network, the interface, the app, the developer pages, the bible |
| `src/ui/` | The interface: it shows what it's handed and asks the app for what it does | The network, the app, the bible |
| `src/net/` | The world connection, prediction, and everyone else as the server sends them | Drawing, the interface, the developer pages, the bible |
| `src/input/` | Keys, mouse and controller, and auto-run | Drawing, the interface, the network, the app, the developer pages, the bible |
| `src/content/` | Typed readers of the bundles, and looks | Anything of the game's but the assets |
| `src/assets/` | The asset catalogue and the loader | Anything of the game's |
| `src/dev/`, `src/bible/` | The developer pages and the content library; the Ruina Bible | (no limits) |

`tests/unit/boundaries.test.ts` holds these lines, with each exception and its reason. Each area's
`AGENTS.md` says more.

## Content and Its Ids

`content/` holds a folder per kind and a file per thing. `npm run content` (`tools/content/contentc.mjs`)
checks each against its schema and every cross-reference, and builds the bundles both sides read
(`shared/*.json`), with their hash. The server builds them in, and the browser loads them.
- **Saves and builds** name things by id.
- **The wire** carries a thing as its place in its bundle's order, which both sides take from the
  same bundle. The hash in the welcome makes sure they have the same one.
- **A new thing of a kind the game knows** is files alone ([content.md](content.md)).

## Where It's Going

The world is one seamless world of regions, with instances beside it ([world.md](world.md)). Its
foundations are laid in one process:
- the world map of regions on chunks, its ground answered across them;
- spaces, so an instance is played round its own origin;
- a tick that splits, so players can be stepped all at once;
- the world's clock.

After the refactor, the world splits between several servers:
- the server in tiers;
- regions owned by simulations, their borders crossed seamlessly;
- land shared by every channel and contested;
- channels opening and merging with the crowd.

The research and the decisions are in `.plans/world/research.md`, and the steps are in
`.plans/refactor/tracker.md` (R10.8, R10.17 to R10.24).

### Several Processes

`ruina-server` plays every tier in one process by default, as Railway's beta does. Started with
`--role gate|sim|services`, it plays one role in a process of its own (`crates/server/src/cluster/`):

| Role | Plays | Today (scaffolding until the tiers run apart) |
|---|---|---|
| `all` | Everything, in one process (the default) | The server as it always ran |
| `gate` | Players' connections: sign-in, each player's inputs to the sim that plays them, each client's update | Finds the sims in the directory, keeps a link to each and asks how it is |
| `sim` | Spaces: a region's channel or an instance's copy, each under a lease | Stands for its spaces, and plays each as a stand-in while it holds its lease |
| `services` | The directory, the store, social | Forgets processes long gone |

- **Finding each other.** Every process writes itself into the directory's `nodes` table (its role,
  where its links take messages) and beats there every 2 s.
- **Links.** Processes talk over TCP (`crates/link`) with the messages the tiers pass in one
  process (world-api's, as MessagePack with field names). A message arrives once and in order
  across lost connections, and a restarted peer is sent what it never acknowledged.
- **Leases and epochs.** `space_leases` says which sim plays each space (or part of a region),
  under which epoch, until when.
  - A grant bumps the epoch. The holder renews a lease of 10 s every 2 s.
  - A sim that can't renew stops 2 s before its lease runs out (`keeper.rs`).
  - Every write about a space carries its epoch and passes the fence (`leases::check`: the lease's
    row FOR SHARE, inside the write's transaction). So a sim that lost its space can't write over
    whoever has it now. A character's own epoch (the store's) fences their life the same way.
- **Taking over.** A sim that dies leaves its leases to run out. One standing by takes the space
  under the next epoch, and carries on from its last snapshot (`space_snapshots`).

The tiers' messages cross the links once the gate and the sims run apart (the multi-server work's
second half, `.plans/refactor/reports/multiserver.md`). Running several processes:
[deploys.md](deploys.md).
