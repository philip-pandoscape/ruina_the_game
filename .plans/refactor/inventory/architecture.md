# Inventory: architecture, accounts, developer pages and assets (2026-11-05, beta d49c3b8)

Surveyed read-only before the refactor. Nothing was built for this survey; the `farming` chunk's
cause (section 7) is inferred from the code.

## 1. The three large client files

### src/main.ts (2,451 lines)

| Lines | Section |
|---|---|
| 1-76 | Imports, including 4 CSS files at 69-72 |
| 78-116 | `initUiScale`, the URL options doc block, log capture (107), flags: testMode, serverUrl, raidCount, battlefield, yardMode, openWorld, team, lagMs |
| 118-176 | Mode and boot: `loadModels()` preload (119), `await goOnline` (125), world choice battlefield / zone / yard (133), goblins (135-136), `serverRules` and `Sim` (142-143), `build` (148), TrainingRange (157), OpenStage or Stage (168-176) |
| 177-206 | Scene: hero, dummy, ActorView, MissileView, Vfx, SpellView, drawnGround |
| 207-292 | FollowCamera hooks: groundAt, ceiling, blocker |
| 293-300 | Input, Hud, `bugs` placeholder |
| 302-529 | Open world: Life (`command` wrapped for the bug log, 305-313), LifeView, AutoWalk, LifeUI, WorldPeers, GameTables, MinigamesUI, PartyUI (menu button at 367), DungeonVisit and onPortal (369-421), sky and clock (422-446), Studio and portraits (447-477), `life.remote` and `?fresh` (478-496), `teleport()` and dev-panel hooks (498-529) |
| 531-604 | rideCamera, yard XP (555-582), SkillsPanel (583-604) |
| 605-701 | castOf and NAMES; crowd, NetCrowd, NetSpells, NetMonsters, prediction, remotes (640-684); applyBuild (686-694) |
| 703-999 | Combat input: autoAim (test hook), forEachEnemy, combatStance, aimAssist, lockOn (845-861), ground-aim reticle (863-999) |
| 1001-1039 | syncNet, shadow blob, resize |
| 1041-1155 | `stepOnce`, `showEvent` |
| 1157-1401 | Warnings, drawSpells, drawAbilityBar, refreshActors, `draw()` |
| 1403-1462 | Performance and GPU timer |
| 1464-1611 | `frame()`: input polling 1496-1541, fixed steps 1553-1567, stats |
| 1613-2191 | The test API, `window.__game` (94 members) |
| 2193-2276 | Bug reporter: snapshot, sample, wiring |
| 2278-2451 | Online world: badge, overlay and freeze (2295-2337), reconnect and space change (2341-2360), commands run ahead of the server (2362-2401), onTick (2402-2432), splash fade |

- **Seams:** options and mode; camera rig; open-world composition; battlefield networking; the
  combat-input pipeline; step and events; drawing; performance; the loop; the test API; bug wiring;
  online wiring.
- **Shared state:** 30 top-level `let`s (148, 300, 533-534, 566, 648-673, 791, 870, 914-917, 1301,
  1406-1413, 1466-1476) plus 6 in the online block (2308, 2363-2372). Worst: `build` reassigned at
  494 and 688; `shownActors`/`presentActors` read by castOf, forEachEnemy, stepOnce, the warnings and
  lockOn; `paused`, `frozen`, `acc`, `last` written by the loop, `api.setPaused` and the online block;
  `aimingSlot`, `combat`, `cancelWaiting` module-wide though they belong to aiming; `scripted` and
  `autoAttack` test hooks read in the loop; `bugs` bound late.
- **Hazards:** closures use names before they are declared (`prediction` at 485/505, declared 664;
  `frozen` at 602, declared 1471; `ahead` at 2343, declared 2365); six top-level `await`s;
  `life.command` monkeypatched (307); `lifeUI.intercept` chained twice (368, 410); `life.remote` set
  twice (485, 2379).

### src/ui/life/lifeUI.ts (2,050 lines)

| Lines | Contents |
|---|---|
| 40-110 | Types, NPC faces and greetings, helpers `clock`, `esc`, `withIcons`, `dropcap`, `el` |
| 112-229 | About 45 private fields; the constructor builds 13 HUD elements and `#hud-menu` (198-206) |
| 235-277 | `addMenuButton`, getters |
| 279-501 | Input: `press` (281-332), menu focus, open/close/bag, `finish`, click and context menus |
| 502-593 | Events, toasts, `update()` (525), `signature()` (558) |
| 595-1144 | HUD: portrait/vitals 602, clock 665, minimap 679-770, compass 771, quest goal 809-913, banner/prompt 914, quest tracker 953-1019, ride box 1020, plates/hints 1070-1144 |
| 1145-1187 | Tooltips |
| 1188-1273 | The window frame: `renderPanel`, `updateScroll`, `view()` dispatch |
| 1303-1882 | Windows: dialog 1303, shop 1393, craft 1454, storage 1507, bag 1527-1619, rides 1620, quest log 1656, character 1730, settings 1768, big map 1792 |
| 1884-1943 | The developer panel |
| 1945-1962 | Hooks main.ts sets |
| 1973-2050 | Map drawing, `buildMapImage` |

- **Seams:** HUD widgets; a generic window frame (`View` objects with `data-act` handlers); one
  module per window; map drawing; quest-goal logic.
- **Shared state:** no mutable module-level state; the coupling is the instance (`panel`, `bagOpen`,
  `hadMouse`, `logSel`, `abandonAsk`, `menuFocus`, the handler maps, one global `signature()` that
  triggers re-renders, and 12 hook fields main.ts assigns).

### src/library/app.ts (1,912 lines)

One class, `App` (60-1872): imports and preferences 1-58; DOM layout 110-181; opening a subject and
animation, takes cache 183-284; playback and transport 285-462; pose editing 463-555; notes and
composer 556-666; prompts 667-767; panels 768-1479 (browser 821, transport 975, notes 1099-1326, pose
1327, about 1442); all-notes and help modals 1480-1586; pointer and keys 1587-1755; preferences, URL
hash, routing 1756-1819; test hooks 1820-1872. Helpers are already separate modules (stage, editor,
timeline, store, prompt, measure). Shared state: App's fields and the module singletons `store`
(store.ts:227) and `toastHost` (dom.ts:64).

## 2. Client imports between directories

Import statements from the row's directory into the column's; "(t)" = how many are type-only.

| from | into |
|---|---|
| app | content 3, crowd 1(1), net 4(2), render 1(1), **sim 22(10)**, ui 4, tuning 1 |
| content | sim 1(1), species 1, tuning 2(1) |
| creatures | species 4(1) |
| crowd | species 4, rng 1 |
| input | sim 1(1), tuning 1 |
| library | content 5, render 12(1), species 4, tuning 1 |
| net | app 1, content 1, crowd 1(1), **render 6(3)**, sim 19(10), skills 3(1), tuning 6(2) |
| render | content 42(15), input 1(1), **net 2(2)**, sim 40(21), species 3, **ui 2**, tuning 6, rng 7 |
| sim | content 50(1), skills 3(1), tuning 17(1), rng 2 |
| species | content 5(1), creatures 1, render 6 |
| ui | app 2(2), content 9, input 3(3), **net 6(4)**, render 2(1), sim 18(5), skills 5(1), tuning 5(2), build 3 |
| main.ts | app 8, content 3, crowd 2, input 1, net 7(1), render 18(1), sim 20(2), ui 13 (4 CSS), skills, tuning, build 1 each |
| tuning, build | skills 1; build also tuning 1 |

- **The rules are clean:** `src/sim` imports no render, ui, net, app, input or three, and touches no
  DOM (`document`, `window`, `localStorage`, `performance.now`, `requestAnimationFrame`).
- **render -> net** is type-only (`render/actors.ts`, `render/open/gameTables.ts`).
- **ui -> net with values:** `signIn.ts` and `characterSelect.ts` call `net/account.ts` directly;
  `minigames.ts` and `partyUI.ts` make 28 direct `link.*` calls and set its callbacks.
- **net -> render is the worst:** `netPlayer.ts` builds `Hero` objects; `worldPeers.ts` builds `Hero`
  plus `LifeView` per player.
- **Who changes the rules' state:** never render or the UI (the UI only queues `life.command`). Writers:
  main.ts 375-391, 499-521, 1760-1955, 2387-2431; `app/dungeonVisit.ts` 38-39, 58-59; `app/save.ts`
  62-87; `net/netPlayer.ts` 108-124 (replaces `sim.player`); `net/worldPeers.ts` 195, 202 (adds
  colliders to the local sim), 264 (`sim.world.movers`).
- **content imports three:** `content/creatures/hero.ts` (a value import).
- **Two-way dependencies between directories:** net/render (`worldPeers.ts` -> `render/open/life.ts`;
  `gameTables.ts` -> `worldLink.ts`); app/net (`online.ts` -> `worldLink.ts`; `worldLink.ts:7` ->
  `app/resume.ts`); app/ui (`online.ts` -> signIn, characterSelect, splash; `lifeUI.ts:31` ->
  `autoWalk`); render/ui (`hud.ts:3` -> theme icons; `characterSelect.ts:2` -> `heroPreview`);
  render/species (`actors.ts` -> registry and jelly; `species/crowd.ts` -> look and toon);
  species/creatures (`registry.ts` -> `creatures/index.ts`; `goblin/body.ts` -> species);
  content/sim, a file-level cycle (`content/actors.ts:2` and `sim/actor.ts:6`).
- **File-level cycles inside directories:** the 13-file sim/life cluster; `sim/sim.ts` plus 10 files;
  `sim/zone/generate` -> `sim/types` -> `zone/world`; `render/detail` body and gait; `net`
  actorTimeline and netCrowd.

## 3. The server

| Group | Files |
|---|---|
| Networking | `http.rs` (router, AppState, `same_origin`, ApiError, graceful stop); `world_socket.rs` (`/ws/world`: Hub, play loop, messages, island saver, SQL for home channel, builds and islands); `net.rs` (`/ws/battle`, test lag); `protocol.rs` (the battlefield's binary format) |
| Persistence | `db.rs` (pool, `migrate!`, hourly session purge); `accounts.rs`; `characters.rs`. Islands and builds are JSONB columns on `characters`, written from `world_socket.rs` (425-457, 502, 583, 707) |
| World | `spaces.rs` (channels, dungeon copies, parties, moving players); `channels.rs` (estates, plot claims, CHANNEL_CAP); `parties.rs`; `world_game.rs` (one ChannelGame at 20 Hz: commands, teleport, ride-along, saves); `world_game/tables.rs` (challenges, stakes); `minigames/{mod,beacons}.rs` |
| Rules (TS mirrors) | `tuning`, `skills`, `jsmath`, `content`, `creatures`, `actor`, `actors`, `ai`, `pack`, `missiles`, `player` (`sim.ts` networked), `game` (players' combat, battlefield and world), `open/{mod,colliders,traverse,zone,dungeon}`, `terrain`, `life/*` (13 files) |
| Battlefield | `sim.rs` (bot armies), `world.rs` (its layout), `interest.rs`, `protocol.rs`, `net.rs`, `main.rs` `run()` (150-378) |
| Binaries | `main.rs`; `bin/` aicheck, balance, lifecheck, loadtest, simcheck, terraincheck, worldcheck |

- **The battlefield is tangled into the open world:** `world_game.rs:31,206` creates `Battle::new(0)`;
  `game.rs:19-29` uses `protocol`, `sim` and `world`; `world::{World, Spawn}` are used by `player.rs`,
  `open/mod.rs` and `world_game.rs:33`.
- **main.rs flags (51-74):** `--battle off`; `--bots` (default 10000, 2-65535); `--virtual-clients`;
  `--port`; `--hz` (default 20, 1-60); `--slimes` (default 0); `--static DIR`.
- **Environment:** `PORT`, `DATABASE_URL`, `STATIC_DIR`; `DEV_LOGIN=1` (forced off when
  `RAILWAY_PROJECT_ID` is set, :79); `DEV_TOOLS=1` (implied by DEV_LOGIN, :81); `COOKIE_SECURE=1`
  (implied on Railway). docker-compose has no battlefield (the `server` stage's CMD is `--battle off`).
- **lib.rs** is a flat list of 30 `pub mod`s (7-36), no facade; nested in `life/mod.rs:10-22`,
  `open/mod.rs:6-9`, `minigames/mod.rs:12`; `tables` private (`world_game.rs:37`). The binaries import
  `yggdrasil_server::...` directly.
- **WORLD_PROTOCOL = 7:** `server/src/world_socket.rs:75` (sent at 535) and `src/net/worldLink.ts:189`
  (checked at 588). The battlefield's protocol has no version.

## 4. Accounts, sessions and developer switches

**Schema (three migrations).** `accounts`: id, username, username_key UNIQUE, password_hash
(Argon2id), created_at, last_login_at. `sessions`: token_hash BYTEA PK (SHA-256), account_id FK
(cascade), created_at, expires_at; indexes by account and by expiry. `characters`: id, account_id FK
(cascade), name, island JSONB, build JSONB, saved_at, live_session, created_at, home_channel (0002),
last_played_at (0003); indexes by channel and by account, unique `lower(name)` (0003 dropped the
one-per-account index).

| Route | What it does | Auth |
|---|---|---|
| GET /api/health | `{ok, database, battle, playing}` | none |
| GET /api/me | `{id, username}` or null | cookie optional |
| POST /api/register | account and first character in one transaction, sets the cookie | none |
| POST /api/login | sets the cookie; 10 wrong passwords per name per 10 minutes, in memory | none |
| POST /api/logout | deletes the session, cookie Max-Age=0 | optional |
| POST /api/dev-login | sign in by name only | DEV_LOGIN, else 404 |
| GET/POST /api/characters | list; create (max 6) | session, else 401 |
| DELETE /api/characters/{id} | needs the typed name; 409 while playing | session |
| POST /api/dev/stop | stops the server as a deploy does | DEV_LOGIN only, **no sign-in check** |
| /ws/world?character= | the open world | same-origin check and cookie |
| /ws/battle | the battlefield | **no auth, no origin check** |
| fallback | ServeDir of the built files | none |

Vite also serves `/__bugs/*` and `/__anim-review/*` in development (localhost only).

- **Sessions:** a 32-byte random token (hex), only its SHA-256 stored. Cookie `ruina_session; Path=/;
  HttpOnly; SameSite=Lax; Max-Age=2592000`, `Secure` on Railway or with COOKIE_SECURE
  (`accounts.rs:167-170`). A fixed 30 days, never extended (`signed_in`, 114-124).
- **DEV_LOGIN gates** `/api/dev-login` (`accounts.rs:95`) and `/api/dev/stop` (`http.rs:155`); on the
  client `?as=` (`app/online.ts:43-51`).
- **DEV_TOOLS gates**, through AppState -> `Arrival.dev` (`world_socket.rs:521`) -> `Member.dev`
  (`world_game.rs:69`): `world_game.rs:560` blocks the `is_dev` commands **grant, warp, teleport**
  (`life/mod.rs:93-98`); `tables.rs:220-221` seeded and timed mini-game challenges; `welcome.dev`
  (`world_socket.rs:541`) -> `lifeUI.devTools` (`main.ts:434`).
- **Not gated at all:** island reset (`world_socket.rs:593`), battlefield lag, `window.__game`.
  Offline the developer panel is always on (`lifeUI.ts:1951`).
- **No admin, role or permission exists.** Beta runs with DEV_TOOLS=1, so **every player on beta can
  grant, warp and teleport.**

**Where the admin pieces go.**
- Role: migration `0004`, `ALTER TABLE accounts ADD role TEXT NOT NULL DEFAULT 'player'`.
- `ADMIN_USERS`: parsed at `main.rs:76-81` beside the dev flags, kept in AppState
  (`http.rs:44-58`), matched against `username_key`.
- `admin` in /api/me: a field on `Account` (`accounts.rs:29-34`), filled in `signed_in` (114-124),
  the one function /api/me (49-52), `characters.rs:110` and `world_socket.rs:302` all use; also
  `account_by_id` (150) and `create_account` (147); login and register return the same struct (164).
  Client: the `Account` interface, `net/account.ts:6-9`.
- `/dev/*` pages: at `http.rs:75-78`, `nest_service("/dev", ...)` behind
  `middleware::from_fn_with_state` (`Arc::new(state)` at 79 moves above the router);
  `vite.config.ts` gets `build.rollupOptions.input` for the pages, their chunks kept out of the public
  `/assets` if they should be private.
- Developer commands: `world_socket.rs:521` and `:541` become `dev_tools && account.admin`; the checks
  at `world_game.rs:560` and `tables.rs:220` do the rest. `dev_stop` (`http.rs:154`) should check
  for an admin session; consider guarding `/ws/battle` (`http.rs:162`) too.

## 5. Developer pages and debug entry points

| Entry | Module | Needs | On beta if built? |
|---|---|---|---|
| `/library.html` (hash `#/subject/anim?f=&r=`) | `library/main.ts` | the `animReviews` plugin to save to disk (otherwise notes fall back to localStorage) | yes, notes not saved to disk |
| `/animations.html?anim=&speed=&view=` | `render/detail/animations.ts` | nothing | yes |
| `/retarget.html?file=&clip=&url=&mesh=&view=&draw=0` | `render/detail/retargetView.ts` | `/scratch` files only for `url=`/`mesh=` | yes, for shipped files |
| `/models.html?cat=&only=&label=&yaw=&anchors=1` | `render/models/harness.ts` | nothing | yes |
| `/buildings.html?plan=&cut=&colliders=1&mirror=1&night=1&cam=&at=` | `render/village/viewer.ts` | nothing | yes |
| `/creatures.html` | `render/detail/harness.ts` | nothing | yes |
| `/species.html` | `species/harness.ts` | nothing | yes |
| `/design/`, `/design/ui.html` | `design/bible.ts`, `design/ui.ts` | Google Fonts | yes |
| `?yard`, `?yard&goblins=6` (0-24), `?test`, `?world&test[&load]` | main.ts | nothing | already work in production |
| `?raid=N[&outline=0]` (100-50000) | main.ts | nothing | already works (heavy) |
| `?server=ws://host:7777[&team=&play=0&lag=]` | main.ts, `netCrowd.ts:285` | a battle server (`npm run server`) | no: Railway runs `--battle off` |
| `?as=name` | `app/online.ts` | DEV_LOGIN | no, by design |
| `&fresh`; `&lag=` | main.ts, `worldLink.ts` | none | yes (`&fresh` is ungated) |
| `&look=classic\|new`, `&quality=`, `&lookdebug=ao` | `render/look.ts:35-45` | none | yes |
| `?heroModel=&heroHeight=&heroGait=box`, `?swordMoves=` (club/staff/bow too), `?heroWeapons=box`, `?sword=url,tip,grip` | `madeHero.ts:22-67`, `madeWeapons.ts:57-69` | a URL for custom GLBs | yes |
| `&softlock=0`, `?bugs=0`, `&bugspeech=0`, `&buglang=` | main.ts 856, 2259-2268 | none | yes |

- **The in-game developer panel:** the backquote key (`input.ts:118` -> `press('dev')`,
  `lifeUI.ts:329`); no menu button, no controller binding. `devView` (`lifeUI.ts:1884-1943`): grant
  coins/seals/labor/items, warp time (+1 min, +10 min, +1 h), teleport to places and dungeon doors,
  start the island over, record a bug report.
- **The bug reporter:** `\` or both sticks; Backspace twice throws a report away
  (`app/bugs/reporter.ts`). Saving goes through `/__bugs` (`tools/bugReports.ts`), dev server only,
  same machine and origin. On beta it records the 3D view all the time but can't save.

## 6. Where an Admin button goes

| Screen | Where | How buttons are added |
|---|---|---|
| Title screen | `index.html:100-215`; `.sp-foot` "Prototype" at 214; the splash is skipped for `?server/raid/yard/test` (line 15) | cards on `splash.layer` (`#sp-ui`, `splash.ts:60`) |
| Sign-in | `signIn.ts:96-143` (`.fd-swap` row at 139) | `el()` / `card()` (14-23) |
| Character select | `.cs-account` row (`characterSelect.ts:71`, "Signed in as ... Sign Out"), `.cs-buttons` (65) | `el('button')` with `onclick` |
| In game, open world | `#hud-menu` (`lifeUI.ts:198-206`), buttons with `data-press` -> `press()` | `addMenuButton(press, icon, label, key)` (235-242), before Settings, as Party does (`main.ts:367`). A new 'admin' press needs the `LifePress` type (40), a `press()` case (295-331), a `Panel` kind (53) and a `view()` case (1247) |
| In game, elsewhere | online badge (`signIn.ts:155-159`: Characters, Sign Out); Settings window (1768-1789) | as above |
| Yard and battlefield | no menu bar, only the Skills button (`render/hud.ts:143`) | |

## 7. Asset loading

| Folder | Contents | Referenced | Fetched |
|---|---|---|---|
| `render/assets/models` | 41 GLB, 4.84 MB | eager URL globs (`models/glb.ts:13`, `madeHero.ts:20`, `madeWeapons.ts:45`), GLTFLoader + Meshopt (`assets.ts:38-54`) | made models swap in as the island builds; the hero (699 KB), walk, run, `hero_swings` (316 KB) and 4 weapons (892 KB) with the first `Hero` (so the character select preview); `hero_moves_meshy` only with `?swordMoves=meshy` |
| `render/assets/village` | `kit.glb` 2.16 MB, `props.glb` 1.66 MB | `village/kit.ts:17` | when OpenStage builds the village (`village.ts:163`) |
| `render/assets/ground` | 14 JPG, 2.43 MB | `ground.ts:19` | terrain build |
| `render/assets/*.jpg` | bark and detail, 273 KB | `leaves.ts:12`, `models/detail.ts:19` | first use |
| `ui/theme/icons` | 143 WebP, 1.03 MB | `new URL()` in `icons.gen.ts` | on demand (`icons.ts:37-45`) |
| `ui/theme/fonts` | 4 woff2, 315 KB | `theme.css:6-9`, `index.html:33` | preloaded (`scale.ts:77-81`) |

- Shared JSON and CSS are static imports, bundled into the JavaScript. Nothing is split by zone: the
  open world fetches everything when it is first built.
- The `models` chunk: `render/open/models.ts:36-46` loads `render/models/index.ts` through a
  non-eager glob (a dynamic import, so its own chunk), "soft" (if it fails, stand-ins are drawn). It
  starts during sign-in (`main.ts:119`), open world only. Only partly lazy: `models/kit.ts` and
  `models/glb.ts` are statically imported by the main bundle (`stage.ts:4-5`, `gameTables.ts:5`).
- The `farming` chunk (inferred): `render/models/data.ts:1-3` imports `structures.json`,
  `farming.json` and `trade.json`, which the main bundle also imports; the bundler likely moved them
  into a common chunk named after `farming.json` (`build.manifest` would confirm).
