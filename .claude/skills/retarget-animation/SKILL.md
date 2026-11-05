---
name: retarget-animation
description: Bring an animation clip onto one of the game's characters - a Meshy library clip, a Quaternius Universal Animation Library clip, a Mixamo clip, or any humanoid GLB - retargeted bone for bone onto our skeleton, checked against its source, and wired to a move. The made hero today; any made humanoid (villager, humanoid mob) the same way. Use when the user asks to use, add, replace, try or "rig up" an animation for a hero, character, mob or creature.
argument-hint: "[the move, the library, or a clip name]"
---

# Retarget an animation onto a character

A character's moves can be its own code (`src/render/detail/humanoid.ts`, the keyframed swings in
`swings.ts`) or a clip from an animation library played on it. A clip is retargeted bone for bone
(`src/render/detail/retarget.ts`): each of the library's bones has one of our joints (`fit.ts` gives
a made body the spine's three bones, the collarbones and the toes for this), each joint's rest is
first turned to point the way its source bone points at rest, and then it takes its source bone's
turn away from rest at every moment. The body follows the point between the source's hip joints,
sized by leg length; the clip's own travel is taken off, so the rules carry the body and the feet
the clip plants are held on the ground (`character.ts` holdFeet). Done right, every bone points
within a tenth of a degree of its source's: `tests/retarget.spec.ts` holds every move to that.

If arguments were given (`$ARGUMENTS`), that is the move or clip to bring in.

## 1. Find the clip: free first

AGENTS.md (Art and assets): look for a free clip before paying for one, and never trade quality
for the saving. Show the user what you found (the source's own preview, or the clip on its
skeleton) before wiring it in.

- **Quaternius' Universal Animation Library** (CC0): pack 1 and pack 2 on itch.io, each with a free
  Standard set (sword combos, a heavy combo, a block, a roll, hits, a death, spells, farming,
  climbing). Download the way a visitor does: the purchase page, "No thanks, just take me to the
  downloads", the `[Standard].zip`. Use the `_RM` GLB (root motion kept: the retarget measures from
  the root as it goes). The clips are animated by hand, not motion-captured.
- **Meshy's library** (`meshy_list_animations`, free to search; each entry has a preview GIF):
  `meshy_animate` with the character's rig task (find it with `meshy_list_tasks` and
  `task_types: ["rigging"]`; the hero's rig is the one its `hero.glb` came from). 3 credits an
  action: say so and wait for the user's OK. The clips come on the character's own skeleton, so
  they fit exactly. Download `animation_glb_url` into `scratch/`.
- **Mixamo** needs the user's Adobe account, and its FBX files need converting to GLB (Blender).
- **Sketchfab** (with `SKETCHFAB_TOKEN` in `.env`, if the user has added it): downloadable CC0 or
  CC-BY animated humanoids; no fan art of other games.

## 2. Cut it into the game

```sh
node tools/models/clips.mjs library.glb                       # its clips and their seconds
node tools/models/clips.mjs library.glb scratch/cut.glb "Long|clip=Short" Other_Clip
npx @gltf-transform/cli optimize scratch/cut.glb src/render/assets/models/hero_<name>.glb \
  --compress meshopt --simplify false --join false --instance false --flatten false --texture-compress false
```

The tool needs `@gltf-transform/core`, `@gltf-transform/extensions`, `@gltf-transform/functions`
and `meshoptimizer` (`npm i --no-save ...`). It keeps the skeleton and the named clips, drops the
mesh. `--flatten false` keeps the skeleton's tree. The hero's clip files are `hero_*.glb`
(`madeHero.ts` finds them by name).

## 3. A skeleton the game doesn't know yet

`LIBRARIES` in `retarget.ts` names each library's 22 bones (hips, three spine bones, neck, head,
and per side the collarbone, upper arm, forearm, hand, thigh, shin, foot and toe), its root bone if
it has one, and the right fist's index and little-finger knuckles if it has fingers (a held blade
runs through the fist from one past the other; without them, straight ahead in the T-pose). Add a
table for a new library; `libraryOf` picks it by the hips' name. Look at the skeleton first
(`gltf-transform inspect`, or the node names from a scratch script): three drops `:` from bone
names (`mixamorig:Hips` loads as `mixamorigHips`). The rests are lined up bone by bone, so a T- or
an A-pose both work.

## 4. Wire it to a move

`src/render/detail/moves.ts`: `HERO_MOVES` holds, per weapon, sets of combo hits, each a clip
(`file`, `parts` played end to end, and for a combo in one clip how many `strikes` it holds and which
`strike` this hit plays) or `null` for the keyframed swing; `HERO_MOVE_SETS` picks each weapon's set.
Strikes are found by the right hand's speed; `strikeTime` lands a clip's strike on the rules' first
active frame and plays it at up to 1.5x its pace, leaving most of the wind-up out (the user chose
this: the rules' swings are much quicker than library clips).

Moves other than combo hits (a dodge, a block, getting hit, a death, an idle, a cast) are not wired
to clips yet: give that state's pose function in `humanoid.ts` a branch that calls `poseFromClip`
with a time from the state's own frame, as `clipAttack` does, and a table entry like `HERO_MOVES`.

Another character (a villager, a humanoid mob): a Meshy-rigged model fitted with `fit()` gives the
`Target` (`{ joints, bind }`) the bake needs, exactly as the hero's does. A creature that isn't a
humanoid (a slime, a beast) needs its own bone table and target: the canonical bones here are a
humanoid's.

## 5. Check it

1. `/retarget.html?look=new&file=hero_<name>&clip=A~B` (add `&mesh=/scratch/<skinned source>.glb` to
   show the source skinned rather than as bones): the hero as the game bakes and poses it, beside the
   source. `window.__retarget.seek(t)` gives each moment's error.
2. `npx playwright test tests/retarget.spec.ts`: every move's clip, every frame: bones within 0.1°
   on average and 1° at worst, ankles no more than 2.5 cm under where they stand. `RECORD=1` keeps
   the frames under `test-results/retarget/` for a GIF.
3. `/animations.html?look=new` (`&swordMoves=keyed|meshy|quaternius` to compare sets): the move in the
   game's timing, with the trail, the feet held and the fingers round the weapon. Step it with
   `window.__anims.sheet(id, { frames: [f] })` and screenshot each frame for a GIF.
4. `npx playwright test tests/animation.spec.ts` (and the game and combat suites).

Show the user the clip against its source and in the game, side by side with what it replaces,
before you call it done.

## 6. Credit it

A library's clip goes in `CREDITS.md` (what, where, from, licence); Meshy's are the project's own.
