# ruina_the_game

An original browser MMORPG prototype: third-person 3D action combat with platform-fighter movement
(run, slide, double jump), classless skill trees, Xbox controller support, and a Rust game server
that plays the open world itself (every rule, from movement to trade, runs there), keeps players'
accounts and islands in Postgres, and is built for 10,000-player PvP raids. The code still uses the working name *yggdrasil* (package name,
server binary, page title).

The open world starts on **Emberholm**, a starter isle with ArcheAge-style life systems: gliders,
carts, a roadster, boats that sail on the wind, mounts, trade packs you carry to faraway trading
posts, scarecrow farms, and houses you build from hauled materials.

**Design bible:** the root design document lives in `design/`: every system, live numbers from the
game's data, an interactive map, and the implementation tracker (`design/status.json`). Run
`npm run dev` and open http://localhost:5173/design/. The prose is `design/index.html`; everything
else is drawn by `design/bible.ts` from the game's own modules (the content in `shared/*.json`, the
rules' formulas and the terrain generator), so it is always current and there is nothing to rebuild.

- `src/`: browser client (Three.js + TypeScript, built with Vite)
- `src/skills.ts` and `server/src/skills.rs`: the skill tree, the levels skills gain by use, and the
  modifiers both apply, mirrored in both languages. The tree is data in `shared/skilltree.json`
  (laid out by `tools/skilltree/gen.mjs`), points and levels in `shared/tuning.json`; adding a
  skill should not mean writing code.
  An ability is targeting plus a list of *effects*, and a movement skill is an *action state* with
  a startup / active / recovery timeline. Those two vocabularies are the only things that cost
  code, and then in both languages at once.
- `server/`: the Rust game server, one port for everything (axum): accounts; Emberholm, which it
  plays (`server/src/world_game.rs`: each channel's players from their key presses, the island's
  rules in `server/src/open` and `server/src/life`, the slimes and the fighting), keeping islands
  in Postgres (`server/migrations/`); and the PvP battlefield, which decides all hits, runs bots,
  sends each player only what's near them, and rewinds time for lag compensation
- `shared/tuning.json`: gameplay numbers, read by both the browser and the server
- `shared/zones/`, `shared/{vehicles,trade,farming,housing,items,quests,structures,traversal}.json`:
  the open world's content. `src/sim/zone/` grows the island from a zone recipe, `src/sim/life/`
  runs trade, farming, housing, vehicles and quests, `src/render/open/` and `src/render/models/`
  draw it (preview every model at http://localhost:5173/models.html), `src/ui/life/` is its HUD
  and windows, in the look `src/ui/theme/` gives the whole UI
- `tests/`: Playwright tests that play the real game in a browser, plus checks that the TypeScript and
  Rust rules agree frame by frame

## Setup

1. [Docker](https://www.docker.com/products/docker-desktop/) and Node.js 22.12 or newer
2. `npm install`
3. `npx playwright install chromium` (the browser the tests use; on Windows they use Edge instead)

Work on `beta`; see [Branches, CI and deploys](#branches-ci-and-deploys). `AGENTS.md` is the
short version of this file for coding agents.
4. Optional, for the battlefield and the tests that compare the TypeScript and Rust rules: Rust
   (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`), then
   `cargo build --release --manifest-path server/Cargo.toml`

## Run

1. `npm run up` starts Postgres and the game server in Docker (`docker-compose.yml`), building the
   server first if its code changed. Run it again after changing anything in `server/`.
   `npm run logs` follows the server's output, `npm run psql` opens the database, `npm run down` stops both.
2. `npm run dev`, then open
   - http://localhost:5173/ for the open world, Emberholm. Sign in or make an account; your island is
     kept on the server. `?as=name` signs straight in as `name` (development only, a new account if
     it's new), so you can play several characters in different windows. `?fresh` starts your island over.
   - http://localhost:5173/?yard for the training yard (offline)
   - http://localhost:5173/animations.html for the hero's animations, each played with the game's
     own timing: slow motion, any camera, and a floor to judge the feet by (`src/render/detail/`)
   - http://localhost:5173/?raid=10000 for the rendering stress test (offline)
   - http://localhost:5173/?server=ws://localhost:7777 to join the battle (add `&team=0` or `&team=1`
     to pick a side). The battlefield needs the server started with bots: `npm run server` (Rust),
     which runs 10,000 of them.

Vite serves the game and forwards `/api` and `/ws` to the server, so the browser sees one address,
as it does in production. A character plays in one window at a time: opening it in a second window
stops the first.

**Playing together:** Emberholm runs as channels, copies of the island each home to up to 24
characters (the badge in the corner says which). Everyone in your channel sees everyone else move,
glide, sail and ride, with a name over their head, fights the same slimes, and sees what every
resident has built: houses and farms stay standing while their owner is away, their walls are solid,
and a house plot belongs to whoever claimed it first.

**The server decides:** your browser sends only what you press (about 60 times a second) and what
you ask your island to do (talk, plant, buy, craft, drive...). The server runs every rule on its own
copy: where you are (hills, cliffs, walls, water, gliders, vehicles), every hit, and everything on
your island (bag, coins, labor, farms, houses, packs, quests), and keeps the island in Postgres
from that copy. It answers 20 times a second; meanwhile your browser predicts your own moves with
the same rules (in TypeScript) and corrects itself to the answer, so play feels instant.
`tests/world-conformance.spec.ts` and `tests/life-conformance.spec.ts` check the two sets of rules
agree. The developer panel (give items, skip time, teleport) exists only where the server allows it
(development and beta, not production). Automated tests (`?test`) run the island offline, in the
browser, except `tests/online.spec.ts`, which needs `npm run up`.

## Branches, CI and deploys

| Branch | How changes get in | Deploys to |
|---|---|---|
| `beta` (default) | Push directly | https://ruinathegame-beta.up.railway.app |
| `production` | Pull request (usually from `beta`), with CI passing | https://ruinathegame-production.up.railway.app |

Both branches are protected against force-pushes and deletion. `.github/workflows/ci-cd.yml` runs
on every push and pull request to them: the client typechecks and builds, the Rust server's tests
pass, and the whole Playwright suite plays the game against a real server and Postgres (with the
battlefield and the TypeScript/Rust conformance tests, which need the Rust binaries). A push that
passes is uploaded to the Railway environment of the same name with `railway up`, and the job
waits until `/api/health` answers from the new deployment.

**Railway** (project `intuitive-enthusiasm`): environments `beta` and `production`, each with the
game service and its own Postgres. The game's `DATABASE_URL` refers to that environment's
database, and `PORT` is 8080. The `Dockerfile`'s last stage is the whole game (the server serving
the built client, the account API and both WebSockets); `railway.json` tells Railway to build it
and health-check `/api/health`. The server applies database migrations itself when it starts, and
developer sign-in (`?as=`) is always off on Railway.

**Keys:** each GitHub environment (`beta`, `production`) holds `RAILWAY_TOKEN`, that Railway
environment's project token, and accepts deployments only from its own branch. Local copies live
in `.env` (git-ignored) as `RAILWAY_BETA_API_KEY` and `RAILWAY_PRODUCTION_API_KEY`.

## Controls

| | Keyboard and mouse | Xbox controller |
|---|---|---|
| Move / camera | WASD / mouse (click to capture) | Left / right stick |
| Sprint | Hold Shift | Click left stick |
| Crouch | Ctrl | Click right stick |
| Jump (twice for a double jump) | Space | A |
| Attack | Left click or J | X |
| Slide | C | B |
| Hotbar (hold to aim a ground cast) | 1 – 8 | LT or RT + A/B/X/Y |
| Movement skills (dodge, backstep, block) | Q, E | LB, RB |
| Next target | Tab (Shift-Tab goes back) | D-pad right / left |
| Skill book (your skills, their levels, the hotbar) | T | View |
| Skill tree (learning) | N | A bumper, from the skill book |
| Report a bug (press again to save it) | \ (Backspace twice throws it away) | Click both sticks |

**Fighting** (an enemy marked, or for a moment after you swing or cast) you keep facing where the
camera looks: the stick strafes and backs off, a little slower than running ahead, and dodges and
double jumps go whichever way you push without turning you. Sprint to turn and run. Out of a
fight you turn and run the way you push. Your weapon comes out for a fight and goes away a few
seconds after it (sword and club at the hip, staff and bow on the back); swing, shoot or cast and
it's in your hand at once.

In the open world:

| | Keyboard and mouse | Xbox controller |
|---|---|---|
| Interact (talk, plant, harvest, load, drive, build) | F | Y |
| Open the glider (in the air, after the double jump) / fold it | Space again, or G | A |
| Glider: dive / flare | Shift / Ctrl | Click left / right stick |
| Drive: throttle, steer, handbrake, boost | W S, A D, Space, Shift | Left stick, A |
| Sail: raise / lower the sail | W / S | Left stick |
| Call or dismiss your mount | R | D-pad down |
| Drop the pack on your back | X | |
| Change the seed you plant | Z | |
| Bag, map, vehicles, quest log | I, M, V, L | Menu, D-pad up |
| Character (your gear) | P | |
| Developer tools (give items, skip time, teleport) | ` | |

## Bug reports

Press `\` (the key next to Return; or click both sticks) the moment something goes wrong. The game
keeps the last 30 seconds of play, then records your voice and the screen while you say what
happened and show it. Press `\` again to save it. The dev server writes the report to
`bugs/<when>-<what>/` (git-ignored). Type `/fix-bugs` in Claude Code and it works through the open
reports: it reads the transcript, looks at the frames, reproduces the bug, fixes it, adds a test,
and moves the report to `bugs/closed/`.

A report holds: the transcript, `voice.wav`, a video, a screenshot with the HUD, frames from 30 s
before the press, console output and errors, game events, the player's path and inputs, the full
game state, and the island save (so the bug can be replayed on the same island).
`node tools/bugs.mjs` lists and summarizes them from the terminal.

- Live transcription uses the browser's speech recognition (Chrome runs it on Google's servers).
  `?bugspeech=0` turns it off; `node tools/bugs.mjs transcribe <id>` transcribes `voice.wav`
  locally with whisper.cpp instead (`brew install whisper-cpp` plus a model).
- `?bugs=0` turns the reporter off. It's off in automated tests unless the URL asks for `&bugs`.
- Saving needs the dev server (`npm run dev`). A server started before `vite.config.ts` existed
  has to be restarted once.

## Tests

`npm test` runs everything. Tests that need a server start their own on ports 7791–7794, so they never
join a game you're playing. `npm run typecheck` checks types. `tests/world.spec.ts` plays the open
world (`/?world&test`) and `tests/models.spec.ts` checks every procedural model.

## Balance

`npm run balance` runs the builds in `balance.json` against each other under the server's own hit
resolution and prints a win-rate, time-to-kill and damage table (JSON on stdout for diffing, the
table on stderr to read). Both fighters are driven by the same plain policy — walk in and swing —
so it measures the paper matchup, not the played one: anything that wants to kite or space will
read worse there than it plays. Use it to catch regressions and outliers, not to settle design.
