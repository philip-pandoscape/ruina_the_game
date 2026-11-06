# src/app

The game's start and wiring: what `src/main.ts` sets up and connects, in modules of their own. App
code may import any area (it's where they meet); nothing but `src/main.ts`, the developer pages and
the tests imports it back (`tests/unit/boundaries.test.ts` holds the lines). The other areas don't
know each other's insides: the app hands each what it needs (the world connection to the windows, the
peers to their drawing).

| File | What |
|---|---|
| `boot.ts` | The page's entry (`index.html`): the way in, which is all the first download carries; it fetches `src/main.ts` once a character is chosen (`docs/assets.md`). |
| `options.ts` | Every option of the game page's address, documented and read once (`tests/unit/options.test.ts` keeps the list honest). |
| `online.ts` | The way in: sign-in, character select, connecting to the world (once a page: `boot.ts` starts it, the game takes the same one). |
| `onlineWiring.ts` | Playing on the server, wired up: the badge, freezing while the server is away, moving between spaces, commands run ahead, each tick. |
| `testApi.ts` | `window.__game`, the test API; `GameApi` is its type, which `tests/support/game.ts` checks the tests' calls against. |
| `bugWiring.ts` | The bug reporter (`bugs/`) wired to the game: what a report keeps and samples. |
| `dungeonVisit.ts` | Into a copy of a dungeon and out again. |
| `drawing.ts` | Drawing a frame: the world as the rules have it at the moment shown (between two steps), the effects of what happened, spells' circles, monsters' warnings, the ability bar, the camera, everyone else. |
| `step.ts` | One step of the rules with what you pressed, and what it shows: the effects of what happened, your levels, the yard's practice; online, the server's word on you taken in first. |
| `cameraRig.ts` | The camera's sense of where it is: not into the ground, under the sea or below your storey, pulled in rather than through a wall, the eye kept under a hood of rock. |
| `loop.ts` | The main loop: the rules stepped at 60 Hz for the time that has passed, with what you pressed for each step, then a frame drawn; tests pause it and step it a frame at a time. |
| `aiming.ts`, `targeting.ts` | Aiming: the mark (a soft lock you override with Tab), the circle a ground-aimed spell is placed with, aim assist, the combat stance. |
| `perf.ts` | How the game runs: frame times, the page's and the graphics card's share, draw calls; the HUD's stats line and the stress tests read it. |
| `save.ts`, `savedBuild.ts`, `storage.ts`, `resume.ts` | The island and the build kept in the browser offline, browser storage under the game's name, coming back after a reload. |

## How the modules reach the game

`src/main.ts` builds the game as one long start-up and hands its modules a `refs` object
(`GameRefs`): a getter for each thing they use, read when they use it, and a setter for the few they
assign. It is declared before the first module built from it (the drawing), so the start-up reads:
the game's parts, `refs`, then the modules that run on them. A module that keeps state the rest of
main.ts uses gives it out through what it returns (`drawing.showEvent`, `loop.paused`). A module
takes `g: GameRefs` and writes `g.sim`, `g.life`; a module that runs once, where its code used to
run, may take main.ts's constants into locals at its top (`const { sim, life } = g`), which keeps
TypeScript's narrowing inside its closures. Moving more of main.ts out goes the same way:
`tools/refactor/` has the scripts that do it (`region.mjs` says what a range of main.ts takes in and
gives out, `move-region.mjs` moves it, giving out what the rest uses through an object,
`localize-consts.mjs` and `prune-imports.mjs` tidy up); they work from oxc's syntax tree, so a name
a function declares for itself is never taken for main.ts's.

## Tests

The test API is how the integration tier plays the game (`tests/support/game.ts`, `docs/testing.md`).
A change here is checked by the specs that drive what it wires: `online.spec.ts`, `update.spec.ts`,
`party.spec.ts`, `bugreport.spec.ts`, and broadly `world.spec.ts`.
