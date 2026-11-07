# src/render

Drawing, with three.js: the island and its buildings, bodies and creatures, models, effects and the
look. It reads the rules' state and whatever it's handed, and never changes the rules' state.

| Path | What |
|---|---|
| `look.ts` | The look, its palette, and how much of it each quality draws (`GRAPHICS`: `high`, `medium`, `low`; `?quality=`). |
| `scene.ts`, `camera.ts` | The stage (renderer, scene, light) and the camera that follows you. |
| `open/` | The open world: terrain and ground (`ground.ts`), water, sky, foliage, the stage (`stage.ts`), screen effects (`post.ts`), the island's life drawn (`life.ts`), everyone else drawn (`peersView.ts`: heroes up close, crowd bodies past 42 m, crossfading between), dungeons and zones (`dungeonView.ts`, a cave as its file dresses it; `arenaView.ts`), mini-game tables (`gameTables.ts`, each game's board on them `gameBoards/<id>.ts`, found by the game's id). |
| `village/` | Buildings you can walk into, from Quaternius' village kit: assembled from their plans, cut open above your storey, doors and lamps. |
| `character.ts`, `detail/` | The hero up close: poses as a pure function of `PoseInput` (`detail/humanoid.ts`), feet and hands (`body.ts`, `gait.ts`), swings, the made body fitted to our rig (`fit.ts`, `madeHero.ts`), retargeted clips (`retarget.ts`, `moves.ts`). |
| `creatures/` | Creature bodies for the crowd renderer: the species format, its registry, baked clips, jelly, the goblin and bodies with folders of their own; a crowd built with `fade` fades each body by a pattern on the screen (other players far off, as they become heroes and back). |
| `actors.ts`, `missiles.ts`, `dummy.ts` | Monsters by species (one instanced crowd each), what they throw, the training dummy. |
| `spells.ts`, `vfx.ts` | Ground circles, arrows and meteors; slash trails, sparks and dust. |
| `models/`, `assets.ts`, `assets/` | Procedural models (each kind's bodies, by the names looks give them) and the made ones swapped in for them (`models/glb.ts`), files by id through the loader, the files themselves. |
| `portrait.ts`, `studio.ts`, `heroPreview.ts` | Portraits for the windows, and the hero on character select (handed the UI's scale). |

## Rules

- **Boundaries** (`tests/unit/boundaries.test.ts`): render may use the rules (through the bridge, `src/engine/`), content,
  input and the asset loader. It never imports the network, the UI, the app or the developer pages:
  what it draws of the server's world (monsters, tables, other players) comes in shapes it declares
  itself (`ShownActor`, `ShownTable`, `ShownPeer`), and the app hands it the real thing.
- **Reads, never writes.** Drawing doesn't change the rules' state; a change it wants is a command
  through the app.
- **Looks are content**: a thing's look (`src/content/looks.ts`) names the body it is drawn with
  (a builder in `models/`, found by that name) and the made model fitted over it, so the rules,
  colliders and server never see them (root `AGENTS.md`, Art and assets). A thing that names no
  look gets its kind's plain body.
- **Weapons by id**: a pose has the weapon's place in the list (`PoseInput.weapon`), and the hero's
  stances, swings, trails, attachments and stow places know it by its id (`weaponId`,
  `src/content/tuning.ts`), never by that place, so the list's order can change
  (`tests/unit/weaponOrder.test.ts`). A cast and a movement skill are their places too
  (`castAbility`, `actionId`), drawn as their data says (a cast's pose, a move's action); what the
  crowd's clips show is named by id (`CROWD_WEAPON`, `CROWD_CAST` in `creatures/heroBody.ts`).

## Tests

The look at each quality: `tests/stress/look.spec.ts` (a real GPU). The hero's films measured without
drawing: `tests/unit/animation.test.ts`; with the weapons, abilities and movement skills in another
order: `tests/unit/weaponOrder.test.ts`. The content library's specs show every model, body and building:
`library.spec.ts`, `models.spec.ts`, `buildings.spec.ts`, `creatures.spec.ts`, `species.spec.ts`,
`retarget.spec.ts`.
