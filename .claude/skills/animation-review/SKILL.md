---
name: animation-review
description: Work through notes left in the animation library (/dev/library.html) - notes on whole animations, stretches of frames, and single frames with poses corrected by moving the bones - by changing the animation code until the corrected poses are met, measured against them. Use when the user pastes a prompt starting "# Animation review", types /animation-review, or asks to fix the animations they reviewed or noted in the library.
---

# Animation review

The user reviews animations in the animation library (`/dev/library.html`, `src/library/`): they play an
animation, leave notes on all of it, on a stretch of frames or on one frame, and on a frame they can
move the bones to where they should be. **Create Prompt** turns the open notes into a prompt. This
skill is how to act on one.

## Where everything is

The dev server keeps the review in `reviews/animations/` of the checkout it runs from (git-ignored):

- `review.json`: every note. A pose correction has `fix.before` and `fix.after` (every joint's local
  transform: position, quaternion x y z w, scale), `fix.touched` (bones the user moved by hand),
  `fix.model` (each joint's position in the body's own space, before and after: x to its left, y up,
  z ahead), and `state` (what the rules had the body doing on that frame).
- `images/<note id>.png`: the frame as it was and as corrected, from the user's view and from the
  side. `images/<note id>-now.png`: the same frame as the code makes it now, the correction as a green
  ghost over it (written by the check below).
- `prompt.md`: the last prompt made (`prompts/` keeps them all). If the user typed /animation-review
  without pasting, read this one. `check.md`: the last check.

The prompt gives absolute paths; use them (the review may be in another checkout than yours).

## How to work

1. Read the whole prompt, then **look at every picture** it names (Read the PNGs). The numbers say
   how far; the pictures say what the user saw.
2. Measure where things stand before changing anything:
   `REVIEW="<path to review.json>" npx playwright test tests/integration/library-review.spec.ts`
   (add `PW_PORT=5213 TEST_PORT_OFFSET=13` if another checkout's suite may be running). It prints, for
   each correction, the worst bone's angle from the corrected pose and the worst joint's distance, and
   writes the `-now` pictures.
3. Find the code that makes each pose. The prompt names it per character and per animation. For the
   hero, the frame's PoseInput (`What drives it`) says which branch: `attackIndex`/`attackFrame`/`step`
   for a swing (swings.ts keyframes, or a library clip if moves.ts gives that weapon a clip set),
   `actionId` for a movement skill, `travel` for riding/swimming/gliding, `run`/`heading` for the gait.
   Transitions and planted feet are character.ts (Inertia, holdFeet).
4. Turn a correction into code: the bone table gives each bone's local Euler angles before and after
   and the axis it turned about (in its parent's space); the joint list gives where hands, feet and the
   weapon's tip went, in centimetres and words. Change the pose function or the keyframes so the
   animation passes through the corrected pose on that frame **and blends into and out of it** (the
   frames around it must stay smooth: scrub them). Never special-case a frame number.
5. Do not change the rules' timing (frame counts in shared/*.json and src/tuning.ts, speeds, the
   films in scenarios.ts) to meet a note; if only a timing change can meet it, say so. Rules are
   TypeScript and Rust together (AGENTS.md).
6. Measure again (step 2) until each corrected bone is within a few degrees and each moved joint
   within 2-3 cm, or you can say why not. Look at the `-now` pictures.
7. Run what holds the animation together: `npm run typecheck` and the checks the prompt lists for
   that character (for the hero `tests/integration/animation.spec.ts`, and `tests/integration/retarget.spec.ts` if a clip
   changed).
8. Report note by note: what you changed (file, function), how close each correction is now (from the
   check), and anything you couldn't meet. The user looks in the library (it reloads by itself; the
   green ghosts show where the code still differs, and each note shows a meter of how close it is) and
   marks the notes done themselves.

## Notes

- Frame numbers count from 0 and are the animation's own: the hero's films run at 60 fps (a sim
  frame each), species clips at their clip rate (30 fps).
- The library shows the made hero; the box hero (the stand-in while the made body loads, or if it
  can't) shares the same pose code, so a fix lands on both.
- `window.__library` drives the page from a test or the console: `open(subject, anim, options,
  frame)`, `seek`, `state`, `bones`, `turn`, `notes`, `prompt`, `check(note)`.
- Another session may be working on the hero's animations (`src/render/detail/`): keep changes to
  what the notes ask for, and say which files you touched.
