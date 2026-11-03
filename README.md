# ruina_the_game

An original browser MMORPG prototype: third-person 3D action combat with platform-fighter movement
(run, slide, double jump), classless skill trees, Xbox controller support, and a Rust battle server
built for 10,000-player PvP raids. The code still uses the working name *yggdrasil* (package name,
server binary, page title).

- `src/`: browser client (Three.js + TypeScript, built with Vite)
- `server/`: Rust battle server (tokio WebSockets): decides all hits, runs bots, sends each player
  only what's near them, rewinds time for lag compensation
- `shared/tuning.json`: gameplay numbers, read by both the browser and the server
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
  - http://localhost:5173/ for the training yard (no server needed)
  - http://localhost:5173/?server=ws://localhost:7777 to join the battle (add `&team=0` or `&team=1` to pick a side)
  - http://localhost:5173/?raid=10000 for the rendering stress test

The browser reloads itself when the server restarts. Rebuild and restart the server after changing
anything in `server/` or the network messages, or the game stops responding.

## Controls

| | Keyboard and mouse | Xbox controller |
|---|---|---|
| Move / camera | WASD / mouse (click to capture) | Left / right stick |
| Jump (twice for a double jump) | Space | A |
| Attack | Left click or J | X |
| Slide | Shift | B |
| Abilities | E (or right click), Q | Y, RB |
| Skill trees | T | View |

## Tests

`npm test` runs everything. Tests that need a server start their own on ports 7791–7793, so they never
join a game you're playing. `npm run typecheck` checks types.
