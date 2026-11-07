# ruina_the_game

Ruina is an original browser MMORPG prototype. It has:

- third-person action combat with platform-fighter movement (run, slide, double jump);
- classless skill trees, and controller support;
- ArcheAge-style life systems: gliders, carts, boats that sail on the wind, mounts, trade packs
  carried to far-off trading posts, farms, and houses built from hauled materials.

A Rust game server plays the world itself: every rule, from movement to trade, runs there, and it
keeps players' accounts and characters in Postgres. The world is meant to be one seamless open
world of regions. **Emberholm**, a starter isle, is the first. Only the repository keeps the
game's working name, *yggdrasil*.

## Quick Start

You need [Docker](https://www.docker.com/products/docker-desktop/), Node.js 22.12 or newer, and
Rust with its WebAssembly target:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown
npm install
npx playwright install chromium   # the browser the tests use (on Windows they use Edge)
npm run up                        # Postgres and the game server, in Docker
npm run dev                       # builds the engine's WebAssembly, then serves the game
```

Then open http://localhost:5173/. Sign in or make an account, then pick or make a character (up to
six). In development, `?as=name` signs straight in as `name` and plays its last character, so you
can play several characters in different windows.

| Page | What |
|---|---|
| http://localhost:5173/ | The world. `?fresh` starts your character's life over; `?offline` plays the world offline, `?offline=yard` the training yard (any instance by its id). |
| http://localhost:5173/bible/ | The Ruina Bible: how the game works, exactly, with every control on a keyboard and on a controller. |
| http://localhost:5173/dev/library.html | The content library: everything the game draws, every animation frame by frame (admins). |
| http://localhost:5173/design/ | The design bible's Development tab and its tracker (admins); the UI design system is `design/ui.html`. |

The Admin menu, in the world or on character select, takes you into the developer zones: the
training yard, the battlefield and the goblin camp. In development everyone is an admin.

Vite serves the game and forwards `/api` and `/ws` to the server, so the browser sees one address,
as it does in production. Other commands:

- `npm run up` again after changing anything in `crates/`;
- `npm run logs` follows the server's output;
- `npm run psql` opens the database;
- `npm run down` stops both.

## Where to Read Next

`AGENTS.md` is the map of the code: what is where, the commands, the rules every change keeps,
assets, and deploys. It's written for coding agents and people alike. The guides go deeper:

| Guide | What |
|---|---|
| `docs/architecture.md` | The map: the pieces, a game online and offline, the client's areas, content and its ids |
| `docs/engine.md` | The rules, one copy in Rust, and how the server and the browser reach them |
| `docs/content.md` | Adding content as files alone: items, quests, creatures, buildings, regions |
| `docs/world.md` | The world: regions on chunks, its ground, spaces and channels; dungeons and developer zones, their copies, and bots |
| `docs/testing.md` | The test tiers, and where a new test goes |
| `docs/assets.md` | Models, textures and sounds, from a find to the screen |
| `docs/admin.md` | The Admin menu, and the developer pages and commands |
| `docs/deploys.md` | Branches, CI and Railway |

## How It Plays Online

**The server decides.**

- Your browser sends only what you press, 60 times a second, and what you ask to do (talk, plant,
  buy, craft, drive).
- The server runs every rule and answers 20 times a second.
- Meanwhile, your browser predicts your own moves with the same rules (the engine, compiled to
  WebAssembly), so play feels instant.

**Channels.** Emberholm runs as channels, each home to up to 24 characters. In yours, everyone:

- sees everyone else move, ride and build;
- fights the same creatures, under the same sky;
- can ride along in a friend's vehicle, or challenge them to a mini-game at a table, for a stake.

A character plays in one window at a time. When the server is updated, the world freezes under a
notice and carries on by itself.

## Bug Reports

Press `\` (the key next to Return), or click both sticks, the moment something goes wrong.

1. The game keeps the last 30 seconds of play, then records your voice and the screen while you
   say what happened and show it.
2. Press `\` again to save it. The dev server writes the report to `bugs/<when>-<what>/`
   (git-ignored).
3. Type `/fix-bugs` in Claude Code to work through the open reports. For each one, it reproduces
   the bug, fixes it, adds a test, and moves the report to `bugs/closed/`.

`node tools/bugs.mjs` lists the reports from the terminal. A report holds:

- the transcript and the recording;
- a screenshot with the HUD, and frames from before the press;
- the console and the game's events;
- the player's path and inputs;
- the save, so the bug can be replayed on the same character.

`?bugs=0` turns the reporter off. `?bugspeech=0` turns off live transcription (the browser's speech
recognition). `node tools/bugs.mjs transcribe <id>` transcribes the recording locally with
whisper.cpp.

## Tests

| When | Run | What it holds |
|---|---|---|
| After every change | `npm run check` | Types, format and lints, dead code, and the unit tests: seconds |
| Before a push to `beta` | `npm run check:beta` | Adds the game in a browser, with its servers |
| Before a release | `npm run check:release` | Adds frame rates and crowds, on a real GPU |

`docs/testing.md` says what each tier holds and where a new test goes. The online tests need
`npm run up`. To run the suite beside another checkout's, give it ports of its own:
`PW_PORT=5211 TEST_PORT_OFFSET=10`.

## Balance

`npm run balance` runs the builds in `tools/balance/scenario.json` against each other under the
server's own rules. It prints a table of win rates, times to kill and damage: the table on stderr
to read, and JSON on stdout to compare.

Both fighters follow the same plain policy (walk in and swing), so it measures the matchup on
paper, not as played. Anything that kites or keeps its distance reads worse there than it plays.
Use it to catch regressions and outliers, not to settle design.

## Branches

| Branch | How changes get in | Deploys to |
|---|---|---|
| `beta` (the default) | Push directly | https://ruinathegame-beta.up.railway.app |
| `production` | Pull request from `beta`, with CI passing | https://ruinathegame-production.up.railway.app |

What CI runs, Railway, and how a deploy reaches players: `docs/deploys.md`.
