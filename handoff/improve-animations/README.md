# Handoff: hero animations, round 2 (`feature/improve-animations`)

Parked on 2026-11-04 at a stopping point. This branch is beta `5d273fb` plus one commit: the
whole of round 2 below, **typechecked but not yet tested**. Nothing here is on beta. Read this
file, then `AGENTS.md`, then carry on from "Next steps".

## Where it came from

The user asked for a hero with elbows and knees and every animation greatly improved; then for
side-strafing, walking backwards, and 8-direction dodges and jumps ("I want the movement in general
to just feel great"). With strafing chosen to happen **in combat** (soft lock or Tab, or just after a
swing or cast), strafe 85% and back off 65% of run speed.

**Round 1 is on beta** (`1f58f0a..5d273fb`, CI green, deployed to the beta site):

- `1f58f0a` jointed hero (23 joints, two-bone IK, planted-foot gait, keyframed swings, the
  `/animations.html` gallery, `tests/animation.spec.ts`) and combat stance in both rules (inputs
  carry `faceX`/`faceZ`; battlefield INPUT 16 bytes, open-world 10, `WORLD_PROTOCOL` 3)
- `bf407cf` Escape and the button that closes a menu are kept until a rules step sees them
- `ad318c9` server listens dual-stack (socket2), so it answers on 127.0.0.1 on Windows too
- `5d273fb` on the island you start, and respawn, standing on the ground (both rules)

**Round 2 is this branch**: the user tried round 1 and wrote (verbatim):

> - When operating vehicles, the legs clip into the vehicle, we need a better seated position.
> - The hands when rowing do not align with the oars.
> - The steering wheel and turning look good but it looks like the steering wheel is turned the wrong direction or something.
> - Riding a horse looks bad.
> - Gliding puts the handle bar through my head.
> - Firing a bow looks like I pull the arrow through my torso.
> - Running with the sword backwards looks dumb.
> - We should add in a take weapon out and put weapon away animation and have animations for when no weapons are out. I.E. in combat, weapons come out, out of combat they are put away.

They also sent screenshots of each problem (cart and helm legs inside the seat, rowing hands off
the oars, the rider standing in the horse, the glider bar through the face, the arrow crossing the
chest, the sword trailing behind).

## What round 2 does

All of it is drawing only: no rules change, so no conformance impact. The one data change is the
rowboat's `oars` in `shared/vehicles.json`, which only the 3D model reads (grep confirms neither
`src/sim` nor `server/src` uses `oars`).

| Item | How | Where |
|---|---|---|
| Seated legs clip | Sit forward on the seat; thighs out over its front edge, knees bent, shins down to the vehicle's footrest if it's in reach, otherwise hanging just past the edge | `humanoid.ts` `seatedLegs()`, `travelPose()`; footrests in `vehicles.ts` (cart footboard, roadster floor pan, rowboat floor, sloop/cog helm deck) |
| Rowing hands | The boat model hands the hero its oar handles every frame (`Holds`); hands go exactly there; body leans with how far out the handles are. Oarlocks moved from z 0.05 to 0.42 (x ±0.68) so the stroke runs from the belly to arm's reach; stroke amplitude 0.55 → 0.3 rad | `vehicles.ts` `oars()`, `humanoid.ts` `row()`, `shared/vehicles.json` |
| Steering wheel | The cart, roadster and hauler wheels never turned (fixed geometry) while the hands turned them; now `steeringWheel()` turns them (−steer × 1.1 rad, left turns the top left), with grips at ten to two. The ship's helm turned the wrong way (`+steer × 2.4`); now `−steer × 1.1`. Hands follow the rims, shoulders twist a little | `vehicles.ts` `steeringWheel()`, `helm()`; `humanoid.ts` drive branch, `helmsman()` |
| Horse | The stirrups hung 0.78 below the seat, out of the hero's reach, so straight legs went through the barrel. Stirrups raised to `back − 0.30`; mounts expose the irons as foot holds; the rider sits lower, knees out round the barrel (kneeOut 0.9), heels down | `mounts.ts` `saddle()`, `body()`; `humanoid.ts` `ride()` |
| Glider bar | Bar lowered and brought forward (`BAR` 2.0 → 1.8, `BAR_Z` 0.32 → 0.45): in front of the chin. The pilot hangs just behind it and swings with it as the wing tilts, so the hands stay on the grips | `gliders.ts`, `humanoid.ts` `glide()` |
| Bow | The shot line ran along the shoulders, through the neck. Now 0.26 forward of them at the chin: the draw hand anchors under the jaw and the arrow runs in front of the chest | `humanoid.ts` `bowShot()` |
| Sword carried backwards | Running ahead it's now carried ready: elbow bent, blade up and forward, bobbing with the stride | `humanoid.ts` `holdArmed()` sword branch |
| Draw / put away | See below | `stow.ts`, `humanoid.ts` `holdWeapon()`, `character.ts` |

### Weapons out in a fight, put away after

- **Where they go** (`src/render/detail/stow.ts`): on foot, sword and club at the right hip (hilt
  forward of the swinging arm, blade back past the leg, clear of the cape; the hero's arms are too
  short to cross-draw from the left), staff over the right shoulder, bow high by the left shoulder.
  Travelling: flat (swim, glide) along the body; saddle down the flank; oars pointing back; seats
  with a backrest or a wheel (cart, roadster, helm) across the lap.
- **The move** (`PoseInput.stow`, 0 in hand to 1 put away): the drawing hand (`DRAWING_HAND`: bow
  left, the rest right) reaches to the stowed grip and is there around halfway, where the attachment
  changes over. At that moment the weapon in the hand is exactly where the put-away one is
  (measured: 0.000 m jump). The whole hand turns at an even pace from how it held the weapon, by way
  of the blade straight up (never through the ground), to how it lies put away. Past halfway the arm
  eases into hanging free. `holdArmed()` is the old `holdWeapon()`.
- **When** (`character.ts` `drawOrSheathe()`): `Hero.armed` is set by `main.ts` for the player:
  `inAFight()` = an enemy marked (soft lock counts) or a swing or cast in the last 90 frames, which is
  the same rule as the combat stance; battlefield always armed. Other players' heroes judge by their
  rules state (attacking, casting, guarding, stunned) and keep it out 4 s after. Draw 0.45 s, put
  away 0.6 s, 2.5 s after the fight. Swinging, shooting, casting or guarding puts it in hand at once
  (the swing's wind-up covers it). A trade pack keeps it in hand (over the shoulder). Battlefield
  remotes: `hero.armed = true` (`netPlayer.ts`).
- **Hooks**: `__game.heroWeapon()` gives 'hand' or 'away'. Gallery API: `weaponTrack(id, weapon)` (the
  weapon's far end per frame, its stow, and whether it hangs from a hand) and `holdGap(id)` (seated:
  hands against the vehicle's grips, feet against its footrest).
- **Films**: `idleAway`, `runAway` (put away), `sheathe`, `sheatheRun` (put away and draw, standing and
  running). Pass a weapon with the gallery's weapon buttons, or `sheet(id, { weapon })`.

Measured in the gallery before the tests were written: hands on grips (drive 1.4 cm, row 0, helm
2.4 cm at full lock); ride feet within 1.9 cm of the irons; seated feet hang 6.6 to 11 cm over
unreachable footrests (the legs are short); the sword's tip peaks at about 0.6 m per frame
mid-draw (a quick flourish), and the other weapons at 0.34 m or less.

## Next steps

1. **Run the new tests**; the run was interrupted, so they've never passed. In
   `tests/animation.spec.ts`: "drawing and putting the weapon away...", "with the weapon put away
   the hands are free...", "seated, the hands hold what the vehicle gives them...". In
   `tests/combat.spec.ts`: "the weapon comes out for a fight and goes away after it". Then the
   whole of `animation.spec.ts`, `creatures`, `species`, `world`, `combat`, `models`. Likely
   trouble spots:
   - `models.spec.ts` budgets: steering wheels are now their own meshes.
   - "knees and elbows only fold the way they can" over the new films.
   - The seated hands threshold (helm 2.4 cm against a 3 cm limit).
   - Anything that expected the weapon in hand in the yard (it's in hand while the dummy is marked,
     which the yard does for you while you face it).
2. **Run the full suite and conformance** (see "Running things"). Conformance shouldn't change, but
   `shared/vehicles.json` did.
3. **Show the user round 2** before landing: they review visually. Render before/after sheets
   (`tools/shots.mjs`; "before" means beta `5d273fb`) and build a review page. Key films: drive,
   sit, row, helm, ride, glide, bow, run, runAway, sheathe, sheatheRun (with each weapon).
4. **On landing**:
   - Update `design/status.json`: the jointed-hero feature notes, a feature for weapons out in a
     fight and put away after, and the "Moving well" session log.
   - Update the README "Fighting" paragraph: weapons come out for a fight.
   - Add `stow.ts` to the `src/render/detail/` row in `AGENTS.md`.
   - Rebase on beta, which may have moved.
   - Ask the user how to land it. Round 1 was "commit and push to beta". Don't assume the same for
     round 2.
5. **Ideas noted, not done**:
   - Reins on the horse: hands on a line to the bit.
   - A draw or sheathe when entering or leaving travel: it changes in one frame there.
   - Cape against back-carried staff and bow (they can cross when the cape streams out).
   - Give the townsfolk the hero's gait (`src/render/models/villagers.ts`).
   - The hauler has no footrest hold.
   - Peers' weapons follow `armed` heuristics only.

## Running things (this machine)

- **Worktree**: `C:\GitHub\heggelund\games\ruina-hero-animations`. Its `node_modules` is a symlink
  to the main repo's. `scratch/` is git-ignored (old sheets and probes live there).
- **Gallery**: `npm run dev`, then `http://localhost:5173/animations.html`. The films are in
  `src/render/detail/scenarios.ts`, the page in `src/render/detail/animations.ts`
  (`window.__anims`).
- **Sheets and probes**: `node handoff/improve-animations/tools/shots.mjs out run:side drive:three:4:0:240::2`
  and `node handoff/improve-animations/tools/probe.mjs "A.holdGap('row')"` (both need the dev
  server; `GALLERY=http://localhost:5288` if it's elsewhere).
- **Playwright**: use `-c handoff/improve-animations/tools/pw.config.ts` (port 5299). Plain
  `npx playwright test` reuses whatever dev server holds 5199, which is often another session's
  checkout, and then fails confusingly (the gallery 404s to the sign-in page). On Windows the tests
  use Edge. The full suite takes about 11 minutes.
- **Rust and conformance** (no cargo on this machine): Docker images `ruina-dev` and
  `ruina-dev-pw`; volumes `ruina-target`, `ruina-cargo`, `ruina-nm`:

  ```sh
  MSYS_NO_PATHCONV=1 docker run --rm -v "C:/GitHub/heggelund/games/ruina-hero-animations:/app" \
    -v ruina-target:/app/server/target -v ruina-cargo:/usr/local/cargo/registry -v ruina-nm:/app/node_modules \
    -w /app ruina-dev-pw sh -c "cargo build --release --locked --manifest-path server/Cargo.toml && \
    cargo test --release --locked --manifest-path server/Cargo.toml && CI=1 npx playwright test \
    tests/conformance.spec.ts tests/world-conformance.spec.ts tests/life-conformance.spec.ts tests/ai-conformance.spec.ts"
  ```

- **Battlefield and server tests natively on Windows** (`net`, `pvp`, `combat` and `skills` online,
  mostly `@gpu`, which CI skips): cross-compile in Docker, then copy into `server/target/release/`
  (git-ignored; the dual-stack fix means no relay is needed any more):

  ```sh
  MSYS_NO_PATHCONV=1 docker run --rm -v "C:/GitHub/heggelund/games/ruina-hero-animations:/app" \
    -v ruina-target-win:/app/server/target -v ruina-cargo:/usr/local/cargo/registry -w /app ruina-dev sh -c \
    "apt-get update -qq && apt-get install -y -qq gcc-mingw-w64-x86-64 && rustup target add x86_64-pc-windows-gnu && \
    cargo build --release --target x86_64-pc-windows-gnu --manifest-path server/Cargo.toml && \
    mkdir -p /app/scratch/winbin && cp server/target/x86_64-pc-windows-gnu/release/*.exe /app/scratch/winbin/"
  mkdir -p server/target/release && cp scratch/winbin/*.exe server/target/release/
  ```

  Remove `server/target/release/` again when done if you won't keep it current: with an old binary
  there, the server tests test that instead of being skipped. As parked, it holds Windows builds of
  beta `5d273fb`'s server, which are current for this branch (round 2 changed no Rust).

- **Online tests against this branch's server** (`tests/online.spec.ts`), without touching the
  shared `npm run up` containers (`ruina-server-1` on 7777 belongs to the main checkout): a private
  Postgres and server on 7790, then
  `RUINA_SERVER=http://localhost:7790 npx playwright test -c handoff/improve-animations/tools/pw.config.ts tests/online.spec.ts`:

  ```sh
  docker network create ruina-anim-net
  docker run -d --name ruina-anim-db --network ruina-anim-net -e POSTGRES_USER=ruina -e POSTGRES_PASSWORD=ruina -e POSTGRES_DB=ruina postgres:18
  MSYS_NO_PATHCONV=1 docker run -d --name ruina-anim-server --network ruina-anim-net -p 127.0.0.1:7790:7777 \
    -v ruina-target:/t:ro -e DATABASE_URL=postgres://ruina:ruina@ruina-anim-db:5432/ruina -e DEV_LOGIN=1 ruina-dev \
    sh -c "cp /t/release/yggdrasil-server /tmp/s && exec /tmp/s --battle off --port 7777"
  ```

- **Known flakes**: before `bf407cf`, the yard's "Escape backs out of placing a circle" and the
  skill panel "B closes" tests failed often on this fast machine. Both pass 10 of 10 now. The raid
  benchmark times out if other tests run alongside it.

## The user's rules worth repeating

- No AI attribution anywhere in commits or PRs ("Generated with", "Co-Authored-By" and the like).
- Commit and push only when asked. Beta deploys on push (CI runs first). Production is PR-only.
- Rules both sides run change in TypeScript and Rust together. Round 2 touched no rules.
- Other Claude sessions work in this repo at the same time: the main checkout on beta, and a
  `ui-restyle` worktree that will merge beta's `main.ts` input changes. Expect beta to move.
