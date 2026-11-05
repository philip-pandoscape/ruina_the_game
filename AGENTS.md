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
npm run image -- --out scratch/x.png --ref look.png "prompt"   # a picture from Gemini (Art and assets below)
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
- Never commit `.env` (Railway keys, `GEMINI_API_KEY`). Commit messages carry no AI attribution.

## Art and assets

Concepts come first: paint them and show the user (side by side, with today's look) before making
models. Meshy credits and Gemini billing are the user's money, so say what a batch makes and what it
costs before running it. Whatever comes from outside goes in `CREDITS.md` (what, where, from,
licence).

- **Free assets.** CC0 only (or a licence that asks for no more than a credit), never anything
  taken from another game. Textures from [Poly Haven](https://polyhaven.com/textures) and
  [ambientCG](https://ambientcg.com): the 1K JPGs, only the maps the shader reads, in
  `src/render/assets/` (ground in `ground/`); greyscale where the palette gives the colour
  (`detail.jpg` packs three grains, a channel each).
- **Gemini API** for pictures (concept art, Meshy's input, textures): `tools/images/gemini.mjs`,
  run as `npm run image` (`--list` for the models). It runs the same Nano Banana models as Meshy's
  image tools, for less: Nano Banana Pro (the default) for concepts, `--model
  gemini-3.1-flash-image` (Nano Banana 2) for cheap drafts. The key is `GEMINI_API_KEY` in `.env`;
  in a worktree it is read from the main checkout's `.env`. It needs billing on the key's Google
  project: on the free tier every image model's quota is 0 (a 429). Give the island's reference
  picture as a `--ref` to keep the style. Work in `scratch/` (git-ignored).
- **Meshy** (the `meshy` MCP server) for 3D models: image-to-3D from a concept painted "isolated on
  white, three-quarter front-left view" (that face becomes +Z), `meshy-t2.5` smart topology,
  textured (15 credits; `meshy-7.1` for a showpiece). Check the balance first (free). t2.5 can drop
  thin parts and parts on top (the hay cart lost its hay); `meshy-6` and a remesh fix that.
  - Compress into the game: `npx @gltf-transform/cli optimize in.glb
    src/render/assets/models/<id>.glb --compress meshopt --texture-compress webp --texture-size
    1024 --simplify false --join false --instance false --flatten true` (1024 for buildings, 512
    for props, nodes and packs).
  - An entry in `MADE_STRUCTURES`, `MADE_PROPS` or `MADE_PACKS` (`src/render/models/glb.ts`)
    swaps it in for the procedural model with the same id, fitted into its footprint, so the
    rules, colliders and server never see it.
  - Meshopt keeps positions as normalized int16: bake them to Float32 before any `applyMatrix4`,
    or everything past ±1 m is cut off (`baked` in `glb.ts`).
- `tests/look.spec.ts` shoots the same places at the same hours in both looks
  (`screenshots/look-*`): run it before and after, and show the user both.

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
