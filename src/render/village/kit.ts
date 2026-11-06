import * as THREE from 'three';
import { loadModel } from '../assets';
import { windowGlow } from '../models/glb';
import { toon } from '../toon';

// The village kit (src/render/assets/village/kit.glb and props.glb, packed by
// tools/models/village.mjs from Quaternius' Medieval Village MegaKit and Fantasy Props MegaKit):
// every piece and prop as plain geometry, one part per material, already in metres with its origin
// where the kit put it, and the game's own materials for each of the kits' trim sheets.
//
// Everything built from the kit carries an `aPart` attribute: which building it belongs to and
// which part of it (a storey, or the roof). While you are indoors, the materials drop that
// building's parts above your storey from the picture, so you look down into the room; the shadow
// pass draws them still, so the room stays in the shade of its roof.

// Under Node (tests importing the game's modules) there is no glob and the table is empty.
const urls = (typeof window !== 'undefined' ? import.meta.glob('../assets/village/*.glb', { query: '?url', import: 'default', eager: true }) : {}) as Record<string, string>;

/** Parts per building in `aPart`: storeys from 0, the roof last. */
export const PARTS = 8;
export const ROOF_PART = PARTS - 1;

/** The building drawn cut open (its index, -1 for none) and the highest part of it still drawn. */
export const cut = { building: { value: -1 }, part: { value: PARTS } };

/**
 * The light that fills a room you are in, instead of the sky's: under its roof the sky's blue and
 * the grass's green don't reach, and lamplight does (Village sets it by the hour).
 */
export const indoorAmbient = { value: new THREE.Color(0.62, 0.5, 0.4) };

export interface KitPart {
  geometry: THREE.BufferGeometry;
  /** The kit's material name (MI_Plaster, MI_WoodTrim, ...). */
  material: string;
}

export interface Kit {
  pieces: Map<string, KitPart[]>;
  /** The game's material for each of the kit's. */
  materials: Map<string, THREE.Material>;
  /** A piece's bounds, for fitting and placing. */
  bounds(piece: string): THREE.Box3;
}

/** Teaches a material to leave out the parts of a building above the storey you stand on. */
export function cuttable<T extends THREE.Material>(mat: T, key: string): T {
  const before = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    before.call(mat, shader, renderer);
    shader.uniforms.uCutBuilding = cut.building;
    shader.uniforms.uCutPart = cut.part;
    shader.uniforms.uIndoorAmbient = indoorAmbient;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPart;\nuniform float uCutBuilding;\nuniform float uCutPart;\nvarying float vIndoor;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          float cutB = floor((aPart + 0.5) / ${PARTS.toFixed(1)});
          float cutP = aPart - cutB * ${PARTS.toFixed(1)};
          vIndoor = abs(cutB - uCutBuilding) < 0.5 ? 1.0 : 0.0;
          if (vIndoor > 0.5 && cutP > uCutPart + 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        }`,
      );
    // The room you are in is filled with indoor light rather than the sky's.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uIndoorAmbient;\nvarying float vIndoor;')
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        reflectedLight.indirectDiffuse = mix(reflectedLight.indirectDiffuse, uIndoorAmbient * BRDF_Lambert(diffuseColor.rgb), vIndoor);`,
      );
  };
  const prev = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${prev()}|cut:${key}`;
  return mat;
}

/** The glass: faintly see-through by day; after dark, lit warm from within as seen from outside. */
function glassMaterial(): THREE.Material {
  const mat = toon(0x9fb3bf, { transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWindowGlow = windowGlow;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uWindowGlow;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.66, 0.32) * uWindowGlow * 2.4 * (gl_FrontFacing ? 1.0 : 0.25);
        diffuseColor.a = mix(diffuseColor.a, 0.9, uWindowGlow * (gl_FrontFacing ? 1.0 : 0.0));`,
      );
  };
  mat.customProgramCacheKey = () => 'village-glass';
  return cuttable(mat, 'glass');
}

/** The kit's materials each house tints its own way (TINTS), through its vertices. */
export const TINTED = ['MI_RoundTiles', 'MI_Plaster'];

/** The game's material for one of the kit's: its colour and relief maps under the island's light. */
function islandMaterial(src: THREE.MeshStandardMaterial, colored: boolean): THREE.Material {
  if (src.name === 'MI_WindowGlass') return glassMaterial();
  // The props' "_Vertex" trims are tinted per vertex, and so are each house's roof and plaster.
  const mat = toon(0xffffff, { map: src.map ?? null, normalMap: src.normalMap ?? null, side: THREE.DoubleSide, vertexColors: colored || TINTED.includes(src.name) });
  if (src.normalMap) mat.normalScale.copy(src.normalScale);
  if (src.name === 'MI_Vine') {
    mat.alphaTest = 0.5;
    mat.color.set(0x8fbf5a);
  }
  mat.name = src.name;
  return cuttable(mat, src.name);
}

/** Positions and normals as plain floats in the piece's own frame (meshopt keeps them quantized under a node scale). */
function baked(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv', 'color']) {
    const a = geometry.getAttribute(name);
    if (!a) continue;
    // Colours come as RGBA; the alpha is never used.
    const size = name === 'color' ? 3 : a.itemSize;
    const f = new Float32Array(a.count * size);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < size; k++) f[i * size + k] = a.getComponent(i, k);
    g.setAttribute(name, new THREE.BufferAttribute(f, size));
  }
  if (geometry.index) g.setIndex(Array.from(geometry.index.array));
  g.applyMatrix4(matrix);
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  return g;
}

let kit: Promise<Kit> | null = null;

/** Loads the kit and the props once, as one library. */
export function loadKit(): Promise<Kit> {
  if (kit) return kit;
  const files = ['kit', 'props'].map((f) => urls[`../assets/village/${f}.glb`]);
  if (files.some((u) => !u)) return (kit = Promise.reject(new Error('the village kit is missing (src/render/assets/village/kit.glb, props.glb)')));
  kit = Promise.all(files.map((u) => loadModel(u))).then((scenes) => {
    const pieces = new Map<string, KitPart[]>();
    const materials = new Map<string, THREE.Material>();
    const boxes = new Map<string, THREE.Box3>();
    for (const scene of scenes) scene.updateMatrixWorld(true);
    for (const node of scenes.flatMap((sc) => sc.children)) {
      const parts: KitPart[] = [];
      const box = new THREE.Box3();
      node.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const src = mesh.material as THREE.MeshStandardMaterial;
        if (!materials.has(src.name)) materials.set(src.name, islandMaterial(src, !!mesh.geometry.getAttribute('color')));
        // Every piece sits at the origin in the file, so all its node transform holds is meshopt's
        // dequantization (a scale and an offset), which the geometry keeps.
        const geometry = baked(mesh.geometry, mesh.matrixWorld);
        geometry.computeBoundingBox();
        box.union(geometry.boundingBox!);
        parts.push({ geometry, material: src.name });
      });
      pieces.set(node.name, parts);
      boxes.set(node.name, box);
    }
    return { pieces, materials, bounds: (p: string) => boxes.get(p)?.clone() ?? new THREE.Box3() };
  });
  return kit;
}
