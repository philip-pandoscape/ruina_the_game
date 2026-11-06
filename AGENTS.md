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
| `src/render/village/`, `shared/buildings.json` | Buildings you can walk into, built from Quaternius' village kit: plans (`src/content/buildings.ts`) on its 2 m grid, 3 m a storey, walls written as strings of modules (door, window, arch...), stairs, roof, furniture. The rules wall, floor and stair-step each one from its plan (`src/sim/zone/buildings.ts`: doorways open, upper floors and treads as decks, furniture solid; baked for the server like the rest of the island). `assemble.ts` lays out the kit's pieces; `village.ts` draws the town in a few merged meshes, cuts the house you are in open above your storey (its roof still shading the room), keeps the camera in its walls, swings doors open as anyone comes up to them and lights the lamps and hearths nearest you; `furnish.ts` the furniture (props, rugs, straw, fire). Players' cottages are its too, stage by stage. `/buildings.html` shows each plan (`?cut=0` from inside, `?colliders=1` the rules over it) |
| `src/render/detail/` | Close-up bodies. `humanoid.ts` poses every humanoid as a pure function of `PoseInput` (the crowd bakes its clips from it), with `body.ts` (two-bone IK), `gait.ts` (planted feet at any speed and heading), `swings.ts` (weapon keyframes), `stow.ts` (where weapons are put away); `src/render/character.ts` adds the stateful parts (transitions, foot holds, trails, bowstring, drawing and putting away the weapon). `/animations.html` plays them all; `tests/animation.spec.ts` measures them. The new look's hero wears a made body (`madeHero.ts`, `assets/models/hero.glb`): `fit.ts` measures the hero rig off the model's skeleton, moves its skin onto our joints, adds a palm and finger joints to each hand and closes them round what they hold (`gripHands`), so the same poses move it; it carries made weapons (`madeWeapons.ts`) where the box hero's were. Its moves can also be clips from animation libraries, retargeted onto it bone for bone (`retarget.ts`; which move plays which clip: `moves.ts`, `?swordMoves=keyed|meshy|quaternius` to compare); `/retarget.html` shows a clip on the hero beside its source and `tests/retarget.spec.ts` holds every one to it |
| `src/ui/` | The Parchment & Timber look. `theme/`: the CSS, the UI laid out on a 1029 px virtual screen and scaled to the window (`scale.ts`), fonts, tooltips, right-click menus (`contextMenu.ts`), the writing rule (`text.ts`), painted icons (`icons.ts`; `tools/icons/catalog.mjs` lists what each one shows and the emoji or item it stands for, `node tools/icons/paint.mjs` paints them nine to a sheet with Gemini, `npm run icons` cuts them out). `life/lifeUI.ts`: the island's HUD and its windows docked at the sides. `skills/`: the skill book (T) and the skill tree (N). Skill points are counted from finished quests (`src/sim/life/progress.ts`), never stored. `minigames/`: challenging another player (F on them), the invitation, and the game window at your table (Beacons' board), all showing what the server sends |
| `src/main.ts` | Wires it all up; URL options at the top (`?lag=ms` plays a local server as a far one feels); `window.__game` is the test API. Riding, the vehicle is placed before its rider is posed in its seat (`LifeView.placeRide`). Online, picking packs up and putting them down, loading, unloading and getting in run ahead in the browser until the server has run them too |
| `src/app/autoWalk.ts`, `src/sim/zone/roads.ts` | Auto-run (H) and travel by road from the map: the road network and its routes, followed by making the same controls the keyboard would (`src/ui/life/travelUI.ts` draws them) |
| `src/app/online.ts`, `src/net/` | The way in (the title screen drawn by `index.html`, `src/ui/splash.ts`, sign-in `src/ui/signIn.ts`, `src/ui/characterSelect.ts`), the world connection (`worldLink.ts`: inputs and commands out, the server's ticks in; riding out a server update, `src/app/resume.ts`), predicting your own player (`netPlayer.ts`), everyone else in your channel (`worldPeers.ts`: their vehicles solid to you, and drawn before anyone riding along sits in them; at a mini-game's table on its stool, `src/render/open/gameTables.ts`), monsters drawn on a timeline between the server's ticks (`actorTimeline.ts`) with hits felt at once (`netMonsters.ts`), the battlefield client |
| `server/` | Rust server. It plays Emberholm: `world_game.rs` runs each channel (players from their inputs, the island's rules, slimes, combat via `game.rs`), `world_socket.rs` is the connection; riding along in someone else's vehicle is the channel's (the player's `host`, `seat_passengers`), as their vehicles aren't on your island; so are mini-games (`world_game/tables.rs`: challenges, the tables and the money on them, a pot only ever moving between the two islands at the table, written together; `minigames/` the tables' clocks and each game's rules, Beacons first); `open/` the island's ground, colliders and traversal (baked from the TS generator into `server/data/emberholm.zone` by `tests/terrain.spec.ts`), `life/` trade, farming, housing, vehicles and quests. Accounts and islands in Postgres (`server/migrations/`, applied on start). The PvP battlefield. `player.rs`, `skills.rs`, `open/`, `life/` mirror the TS rules |
| `shared/*.json` | Content and tuning, read by both sides. New content is data, not code |
| `tests/` | Playwright tests that play the real game, plus TS/Rust conformance |
| `design/` | Design bible (`/design/` on the dev server) and the UI design system (`/design/ui.html`); `design/status.json` is the tracker and session log |

## Commands

```sh
npm run up              # Postgres + game server in Docker (rebuilds the server); npm run down stops
npm run dev             # http://localhost:5173  (?as=name signs in on dev and plays its last character, ?yard, ?world&test)
npm run typecheck
npx playwright test     # all (or npm test), ~12 min; tests/online.spec.ts and tests/minigames.spec.ts need `npm run up`; tests/update.spec.ts needs RUINA_DATABASE_URL
npx playwright test tests/ui.spec.ts   # some of it: files, -g "title"
npx playwright test --last-failed      # after a fix, what failed last time, not the whole suite again
PW_PORT=5211 TEST_PORT_OFFSET=10 npx playwright test   # beside another checkout's suite (its own Vite and battle-server ports)
PW_WORKERS=4 npx playwright test   # fewer test pages side by side (6 by default)
cargo test --release --manifest-path server/Cargo.toml   # needs Rust; CI runs it anyway
npm run image -- --out scratch/x.png --ref look.png "prompt"   # a picture from Gemini (Art and assets below)
```

## Rules

- Rules both sides run (movement, traversal, combat, skills, the island's life systems) change in
  TypeScript **and** Rust together; `tests/conformance.spec.ts`, `tests/world-conformance.spec.ts`
  and `tests/life-conformance.spec.ts` compare them. Online the server decides; the browser only
  predicts its own moves and shows what the server says.
- After changing the island (`shared/zones/`, `src/sim/zone/`, the building plans in
  `shared/buildings.json`), rebake the server's copy: `BAKE=1 npx playwright test tests/terrain.spec.ts`.
  The server builds the bake into itself, so rebuild it before the conformance tests.
- Keep `src/sim/` deterministic: its own seeded RNG, never `Math.random` or `Date.now`.
- When a feature lands, update `design/status.json` (feature status, next steps, session log).
- UI follows the design system (`design/ui.html`): labels (buttons, tabs, headings, prompts, tags) in
  Title Case and sentences in sentence case (`src/ui/theme/text.ts`, checked by `tests/ui.spec.ts`);
  items answer a click (pick), a double-click (their main action) and a right-click (a menu).
- Tag a test `@gpu` if it needs a real GPU to keep up (several game windows, frame rates, screen
  capture). CI renders in software and skips them; run them locally before pushing such changes.
- Locally the tests run side by side, six pages at once (`playwright.config.ts`), and `@gpu` and
  `@alone` tests one at a time: the whole suite plays them after the rest, a run of some of it beside
  the rest. Tag a test `@alone` if it races the clock in a way other pages drawing would upset
  (stopping a server under players, two windows of one character). A spec file that starts a battle
  server gives it a port no other file uses (`tests/testServer.ts`); one whose tests share nothing
  says so (`test.describe.configure({ mode: 'parallel' })`). A test never waits a fixed time for the
  game to notice something (a key, a pad button): it waits for frames.
- Never commit `.env` (Railway keys, `GEMINI_API_KEY`). Commit messages carry no AI attribution.

## Art and assets

Free first: before making a model, texture or animation, look for a free one (below) and judge it in
the game's look beside what we would make. Make one only when nothing free is as good; never trade
quality for the saving. Concepts come first for whatever is made: paint them and show the user (side
by side, with today's look) before making models. Meshy credits and Gemini billing are the user's
money, so say what a batch makes, what it costs and what free option it beats before running it.
Whatever comes from outside goes in `CREDITS.md` (what, where, from, licence).

- **The village kit.** Buildings are plans, not models: walls, floors, roofs, stairs, doors and
  windows from Quaternius' Medieval Village MegaKit, furniture from his Fantasy Props MegaKit (both
  CC0; the free Standard zips from quaternius.itch.io). `node tools/models/village.mjs <MegaKit
  glTF folder> <Props glTF folder>` packs the pieces it lists into `src/render/assets/village/kit.glb`
  and `props.glb` (WebP at 1024, meshopt, the heaviest simplified). A new building is a plan in
  `shared/buildings.json` and a structure with `collider: 'building'`; a new piece of furniture an
  entry in its catalogue.

- **Free assets.** CC0 (or a licence that asks for no more than a credit), never anything taken
  from another game, fan art of one included.
  - Models: [Poly Haven](https://polyhaven.com/models) first. Realistic, CC0 and scriptable:
    `https://api.polyhaven.com/assets?t=models` lists every model with its tags, `/info/<id>` gives
    its size in millimetres and its triangles, `/files/<id>` its glTF at 1k to 8k with the textures.
    Props, tools, rocks, trees and a few weapons (an estoc, a saber, a mace, a war hammer, a dagger,
    axes, a kite shield). [Sketchfab](https://sketchfab.com) has far more: its search API
    (`https://api.sketchfab.com/v3/search?type=models&downloadable=true&license=cc0`, or `by`)
    needs no key, but downloads need the user's API token, and many CC0 models there are museum
    scans too heavy to use as they are. [Quaternius](https://quaternius.com) and
    [Kenney](https://kenney.nl) are CC0 but low-poly and stylized: stand-ins, not the look.
  - Textures from [Poly Haven](https://polyhaven.com/textures) and
    [ambientCG](https://ambientcg.com): the 1K JPGs, only the maps the shader reads, in
    `src/render/assets/` (ground in `ground/`); greyscale where the palette gives the colour
    (`detail.jpg` packs three grains, a channel each).
  - Animations: a Meshy rig comes with a free walk and run (`mocap.ts` bakes them onto our rig).
    Quaternius' Universal Animation Library ([1](https://quaternius.com/packs/universalanimationlibrary.html),
    [2](https://quaternius.com/packs/universalanimationlibrary2.html)) is CC0, its free sets on
    itch.io: sword combos, a heavy combo, a block, a roll, hits, a death, spells, farming (animated
    by hand, not captured). Meshy's library (`meshy_animate`, 3 credits a clip) is made on our
    hero's own skeleton. Bringing a clip onto a character (find it, cut it with
    `tools/models/clips.mjs`, retarget it, wire it to a move, check it against its source): the
    `retarget-animation` skill (`.claude/skills/retarget-animation/SKILL.md`).
- **Gemini API** for pictures (concept art, Meshy's input, textures): `tools/images/gemini.mjs`,
  run as `npm run image` (`--list` for the models). It runs the same Nano Banana models as Meshy's
  image tools, for less: Nano Banana Pro (the default) for concepts, `--model
  gemini-3.1-flash-image` (Nano Banana 2) for cheap drafts. The key is `GEMINI_API_KEY` in `.env`;
  in a worktree it is read from the main checkout's `.env`. It needs billing on the key's Google
  project: on the free tier every image model's quota is 0 (a 429). Give the island's reference
  picture as a `--ref` to keep the style. Work in `scratch/` (git-ignored).
- **Icons** are painted with Gemini too, nine to a 2K sheet on a flat key colour, the first sheet
  the style for the rest: `tools/icons/catalog.mjs` says what each one shows and which emoji or item it
  stands for, `node tools/icons/paint.mjs` paints the sheets it has no picture of yet, `npm run icons`
  cuts them out into `src/ui/theme/icons/` (and fails while content names an emoji no icon stands
  for). Look at a new sheet before baking it: the painter now and then ignores the background
  colour, draws the cells, or paints the wrong thing (a glider as a bird); paint it again.
- **Meshy** (the `meshy` MCP server) for the 3D models nothing free matches: image-to-3D from a
  concept painted "isolated on white, three-quarter front-left view" (that face becomes +Z),
  `meshy-t2.5` smart topology, textured (15 credits; `meshy-7.1` for a showpiece). Check the
  balance first (free). t2.5 can drop thin parts and parts on top (the hay cart lost its hay);
  `meshy-6` and a remesh fix that.
  - Compress into the game: `npx @gltf-transform/cli optimize in.glb
    src/render/assets/models/<id>.glb --compress meshopt --texture-compress webp --texture-size
    1024 --simplify false --join false --instance false --flatten true` (1024 for buildings, 512
    for props, nodes and packs).
  - An entry in `MADE_STRUCTURES`, `MADE_PROPS` or `MADE_PACKS` (`src/render/models/glb.ts`)
    swaps it in for the procedural model with the same id, fitted into its footprint, so the
    rules, colliders and server never see it.
  - Meshopt keeps positions as normalized int16: bake them to Float32 before any `applyMatrix4`,
    or everything past ±1 m is cut off (`baked` in `glb.ts`).
  - A character: paint a front, side and back sheet (Gemini), then multi-image-to-3D with
    `pose_mode: "t-pose"` and a remesh to ~30k triangles (`meshy-7.1`, 30 credits), then
    `meshy_rig` (5). Meshy's rig has no finger bones; `fit.ts` adds them. Compress with
    `--flatten false` so the skeleton keeps its tree.
  - Meshy's textures are colour only, so its metal looks painted. For the hero's weapons
    (`madeWeapons.ts`), `tools/models/weaponprep.mjs` paints a metal-roughness map from the colours
    (and a glow map, and cuts off the bowstring the game draws itself) before compressing.
- `tests/look.spec.ts` shoots the same places at the same hours in both looks
  (`screenshots/look-*`): run it before and after, and show the user both.

## Branches and deploys

- `beta` (default): push directly. CI (`.github/workflows/ci-cd.yml`) typechecks and builds the
  client and runs the Rust tests; if they pass, it deploys to https://ruinathegame-beta.up.railway.app.
  It skips the Playwright suite for a beta push (CI has no GPU, so it takes half an hour and more):
  run the full suite locally before pushing (`npx playwright test`; online specs need a server).
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
