# ruina_the_game

An original browser MMORPG prototype: third-person 3D action combat with platform-fighter movement
(run, slide, double jump), classless skill trees, Xbox controller support, and a Rust battle server
built for 10,000-player PvP raids. The code still uses the working name *yggdrasil* (package name,
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
- `src/skills.ts` and `server/src/skills.rs`: the skill tree and its modifiers, mirrored in both
  languages. Skills are data in `shared/tuning.json`; adding one should not mean writing code.
  An ability is targeting plus a list of *effects*, and a movement skill is an *action state* with
  a startup / active / recovery timeline. Those two vocabularies are the only things that cost
  code, and then in both languages at once.
- `server/`: Rust battle server (tokio WebSockets): decides all hits, runs bots, sends each player
  only what's near them, rewinds time for lag compensation
- `shared/tuning.json`: gameplay numbers, read by both the browser and the server
- `shared/zones/`, `shared/{vehicles,trade,farming,housing,items,quests,structures,traversal}.json`:
  the open world's content. `src/sim/zone/` grows the island from a zone recipe, `src/sim/life/`
  runs trade, farming, housing, vehicles and quests, `src/render/open/` and `src/render/models/`
  draw it (preview every model at http://localhost:5173/models.html), `src/ui/life/` is its HUD
- `tests/`: Playwright tests that play the real game in a browser, plus checks that the TypeScript and
  Rust rules agree frame by frame

## Setup (macOS)

1. Xcode command line tools (`xcode-select --install`), Node.js 22.12 or newer (`brew install node`),
   and Rust (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
2. `npm install`
3. `npx playwright install chromium` (the browser the tests use)
4. `cargo build --release --manifest-path server/Cargo.toml`

## Run

- Battle server: `npm run server` (10,000 bots on ws://localhost:7777)
- Game: `npm run dev`, then open
  - http://localhost:5173/ for the open world, Emberholm (no server needed; your island saves in the
    browser, and `?fresh` starts it over)
  - http://localhost:5173/?yard for the training yard
  - http://localhost:5173/?server=ws://localhost:7777 to join the battle (add `&team=0` or `&team=1` to pick a side)
  - http://localhost:5173/?raid=10000 for the rendering stress test

The browser reloads itself when the server restarts. Rebuild and restart the server after changing
anything in `server/` or the network messages, or the game stops responding.

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
| Skill trees | T | View |
| Report a bug (press again to save it) | \ (Backspace twice throws it away) | Click both sticks |

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
