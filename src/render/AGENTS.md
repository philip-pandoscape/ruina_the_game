# src/render

Drawing, with three.js: the world and its buildings, bodies and creatures, models, effects and the
look. It reads the rules' state and whatever it's handed, and never changes the rules' state.

| Path | What |
|---|---|
| `look.ts` | The look, its palette, and how much of it each quality draws (`GRAPHICS`: `high`, `medium`, `low`; `?quality=`). |
| `scene.ts`, `camera.ts` | The stage (renderer, scene, light) and the camera that follows you. |
| `open/` | The open world: the stage (`stage.ts`: lights, sky, sea and a view of each region held round you, added as they arrive and let go behind you), a region drawn where the world places it (`regionView.ts`: its ground `terrain.ts` and `ground.ts`, trees and grass `foliage.ts`, dressing, buildings and falls, built a little each frame), the sea (`water.ts`, reading the nearest regions' depths, `seaDepths.ts`), sky, screen effects (`post.ts`), the land drawn (`land.ts`), everyone else drawn (`peersView.ts`: heroes up close, crowd bodies past 42 m, crossfading between), dungeons and zones (`dungeonView.ts`, a cave as its file dresses it; `arenaView.ts`), mini-game tables (`gameTables.ts`, each game's board on them `gameBoards/<id>.ts`, found by the game's id). |
| `origin.ts` | The scene's origin, moving with you (a floating origin): where it stands (on a lattice, once the camera is far from it), what the patterns laid in the world are handed to stay put and precise (`repeatShift`, `noiseShift`, `followOrigin`), and going between the world's coordinates and three.js's own (`toScene`, `fromScene`, `lookAtWorld`). |
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
- **The world's coordinates, the scene's origin.** Everything is placed in the world's coordinates
  (the rules'); the scene stands shifted by its origin (`origin.ts`), the camera in it. A shader that
  lays a pattern in the world (reads `modelMatrix * position`) adds what the origin is worth to it
  (`followOrigin`); code that reads three.js's own frame back (a raycast's hit, `project`,
  `getWorldPosition`, `matrixWorld`) goes through `toScene` and `fromScene`; a camera is turned with
  `lookAtWorld`.
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

The look at each quality: `tests/stress/look.spec.ts` (a real GPU). The world's regions drawn as you
travel, and drawing far from the origin: `tests/integration/bigworld.spec.ts`; the origin's
arithmetic: `tests/unit/origin.test.ts`. The hero's films measured without
drawing: `tests/unit/animation.test.ts`; with the weapons, abilities and movement skills in another
order: `tests/unit/weaponOrder.test.ts`. The content library's specs show every model, body and building:
`library.spec.ts`, `models.spec.ts`, `buildings.spec.ts`, `creatures.spec.ts`, `species.spec.ts`,
`retarget.spec.ts`.
