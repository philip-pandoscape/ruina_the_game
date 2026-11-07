// Packs the village's building kit and its furniture into the files the game loads: every piece
// we build or furnish with, as a named node, sharing one set of textures per file.
//
//   node tools/models/village.mjs "<Medieval Village MegaKit[Standard]>/glTF" "<Fantasy Props MegaKit[Standard]>/Exports/glTF"
//
// Both are Quaternius' (CC0, https://quaternius.com): the Medieval Village MegaKit's walls, floors,
// roofs and stairs, and the Fantasy Props MegaKit's beds, tables, barrels and lamps. Their pieces
// come as one .gltf each, all pointing at the same trim-sheet textures. This drops what the game's
// shading never reads (roughness maps, a second UV set, skins), merges the pieces into one scene
// with glTF Transform, then compresses it: meshopt geometry, WebP textures at 1024 pixels. Output:
// src/render/assets/village/kit.glb and props.glb (src/render/village/kit.ts reads them).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [kitDir, propsDir] = process.argv.slice(2);
if (!kitDir || !fs.existsSync(kitDir) || !propsDir || !fs.existsSync(propsDir)) {
  console.error('usage: node tools/models/village.mjs <Medieval Village MegaKit glTF folder> <Fantasy Props MegaKit glTF folder>');
  process.exit(1);
}

/** Every piece the buildings are made of (the heaviest the game never uses are left out). */
const PIECES = [
  // Walls: plaster over a timber frame, and rough stone; each with doors and windows.
  'Wall_Plaster_Straight',
  'Wall_Plaster_Straight_Base',
  'Wall_Plaster_Straight_L',
  'Wall_Plaster_Straight_R',
  'Wall_Plaster_Door_Flat',
  'Wall_Plaster_Door_Round',
  'Wall_Plaster_Door_RoundInset',
  'Wall_Plaster_Window_Thin_Round',
  'Wall_Plaster_Window_Wide_Flat',
  'Wall_Plaster_Window_Wide_Flat2',
  'Wall_Plaster_Window_Wide_Round',
  'Wall_Plaster_WoodGrid',
  'Wall_UnevenBrick_Straight',
  'Wall_UnevenBrick_Door_Flat',
  'Wall_UnevenBrick_Door_Round',
  'Wall_UnevenBrick_Window_Thin_Round',
  'Wall_UnevenBrick_Window_Wide_Flat',
  'Wall_UnevenBrick_Window_Wide_Round',
  'Wall_Arch',
  'Wall_BottomCover',
  // Corners.
  'Corner_Exterior_Wood',
  'Corner_Exterior_Brick',
  'Corner_ExteriorWide_Wood',
  'Corner_ExteriorWide_Brick',
  'Corner_Exterior_TopDown',
  'Corner_Exterior_TopOnly',
  'Corner_Interior_Big',
  'Corner_Interior_Small',
  // Doors, frames, windows, shutters.
  'Door_1_Flat',
  'Door_1_Round',
  'Door_4_Flat',
  'Door_4_Round',
  'Door_8_Flat',
  'Door_8_Round',
  'DoorFrame_Flat_Brick',
  'DoorFrame_Flat_WoodDark',
  'DoorFrame_Round_Brick',
  'DoorFrame_Round_WoodDark',
  'Window_Thin_Flat1',
  'Window_Thin_Round1',
  'Window_Wide_Flat1',
  'Window_Wide_Round1',
  'Window_Roof_Thin',
  'Window_Roof_Wide',
  'WindowShutters_Thin_Flat_Closed',
  'WindowShutters_Thin_Flat_Open',
  'WindowShutters_Thin_Round_Closed',
  'WindowShutters_Thin_Round_Open',
  'WindowShutters_Wide_Flat_Closed',
  'WindowShutters_Wide_Flat_Open',
  'WindowShutters_Wide_Round_Closed',
  'WindowShutters_Wide_Round_Open',
  // Floors and the trim round a stairwell.
  'Floor_Brick',
  'Floor_RedBrick',
  'Floor_UnevenBrick',
  'Floor_WoodDark',
  'Floor_WoodLight',
  'Floor_WoodDark_Half1',
  'Floor_WoodDark_Half2',
  'Floor_WoodDark_Half3',
  'HoleCover_90Angle',
  'HoleCover_90Half',
  'HoleCover_90Stairs',
  'HoleCover_Straight',
  'HoleCover_StraightHalf',
  // Stairs and balconies.
  'Stair_Interior_Solid',
  'Stair_Interior_Rails',
  'Stair_Interior_Simple',
  'Stair_Interior_SolidExtended',
  'Stairs_Exterior_Straight',
  'Stairs_Exterior_Platform',
  'Stairs_Exterior_Sides',
  'Stairs_Exterior_SingleSide',
  'Balcony_Cross_Straight',
  'Balcony_Cross_Corner',
  'Balcony_Simple_Straight',
  // Jettied upper storeys.
  'Overhang_Plaster_Long',
  'Overhang_Plaster_Short',
  'Overhang_Plaster_Corner',
  'Overhang_Plaster_Corner_Front',
  'Overhang_UnevenBrick_Long',
  'Overhang_UnevenBrick_Short',
  'Overhang_Roof_Plaster',
  'Overhang_RoofIncline_Plaster',
  // Roofs: whole gable roofs by span x length, their end walls, dormers, a tower cap, porch roofs.
  'Roof_RoundTiles_4x4',
  'Roof_RoundTiles_4x6',
  'Roof_RoundTiles_4x8',
  'Roof_RoundTiles_6x6',
  'Roof_RoundTiles_6x8',
  'Roof_RoundTiles_6x10',
  'Roof_RoundTiles_6x12',
  'Roof_RoundTiles_6x14',
  'Roof_RoundTiles_8x8',
  'Roof_RoundTiles_8x10',
  'Roof_RoundTiles_8x12',
  'Roof_RoundTiles_8x14',
  'Roof_Front_Brick2',
  'Roof_Front_Brick4',
  'Roof_Front_Brick6',
  'Roof_Front_Brick8',
  'Roof_Front_Brick4_Half_L',
  'Roof_Front_Brick4_Half_R',
  'Roof_Front_Brick6_Half_L',
  'Roof_Front_Brick6_Half_R',
  'Roof_Front_Brick8_Half_L',
  'Roof_Front_Brick8_Half_R',
  'Roof_Dormer_RoundTile',
  'Roof_Tower_RoundTiles',
  'Roof_2x4_RoundTile',
  'Roof_RoundTile_2x1',
  'Roof_RoundTile_2x1_Long',
  'Roof_Wooden_2x1',
  'Roof_Wooden_2x1_L',
  'Roof_Wooden_2x1_R',
  'Roof_Wooden_2x1_Middle',
  'Roof_Wooden_2x1_Center',
  'Roof_Wooden_2x1_Corner',
  'Roof_Log',
  'Roof_Support2',
  'Roof_FrontSupports',
  'Roof_Modular_RoundTiles',
  // Props.
  'Prop_Chimney',
  'Prop_Chimney2',
  'Prop_Crate',
  'Prop_Wagon',
  'Prop_Support',
  'Prop_WoodenFence_Single',
  'Prop_WoodenFence_Extension1',
  'Prop_WoodenFence_Extension2',
  'Prop_ExteriorBorder_Straight1',
  'Prop_ExteriorBorder_Straight2',
  'Prop_ExteriorBorder_Corner',
  'Prop_Brick1',
  'Prop_Brick2',
  'Prop_Brick3',
  'Prop_Brick4',
  'Prop_Vine1',
  'Prop_Vine2',
  'Prop_Vine4',
  'Prop_Vine5',
  'Prop_Vine6',
  'Prop_Vine9',
];

/** The furniture and small things rooms are dressed with (the skinned banner cloths are left out). */
const PROPS = [
  'Anvil',
  'Anvil_Log',
  'Axe_Bronze',
  'Bag',
  'Banner_1',
  'Banner_2',
  'Barrel',
  'Barrel_Apples',
  'Barrel_Holder',
  'Bed_Twin1',
  'Bed_Twin2',
  'Bench',
  'BookGroup_Medium_1',
  'BookGroup_Medium_2',
  'BookGroup_Medium_3',
  'BookGroup_Small_1',
  'BookGroup_Small_2',
  'BookGroup_Small_3',
  'BookStand',
  'Book_5',
  'Book_7',
  'Book_Stack_1',
  'Book_Stack_2',
  'Bookcase_2',
  'Bottle_1',
  'Bucket_Metal',
  'Bucket_Wooden_1',
  'Cabinet',
  'CandleStick',
  'CandleStick_Stand',
  'CandleStick_Triple',
  'Candle_1',
  'Candle_2',
  'Carrot',
  'Cauldron',
  'Chair_1',
  'Chalice',
  'Chandelier',
  'Chest_Wood',
  'Coin_Pile',
  'Coin_Pile_2',
  'Crate_Metal',
  'Crate_Wooden',
  'FarmCrate_Apple',
  'FarmCrate_Carrot',
  'FarmCrate_Empty',
  'Key_Metal',
  'Lantern_Wall',
  'Mug',
  'Nightstand_Shelf',
  'Peg_Rack',
  'Pickaxe_Bronze',
  'Pot_1',
  'Pot_1_Lid',
  'Potion_1',
  'Potion_2',
  'Potion_4',
  'Pouch_Large',
  'Rope_1',
  'Rope_2',
  'Rope_3',
  'Scroll_1',
  'Scroll_2',
  'Shelf_Arch',
  'Shelf_Simple',
  'Shelf_Small_Bottles',
  'Shield_Wooden',
  'SmallBottle',
  'SmallBottles_1',
  'Stall_Cart_Empty',
  'Stall_Empty',
  'Stool',
  'Sword_Bronze',
  'Table_Fork',
  'Table_Knife',
  'Table_Large',
  'Table_Plate',
  'Table_Spoon',
  'Torch_Metal',
  'Vase_2',
  'Vase_4',
  'Vase_Rubble_Medium',
  'WeaponStand',
  'Whetstone',
  'Workbench',
  'Workbench_Drawers',
];

/**
 * Pieces simplified before packing, to this share of their vertices (the rest are drawn as they
 * come): the kit's sculpted stone quoins and door surrounds, and the props a town has hundreds of,
 * carry thousands of triangles of detail nobody sees at a few metres.
 */
const SIMPLIFY = {
  Corner_Exterior_Brick: 0.25,
  Corner_ExteriorWide_Brick: 0.25,
  DoorFrame_Flat_Brick: 0.3,
  DoorFrame_Round_Brick: 0.3,
  Window_Thin_Round1: 0.6,
  Window_Wide_Round1: 0.6,
  CandleStick_Triple: 0.35,
  CandleStick_Stand: 0.3,
  CandleStick: 0.5,
  Chandelier: 0.35,
  Shelf_Small_Bottles: 0.3,
  FarmCrate_Apple: 0.3,
  FarmCrate_Carrot: 0.3,
  FarmCrate_Empty: 0.5,
  Barrel_Apples: 0.4,
  Barrel_Holder: 0.5,
  Crate_Metal: 0.5,
  Chest_Wood: 0.5,
  Cabinet: 0.5,
  Lantern_Wall: 0.45,
  Anvil_Log: 0.4,
  Cauldron: 0.5,
  WeaponStand: 0.5,
  Bookcase_2: 0.6,
  Whetstone: 0.6,
  Bed_Twin1: 0.6,
  Bed_Twin2: 0.6,
  Pot_1: 0.5,
  Pot_1_Lid: 0.5,
  Bucket_Wooden_1: 0.5,
  Stall_Cart_Empty: 0.5,
  Coin_Pile: 0.4,
  Coin_Pile_2: 0.4,
  Book_7: 0.5,
  Rope_1: 0.4,
  Rope_2: 0.4,
  Rope_3: 0.4,
  BookStand: 0.5,
  Shield_Wooden: 0.5,
};

pack(kitDir, PIECES, 'kit');
pack(propsDir, PROPS, 'props');

/** One file of pieces: src/render/assets/village/<name>.glb. */
function pack(src, pieces, name) {
  const out = path.resolve(`src/render/assets/village/${name}.glb`);
  const work = path.resolve(`scratch/village-build/${name}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const cli = (args) =>
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', '@gltf-transform/cli', ...args], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      cwd: work,
    });

  const rel = path.relative(work, path.resolve(src)).split(path.sep).join('/');
  const files = [];
  for (const piece of pieces) {
    const file = path.join(src, `${piece}.gltf`);
    if (!fs.existsSync(file)) throw new Error(`${src} has no ${piece}`);
    const g = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Toon shading reads colour and normals only, and nothing here is skinned.
    for (const m of g.materials ?? []) if (m.pbrMetallicRoughness) delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    for (const mesh of g.meshes)
      for (const p of mesh.primitives) {
        delete p.attributes.TEXCOORD_1;
        delete p.attributes.JOINTS_0;
        delete p.attributes.WEIGHTS_0;
      }
    delete g.skins;
    for (const n of g.nodes) delete n.skin;
    // One root node per piece, named after it (a chest's lid and body hang under it).
    const scene = g.scenes[g.scene ?? 0];
    if (scene.nodes.length === 1 && !g.nodes[scene.nodes[0]].children) {
      g.nodes[scene.nodes[0]].name = piece;
      if (g.meshes.length === 1) g.meshes[0].name = piece;
    } else {
      g.nodes.push({ name: piece, children: scene.nodes });
      scene.nodes = [g.nodes.length - 1];
    }
    for (const b of g.buffers) b.uri = `${rel}/${b.uri}`;
    for (const im of g.images ?? []) im.uri = `${rel}/${im.uri}`;
    fs.writeFileSync(path.join(work, `${piece}.gltf`), JSON.stringify(g));
    // Bare names, run from the work folder: Windows' command line holds 8191 characters.
    if (SIMPLIFY[piece]) {
      cli(['weld', `${piece}.gltf`, `${piece}.welded.glb`]);
      cli(['simplify', `${piece}.welded.glb`, `${piece}.glb`, '--ratio', String(SIMPLIFY[piece]), '--error', '0.01']);
      files.push(`${piece}.glb`);
    } else files.push(`${piece}.gltf`);
  }

  cli(['merge', ...files, 'merged.glb', '--merge-scenes']);
  cli([
    'optimize',
    'merged.glb',
    out,
    '--compress',
    'meshopt',
    '--texture-compress',
    'webp',
    '--texture-size',
    '1024',
    '--flatten',
    'false',
    '--join',
    'false',
    '--instance',
    'false',
    '--palette',
    'false',
    '--simplify',
    'false',
  ]);
  console.log(`wrote ${path.relative(process.cwd(), out)} (${(fs.statSync(out).size / 1e6).toFixed(2)} MB, ${pieces.length} pieces)`);
}
