# src/render

Drawing, with three.js: the island and its buildings, bodies and creatures, models, effects and the
look. It reads the rules' state and whatever it's handed, and never changes the rules' state.

| Path | What |
|---|---|
| `look.ts` | The look, its palette, and how much of it each quality draws (`GRAPHICS`: `high`, `medium`, `low`; `?quality=`). |
| `scene.ts`, `camera.ts` | The stage (renderer, scene, light) and the camera that follows you. |
| `open/` | The open world: terrain and ground (`ground.ts`), water, sky, foliage, the stage (`stage.ts`), screen effects (`post.ts`), the island's life drawn (`life.ts`), everyone else drawn (`peersView.ts`), dungeons and zones (`dungeonView.ts`, `arenaView.ts`), mini-game tables (`gameTables.ts`, each game's board on them `gameBoards/<id>.ts`, found by the game's id). |
| `village/` | Buildings you can walk into, from Quaternius' village kit: assembled from their plans, cut open above your storey, doors and lamps. |
| `character.ts`, `detail/` | The hero up close: poses as a pure function of `PoseInput` (`detail/humanoid.ts`), feet and hands (`body.ts`, `gait.ts`), swings, the made body fitted to our rig (`fit.ts`, `madeHero.ts`), retargeted clips (`retarget.ts`, `moves.ts`). |
| `creatures/` | Creature bodies for the crowd renderer: the species format, its registry, baked clips, jelly, the goblin and bodies with folders of their own. |
| `actors.ts`, `missiles.ts`, `dummy.ts` | Monsters by species (one instanced crowd each), what they throw, the training dummy. |
| `spells.ts`, `vfx.ts` | Ground circles, arrows and meteors; slash trails, sparks and dust. |
| `models/`, `assets.ts`, `assets/` | Procedural models and the made ones swapped in for them (`models/glb.ts`), files by id through the loader, the files themselves. |
| `portrait.ts`, `studio.ts`, `heroPreview.ts` | Portraits for the windows, and the hero on character select (handed the UI's scale). |

## Rules

- **Boundaries** (`tests/unit/boundaries.test.ts`): render may use the rules (through the bridge, `src/engine/`), content,
  input and the asset loader. It never imports the network, the UI, the app or the developer pages:
  what it draws of the server's world (monsters, tables, other players) comes in shapes it declares
  itself (`ShownActor`, `ShownTable`, `ShownPeer`), and the app hands it the real thing.
- **Reads, never writes.** Drawing doesn't change the rules' state; a change it wants is a command
  through the app.
- **Made models** are swapped in by id and fitted into the footprint of the procedural model they
  replace, so the rules, colliders and server never see them (root `AGENTS.md`, Art and assets).

## Tests

The look at each quality: `tests/stress/look.spec.ts` (a real GPU). The hero's films measured without
drawing: `tests/unit/animation.test.ts`. The content library's specs show every model, body and
building: `library.spec.ts`, `models.spec.ts`, `buildings.spec.ts`, `creatures.spec.ts`,
`species.spec.ts`, `retarget.spec.ts`.
