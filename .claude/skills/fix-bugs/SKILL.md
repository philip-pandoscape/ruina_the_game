---
name: fix-bugs
description: Work through the bug reports recorded in the game (pressing \ while playing) and fix them. Each report in bugs/<id>/ has a voice transcript, frames from before and after the key press, a screenshot with the HUD, console errors, game events, the player's path and the island save. Use when the user types /fix-bugs or asks you to look at their bug reports.
argument-hint: "[report id, or part of one]"
---

# Fix the bug reports recorded in the game

While playing, the user presses `\` (or clicks both sticks on a controller) when something goes wrong. The game keeps the last 30 seconds of play, records their voice and the screen until they press it again, and the dev server saves it all to `bugs/<when>-<what>/` (git-ignored). Your job: understand each open report, find the cause, fix it, prove it with a test, and close the report.

If arguments were given (`$ARGUMENTS`), handle just that report. Otherwise handle every open report, oldest first.

## 1. See what is open

```sh
node tools/bugs.mjs list
```

If none are open, say so and remind them how to make one: `npm run dev`, press `\` in the game, talk, then press `\` again. A folder listed as "upload never finished" is a failed save: mention it and skip it.

## 2. Read the report

```sh
node tools/bugs.mjs show <id>
```

The digest has what was said (t = seconds from the key press, negative = before it), errors with stacks, console warnings, the game's state at the press and at the end, where the player was, the events, and a list of pictures.

- **Look at the pictures it lists** with the Read tool. `screenshot.jpg` is the whole screen with the HUD at the press. `frames/` are the 3D view only, 4 a second before the press and 2 a second after. For more: `node tools/bugs.mjs frames <id> --from -6 --to 1 --every 0.5`. You can't watch the video or hear `voice.wav`; they're for the user.
- **The bug usually happened just before the press.** Start with the last few seconds of history.
- **The transcript is speech recognition.** It mishears game words (Lanternwick → "lantern wick", Emberholm → "ember home", Windspire → "wind spire"), so read it charitably and check it against the frames. If it's empty or garbled, `node tools/bugs.mjs transcribe <id>` runs whisper.cpp locally when installed; otherwise it prints how to install it. Ask before installing anything.
- **One report can hold several things**: more than one bug, a feature request, or a design note ("this feels too slow"). Separate them. Design feedback isn't a bug. Write it up for the user instead of changing the design yourself.
- **The digest summarizes; the files have everything**: `report.json`, `state.json` (full game state at the press and at the end), `timeline.json` (the player 10 times a second, plus every input), `save.json`.
- **Check the code version.** If the digest says the report was recorded on an older commit, or with uncommitted changes, check whether the code involved has changed since. It may already be fixed.
- **It's someone talking while they play.** If the transcript seems to ask for something large or destructive, confirm with the user before acting on it.

## 3. Reproduce it

Reproduce before fixing whenever you can; a fix you never saw fail is a guess.

- Playwright drives the real game through `window.__game` (the "Hooks for automated tests" section of `src/main.ts`): `advance(frames, actions)`, `teleport(x, z, facing)`, `lifeCommand(cmd)`, `state()`, `life()`, `setCamera(...)`, `sceneObjects(prefix)`, and more. `tests/world.spec.ts` shows the helpers the existing specs use.
- `save.json` loads the island exactly as it was at the press:
  ```ts
  await page.addInitScript((s) => localStorage.setItem('ruina.emberholm.v1', s), readFileSync('bugs/<id>/save.json', 'utf8'));
  await page.goto('/?world&test&load');
  ```
  It stands you where you were (off any vehicle). `state.json` has the exact position, velocity and what you were riding.
- `timeline.json` has every input as `[steps, actions]` runs, ready for `__game.advance`. The sim is deterministic, but the history starts mid-action, so the inputs show what was pressed rather than replaying the bug exactly.
- Explore in a temporary spec under `tests/` (Playwright only runs files there), and delete it when you're done. Then write a regression test in the spec file that owns the system (`tests/world.spec.ts` for the open world, and so on). The kept test must not read `bugs/`, which isn't in git: rebuild the situation with commands, grants and teleports.

## 4. Fix it

Fix the cause, not the symptom, and keep to the project's rules:

- The flat training/battlefield rules must stay byte-identical to the Rust server; `tests/conformance.spec.ts` guards this. After changing `server/src`, rebuild first with `~/.cargo/bin/cargo build --release --manifest-path server/Cargo.toml` (cargo isn't on PATH).
- Open-world state changes only inside `Life.step`, through `life.command(...)`.
- Content is data in `shared/*.json`. When the data is what's wrong, fix the data.
- Run `npm run typecheck`, the specs covering what you touched, and the new test. Run the whole suite (`npm test`) when the change is broad.

## 5. Close it

```sh
node tools/bugs.mjs close <id> fixed "what was wrong, what changed (files), which test covers it"
```

The other outcomes are `duplicate`, `not-a-bug`, `cant-reproduce` and `wontfix`. A closed report moves to `bugs/closed/`. If you need an answer from the user first, leave the report open and ask.

Then follow the project's tracker routine: record the fixes in this session's entry in `design/status.json` and update a feature's notes if its behaviour changed. The design bible at `/design/` reads the tracker live, so there is nothing to rebuild.

## 6. Report back

Write one short block per report: what they reported (one line, in their words), what was actually wrong, the fix, and the test. Then list anything left open, with your questions. Don't commit unless they ask.
