# AGENTS.md

**Ruina**: an original browser MMORPG prototype. Three.js + TypeScript client (Vite), a Rust game
server (axum), Postgres. The code still says *yggdrasil* (package, server binary, page title).
The open world is **Emberholm**, a starter isle with ArcheAge-style life systems.

## Layout

| Path | What |
|---|---|
| `src/sim/` | Game rules: fixed 60 Hz steps, deterministic, no DOM. `src/sim/life/` (trade, farming, housing, vehicles, quests) changes only through queued commands |
| `src/render/`, `src/ui/` | Presentation. Reads the rules' state, never changes it |
| `src/main.ts` | Wires it all up; URL options at the top; `window.__game` is the test API |
| `src/app/online.ts`, `src/net/` | Sign-in, the world connection, the battlefield client |
| `server/` | Rust server: accounts and islands in Postgres (`server/migrations/`, applied on start), the PvP battlefield. `player.rs`/`skills.rs` mirror the TS rules |
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

- Rules both sides run (movement, combat, skills) change in TypeScript **and** Rust together; the
  conformance tests compare them frame by frame.
- Keep `src/sim/` deterministic: its own seeded RNG, never `Math.random` or `Date.now`.
- When a feature lands, update `design/status.json` (feature status, next steps, session log).
- Never commit `.env` (Railway keys). Commit messages carry no AI attribution.

## Branches and deploys

- `beta` (default): push directly. CI (`.github/workflows/ci-cd.yml`) runs; if it passes, it
  deploys to https://ruinathegame-beta.up.railway.app.
- `production`: pull requests only (from `beta`), CI must pass; merging deploys to
  https://ruinathegame-production.up.railway.app.
- Railway project `intuitive-enthusiasm`: environments `beta` and `production`, each with its own
  Postgres. The game service gets `DATABASE_URL` (a reference to that environment's database) and `PORT=8080`.
- The online work is phase 1 of 5 (see the README and the "A world server" entry in `design/status.json`).
