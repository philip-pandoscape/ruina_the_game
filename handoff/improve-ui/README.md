# Handoff: `feature/improve-ui` (the UI restyle, the skill book and the skill tree)

Paused on 2026-11-04 at the user's request, to be picked up in a new session. Point the new session
at this file. **Delete `handoff/` before this branch is merged into `beta`.**

- Branch: `feature/improve-ui`, branched from `beta` at `2f1257e`, pushed to `origin/feature/improve-ui`
  (CI runs only for `beta` and `production`, so pushing this branch deploys nothing).
- Worktree: `C:\GitHub\heggelund\games\ruina-ui-restyle` (the main checkout `C:\GitHub\heggelund\games\ruina`
  stays on `beta`, where another session works).
- The user's standing instruction: build it all on this branch, commit in steps, and **hold until the
  user says to merge into `beta`**. Don't push to `beta` before then.

## Where it stands (second session, 2026-11-04)

Steps 1 to 4 of "What's left" are done and committed; the review canvas (step 5) has been shown.
Nothing is pushed since `81be79e`: the rest is only in this worktree. Wait for the user's go-ahead
before step 6.

- **Conformance** rerun with `valid_movement` in: 78 passed (conformance, ai-, life-, world-
  conformance, skilltree, progress, terrain).
- **Findings a to d fixed** (`f4311e9`, `8f1f426`, `d807cbf`, `1b6fd40`), each with a test that fails on
  the old rule: a place reached counts by each quest's own reach and height (both rules; new
  life-conformance scenario); hits carry their weapon (arrows train their bow, blasts nothing);
  `actorDie` says `killed`, and only kills are defeats; `__game.setBuild` and the offline island use the
  island's budget, and the welcome build is taken as the server sent it (a 31-point build was
  dropped by the browser's 30). Finding e (no TS-versus-Rust run with creatures) is still open.
- **Beta merged** (`8c504e5`) as the merge notes below say. Follow-ups: the battlefield's
  over-budget test build was 9 skills, legal under `skills.points` 30 (`1b4934a`); the server's test of
  what trains what packed 9-byte inputs, 10 since the facing (`9ce5b14`).
- **Docs** (`4f0c4f1`): the two patch scripts, plus a `src/ui/` row in `AGENTS.md`, `src/ui/theme` and
  the character window (P) in the README.
- **Tests** on the merged branch: typecheck clean; the full local suite 270 passed, 12 skipped (all
  `online.spec.ts`), 0 failed; `cargo test --release` 109 passed; `online.spec.ts` 12 passed against
  this branch's server on a private Postgres.
- **Noticed, not changed** (in the canvas for the user): a wide docked window (the quest log) covers
  the left end of a long toast; the `!` in the quest scroll's hint is about 8 px at 720p.

On this machine (`C:\GitHub\games\yggdrasil`): the worktree is `.claude\worktrees\improve-ui`, Rust is
native (`%USERPROFILE%\.cargo\bin\cargo.exe`), and Docker Desktop starts other projects' containers when
it starts. Use `PW_PORT=5321` with the config here; the online tests ran against
`DATABASE_URL=postgres://ruina:ruina@127.0.0.1:5439/ruina DEV_LOGIN=1 server/target/release/yggdrasil-server.exe --battle off --port 7796`
(Postgres from `docker run --rm --name ruina-ui-db ... -p 127.0.0.1:5439:5432 postgres:18`) with
`RUINA_SERVER=http://localhost:7796`, which stays clear of 7777 and the `ruina` compose project.

## Resume in ten minutes

1. `cd C:\GitHub\heggelund\games\ruina-ui-restyle` (if the worktree is gone:
   `git -C C:\GitHub\heggelund\games\ruina worktree add ..\ruina-ui-restyle feature/improve-ui`, then `npm ci`).
2. Read `AGENTS.md`, then this file. `git log --oneline 2f1257e..HEAD` shows the work so far.
3. Check `beta` again: `git log --oneline HEAD..beta`. It had moved to `5d273fb` when this paused.
4. Carry on with **What's left**, in order.

## What the user asked for, and decided

The request: make the game's UI look like a pixel-art RPG UI kit (burgundy panels, brass trim,
parchment buttons, jewel-coloured bars, a round gold minimap, a portrait frame, square icon buttons
with red badges). Prototypes first, then build. Three rounds of prototypes, answered in a Plaude
canvas:

- **Look:** C, "Parchment & Timber" ("Love it"). Pixel icons for items too. Bundled open-licence fonts.
- **HUD:** all four new pieces: portrait with a level ribbon, labor bar and purse, a round minimap, menu
  buttons.
- **Windows:** MMO windows docked at the sides. Quest and shop dialogs should feel like an MMO's
  (WoW was the example the user liked), in our own look and art. Never copy WoW's or Path of Exile's
  art, names or layouts.
- **Character window:** built with today's gear slots.
- **Skills, two parts:** a large tree for learning (like Path of Exile 2's in scale) and a small skill
  book of what you know, each skill with its level, where you assign skills to the hotbar.
  - Tree style: a parchment star chart.
  - **Skill points come only from quests and milestones, not from character levels.**
  - **Skills level up by being used.**
- **Round 2 polish notes:** trained tree nodes were drawn too big; tidy text alignment; nothing may
  cover text; show a quest that needs scrolling; everything 30% smaller; icons in badges clipped their
  borders. Round 3 fixed all of these, and the user said "Love it".
- **Scaling:** the UI scales with the window, plus a UI size setting.
- **Unanswered:** which quests and milestones give skill points, and how many. Defaults were chosen;
  see "Skill points" below. Ask the user again when you show the result.

The approved round-3 screens are in `reference/approved-*.jpg`, and what's built now is in
`reference/built-*.jpg`. The prototype sources are in the main checkout's git-ignored
`scratch/ui-proto/` and may be gone; you shouldn't need them.

## What's done (commits on the branch)

| Commit | What |
|---|---|
| `0533044` | The look (`src/ui/theme/`): fonts, theme, pixel icons baked from Twemoji (`npm run icons`), and the UI laid out on a 1029 px tall virtual screen, scaled to the window, with a UI size setting. The open-world HUD and MMO windows docked at the sides (`src/ui/life/lifeUI.ts`): talk, quest offer, progress and hand-in pages, merchant beside the bag, a character window (P), a two-pane quest log, settings with credits, tooltips. Live portraits (`src/render/portrait.ts`). `CREDITS.md`. |
| `b135cbb` | Input: an open window has the controller. The button that closes a window or panel no longer also counts as a game press. Escape now cancels a ground circle. (Beta fixed the last two its own way; see the merge notes.) |
| `a4a160a` | Skills, browser side: `shared/skilltree.json` (226 nodes, laid out by `tools/skilltree/gen.mjs`, `npm run skilltree`); the rules in `src/skills.ts`, `src/build.ts` and `src/sim/life/progress.ts`; milestones; levels by use; the skill book and tree UI (`src/ui/skills/`); tests. |
| `e1fd39e` | Server: the same skill rules in Rust, budgets on join and on every build, experience counted on the server, milestones; one hit per swing on creatures (a server bug); Q / E slots checked. See "Server (Rust) status". |

Tests at `a4a160a`: the local Playwright suite gave 185 passed and 65 skipped (server specs need a
local Rust build). Two `@gpu` specs failed only while Docker was compiling Rust (`raid.spec`
frame rate, `bugreport.spec` HUD-in-screenshot timing) and passed on a quiet rerun.
At `e1fd39e`, as this paused: `npm run typecheck` was clean; the skills, hotbar, skilltree, progress and
combat specs gave 52 passed and 12 skipped (the server-backed ones); `cargo test --release` in Docker gave
109 passed and 0 failed.

## Server (Rust) status

The port is done and committed (`e1fd39e`). `cargo build --release`
gives no warnings. `cargo test --release` gave **109 passed, 0 failed**, run in Docker when this
paused. The conformance run (`tests/conformance.spec.ts`, `life-conformance`, `world-conformance`,
`skilltree`, `progress`) gave **64 passed**, but that was before `valid_movement` was added; re-run it.

What the server does now:
- **The tree:** `server/src/skills.rs` mirrors `src/skills.ts` (links, roots, soundness, `path_to`,
  the book, levels, `gather` with levels, movement channels). The tree loads from
  `shared/skilltree.json` (`server/src/tuning.rs`).
- **Levels:**
  - `server/src/player.rs`: `levels` re-resolve when they change; the movement cooldown goes through
    the `movement.cooldown` stat.
  - `server/src/life/progress.rs` (new): what trains what, `train`, `observe`, `sync_levels`,
    `points_earned`, `skill_budget`.
- **Quests:** `server/src/life/quests.rs` has milestones (silent start, finish themselves, never handed
  in), the skill-point toast text, objectives that match on `kind`, and walks of the active list that
  survive a milestone finishing mid-walk.
- **Counting experience:**
  - `server/src/game.rs` counts experience at the points where TS emits its events: every melee hit;
    arrow hits, which train the bow (arrows now remember who shot them and with what); kills by
    swing, arrow or meteor count as `defeat`.
  - `server/src/open/mod.rs` counts finished casts and started movement skills.
- **Budgets:**
  - `world_socket.rs` and `world_game.rs`: the open world checks builds against start points plus
    earned points, on join, on every `build` message and on reset.
  - The welcome sends the build the server actually applied.
  - The battlefield allows `skills.points`.

Beyond the brief (keep or revert, but know they're there):
- **One hit per swing on creatures.** A swing that hit only actors never set `attack_hit`, so on the
  server one sword swing hit a slime on each of its five active frames. It now lands once, as TS
  `checkHit` does. This changes damage to slimes online and on the battlefield, so re-run the
  online, net, pvp and raid specs where a GPU is available.
- **`valid_movement`.** The server never checked the Q / E slots before; it now does, everywhere it
  checks a build. TS `validBuild` already checks them.

Open findings to settle, in TS and Rust together:
- **a.** Wayfarer's `reach windspire` (r 40, no minY) sends a `reach` event for the whole place, so
  standing at the foot of the spire also completes Wings' "top of the Windspire" (r 30, minY 115).
  Both sides behave the same. Fix: `stepQuests` credits only the objective it measured, or `matches`
  re-checks r and minY for reach objectives.
- **b.** TS `trainedBy` treats every `hit` as a weapon hit. Offline, training-yard meteor blasts train
  the weapon in your hands, and arrows train whatever you hold when they land. The server trains
  nothing for blasts and the loosing weapon for arrows. Fix: give `hit` events their source.
- **c.** TS `observe` counts a lone slime dissolving (`fuseOut` emits `actorDie`) as a `defeat`; the
  server counts only kills. Fix: mark the `actorDie` that `deal.ts` emits and count only those.
- **d.** The browser checks builds against `SKILL_POINTS` (30), not the island's `skillBudget`
  (`parseBuild(welcome.build)` and `__game.setBuild` / `applyBuild` in `main.ts`), so online it can
  switch to a build the server then refuses. Use `skillBudget(life.state)` when there is a life.
  Characters whose saved builds use more than their earned points fall back to Sword Training on
  join, and the welcome says so.
- **e.** Neither side has a TS-versus-Rust run for hits and defeats; `lifecheck` has no creatures. Rust
  unit tests and `tests/progress.spec.ts` cover each side alone.

## What's left, in order

1. **Close out the server port.** Re-run the conformance specs in Docker (`tests/conformance.spec.ts`,
   `tests/life-conformance.spec.ts`, `tests/world-conformance.spec.ts`, `tests/skilltree.spec.ts`,
   `tests/progress.spec.ts`; build the release binaries first), since `valid_movement` landed after the last
   run. Then settle findings a–d above, in TS and Rust together, with tests.
2. **Merge `beta`** into the branch (`git merge beta`). Expect conflicts. Beta's commits since the branch
   point (`b769b19`, `1f58f0a` hero animations and strafing, `bf407cf` input fixes, `ad318c9`, `5d273fb`)
   changed:
   - `src/main.ts`: the combat stance in the input pipeline, and the Escape and menu-close handling.
   - `src/input/input.ts`, `src/sim/types.ts` (`Actions` gained `faceX`/`faceZ`).
   - `WORLD_PROTOCOL` is now 3 (`src/net/worldLink.ts`, `server/src/protocol.rs`, `world_socket.rs`).
   - Server: `server/src/{game,player,tuning,world_game,world_socket,net,http,open/mod}.rs`.
   - `shared/tuning.json`: `move.strafeSpeed` and `move.backSpeed`. Ours touches only the `skills`
     block and adds a `movement.cooldown` stat.
   - The hero's rendering (`src/render/character.ts`, `src/render/detail/*`), `tests/*`, `README.md`,
     `AGENTS.md`, `design/status.json`.

   **Keep beta's input fixes and drop ours**, as agreed with the other session, so no press is handled
   twice:
   - Escape: beta sets `cancelWaiting` in `updateCombatAim` and `targeting()` consumes it. Delete our
     cancel-on-arrival block in `updateCombatAim`.
   - Menu close: beta calls `input.pollActions(follow.yaw)` once on the frame a panel closes. Delete our
     `input.swallowHeld()` (in `main.ts` and `input.ts`). Keep beta's line, with our extra condition for
     docked windows:
     `if (menuOpen && !panel.isOpen && !lifeUI?.modal && !(lifeUI?.takesPad && input.lastDevice === 'gamepad')) input.pollActions(follow.yaw);`
   - Keep our menu routing: the skill panel gets presses first while open, then life windows, then
     `toggle` opens the book and `tree` opens the tree. Keep `padToMenu` and `pollLife(padToMenu)`.
   - Re-run `tests/skills.spec.ts`, `tests/combat.spec.ts` and `tests/hotbar.spec.ts` after the merge.
     Their controller tests check exactly this.
3. **Update the docs** after the merge (beta changed both files):
   `node handoff/improve-ui/tools/patch-status.cjs` (design tracker features, a question, the session
   log) and `node handoff/improve-ui/tools/patch-readme.cjs` (where skills live, the T / N keys). Check
   `design/status.json` still round-trips with `JSON.stringify(s, null, 2)`, and adjust the scripts if
   beta moved the text they replace.
4. **Test everything:** `npm run typecheck`; the full local suite (run the `@gpu` specs with nothing
   heavy running, since they flake when Docker builds hog the CPU); `cargo test` in Docker; and
   `tests/online.spec.ts` against `npm run up` (it rebuilds the server image from *this* checkout, so
   coordinate with the other session, whose server may be running).
5. **Show the user:** take fresh screenshots (`handoff/improve-ui/tools/look-*.spec.ts`), build a review
   canvas in Plaude (the custom template `style-prototypes` exists; canvas `cnv_882jbwr9` holds rounds
   1–3), and ask about skill-point amounts. Wait for the go-ahead.
6. **Before merging:** delete `handoff/`, then merge into `beta` and push. CI deploys `beta` to Railway.

## Where things are

**Look and HUD**
- `src/ui/theme/theme.css`: variables, buttons, slots and tooltips.
- `hud.css`, `windows.css`, `skills.css`: the HUD, the docked windows, and the book and tree.
- `scale.ts`: the virtual screen, the size setting, the paper-grain tile and font preloading.
- `pixelIcons.ts`: hand-drawn HUD icons. `icons.ts` and `icons.gen.ts` hold the baked item and skill
  icons, generated by `tools/icons/bake.mjs`, which picks up every `"icon"` in `shared/**/*.json`.
- `tooltip.ts`: one tooltip for the whole UI, driven by `data-tip`.
- `fonts/`: the bundled fonts.

**Open-world HUD and windows:** `src/ui/life/lifeUI.ts`.
- Windows dock left (`.lui-card.mw.left`) and right (the bag).
- Walking 9 m from whoever you're talking to closes their window. Only the map is modal.
- `takesPad`: a window holds the controller while it's open.

**Skills UI:** `src/ui/skills/`
- `panel.ts`: owns both views, has the same surface `main.ts` used for the old panel, and provides the
  test hooks.
- `book.ts`: tiles, the details page, the hotbar strip, drag and drop, controller rows.
- `tree.ts`: an SVG star chart with pan, zoom, search, planning, Learn and Undo, right-click to give a
  node back, D-pad focus and a minimap.
- `describe.ts`: modifier and stat text.
- `context.ts`: what the UI needs from `main.ts`.

**Rules (browser side; the server must match)**
- `src/skills.ts`: the tree.
  - Links, `ROOTS`, `reachable`, `soundTree` (connected back to a root), `dependents`, `pathTo`.
  - `BOOK`: the skills that level, in the order weapons, abilities, movement.
  - `levelOf`, `levelsFrom`, and `gather`, which adds `value × (level − 1)` (flat and inc only).
  - `resolveSkills(s, levels)`, including movement channels.
- `src/build.ts`: `learnBlock`, `learnPath`, `validBuild` and `pointsLeft`, each taking a budget.
- `src/sim/life/progress.ts`: what trains what (a melee hit trains the weapon in your hands, a cast
  trains its ability, a movement use trains that skill, slide included).
  - A level-up shows a toast and raises a `skillLevel` quest event. `actorDie` raises `defeat`.
  - `pointsEarned` and `skillBudget`. Skill points are **counted from `quests.done`, never stored**.
- `src/sim/life/quests.ts`: milestones finish themselves, start without a toast, and are never handed
  in. The completion toast lists skill points first.
- `src/sim/sim.ts`: `levels` is part of the cached stats, and `emit()` calls `life.observe()`.
- `src/sim/player/abilities.ts` and `src/tuning.ts`: movement cooldown through `movement.cooldown`
  (`movementCooldownFor`).

**Data**
- `shared/skilltree.json`: the bit order is the node order. The first 15 nodes are the old skills; each
  links to the skill it used to require, so old builds keep their cost. Regenerating it is
  deterministic.
- `shared/tuning.json`: `skills` holds `points: 30` (the training yard and battlefield budget),
  `startPoints: 2`, `trees` with colours, and `levels {xp, per}`. There is a new stat,
  `movement.cooldown`.
- `shared/quests.json`: `rewards.skillPoints` on every quest (21 in all) and eight milestones (one point
  each), with the new objective types `defeat` (with a `kind`) and `skillLevel`.

**Input and the game loop**
- `src/input/input.ts`: the menu presses `tab` (LB/RB) and `tree` (N), and `pollLife(padToMenu)`.
- `src/main.ts`:
  - `frame()`: the input routing.
  - `portraitOf()`: portraits for both the island and the yard.
  - The yard keeps its own skill experience in `localStorage` under `yggdrasil.skillxp`.
  - The panel is built in `new SkillsPanel(...)`.
  - The test API.

**Test API on `window.__game`**
- `panel()` gives `{open, view, selected, assigning, plan, focus, abilities}`.
- `panelFocus({book|slot|move|node})`, `openPanel('book'|'tree')`, `learnNode(id)`, `selectBook(id)`
  and `skillPanel(open)`.
- `skills()` gives `{budget, left, levels, xp}`.

**Tests**
- `tests/skills.spec.ts`: the tree, the book, the controller, and the island (quest points, the sword
  levelling on slimes).
- `tests/skilltree.spec.ts`: the graph, costs, budgets, levels and movement cooldown.
- `tests/progress.spec.ts`: points, milestones and levels, in Node.
- `tests/hotbar.spec.ts`: assigning with Y and a trigger, through the book.

## Skill points (defaults chosen; the user hasn't confirmed them)

- 2 to start. One is already spent on Sword Training, which everyone has.
- The quests give 21:
  - 1 each: landfall, patch, wings, firstFlight, harvest, packwright, livestock.
  - 2 each: westward, wheels, saltSail, contracts.
  - 3 each: home, shipwright.
- The milestones give 1 each:
  - Green Thumb: 30 harvests.
  - Sky Legs: two minutes gliding.
  - Pack Mule: 5 deliveries.
  - Rancher: 3 animals.
  - Contract Hand: 5 contracts.
  - Wayfarer: seven places.
  - Slime Hunter: 15 slimes.
  - Practised Hand: 5 skill levels.
- That makes 31 on Emberholm. From nothing, a keystone costs 8 to 13 points.
- Levels: 10, at `xp` totals `[0, 20, 60, 120, 200, 300, 420, 560, 720, 900]`. Each level adds:
  - weapons: +3% damage;
  - Healing Circle: +5% healing;
  - Meteor: +5% damage;
  - movement skills: −3% cooldown.

## How to run things

- **The game:** `npm run dev`. Use `?yard` for the training yard and `?world&test` for the island in
  test mode.
  - In `?test` the loop is paused: drive it with `__game.advance(n)` and `__game.render()`. Keys do
    nothing there.
- **Tests on a private port** (5299), so a run never reuses another checkout's Vite:
  - `SUITE=1 npx playwright test -c handoff/improve-ui/tools/pw.config.ts skills.spec.ts` runs real
    tests.
  - `npx playwright test -c handoff/improve-ui/tools/pw.config.ts look-windows` runs the screenshot
    specs here, which write to the git-ignored `scratch/shots/`.
- **Rust.** This machine has no Rust toolchain, so use Docker from Git Bash. Use these volumes; the
  other session uses `ruina-target` and `ruina-nm`:
  ```
  MSYS_NO_PATHCONV=1 docker run --rm -v "C:/GitHub/heggelund/games/ruina-ui-restyle:/app" -v ruina-target-ui:/app/server/target -v ruina-cargo:/usr/local/cargo/registry -v ruina-nm-ui:/app/node_modules -w /app ruina-dev-pw sh -c "cargo test --release --manifest-path server/Cargo.toml"
  ```
  The images `ruina-dev` and `ruina-dev-pw` are already built. Pages render at about 1 fps in the
  container, so leave battlefield timing specs to CI.
- **Generators:** `npm run icons` fetches any missing Twemoji SVGs from GitHub. `npm run skilltree`
  lays the tree out again; do that only before anyone has spent points in it.

## Gotchas learned the hard way

- **Fast frames run no rules step at all.** Input read once a frame but used only inside a step gets
  lost (Escape, the button that closes a menu). Gamepad taps in tests must last until the game has
  drawn a frame; see `tap()` in `tests/skills.spec.ts`.
- **The first paint of a big panel takes 70–230 ms** in software-drawn browsers. The UI's fonts are
  preloaded in `scale.ts` for that reason.
- **`hidden` needs help on windows:** `.mw` uses `display: flex`, which beats the attribute, so CSS has
  `.mw[hidden] { display: none; }`.
- **CSS class names collide.** In the round-2 prototype the book's `.tile` matched the tree's SVG
  `rect.tile`, which made trained nodes huge. Keep class names distinct between the book and the tree.
- **The character window's full-body portrait is drawn on layer 1** (the hero and the lights only), so
  NPCs can't stand in the shot.
- **Use a file, not a heredoc,** for any patch script containing an apostrophe: the Bash tool breaks on
  it.
- **Load-sensitive tests:** `raid.spec` and `bugreport.spec` (`hud: true`) fail when the CPU is
  saturated. Rerun them before suspecting the code.

## Reference images

`reference/approved-01…10-*.jpg`: the round-3 prototypes the user approved. `reference/built-01…08-*.jpg`:
the game on this branch at `a4a160a`.
