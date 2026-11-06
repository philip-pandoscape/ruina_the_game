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
| `src/render/look.ts` | The look, its palette, and how much of it each quality draws (`GRAPHICS`): `high` on a graphics card, `medium` on integrated graphics, `low` where WebGL is drawn in software (CI) or there is no WebGL2; `?quality=low|medium|high` chooses. Screen effects in `src/render/open/post.ts`; textured ground `open/ground.ts`; made models (Meshy, compressed, in `src/render/assets/models/`) swapped in for the procedural ones by id and fitted into their footprints, `models/glb.ts`, so the rules never see them; `tests/stress/look.spec.ts` shoots each quality |
| `src/render/village/`, `shared/buildings.json` | Buildings you can walk into, built from Quaternius' village kit: plans (`src/content/buildings.ts`) on its 2 m grid, 3 m a storey, walls written as strings of modules (door, window, arch...), stairs, roof, furniture. The rules wall, floor and stair-step each one from its plan (`src/sim/zone/buildings.ts`: doorways open, upper floors and treads as decks, furniture solid; baked for the server like the rest of the island). `assemble.ts` lays out the kit's pieces; `village.ts` draws the town in a few merged meshes, cuts the house you are in open above your storey (its roof still shading the room), keeps the camera in its walls, swings doors open as anyone comes up to them and lights the lamps and hearths nearest you; `furnish.ts` the furniture (props, rugs, straw, fire). Players' cottages are its too, stage by stage. `/buildings.html` shows each plan (`?cut=0` from inside, `?colliders=1` the rules over it) |
| `src/render/detail/` | Close-up bodies. `humanoid.ts` poses every humanoid as a pure function of `PoseInput` (the crowd bakes its clips from it), with `body.ts` (two-bone IK), `gait.ts` (planted feet at any speed and heading), `swings.ts` (weapon keyframes), `stow.ts` (where weapons are put away); `src/render/character.ts` adds the stateful parts (transitions, foot holds, trails, bowstring, drawing and putting away the weapon). `/animations.html` plays them all; `tests/integration/animation.spec.ts` measures them. The hero wears a made body (`madeHero.ts`, `assets/models/hero.glb`; the box hero stands in until it has loaded): `fit.ts` measures the hero rig off the model's skeleton, moves its skin onto our joints, adds a palm and finger joints to each hand and closes them round what they hold (`gripHands`), so the same poses move it; it carries made weapons (`madeWeapons.ts`) where the box hero's were. Its moves can also be clips from animation libraries, retargeted onto it bone for bone (`retarget.ts`; which move plays which clip: `moves.ts`, `?swordMoves=keyed|meshy|quaternius` to compare); `/retarget.html` shows a clip on the hero beside its source and `tests/integration/retarget.spec.ts` holds every one to it |
| `src/library/` | The animation library, `/library.html`: every animated thing (hero, slimes, crowd bodies, farm animals, townsfolk, mounts) through an adapter in `subjects/` that keeps each frame of an animation, so it can be scrubbed, onion-skinned and posed. Notes on an animation, a stretch of frames or a frame (a pose corrected by moving its bones: `editor.ts`) become one prompt for Claude (`prompt.ts`). The dev server keeps them in `reviews/animations/` (`tools/animReviews.ts`); corrected poses stay as green ghosts on their frames to compare a fix against, and `tests/integration/library-review.spec.ts` (`REVIEW=<review.json>`) measures them. A review to act on: the `animation-review` skill |
| `src/ui/` | The Parchment & Timber look. `theme/`: the CSS, the UI laid out on a 1029 px virtual screen and scaled to the window (`scale.ts`), fonts, tooltips, right-click menus (`contextMenu.ts`), the writing rule (`text.ts`), painted icons (`icons.ts`; `tools/icons/catalog.mjs` lists what each one shows and the emoji or item it stands for, `node tools/icons/paint.mjs` paints them nine to a sheet with Gemini, `npm run icons` cuts them out). `life/lifeUI.ts`: the island's HUD and its windows docked at the sides. `skills/`: the skill book (T) and the skill tree (N). Skill points are counted from finished quests (`src/sim/life/progress.ts`), never stored. `minigames/`: challenging another player (F on them), the invitation, and the game window at your table (Beacons' board), all showing what the server sends. `party/`: the party frame under your portrait, the invitation and the Party window (O) |
| `src/main.ts` | Wires it all up; URL options at the top (`?lag=ms` plays a local server as a far one feels); `window.__game` is the test API. Riding, the vehicle is placed before its rider is posed in its seat (`LifeView.placeRide`). Online, picking packs up and putting them down, loading, unloading and getting in run ahead in the browser until the server has run them too |
| `src/app/autoWalk.ts`, `src/sim/zone/roads.ts` | Auto-run (H) and travel by road from the map: the road network and its routes, followed by making the same controls the keyboard would (`src/ui/life/travelUI.ts` draws them) |
| `src/app/online.ts`, `src/net/` | The way in (the title screen drawn by `index.html`, `src/ui/splash.ts`, sign-in `src/ui/signIn.ts`, `src/ui/characterSelect.ts`), the world connection (`worldLink.ts`: inputs and commands out, the server's ticks in; riding out a server update, `src/app/resume.ts`), predicting your own player (`netPlayer.ts`), everyone else in your channel (`worldPeers.ts`: their vehicles solid to you, and drawn before anyone riding along sits in them; at a mini-game's table on its stool, `src/render/open/gameTables.ts`), monsters drawn on a timeline between the server's ticks (`actorTimeline.ts`) with hits felt at once (`netMonsters.ts`), the battlefield client |
| `server/` | Rust server. It plays Emberholm: `world_game.rs` runs each channel (players from their inputs, the island's rules, slimes, combat via `game.rs`), `world_socket.rs` is the connection; `spaces.rs` holds every channel and every party's copy of a dungeon (a copy is a channel game whose space is a Copy: entered through the dungeon's portal, kept 30 minutes after the last player leaves, as World of Warcraft keeps an instance), moves players between them mid-connection and keeps the parties (`parties.rs`); riding along in someone else's vehicle is the channel's (the player's `host`, `seat_passengers`), as their vehicles aren't on your island; so are mini-games (`world_game/tables.rs`: challenges, the tables and the money on them, a pot only ever moving between the two islands at the table, written together; `minigames/` the tables' clocks and each game's rules, Beacons first); `open/` the island's ground, colliders and traversal (baked from the TS generator into `server/data/emberholm.zone` by `tests/conformance/terrain.test.ts`; the Windspire's waterfall and the ledge behind it are cut by the generator's `falls`), a dungeon's floors and walls solid only in a copy of it (`open/dungeon.rs`, `src/sim/zone/dungeon.ts`), `life/` trade, farming, housing, vehicles and quests. Accounts and islands in Postgres (`server/migrations/`, applied on start). The PvP battlefield. `player.rs`, `skills.rs`, `open/`, `life/` mirror the TS rules |
| `shared/*.json` | Content and tuning, read by both sides. New content is data, not code. `shared/dungeons/`: each dungeon's floors and walls round its origin, where you come in and its way out (its portal is in the island's recipe, `dungeons`; the plan so far is in `.plans/dungeons/`) |
| `shared/creatures/`, `src/creatures/` | Creatures with folders of their own, the goblins first (`design/goblins.md`). A creature is data and a body: `shared/creatures/<name>.json` holds its kinds, attacks and brains (the format of `shared/behaviours.json`, plus its pack's tactics), and `src/creatures/<name>/` its body for the crowd renderer. Both run on shared engine parts, in TypeScript and Rust alike: senses (`src/sim/ai/senses.ts`, every player as a foe), the pack (`pack.ts` ↔ `server/src/pack.rs`: attack tokens, openings, ring places, courage), the brains' walk, strike, throw and heal acts (`brain.ts` ↔ `ai.rs`) and missiles (`src/sim/combat/missiles.ts` ↔ `missiles.rs`). A new creature is a file and a body, listed in `src/content/creatures.ts` and `server/src/creatures.rs` in the same order; a behaviour the engine can't express becomes a new engine part, never creature code. `?yard&goblins=6` puts a band in the yard |
| `tests/` | The test tiers (`tests/AGENTS.md`, `docs/testing.md`): `unit/` (Vitest, no browser), `conformance/` (Vitest: the TypeScript rules against the Rust ones), `integration/` (Playwright: the game in a browser with its servers), `stress/` (Playwright, a real GPU), `support/` (shared helpers, the typed `window.__game`) |
| `design/` | Design bible (`/design/` on the dev server) and the UI design system (`/design/ui.html`); `design/status.json` is the tracker and session log |

## Commands

```sh
npm run up              # Postgres + game server in Docker (rebuilds the server); npm run down stops
npm run dev             # http://localhost:5173  (?as=name signs in on dev and plays its last character, ?yard, ?world&test)
npm run typecheck
npm run check           # typecheck + the unit tier (Vitest tests/unit, cargo test): seconds, run after every change
npm run check:beta      # + the integration tier (tests/conformance, then Playwright tests/integration): before every push to beta
npm run check:release   # + the stress tier (tests/stress, a real GPU): before a release
npx playwright test tests/integration/ui.spec.ts   # some of the integration tier: files, -g "title"; --last-failed after a fix
PW_PORT=5211 TEST_PORT_OFFSET=10 npx playwright test   # beside another checkout's suite (its own Vite and battle-server ports)
npm run bake            # rebake the server's copy of the island after changing it
npm run image -- --out scratch/x.png --ref look.png "prompt"   # a picture from Gemini (Art and assets below)
```

The tiers, where a new test goes, the shared helpers and a private test rig: `docs/testing.md`. The
online specs need a world server with a database (`npm run up`, or the private rig there);
`tests/integration/update.spec.ts` needs `RUINA_DATABASE_URL`.

## Rules

- Rules both sides run (movement, traversal, combat, skills, the island's life systems) change in
  TypeScript **and** Rust together; `tests/conformance/player.test.ts`, `tests/conformance/world.test.ts`
  and `tests/conformance/life.test.ts` compare them. Online the server decides; the browser only
  predicts its own moves and shows what the server says.
- After changing the island (`shared/zones/`, `src/sim/zone/`, the building plans in
  `shared/buildings.json`), rebake the server's copy: `npm run bake`.
  The server builds the bake into itself, so rebuild it before the conformance tests.
- Keep `src/sim/` deterministic: its own seeded RNG, never `Math.random` or `Date.now`.
- When a feature lands, update `design/status.json` (feature status, next steps, session log).
- UI follows the design system (`design/ui.html`): labels (buttons, tabs, headings, prompts, tags) in
  Title Case and sentences in sentence case (`src/ui/theme/text.ts`, checked by `tests/integration/ui.spec.ts`);
  items answer a click (pick), a double-click (their main action) and a right-click (a menu).
- Tests go in the lowest tier that can show the thing works (`docs/testing.md`): `tests/unit` for
  logic (no browser), `tests/integration` for the game in a page, `tests/stress` for speed and crowds.
  Integration tests open the game with `tests/support/game.ts` and drive it through the typed
  `window.__game`, a frame at a time; they never wait a fixed time for the game to notice something.
- Tag a test `@gpu` if it needs a real GPU to keep up (several game windows, frame rates, screen
  capture): CI renders in software and skips them. Tag it `@alone` if it races the clock in a way
  other pages drawing would upset (stopping a server under players, two windows of one character):
  those run one at a time, after the rest. A spec file that starts a battle server gives it a port no
  other file uses (`tests/support/testServer.ts`); one whose tests share nothing says so
  (`test.describe.configure({ mode: 'parallel' })`).
- Servers started on a development machine listen on localhost only (`--listen all` for other
  machines): nothing should ever need someone at the machine to click a Windows prompt.
- Never commit `.env` (Railway keys, `GEMINI_API_KEY`). Commit messages carry no AI attribution.

## Art and assets

Finding and fetching free assets (models, textures, skies, animations, sounds, music, effects,
fonts), checking their licences, crediting and bringing them in: the `find-assets` skill
(`.claude/skills/find-assets/SKILL.md`, with `tools/assets/search.mjs` and `tools/assets/fetch.mjs`).
The repository is public: only CC0 and CC BY files go in it.

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
- `tests/stress/look.spec.ts` shoots the same places at the same hours at each quality
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
  and `ADMIN_USERS` (the accounts, by name, that reach the developer pages and commands: `philip`).
- An account holds up to six characters (`/api/characters`, `server/src/characters.rs`); the world
  plays the one `/ws/world?character=<id>` names, or the last played. `/api/me` is `{id, username, admin}`.
- Deploys: the stopping server tells every player `{t:"updating"}`, saves every island, then closes
  with 1012 (`railway.json` gives it 20 s); pages freeze, reconnect, and reload straight back into the
  world when a new build or `WORLD_PROTOCOL` is out. `POST /api/dev/stop` does the same where
  `DEV_LOGIN=1`, for a signed-in admin (`tests/integration/update.spec.ts`).
- Online the server plays Emberholm: browsers send key presses (binary, 60 a second) and commands,
  the server runs every rule and keeps the islands in Postgres, and answers 20 times a second.
  Nothing a browser says about its own state is believed. The developer commands (`grant`, `warp`,
  `teleport`, starting an island over: the developer panel) and the developer pages (`/dev/`,
  `/design/`) answer admins only: the accounts `ADMIN_USERS` names, or everyone where `DEV_LOGIN=1`
  (development; never on Railway). `DEV_TOOLS` no longer opens them to everyone.
