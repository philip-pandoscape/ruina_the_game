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
| The server | `crates/server` | `ruina-server` on one port (axum): the accounts API, the game's files, the admins' pages and the world's WebSocket. Inside, its tiers: the gate, a simulation for each channel and copy, the store, the social tier and the directory, joined only by the messages of `crates/world-api` | `crates/server/AGENTS.md`, [world.md](world.md), [admin.md](admin.md) |
| Channels | `crates/channels` | The policy that fills a region's channels, opens another past a soft cap, merges a quiet one and lets players change; pure, played by the server's directory (R10.22) | [world.md](world.md) (Channels), `crates/channels/AGENTS.md` |
| Content | `content/` built into `shared/` | Every kind of thing as files, checked and built into the bundles both sides read | [content.md](content.md) |
| Assets | `src/render/assets/`, `src/ui/theme/` | Models, textures, sounds and icons, listed in a manifest and loaded by need | [assets.md](assets.md) |
| What lasts | Postgres, `crates/server/migrations/` | Accounts, sessions, and characters: each one's life (estate included), build, home channel, and the epoch every write about them carries | `crates/server/src/store/` |
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
4. **The tiers.** The server is in tiers that only send each other messages
   (`crates/world-api`), in one process or several (Several Processes, below;
   `crates/server/AGENTS.md`):
   - the gate holds the connections (`gate/`);
   - a simulation plays each region's channel and each instance's copy, on a thread of its own
     (`sim/`);
   - the store keeps what lasts (`store/`), the social tier the parties (`social/`);
   - the directory says who plays where and which simulation plays what (`directory/`).
5. **The tick.** Each simulation steps its game 20 times a second, three of the rules' frames each,
   taking its messages at the tick's boundary (`sim/host.rs`). Each tick it:
   - runs each player's inputs as real time allows;
   - steps their lives, the creatures, arrows and meteors, the tables and the bots;
   - checks hits where the attacker saw their target (lag compensation).

   The tick goes in phases, so the order things are stepped in changes nothing
   (`crates/engine/AGENTS.md`). Ticks are numbered from the world's epoch (`sim/clock.rs`). A slow
   simulation slows only its own players.
6. **What a page hears.** Each tick the simulation packs what everyone may see once, into the 32 m
   cell it stands in (`sim/publish.rs`, `crates/wire`'s Frame), and keeps each player's own state
   apart; the gate keeps an encoder for each connection that writes its update from the cells round
   its player (`gate/encode.rs`):
   - everyone else, the creatures, arrows, meteors and what happened, as a binary update: only
     what's near (within 40 m every tick, to 120 m every fourth, to 250 m about once a second), each
     thing by a handle of the connection's own, as changes against what the page acknowledged,
     within 64 KB/s, nearest and most overdue first (`crates/wire/AGENTS.md`; the page's decoder
     `src/net/wire/`);
   - their own player, their life when it changes, the tables near them and notices, in a slim JSON
     tick beside it: private, rare, or needed exactly.

   The page acknowledges each update; a connection that falls behind is sent only the newest. The
   page's feed takes the same shapes either way (`src/net/feedTick.ts`); far players are drawn as
   crowd bodies. With 64 bots about, a tick is about 1.4 KB where the JSON alone was 43.5 KB.
7. **Prediction.** The page runs your moves through the same rules at once, without waiting
   (`src/net/netPlayer.ts`). When the server's word on you arrives, it starts from there and runs
   again the inputs the server hadn't seen yet. Everyone else and the creatures are drawn a little in
   the past, between two ticks (`worldPeers.ts`, `actorTimeline.ts`).
8. **Saves.** The store writes a life a second after it changes, at least once a minute, and when
   you leave; land goes as rows of its own, and coins between players as ledger transfers
   ([world.md](world.md), Land). Every write is fenced: it carries the epoch the directory granted the
   character under, bumped by every new grant (another window, another simulation), and the epoch
   of the writing simulation's lease where leases are kept in Postgres; an older one is refused
   (`characters.epoch`, `space_leases`). A deploy tells every page, saves everyone, and closes; pages reload into
   the new build ([deploys.md](deploys.md)).
9. **Spaces.** Going through a portal, or into a developer zone from the Admin menu, the simulation
   asks the directory where, and hands you whole to the simulation playing it, mid-connection, your
   life and all ([world.md](world.md)).

## A Game Offline

Without the server, the browser's session plays everything: you, the creatures, your life, and
copies of instances (`crates/engine/src/session.rs`). Offline, the session also stands in for the
server's combat (`training.rs`): blows, arrows, meteors and heals, and in a copy whose file switches
them on the practice rules, the hit pause and aim assist (`docs/world.md`). The tests play this way: paused and stepped a frame at a time with `?test`, or in a copy of
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
| `src/input/` | Keys, mouse and controller, and auto-run; the browser's shortcuts kept from play (`browserKeys.ts`) and Full Keyboard, full screen with every key the game's, on by itself (`fullKeyboard.ts`) | Drawing, the interface, the network, the app, the developer pages, the bible |
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

## The World at Scale

The world is one seamless world of regions, with instances beside it ([world.md](world.md)), built
to be played by many servers:
- the world map of regions on 256 m chunks, grown where they're needed and dropped behind;
- spaces, so an instance is played round its own origin;
- a tick that splits, so players can be stepped all at once, and a region split between
  simulations plays as one (borders);
- the world's clock, the same tick everywhere;
- land kept by where it stands, the same in every channel, plots claimed once in the world, the
  ledger and the world's market;
- channels that open past a region's soft cap and merge when quiet;
- the wire for crowds, each client sent only what's near it, within a byte budget;
- the tiers in one process or several, their messages crossing links between them.

What's left of it is in `.plans/refactor/end-pass.md` (Known Gaps): a split region's parts on
separate processes, with leases of their own and a late pace between them; a stopped part's chunks
taken over; bots and effects across a border; a region's open channels kept in Postgres. The
research and its decisions: `.plans/world/research.md`.

### Several Processes

`ruina-server` plays every tier in one process by default, as Railway's beta does. Started with
`--role gate|sim|services`, it plays one role in a process of its own (`crates/server/src/cluster/`):

| Role | Plays |
|---|---|
| `all` | Everything, in one process (the default, as Railway runs it) |
| `gate` | Players' connections: sign-in and the HTTP API, each player's inputs to the sim that plays them, each client's update (gate ids from the `gate_ids` sequence) |
| `sim` | Whatever spaces the directory starts there: a region's channel or an instance's copy, each under a lease it renews itself |
| `services` | The directory (with its leases in Postgres), the store, social; forgets processes long gone |

`npm run cluster` starts services, two sims and a gate on `DATABASE_URL` (the gate on 7790);
`npm run test:cluster` plays the game across real processes, kills one and cuts another off.

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
- **One post.** Each process delivers to its own tiers' mailboxes in memory and sends everything
  else over a link to the process the directory's tables name (`post.rs`, `Post::set_remote`).
- **Placing.** A new simulation goes to the sim process with the fewest live leases, passing over
  one that holds a lease it hasn't renewed since it was last heard from (it has stopped or been cut
  off, though it counts as heard from for a while yet).
- **Taking over.** A sim that dies or is cut off stops (or is stopped by its keeper) and its leases
  run out. The directory lets the space go, tells its players to come back (`Rejoin`, closed with
  1012 as a deploy does), and plays a region's channel that had players in it again at once on
  another process, under the next epoch, from the lives as last written; a copy is made again by
  the first to need it. A restarted directory reviews no channel until it has heard from every
  channel's simulation ([world.md](world.md), Channels).

Running several processes: [deploys.md](deploys.md).
