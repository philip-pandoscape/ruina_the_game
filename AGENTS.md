# AGENTS.md

**Ruina**: an original browser MMORPG prototype. Three.js + TypeScript client (Vite), a Rust game
server (axum), Postgres. The code still says *yggdrasil* (package, server binary, page title).
The open world is **Emberholm**, a starter isle with ArcheAge-style life systems.

## Layout

| Path | What |
|---|---|
| `src/sim/` | Game rules: fixed 60 Hz steps, deterministic, no DOM. `src/sim/life/` (trade, farming, housing, vehicles, quests) changes only through queued commands |
| `src/render/`, `src/ui/` | Presentation. Reads the rules' state, never changes it |
| `src/render/detail/` | Close-up bodies. `humanoid.ts` poses every humanoid as a pure function of `PoseInput` (the crowd bakes its clips from it), with `body.ts` (two-bone IK), `gait.ts` (planted feet at any speed and heading), `swings.ts` (weapon keyframes); `src/render/character.ts` adds the stateful parts (transitions, foot holds, trails, bowstring). `/animations.html` plays them all; `tests/animation.spec.ts` measures them |
| `src/main.ts` | Wires it all up; URL options at the top; `window.__game` is the test API |
| `src/app/online.ts`, `src/net/` | Sign-in, the world connection (`worldLink.ts`: inputs and commands out, the server's ticks in), predicting your own player (`netPlayer.ts`), everyone else in your channel (`worldPeers.ts`), the battlefield client |
| `server/` | Rust server. It plays Emberholm: `world_game.rs` runs each channel (players from their inputs, the island's rules, slimes, combat via `game.rs`), `world_socket.rs` is the connection, `open/` the island's ground, colliders and traversal (baked from the TS generator into `server/data/emberholm.zone` by `tests/terrain.spec.ts`), `life/` trade, farming, housing, vehicles and quests. Accounts and islands in Postgres (`server/migrations/`, applied on start). The PvP battlefield. `player.rs`, `skills.rs`, `open/`, `life/` mirror the TS rules |
| `shared/*.json` | Content and tuning, read by both sides. New content is data, not code |
| `tests/` | Playwright tests that play the real game, plus TS/Rust conformance |
| `design/` | Design bible (`/design/` on the dev server); `design/status.json` is the tracker and session log |

## Commands

```sh
npm run up              # Postgres + game server in Docker (rebuilds the server); npm run down stops
npm run dev             # http://localhost:5173  (?as=name signs in on dev, ?yard, ?world&test)
npm run typecheck
npx playwright test     # all; tests/online.spec.ts needs `npm run up`
cargo test --release --manifest-path server/Cargo.toml   # needs Rust; CI runs it anyway
```

## Rules

- Rules both sides run (movement, traversal, combat, skills, the island's life systems) change in
  TypeScript **and** Rust together; `tests/conformance.spec.ts`, `tests/world-conformance.spec.ts`
  and `tests/life-conformance.spec.ts` compare them. Online the server decides; the browser only
  predicts its own moves and shows what the server says.
- After changing the island (`shared/zones/`, `src/sim/zone/`), rebake the server's copy:
  `BAKE=1 npx playwright test tests/terrain.spec.ts`.
- Keep `src/sim/` deterministic: its own seeded RNG, never `Math.random` or `Date.now`.
- When a feature lands, update `design/status.json` (feature status, next steps, session log).
- Tag a test `@gpu` if it needs a real GPU to keep up (several game windows, frame rates, screen
  capture). CI renders in software and skips them; run them locally before pushing such changes.
- Never commit `.env` (Railway keys). Commit messages carry no AI attribution.

## Branches and deploys

- `beta` (default): push directly. CI (`.github/workflows/ci-cd.yml`) runs; if it passes, it
  deploys to https://ruinathegame-beta.up.railway.app.
- `production`: pull requests only (from `beta`), CI must pass; merging deploys to
  https://ruinathegame-production.up.railway.app.
- Railway project `intuitive-enthusiasm`: environments `beta` and `production`, each with its own
  Postgres. The game service gets `DATABASE_URL` (a reference to that environment's database) and `PORT=8080`;
  beta also `DEV_TOOLS=1` (the in-game developer panel, off in production).
- Online the server plays Emberholm: browsers send key presses (binary, 60 a second) and commands,
  the server runs every rule and keeps the islands in Postgres, and answers 20 times a second.
  Nothing a browser says about its own state is believed. `grant`, `warp` and `teleport` (the
  developer panel) only work where `DEV_TOOLS=1` or `DEV_LOGIN=1`.
