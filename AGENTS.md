# AGENTS.md

**Ruina**: an original browser MMORPG prototype. Three.js + TypeScript client (Vite), a Rust game
server (axum), Postgres. The Rust crate and server binary still say *yggdrasil*; everything players
see says Ruina.
The open world is **Emberholm**, a starter isle with ArcheAge-style life systems.

## Layout

| Path | What |
|---|---|
| `src/sim/` | Game rules: fixed 60 Hz steps, deterministic, no DOM. `src/sim/life/` (trade, farming, housing, vehicles, quests) changes only through queued commands |
| `src/render/`, `src/ui/` | Presentation. Reads the rules' state, never changes it |
| `src/render/look.ts` | The look: the new one (default) or the old toon one (`?look=classic`, and software WebGL), each with its palette; `?quality=medium` (auto on integrated graphics). Screen effects in `src/render/open/post.ts`; textured ground `open/ground.ts`; made models (Meshy, compressed, in `src/render/assets/models/`) swapped in for the procedural ones by id and fitted into their footprints, `models/glb.ts`, so the rules never see them; `tests/look.spec.ts` shoots both looks |
| `src/render/detail/` | Close-up bodies. `humanoid.ts` poses every humanoid as a pure function of `PoseInput` (the crowd bakes its clips from it), with `body.ts` (two-bone IK), `gait.ts` (planted feet at any speed and heading), `swings.ts` (weapon keyframes), `stow.ts` (where weapons are put away); `src/render/character.ts` adds the stateful parts (transitions, foot holds, trails, bowstring, drawing and putting away the weapon). `/animations.html` plays them all; `tests/animation.spec.ts` measures them |
| `src/ui/` | The Parchment & Timber look. `theme/`: the CSS, the UI laid out on a 1029 px virtual screen and scaled to the window (`scale.ts`), fonts, tooltips, right-click menus (`contextMenu.ts`), the writing rule (`text.ts`), pixel icons baked from Twemoji (`npm run icons`). `life/lifeUI.ts`: the island's HUD and its windows docked at the sides. `skills/`: the skill book (T) and the skill tree (N). Skill points are counted from finished quests (`src/sim/life/progress.ts`), never stored |
| `src/main.ts` | Wires it all up; URL options at the top (`?lag=ms` plays a local server as a far one feels); `window.__game` is the test API. Riding, the vehicle is placed before its rider is posed in its seat (`LifeView.placeRide`). Online, picking packs up and putting them down, loading, unloading and getting in run ahead in the browser until the server has run them too |
| `src/app/autoWalk.ts`, `src/sim/zone/roads.ts` | Auto-run (H) and travel by road from the map: the road network and its routes, followed by making the same controls the keyboard would (`src/ui/life/travelUI.ts` draws them) |
| `src/app/online.ts`, `src/net/` | The way in (the title screen drawn by `index.html`, `src/ui/splash.ts`, sign-in `src/ui/signIn.ts`, `src/ui/characterSelect.ts`), the world connection (`worldLink.ts`: inputs and commands out, the server's ticks in; riding out a server update, `src/app/resume.ts`), predicting your own player (`netPlayer.ts`), everyone else in your channel (`worldPeers.ts`: their vehicles solid to you, and drawn before anyone riding along sits in them), monsters drawn on a timeline between the server's ticks (`actorTimeline.ts`) with hits felt at once (`netMonsters.ts`), the battlefield client |
| `server/` | Rust server. It plays Emberholm: `world_game.rs` runs each channel (players from their inputs, the island's rules, slimes, combat via `game.rs`), `world_socket.rs` is the connection; riding along in someone else's vehicle is the channel's (the player's `host`, `seat_passengers`), as their vehicles aren't on your island; `open/` the island's ground, colliders and traversal (baked from the TS generator into `server/data/emberholm.zone` by `tests/terrain.spec.ts`), `life/` trade, farming, housing, vehicles and quests. Accounts and islands in Postgres (`server/migrations/`, applied on start). The PvP battlefield. `player.rs`, `skills.rs`, `open/`, `life/` mirror the TS rules |
| `shared/*.json` | Content and tuning, read by both sides. New content is data, not code |
| `tests/` | Playwright tests that play the real game, plus TS/Rust conformance |
| `design/` | Design bible (`/design/` on the dev server) and the UI design system (`/design/ui.html`); `design/status.json` is the tracker and session log |

## Commands

```sh
npm run up              # Postgres + game server in Docker (rebuilds the server); npm run down stops
npm run dev             # http://localhost:5173  (?as=name signs in on dev and plays its last character, ?yard, ?world&test)
npm run typecheck
npx playwright test     # all; tests/online.spec.ts needs `npm run up`; tests/update.spec.ts needs RUINA_DATABASE_URL
PW_PORT=5211 TEST_PORT_OFFSET=10 npx playwright test   # beside another checkout's suite (its own Vite and battle-server ports)
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
- UI follows the design system (`design/ui.html`): labels (buttons, tabs, headings, prompts, tags) in
  Title Case and sentences in sentence case (`src/ui/theme/text.ts`, checked by `tests/ui.spec.ts`);
  items answer a click (pick), a double-click (their main action) and a right-click (a menu).
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
- An account holds up to six characters (`/api/characters`, `server/src/characters.rs`); the world
  plays the one `/ws/world?character=<id>` names, or the last played. `/api/me` is `{id, username}`.
- Deploys: the stopping server tells every player `{t:"updating"}`, saves every island, then closes
  with 1012 (`railway.json` gives it 20 s); pages freeze, reconnect, and reload straight back into the
  world when a new build or `WORLD_PROTOCOL` is out. `POST /api/dev/stop` does the same where
  `DEV_LOGIN=1` (`tests/update.spec.ts`).
- Online the server plays Emberholm: browsers send key presses (binary, 60 a second) and commands,
  the server runs every rule and keeps the islands in Postgres, and answers 20 times a second.
  Nothing a browser says about its own state is believed. `grant`, `warp` and `teleport` (the
  developer panel) only work where `DEV_TOOLS=1` or `DEV_LOGIN=1`.
