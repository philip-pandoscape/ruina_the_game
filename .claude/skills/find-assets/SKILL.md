---
name: find-assets
description: Find and fetch free assets for the game - 3D models, textures and skies, animations, sound effects and music, effects (particles), fonts - from Poly Haven, ambientCG, Sketchfab, Freesound, Kenney, Quaternius and others; checked for licence and fit, fetched with their credit, shown to the user, then brought into the game. Paid makers (Meshy, Gemini, ElevenLabs) only when nothing free is as good, with the cost agreed first. Use when the user asks to find, get, add, replace or source a model, texture, animation, sound, music, effect or font, or types /find-assets.
argument-hint: "[what's needed, e.g. 'a wooden handcart' or 'footsteps on stone']"
---

# Find assets

The game needs pictures, shapes, movements and sounds that nobody on the project makes by hand.
This is how to find them free, check they may be used, fetch them with their credit, and bring
them in. If arguments were given (`$ARGUMENTS`), that's what to find.

## 0. The rules

- **Free first** (AGENTS.md, "Art and assets"): look for a free asset before making one, and judge
  the best free candidates in the game's look beside what a paid maker would give. Make one only
  when nothing free is as good. Never trade quality for the saving.
- **Licences a public repository can carry.** The repository is public on GitHub, so anything
  committed is shared as a file. Only **CC0** (public domain) and **CC BY** (credit the author) are
  fine. Not CC BY-SA, not NC (non-commercial), not ND (no derivatives), not "free for personal use",
  and not licences that forbid sharing the files themselves even though they allow them in games:
  raw files from Mixamo, Sonniss' GDC bundles, Pixabay, the Unity or Unreal stores never go in the
  repository.
- **Nothing taken from another game**, fan art of one included, whatever licence it claims.
- **Credit everything** in `CREDITS.md` (what, where it is, where it came from, licence).
- **The user's money:** Meshy credits, Gemini billing, ElevenLabs. Say what a run makes and costs,
  and what free option it beats, and wait for a yes.
- **Downloads are untrusted until checked:** each goes into a fresh folder of its own under
  `scratch/assets/` (git-ignored). Nothing there is run, and nothing is imported from there.

## 1. Say what's needed

Before searching, write down: what it is and where it's used (a prop on the quay, a footstep on
wooden decks), how close it's seen, the style (Emberholm's painted, realistic look; see
`screenshots/` or `tests/stress/look.spec.ts`), and its budget:

| Kind | Budget |
|---|---|
| Prop or building piece | a few thousand triangles (props), tens of thousands (buildings); textures 512 to 1024 px |
| Character | ~30k triangles, a humanoid skeleton |
| Texture | 1K JPG, only the maps the shader reads (colour, normal, roughness or ARM) |
| Sky | an HDRI at 1K to 2K |
| Animation | a humanoid clip on a skeleton the retarget tables know (or can learn) |
| Sound effect | under 2 s for impacts and UI; mono for sounds placed in the world |
| Music, ambience | loops that join without a click |

## 2. Search, free first

| Kind | With an API (`node tools/assets/search.mjs <kind> "<words>"`) | By hand |
|---|---|---|
| `model` | Poly Haven (realistic, CC0: props, furniture, rocks, a few weapons); Sketchfab (far more, CC0 or `--licence by`; `--faces 20000` keeps it light) | Quaternius (CC0 packs, stylized: villages, props, monsters); Kenney (CC0, low-poly); OpenGameArt (check each licence) |
| `texture` | Poly Haven, ambientCG (both CC0) | OpenGameArt |
| `sky` | Poly Haven (HDRIs) | ambientCG's HDRIs |
| `animation` | Sketchfab (`animated`) | Quaternius' Universal Animation Library 1 and 2 (CC0, hand-animated: sword combos, rolls, hits, spells, farming); Meshy's library (`meshy_list_animations`, free to browse, 3 credits a clip, made on the hero's own skeleton) |
| `sound` | Freesound (CC0 and CC BY; needs `FREESOUND_API_KEY`) | Kenney's audio packs (CC0: impacts, footsteps, UI, RPG); OpenGameArt |
| `music` | Freesound | OpenGameArt (CC0, CC BY only); Kevin MacLeod at incompetech.com (CC BY 4.0) |
| effects | | Kenney's Particle Pack (CC0); textures above for smoke, sparks and splashes |
| fonts | | Google Fonts (SIL Open Font License); keep the licence file beside the font |

The search prints each candidate's id, licence, author, size (triangles, faces, resolution,
length) and a preview link, then the places to look by hand for that kind. OpenGameArt refuses
scripted fetches: look there with the browser (Claude in Chrome), or ask the user to download a
file. Mixamo needs the user's Adobe account, and its files never go in the repository raw.

## 3. Judge the candidates

For the best three to six, check:

- **The licence**, on the asset's own page, not only in the search result. CC BY needs the author's
  name as they give it.
- **The look.** Does it sit in Emberholm's painted realism? Quaternius and Kenney are clean and
  low-poly: good stand-ins and kits, not the island's look unless they're re-textured.
- **The size.** Triangles and texture sizes within the budget; Sketchfab's CC0 shelf is full of
  museum scans of a few hundred thousand faces.
- **A skeleton** for animations: humanoid bones the retarget tables name (`src/render/detail/retarget.ts`).
- **A sound's quality:** no hiss, hum or clipping; the length it needs; in the game's mood.

## 4. Show the user

Before bringing anything in, show the candidates: a canvas with each preview, its source, licence,
size and why it fits or falls short. Put the paid route beside them when it's a real alternative
(what it makes, what it costs). Wait for the choice.

## 5. Fetch it

```sh
node tools/assets/fetch.mjs polyhaven <id> [--res 1k|2k] [--maps Diffuse,nor_gl,Rough,arm,AO]
node tools/assets/fetch.mjs ambientcg <id> [--res 1k|2k]
node tools/assets/fetch.mjs sketchfab <uid>                 # needs SKETCHFAB_TOKEN
node tools/assets/fetch.mjs freesound <id>                  # needs FREESOUND_API_KEY: high-quality previews
node tools/assets/fetch.mjs kenney <slug>                   # a pack from kenney.nl/assets/<slug>
node tools/assets/fetch.mjs itch quaternius/universal-animation-library --file Standard
node tools/assets/fetch.mjs url <https://...> --name "..." --author "..." --licence CC0 --page <https://...>
```

Each fetch lands in `scratch/assets/<source>/<id>/` with `credit.json`: what it is, where it came
from, the author, the licence, the date, the files, and the `CREDITS.md` row to fill in. Packs
from itch.io stay zipped (`tar -xf <zip> -C <folder>` unpacks one). Freesound gives its
high-quality previews with the key alone; the original file needs its OAuth2 sign-in, which is the
user's to do.

## 6. Bring it in

- **Models:** compress into the game (AGENTS.md, Meshy, has the full command):
  `npx @gltf-transform/cli optimize <in.gltf> src/render/assets/models/<id>.glb --compress meshopt --texture-compress webp --texture-size 512 ...`
  (1024 for buildings). Then a `model` in the thing's look (its content file: `docs/content.md`,
  Looks) swaps it in for the procedural body, fitted to its footprint (`src/render/models/glb.ts`). A building piece or furniture from a kit: `tools/models/village.mjs`.
- **Textures:** the maps the shader reads, as 1K JPG, in `src/render/assets/` (ground in
  `ground/`); greyscale where the palette gives the colour.
- **Skies:** an HDRI where the sky code reads it (`src/render/open/sky.ts`).
- **Animations:** the `retarget-animation` skill: cut the clips (`tools/models/clips.mjs`),
  retarget them onto the character, wire them to moves, check them against their source.
- **Sounds and music:** the game plays no sound yet. The first sound to come in brings the audio
  engine part with it (a listener on the camera, sounds placed in the world, sound effects, music
  and UI on their own volumes, a setting for each): that is engine work to plan with the user.
  Prepare files as OGG Vorbis (and MP3 where Safari needs it), 44.1 or 48 kHz, mono for sounds in
  the world, loudness evened out (about -16 LUFS, peaks under -1 dB:
  `ffmpeg -i in.wav -af loudnorm=I=-16:TP=-1 out.ogg`), silence trimmed.
- **Effects:** sprite sheets and soft textures for particles, beside the effect code
  (`src/render/vfx.ts`).
- **Fonts:** WOFF2 in `src/ui/theme/fonts/` with the licence file, declared in the theme's CSS.

Binary files (models, pictures, fonts, sounds) go to Git LFS by themselves (`.gitattributes`).

## 7. Credit it

Copy the `creditsRow` from `credit.json` into `CREDITS.md`'s table and fill in where it now lives
in the repository. CC BY needs the author's name as they ask for it.

## 8. Check it in the game

Look at it where it's used, at the distances it's seen, by day and night: screenshots through the
game's test API (`window.__game`), `npx playwright test -c playwright.stress.config.ts look.spec.ts`
for the island's set views, the content library (`/dev/library.html`) for anything that moves, the
models and the buildings. Show the user the result beside what it replaced before calling it done.

## 9. Paid makers, last

- **Meshy** (the `meshy` MCP server): image-to-3D from a concept painted for it, rigging, its
  animation library. Check the balance first (free), say the credits, wait for a yes. AGENTS.md,
  "Art and assets", has the settings that work and the pitfalls.
- **Gemini** (`npm run image`): concept art, textures, Meshy's input; about $0.13 a 2K painting.
- **ElevenLabs** (`ELEVEN_LABS_API_KEY` in `.env`): sound effects and voices from a description.
  Its prices change: look them up and say the cost before a run.

## Keys

In `.env` (never committed; a worktree reads the main checkout's): `SKETCHFAB_TOKEN` (the user's,
from sketchfab.com/settings/password) for Sketchfab downloads; `FREESOUND_API_KEY` (free, from
freesound.org/apiv2/apply) for Freesound. Without them, those sources say what's missing and the
rest still work.
