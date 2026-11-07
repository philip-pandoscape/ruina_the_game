# AGENTS.md

**Ruina** is an original browser MMORPG prototype with ArcheAge-style life systems (trade packs,
farming, housing, vehicles) and action combat. The client is Three.js and TypeScript (Vite); the
rules are one Rust engine that the server runs natively and the browser runs as WebAssembly; the
server is Rust (axum, tokio) on Postgres. Only the repository keeps the working name *yggdrasil*;
everything players see, and the server binary (`ruina-server`), says Ruina.

The main world is one seamless open world of **regions** defined by data, meeting across sea or
land, with **instances** (dungeons, developer zones) beside it, each played in copies of its own.
**Emberholm**, a starter isle, is the first region. The server runs as tiers that only send each
other messages (a gate for connections, simulations, a store, a social tier, a directory), in one
process or spread over several. How it all fits together: [docs/architecture.md](docs/architecture.md).
The words (world, region, instance, channel, copy, space, chunk, cell, land, life):
[docs/world.md](docs/world.md).

## Where Things Are

| Area | What | Its guide |
|---|---|---|
| `crates/engine` | The rules, one copy: movement, traversal, combat, skills, creatures, the world map and its regions' generator, borders between simulations, the life systems and land, mini-games. Deterministic: no clocks, threads or I/O | `crates/engine/AGENTS.md`, [docs/engine.md](docs/engine.md) |
| `crates/engine-wasm` | The engine for the browser: the page's game (`session.rs`) through plain exports | [docs/engine.md](docs/engine.md) |
| `crates/server` | `ruina-server`: the gate (`gate/`), the simulations (`sim/`), the store (`store/`, Postgres and `migrations/`), the social tier (`social/`), the directory (`directory/`), the processes and their leases (`cluster/`), accounts, the HTTP API (`http.rs`); `start.rs` starts the tiers a role asks for | `crates/server/AGENTS.md` |
| `crates/world-api` | The messages between the server's tiers, the ids and the tick's records (no I/O) | `crates/world-api/AGENTS.md` |
| `crates/wire` | What a browser hears of the world: records by 32 m cell, handles, deltas, a byte budget | `crates/wire/AGENTS.md` |
| `crates/link` | TCP links between server processes (once, in order, at least once across restarts) | `crates/link/AGENTS.md` |
| `crates/channels` | The channels' policy: when a region opens, merges or closes a channel, and who goes where | `crates/channels/AGENTS.md` |
| `crates/tools` | The balance harness, the load test (`loadtest`), the conformance programs | [docs/testing.md](docs/testing.md) |
| `src/app` | Start-up, the URL options (`options.ts`), the loop, a frame's drawing and step, online play's wiring, the test API (`window.__game`) | `src/app/AGENTS.md` |
| `src/engine` | The bridge to the rules: the only way to them from the rest of the client, and the views read back after each step | `src/engine/AGENTS.md` |
| `src/net` | The world connection, prediction, the wire's decoder and everyone else as the server sends them | `src/net/AGENTS.md` |
| `src/render` | Drawing (the look, the world's regions, bodies and animation, buildings, creatures): reads the rules, never changes them | `src/render/AGENTS.md` |
| `src/ui` | The Parchment & Timber interface: windows on shared components, the HUD, the writing rule | `src/ui/AGENTS.md` |
| `src/input`, `src/content`, `src/assets` | Keys, mouse, controller and auto-run, the browser's shortcuts kept from play and Full Keyboard (F11); typed readers of the content bundles and looks; the asset catalogue and loader | (in [docs/architecture.md](docs/architecture.md)) |
| `src/dev`, `dev/` | The developer pages: the Content Library, the UI gallery; the Admin menu's list (`src/dev/pages.ts`) | `src/dev/AGENTS.md`, [docs/admin.md](docs/admin.md) |
| `src/bible`, `bible/` | The Ruina Bible, `/bible/`: how the game works, exactly, from its own rules and content | (the bible's own test, `tests/unit/bible.test.ts`) |
| `content/` | Every piece of game data, a folder per kind and a file per thing, built by `npm run content` into the bundles both sides read (`shared/`): edit `content/`, never `shared/` | `content/AGENTS.md`, [docs/content.md](docs/content.md) |
| `tests/` | The tiers: `unit/` (Vitest, no browser), `conformance/`, `integration/` (Playwright, with servers), `stress/` (a real GPU), `support/` | `tests/AGENTS.md`, [docs/testing.md](docs/testing.md) |
| `tools/` | Content's compiler, assets' search and fetch, icons, images, models, the moves script, the cluster runner | |
| `design/` | The design bible's Development tab and its tracker (`design/status.json`), the UI design system (`design/ui.html`) | |
| `.plans/` | Plans in flight: the first refactor (`.plans/refactor/`), the world's research, dungeons | |

## Adding Things

- **Content of a kind the game knows** (a creature, townsperson, item, quest, vehicle, building,
  region, instance, mini-game): files alone, from a template in `content/_templates/`.
  [docs/content.md](docs/content.md) has a recipe for each kind; the unit tier fails on a content id
  in code (`tests/unit/contentIds.test.ts`) and on a misspelt field or broken reference.
- **A rule**: in the engine only, with its Rust tests and, if a scenario's answer moves on purpose,
  the golden answers kept anew (`RUINA_GOLDEN=1 cargo test --release -p ruina-engine golden`).
  What the browser needs of it crosses the bridge (`src/engine/`, [docs/engine.md](docs/engine.md)).
- **A region or an instance**: its files in `content/regions/` or `content/instances/`, its chunks in
  `content/world.json` ([docs/world.md](docs/world.md)).
- **A message between the server's tiers**: in `crates/world-api`, handled where it lands; it
  crosses processes as it is ([docs/architecture.md](docs/architecture.md)).
- **A window**: on `src/ui/components/`, with its states in the UI gallery (`src/dev/ui/`).
- **A developer page or zone**: an entry in `src/dev/pages.ts`, or an instance with
  `developer: true` ([docs/admin.md](docs/admin.md)).
- **An asset**: free first, through the `find-assets` skill, listed in `src/assets/catalog.ts`
  ([docs/assets.md](docs/assets.md)).
- **A system or a kind of content players should understand**: its page in the bible
  (`src/bible/systems/`, `src/bible/things/`); `tests/unit/bible.test.ts` says what's missing.

## Commands

```sh
npm run dev               # http://localhost:5173 (?as=name signs in on a dev server; ?offline plays without one; ?test for tests)
npm run check             # typecheck, Biome, knip, rustfmt and clippy, the unit tier (Vitest and cargo test): after every change
npm run check:beta        # + conformance and the integration tier (Playwright, needs a world server): before a push to beta
npm run check:release     # + the stress tier (a real GPU): before a release
npm run test:cluster      # the leases and the game across several processes (needs RUINA_DATABASE_URL)
npm run cluster           # services, two sims and a gate on DATABASE_URL, the gate on port 7790
npm run loadtest -- --plan quick   # bots and virtual clients against a server, measured (docs/testing.md)
npm run up                # Postgres and the server in Docker; npm run down stops them
npm run content           # content/ into the bundles (the dev server does it on a change)
npm run engine            # the engine's WebAssembly (dev, build and the tests build it first)
npm run format            # Biome and rustfmt, before committing
```

The online specs need a world server with a database: [docs/testing.md](docs/testing.md) says how
to run a private one (a Postgres container and a copy of the release binary, on ports of your own).

## Rules

- **One copy of the rules**, the engine's: the server runs them, the browser predicts its own moves
  and plays offline with the same code, and the server decides. Keep the engine deterministic
  (`crates/engine/AGENTS.md`): its own seeded random numbers, `libm` maths, no `HashMap`, no clocks.
- **Content is data**: a new thing of a known kind needs no code; saves and the network name things
  by id or by their place in a bundle both sides read, never a hand-kept list.
- **The areas' boundaries** are a unit test (`tests/unit/boundaries.test.ts`): drawing and the UI
  never change the rules or call the network; the UI asks the app; only `src/engine/` reaches the rules.
- **Tests go in the lowest tier** that shows the thing works ([docs/testing.md](docs/testing.md)).
  Integration tests open the game with `tests/support/game.ts` and drive the typed `window.__game`
  a frame at a time; they never wait a fixed time. Tag `@gpu` what needs a real GPU (CI draws in
  software) and `@alone` what races the clock under load.
- **The UI's writing rule** (`design/ui.html`, `src/ui/theme/text.ts`): labels in Title Case,
  sentences in sentence case; items answer a click, a double-click and a right-click.
- **The docs move with the code**: a path named in AGENTS.md, `docs/`, the skills or
  `design/status.json` must exist (`tests/unit/paths.test.ts`); a feature that lands updates
  `design/status.json`; the bible's completeness test fails on a system or thing without its page.
- **Servers started on a development machine listen on localhost only** (`--listen all` for other
  machines): nothing should ever need someone at the machine to click a Windows prompt.
- **Never commit `.env`** (Railway keys, `GEMINI_API_KEY`). Commit messages carry no AI attribution.

## Art and Assets

Free first: the `find-assets` skill (`.claude/skills/find-assets/SKILL.md`, with
`tools/assets/search.mjs` and `tools/assets/fetch.mjs`) finds and fetches models, textures, skies,
animations, sounds, music, effects and fonts, checks their licences (the repository is public: CC0
and CC BY only, never anything taken from another game) and credits them in `CREDITS.md`. Judge a
find in the game's look beside what we would make; make one only when nothing free is as good.
Concepts come first for whatever is made, shown to the user beside today's look.

Paid makers are the user's money: say what a batch makes, what it costs and what free option it
beats before running it.
- **Gemini** (`npm run image`, `GEMINI_API_KEY` in `.env`) for pictures: concepts, Meshy's input,
  textures, and the icons (`tools/icons/`, nine to a sheet, `npm run icons` cuts them out).
- **Meshy** (the `meshy` MCP server) for models nothing free matches; the pipeline from a concept to
  a fitted, compressed model, and the gotchas: [docs/assets.md](docs/assets.md).
- **Animations** onto a character, checked against their source: the `retarget-animation` skill.
- **Buildings** are plans on Quaternius' village kit, not models (`content/buildings/`).

Binaries live in Git LFS. Every asset file has a rule in `src/assets/catalog.ts` and is loaded by
id, nearest first. `tests/stress/look.spec.ts` shoots the same places at each quality: run it before
and after a change to the look, and show the user both.

## Branches, Deploys and Running Several Servers

In full: [docs/deploys.md](docs/deploys.md).
- **`beta`** (the default): push directly once `npm run check:beta` passes here; CI runs the unit
  tier and the build, then deploys to https://ruinathegame-beta.up.railway.app.
- **`production`**: pull requests from `beta` only, CI must pass; merging deploys to
  https://ruinathegame-production.up.railway.app.
- Railway project `intuitive-enthusiasm`, environments `beta` and `production`, each with its own
  Postgres; the service's settings (`DATABASE_URL`, `PORT`, `ADMIN_USERS`...) are in the guide.
- A deploy tells every player it's updating, saves every life, and closes with 1012; pages reload
  into the new build. Migrations run as the server starts.
- **Roles:** `ruina-server` runs every tier in one process by default (`--role all`, as Railway
  does), or one role per process (`--role services|gate|sim`), finding each other through the
  directory's tables and talking over `crates/link`. Running it as several Railway services is the
  user's call ([docs/deploys.md](docs/deploys.md), Several Processes).
- **Admins** are named by `ADMIN_USERS`; the developer commands and pages answer them only.

## Working Beside Other Sessions

- Work in a worktree of your own for anything long, with ports of your own: `PW_PORT` and
  `TEST_PORT_OFFSET` move the suite's Vite and its specs' own servers; give your world server and
  Postgres container ports nobody else uses, and remove only the containers you made.
- Moving files: list each move in `.plans/refactor/moves.tsv` and run `tools/refactor/moves.mjs`,
  which rewrites every reference (imports, docs, skills, the tracker); a commit that moves changes
  nothing else.
- Merge the main branch into yours before handing work back, and run `npm run check` after.
