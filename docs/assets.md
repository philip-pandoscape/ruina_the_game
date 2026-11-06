# Assets

Every model, texture, animation, icon and typeface the game ships, from the moment someone finds it
to the moment the game loads it. The game is meant to grow far past what it should load before you
can sign in, so the title screen, sign-in and character select come first; everything else loads as
the world needs it, nearest first, drawn plain until it arrives. The client will be packaged as a
desktop app (the refactor's D15), so a browser's download isn't held to a budget: what comes first
is about start-up time and graphics memory.

| Step | Where | What it does |
|---|---|---|
| Find it | the `find-assets` skill (`.claude/skills/find-assets/SKILL.md`, `tools/assets/search.mjs`, `fetch.mjs`) | Free first: searched, licence checked, fetched with its credit into `scratch/assets/` |
| Bring it in | `src/render/assets/`, `src/ui/theme/icons/`, `src/ui/theme/fonts/` | Compressed into the game's formats (below); binary files go to Git LFS by themselves (`.gitattributes`) |
| Credit it | `CREDITS.md` | What, where it is, where it came from, licence |
| Describe it | `src/assets/catalog.ts` | Its kind and the zones that use it, by its id |
| Load it | `src/assets/loader.ts`, through `src/render/assets.ts` | Fetched by id when it's needed, the most needed first, a stand-in drawn until it arrives |
| Build | `tools/assets/manifest.ts` (a Vite plugin) | `/asset-manifest.json`: every asset with its built file, size, kind and zones |
| Hold the line | `tests/unit/assets.test.ts` | Every file described, with the zones that use it |

## From a Find to the Game

1. **Find it.** The `find-assets` skill: what's needed and its budget, a search of the free sources,
   the candidates judged and shown to the user, the chosen one fetched with `credit.json` beside it.
   Paid makers (Meshy, Gemini) last, with the cost agreed first (AGENTS.md, "Art and assets").
2. **Bring it in**, in the formats the game loads:
   - **Models**: glTF binary, compressed with glTF Transform (meshopt geometry, WebP textures at
     1024 pixels for buildings, 512 for props), into `src/render/assets/models/<id>.glb`:
     `npx @gltf-transform/cli optimize in.glb src/render/assets/models/<id>.glb --compress meshopt
     --texture-compress webp --texture-size 1024 --simplify false --join false --instance false
     --flatten true`. The village kit's pieces are packed by `tools/models/village.mjs`.
   - **Textures**: the maps the shader reads, as 1K JPG (greyscale where the palette gives the
     colour), in `src/render/assets/` (the ground's in `ground/`).
   - **Animations**: clips cut from their library by `tools/models/clips.mjs` into
     `src/render/assets/models/hero_*.glb` (the `retarget-animation` skill).
   - **Icons**: painted and cut out by `npm run icons` into `src/ui/theme/icons/`.
   - **Typefaces**: WOFF2 in `src/ui/theme/fonts/`, with their licence.
3. **Credit it** in `CREDITS.md`.
4. **Describe it** in `src/assets/catalog.ts`: a rule whose pattern matches its id (its path under
   the asset folder, without the extension: `models/well`, `ground/grass`, `icons/coin`) says its
   kind and which zones use it. A new made prop usually matches a rule already (`models/*`: the
   island's). `tests/unit/assets.test.ts` fails on a file no rule names, on a rule that names no file,
   and on a zone the game doesn't have.
5. **Load it** by id, with what it's needed for, and draw something in its place until it arrives:
   `model(id, wanted)`, `gltf(id, wanted)` (animations too) or `picture(id, wanted)` from
   `src/render/assets.ts`. A made model that stands in for a procedural one needs only an entry in
   `MADE_STRUCTURES`, `MADE_PROPS` or `MADE_PACKS` (`src/render/models/glb.ts`), which loads it as it
   comes near.
6. **Check it in the game** (the skill's last step).

## The Manifest

Built with the client: `npx vite build` writes `dist/asset-manifest.json` beside the pages.

| Field | What |
|---|---|
| `assets[].id` | The asset's id |
| `assets[].file` | The built file, named after what's in it (`assets/hero-Lp91RHMo.glb`) |
| `assets[].size` | Its bytes |
| `assets[].kind` | `model`, `animation`, `texture`, `icon`, `font` (and `sound`, `music` once there are any) |
| `assets[].zones` | Where it's used: `front` (the title screen, sign-in and character select: the first download), `*` (every zone a player can be in: their own body and gear), `emberholm` (the island, and the arenas drawn over it), a dungeon or zone by its id (`content/instances/`), `dev` (only the developer pages, or a developer's address option) |
| `code.first` | The scripts and style sheets the game's page starts with (`src/app/boot.ts` and what it imports) |
| `code.later` | Those it fetches on the way into the world (`src/main.ts` and the rest) |

The manifest sits at a fixed address and is asked about every time, as the pages are; every file it
names is under `/assets/`, named after what's in it, so it is kept a year and never asked about
again (`cache_headers`, `crates/server/src/http.rs`). A new build reaches everyone at once, and a
returning player fetches only the files that changed.

The game keeps its own copy (`src/assets/manifest.ts`): each file's address from Vite, its size from
the build (`import.meta.env.RUINA_ASSET_SIZES`, set by the plugin, so the title screen can say how
much has arrived), its kind and zones from the catalogue. Nothing in the game names a file by its
path but the catalogue.

Where the files live: in Git LFS in the repository, and on the game server once built. A CDN in front
of them later is a setting, not a change to the game: every file is named after what's in it and
listed in the manifest, so Vite's `base` (or `experimental.renderBuiltUrl`, for the assets alone)
points the addresses at the CDN, and the cache rules stay as they are.

## The Loader

Everything the game fetches after its code goes through `src/assets/loader.ts`, which decides when.
Each request says what it's needed for:

| Need | What | Order |
|---|---|---|
| `front` | The title screen, sign-in and character select: the hero's body, weapons and moves | First |
| `zone` | What the zone being entered can't be drawn without: the ground's textures, the bark and grain, the village kit the town is built of | Next |
| `near` | What stands in the zone: the made structures, props and packs | Nearest the camera first; past the view distance (`GRAPHICS.viewDistance`), not until the camera comes near |

Six files load at once, the most needed next, so on a slow line what's under and around you
arrives first. `OpenStage.update` tells it where the camera is every frame (`streamFrom`). One
request per file, whoever asks; a second asker with a more urgent need, or a nearer place, moves it
up.

**Low detail first:** whatever asks draws a stand-in until the file arrives and swaps it in after:
the procedural models for the made ones, the ground's plain colours for its textures, the box hero
for the made one. **Progress:** the title screen says how much of the files being fetched has arrived,
under its bar (`src/ui/splash.ts`). Tests wait for `window.__game.assetsReady` (nothing asked for
still on its way, bar what waits for the camera to come near); before the game is there,
`window.__assets` says what the loader is doing.

## The First Download

The page's entry is `src/app/boot.ts`: the title screen (drawn by `index.html` before any code
arrives), sign-in, and character select with its hero (three.js and the hero's code, the hero's body,
weapons and moves), the interface's style sheets and typefaces. The rest of the game's code
(`src/main.ts` and everything it imports: the island, its rules, the HUD, the windows) is fetched
once a character is chosen, while the world link opens; straight in (`?as=name`, a reload into the
world) at once; the offline pages the tests use (`?test`, `?world&test`) at once. The island's files
follow as it is built.

Measured over the wire with brotli from the game server, a browser with nothing cached (2026-11-06):

| | Before Phase 11 | Now |
|---|---|---|
| The title screen and sign-in | 898 KB: code 588, typefaces 309 | 613 KB: code 304, typefaces 309 |
| The first download: character select with its hero | 2,434 KB: code 588, the hero's files 1,524, typefaces 309, icons 12 | 2,150 KB: code 304, the hero's files 1,524, typefaces 309, icons 12 |
| In the world and playing | 5,132 KB | 3,894 KB: the ground's textures and the rest still streaming in |
| Everything the island loads | 9,326 KB | 9,337 KB (one more script) |

No budget holds it any more (D15): with a desktop app coming, the files will be on disk. The
measurements above are kept for the record.

## KTX2 Textures

Dropped from the refactor (D15): with a desktop app the download's size doesn't count, so what's
left is the graphics memory, for a later performance pass. Not made yet: making them needs KTX-Software's `toktx` (which glTF Transform's `etc1s`, `uastc` and
`ktx2` steps call), and it isn't installed on the development machine. What they would bring,
measured on the game's biggest textures (2026-11-06) with the same Basis Universal encoder built to
WebAssembly (the `ktx2-encoder` package, run from `scratch/`, not part of the project), at glTF
Transform's default settings (ETC1S quality 128; UASTC level 2, RDO 4, Zstandard), mipmaps
included; the GPU memory as a desktop graphics card holds each (RGBA8 decoded today, BC1 from ETC1S,
BC7 from UASTC), mipmaps included:

| Textures | Today | As ETC1S | As UASTC | On the GPU today | As ETC1S | As UASTC |
|---|---|---|---|---|---|---|
| The ground's colour (7 at 1024 px, JPG) | 1,757 KB | 1,220 KB | 1,127 KB for grass alone (321 KB today) | 37.3 MB | 4.7 MB | 9.3 MB |
| The ground's normal maps (7 at 512 px, JPG) | 614 KB | 427 KB | 2,038 KB | 9.3 MB | 1.2 MB | 2.3 MB |
| The hero's body (2048 px, WebP) | 248 KB | 568 KB | 3,160 KB | 21.3 MB | 2.7 MB | 5.3 MB |
| The staff's three (1024 px, WebP) | 255 KB | 302 KB | | 16.0 MB | 2.0 MB | 4.0 MB |
| The windmill (1024 px, WebP) | 141 KB | 163 KB | | 5.3 MB | 0.7 MB | 1.3 MB |
| The village kit and its furniture (24, WebP) | 1,149 KB | 2,616 KB | 1,497 KB for two normal maps (165 KB today) | 124.0 MB | 15.5 MB | 31.0 MB |
| **These 43** | **4,164 KB** | **5,296 KB** | | **213.3 MB** | **26.7 MB** | **53.3 MB** |

**Where it pays:** GPU memory above all. A JPG or WebP is decoded to 4 bytes a pixel (5.3 with its
mipmaps); KTX2 stays compressed on the graphics card at half a byte (ETC1S, as BC1) or one (UASTC,
as BC7), and is ready to draw without decoding on the page's thread. All 83 textures the game ships
come to 295 MB on the card today: 37 MB as ETC1S, 74 MB as UASTC; the hero's one 2048-pixel texture
alone is 21 MB. On the wire it depends what it replaces: ETC1S is 30% smaller than the ground's JPGs
(2.37 MB down to 1.65 MB, and 47 MB of GPU memory down to 6), but one to five times the size of the
models' WebPs; UASTC is three to thirteen times the size of either. And the transcoder that turns
either into what the card takes (`three/examples/jsm/libs/basis/`) is 217 KB more with brotli,
fetched before the first KTX2 texture. So, in order: the ground as ETC1S (smaller and lighter both;
its normal maps as ETC1S too if the look test can't tell, else UASTC), then the village kit (1.4 MB
more to download for 108 MB less on the card), then the made models as they grow; not the hero's
while it is in the first download.

**The step, once `toktx` is installed** (KTX-Software, from github.com/KhronosGroup/KTX-Software;
check it with `toktx --version`):

- *A model's textures*, in place of WebP:
  `npx @gltf-transform/cli etc1s in.glb out.glb --quality 128 --slots "!normalTexture"` then
  `npx @gltf-transform/cli uastc out.glb out.glb --slots "normalTexture" --level 2 --rdo 4 --zstd 18`,
  then the `optimize` step above without `--texture-compress`. The file keeps its name and id.
- *The ground's textures*: the shader reads them as one array texture a set (colour, normals), so they
  become two KTX2 array textures: `toktx --t2 --encode etc1s --genmipmap --layers 7 ground.ktx2
  grass.jpg road.jpg ...` (and `--encode uastc --zcmp 18 --assign_oetf linear` for the normal maps);
  the average colour of each, which `ground.ts` works out from the pixels today, is written down
  beside them.
- *The game*: `GLTFLoader.setKTX2Loader(new KTX2Loader().setTranscoderPath(...).detectSupport(renderer))`
  in `src/render/assets.ts`, the transcoder's two files copied into the build, and a `ktx2` rule in the
  catalogue (the asset folders already take `.ktx2`). The look test (`tests/stress/look.spec.ts`)
  before and after.

## Caching

Done in R11.3: everything under `/assets/` kept a year (`immutable`), the pages and the manifest
asked about every time and answered "not modified" unless they changed, brotli beside gzip
(`crates/server/src/http.rs`), for the browser game until the desktop app. A service worker that
kept the files between visits was dropped (D15): the desktop app will have them on disk.
