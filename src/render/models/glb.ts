import * as THREE from 'three';
import { loadModel, track } from '../assets';
import { NEW_LOOK } from '../look';
import { toon } from '../toon';

// The new look's made models (src/render/assets/models: generated with Meshy from concept art
// painted after the island's reference picture, then compressed). Each stands in for a procedural
// model of the same id: the procedural one is drawn at once, and the made one replaces it when it
// has loaded, fitted into the same box (the rules' footprint), front to +Z, foot on the ground.

// Vite turns this into a table of file URLs; under Node (tests that import the game's modules)
// there is no glob and the table is empty.
const urls = (typeof window !== 'undefined' ? import.meta.glob('../assets/models/*.glb', { query: '?url', import: 'default', eager: true }) : {}) as Record<string, string>;

export interface MadeModel {
  /** Model files to pick from by seed, without the extension. */
  files: string[];
  /** The box it is fitted into (metres); missing sides come from the structure's data. */
  w?: number;
  h?: number;
  d?: number;
  /** Turn about Y (radians) before fitting, for a model whose front isn't +Z. */
  yaw?: number;
  /** How far it sinks into the ground, so it sits on a slope without a gap under it. */
  sink?: number;
  /** Children of the procedural model to keep (the windmill's turning sails). */
  keep?: string[];
  /** Its painted windows (warm and bright in the texture) light up after dark. */
  windows?: boolean;
}

/** How much the made buildings' windows glow: 0 by day, up to 1 at night (OpenStage.setTime). */
export const windowGlow = { value: 0 };

/** Structures with a made model, by id (shared/structures.json). */
export const MADE_STRUCTURES: Record<string, MadeModel> = {
  townhouse: { files: ['townhouse_red', 'townhouse_slate'], sink: 0.2, windows: true },
  inn: { files: ['inn'], sink: 0.2, windows: true },
  registrar: { files: ['registrar'], sink: 0.2, windows: true },
  tradingPost: { files: ['tradingPost'], sink: 0.2, windows: true },
  stable: { files: ['stable'], sink: 0.15 },
  workshop: { files: ['workshop'], sink: 0.2, windows: true },
  boathouse: { files: ['boathouse'], sink: 0.2 },
  lighthouse: { files: ['lighthouse'], w: 5.6, d: 5.6, sink: 0.3, keep: ['glow'] },
  windmill: { files: ['windmill'], w: 5.4, d: 5.4, h: 10.6, sink: 0.2, keep: ['sails'] },
  stall: { files: ['stall_red', 'stall_blue'], sink: 0.05 },
  well: { files: ['well'], sink: 0.1 },
  noticeBoard: { files: ['noticeBoard'], sink: 0.05 },
  workbench: { files: ['workbench'], sink: 0.03 },
  scarecrow: { files: ['scarecrow'], sink: 0.1 },
  oreNode: { files: ['oreNode'], sink: 0.2 },
  stoneNode: { files: ['stoneNode'], sink: 0.2 },
  timberNode: { files: ['timberNode'], sink: 0.1 },
  herbNode: { files: ['herbNode'], sink: 0.05 },
};

/** Props with a made model, by id: drawn many times over as one instanced mesh per kind. */
export const MADE_PROPS: Record<string, MadeModel> = {
  barrel: { files: ['barrel'], sink: 0.02 },
  crates: { files: ['crates'], sink: 0.02 },
  bench: { files: ['bench'], sink: 0.02 },
  lamp: { files: ['lamp'], sink: 0.05 },
  signpost: { files: ['signpost'], sink: 0.1 },
  haycart: { files: ['haycart'], sink: 0.02 },
  bollard: { files: ['bollard'], sink: 0.02 },
  fence: { files: ['fence'], sink: 0.08 },
  // The island's loose rocks (src/render/open/foliage.ts): the box of a rock at scale 1.
  boulderGranite: { files: ['boulder_granite'], w: 1.7, h: 1.15, d: 1.7, sink: 0.3 },
  boulderCoast: { files: ['boulder_coast'], w: 1.6, h: 1.3, d: 1.6, sink: 0.3 },
};

const materials = new Map<string, THREE.Material>();

/** The made model's own material, lit the way everything else on the island is. */
function islandMaterial(m: THREE.Material, windows: boolean): THREE.Material {
  const key = `${m.uuid}:${windows}`;
  let out = materials.get(key);
  if (!out) {
    const src = m as THREE.MeshStandardMaterial;
    const mat = toon(0xffffff, { map: src.map ?? null, side: THREE.DoubleSide });
    if (windows) litWindows(mat);
    materials.set(key, (out = mat));
  }
  return out;
}

/** After dark, the texture's warm bright panes (the concept art painted them lit) glow. */
function litWindows(mat: THREE.MeshToonMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWindowGlow = windowGlow;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uWindowGlow;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 t = diffuseColor.rgb;
          float warm = smoothstep(0.35, 0.6, t.r) * smoothstep(0.2, 0.42, t.g) * (1.0 - smoothstep(0.2, 0.42, t.b)) * smoothstep(1.8, 3.0, t.r / max(t.b, 0.02));
          totalEmissiveRadiance += vec3(1.0, 0.72, 0.38) * warm * uWindowGlow * 2.2;
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'made-windows';
}

/** A copy of the model turned, scaled into the box w x h x d, centred, its foot at y = -sink. */
export function fitted(scene: THREE.Object3D, made: MadeModel, w: number, h: number, d: number): THREE.Group {
  const model = scene.clone(true);
  model.rotation.y = made.yaw ?? 0;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const holder = new THREE.Group();
  holder.name = 'made';
  model.position.set(-centre.x, -box.min.y, -centre.z);
  const inner = new THREE.Group();
  inner.add(model);
  inner.scale.set(w / size.x, h / size.y, d / size.z);
  inner.position.y = -(made.sink ?? 0);
  holder.add(inner);
  holder.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const windows = made.windows ?? false;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => islandMaterial(m, windows)) : islandMaterial(mesh.material, windows);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
  return holder;
}

/**
 * Swaps a made model in for a procedural structure once it has loaded. `root` keeps its place in
 * the scene; only its children change.
 */
export function madeStructure(id: string, root: THREE.Object3D, box: { w: number; h: number; d: number }, seed = 1): void {
  if (!NEW_LOOK) return;
  const made = MADE_STRUCTURES[id];
  if (!made) return;
  const file = made.files[Math.abs(Math.floor(seed)) % made.files.length];
  const url = urls[`../assets/models/${file}.glb`];
  if (!url) return;
  track(
    loadModel(url).then((scene) => {
      const model = fitted(scene, made, made.w ?? box.w, made.h ?? box.h, made.d ?? box.d);
      for (const child of [...root.children]) if (!made.keep?.includes(child.name)) root.remove(child);
      root.add(model);
    }),
  );
}

/**
 * A made prop as one geometry and material, fitted into the box, for an instanced mesh. Null when
 * there is no made model for it (or in the classic look).
 */
export function madeProp(id: string, box: { w: number; h: number; d: number }): Promise<{ geometry: THREE.BufferGeometry; material: THREE.Material } | null> | null {
  if (!NEW_LOOK) return null;
  const made = MADE_PROPS[id];
  const url = made && urls[`../assets/models/${made.files[0]}.glb`];
  if (!made || !url) return null;
  return loadModel(url).then((scene) => {
    const model = fitted(scene, made, made.w ?? box.w, made.h ?? box.h, made.d ?? box.d);
    model.updateMatrixWorld(true);
    let found: { geometry: THREE.BufferGeometry; material: THREE.Material } | null = null;
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (found || !mesh.isMesh || Array.isArray(mesh.material)) return;
      found = { geometry: mesh.geometry.clone().applyMatrix4(mesh.matrixWorld), material: mesh.material };
    });
    return found;
  });
}
