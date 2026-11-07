# Credits

Ruina's own code, art and writing are the project's. These pieces come from others, under their
licences:

| What | Where it is | From | Licence |
|---|---|---|---|
| Body type: TeX Gyre Pagella | `src/ui/theme/fonts/pagella-*.woff2` | [GUST e-foundry](https://www.gust.org.pl/projects/e-foundry/tex-gyre) | GUST Font License (`src/ui/theme/fonts/GUST-FONT-LICENSE.txt`) |
| Title type: Alegreya SC | `src/ui/theme/fonts/alegreya-sc-700.woff2` | [The Alegreya Project Authors](https://github.com/huertatipografica/Alegreya) (Juan Pablo del Peral, Huerta Tipográfica) | SIL Open Font License 1.1 (`src/ui/theme/fonts/ALEGREYA-SC-OFL.txt`) |
| Ground textures: grass | `src/render/assets/ground/grass*.jpg` | [ambientCG](https://ambientcg.com/view?id=Grass004) (Grass004) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Ground textures: path, sand, rock, soil, cobbles, forest floor | `src/render/assets/ground/` | [Poly Haven](https://polyhaven.com/textures) (dirt_floor, coast_sand_01, rock_face_03, farm_soil, cobblestone_floor_08, forrest_ground_01) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Tree bark | `src/render/assets/bark_*.jpg` | [Poly Haven](https://polyhaven.com/textures) (bark_brown_02, pine_bark) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| The made hero's sword and club swings | `src/render/assets/models/hero_swings.glb`, cut from the library by `tools/models/clips.mjs` | [Quaternius](https://quaternius.com/packs/universalanimationlibrary2.html), Universal Animation Library 2 (Sword_Regular_A, B and C with their recoveries, Sword_Heavy_Combo) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Buildings: walls, floors, roofs, stairs, doors, windows | `src/render/assets/village/kit.glb`, packed by `tools/models/village.mjs` | [Quaternius](https://quaternius.com/packs/medievalvillagemegakit.html), Medieval Village MegaKit (Standard) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Furniture and the things in the houses | `src/render/assets/village/props.glb`, packed by `tools/models/village.mjs` | [Quaternius](https://quaternius.com/packs/fantasypropsmegakit.html), Fantasy Props MegaKit (Standard) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Wood, stone and plaster grain | `src/render/assets/detail.jpg` | [Poly Haven](https://polyhaven.com/textures) (brown_planks_05, stone_wall, plastered_wall), made greyscale and packed a channel each | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

The made models in `src/render/assets/models/` (the lighthouse, the windmill, stalls, props, resource nodes, boulders, the hero,
his weapons and his Meshy animation clips: `hero_walk`, `hero_run`, `hero_moves_meshy`) are the project's
own: generated with [Meshy](https://www.meshy.ai) on a paid plan from concept art it painted for Ruina, then
compressed with [glTF Transform](https://gltf-transform.dev).

The townsfolk's bodies (`npc_*` in `src/render/assets/models/`) are the project's own: made with
[Tripo AI](https://www.tripo3d.ai) on a paid plan (Smart Mesh P2.0 from four views, textured and rigged
there) from turnaround sheets painted for Ruina with Google's Gemini image model, then compressed with glTF
Transform.

The icons in `src/ui/theme/icons/` (items, skills, places and the HUD's own) are the project's own: painted
for Ruina with Google's Gemini image model (Nano Banana Pro, on a paid plan) by `tools/icons/paint.mjs`, and
cut out of their sheets by `tools/icons/bake.mjs`.

The game says so too, in its Settings window.
