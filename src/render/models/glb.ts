import { sceneOrigin } from '../origin';
import * as THREE from 'three';
import { asset } from '../../assets/manifest';
import type { MadeModel } from '../../content/looks';
import { model, trackPlaced } from '../assets';
import { toon } from '../toon';

// The made models (src/render/assets/models: generated with Meshy from concept art
// painted after the island's reference picture, then compressed). A thing's look names its made
// model and how it is fitted (content: src/content/looks.ts MadeModel): its body is drawn at once,
// and the made model replaces it when it has loaded, fitted into the same box (the rules'
// footprint), front to +Z, foot on the ground. They stream in nearest the camera first
// (src/assets/loader.ts).

/** The manifest's id for a made model's file, if the manifest has it (under Node it has none). */
const fileId = (file: string): string | null => (asset(`models/${file}`) ? `models/${file}` : null);

/** Where something stands, for the loader to fetch what's nearest first. */
const whereIs = (o: THREE.Object3D) => (): { x: number; z: number } => {
  o.updateWorldMatrix(true, false);
  // three.js's own coordinates are the scene's, shifted by its origin: back in the world's.
  const [ox, oz] = sceneOrigin();
  return { x: o.matrixWorld.elements[12] + ox, z: o.matrixWorld.elements[14] + oz };
};

/** How much windows glow: 0 by day, up to 1 at night (OpenStage.setTime; the village's glass reads it). */
export const windowGlow = { value: 0 };

/** The island's loose rocks (src/render/open/foliage.ts), made: each the box of a rock at scale 1. */
export const ROCKS = {
  granite: { files: ['boulder_granite'], w: 1.7, h: 1.15, d: 1.7, sink: 0.3 },
  coast: { files: ['boulder_coast'], w: 1.6, h: 1.3, d: 1.6, sink: 0.3 },
} satisfies Record<string, MadeModel>;

/**
 * Which of a made model's files a placement of it gets: the one painted nearest its tint in hue,
 * where its files have tints and the placement one; otherwise one picked by its seed.
 */
export function madeFile(made: MadeModel, seed = 1, tint?: number): string {
  const tints = made.tints;
  if (tint !== undefined && tints?.length === made.files.length) {
    const hsl = { h: 0, s: 0, l: 0 };
    const hue = (c: number) => new THREE.Color(c).getHSL(hsl).h;
    const want = hue(tint);
    const apart = (c: number) => {
      const d = Math.abs(hue(c) - want);
      return Math.min(d, 1 - d);
    };
    let best = 0;
    tints.forEach((t, i) => {
      if (apart(t) < apart(tints[best])) best = i;
    });
    return made.files[best];
  }
  return made.files[Math.abs(Math.floor(seed)) % made.files.length];
}

const materials = new Map<string, THREE.Material>();

/** The made model's own material, lit the way everything else on the island is. */
function gameMaterial(m: THREE.Material): THREE.Material {
  let out = materials.get(m.uuid);
  if (!out) {
    const src = m as THREE.MeshStandardMaterial;
    materials.set(m.uuid, (out = toon(0xffffff, { map: src.map ?? null, side: THREE.DoubleSide })));
  }
  return out;
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
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => gameMaterial(m)) : gameMaterial(mesh.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
  return holder;
}

/**
 * Swaps a made model (its `file`) in for a structure's body once it has loaded. `root` keeps its
 * place in the scene; only its children change.
 */
export function madeStructure(made: MadeModel, file: string, root: THREE.Object3D, box: { w: number; h: number; d: number }): void {
  const id = fileId(file);
  if (!id) return;
  trackPlaced(
    id,
    model(id, { need: 'near', at: whereIs(root) }).then((scene) => {
      const fit = fitted(scene, made, made.w ?? box.w, made.h ?? box.h, made.d ?? box.d);
      for (const child of [...root.children]) if (!made.keep?.includes(child.name)) root.remove(child);
      root.add(fit);
    }),
  );
}

/**
 * The geometry moved by a matrix into plain floats. The compressed models keep positions and
 * normals as normalized 16-bit numbers, which can't hold anything past -1..1: moving them in place
 * would clip a lamp post at a metre.
 */
export function baked(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const g = geometry.clone();
  for (const name of ['position', 'normal']) {
    const a = g.getAttribute(name);
    if (!a) continue;
    const f = new Float32Array(a.count * 3);
    for (let i = 0; i < a.count; i++) f.set([a.getX(i), a.getY(i), a.getZ(i)], i * 3);
    g.setAttribute(name, new THREE.BufferAttribute(f, 3));
  }
  return g.applyMatrix4(matrix);
}

/**
 * A made prop as one geometry and material, fitted into the box, for an instanced mesh. Null when
 * there is no made model (or, under Node, no file to load).
 */
export function madeProp(
  made: MadeModel | undefined,
  box: { w: number; h: number; d: number },
): Promise<{ geometry: THREE.BufferGeometry; material: THREE.Material } | null> | null {
  const file = made && fileId(made.files[0]);
  if (!made || !file) return null;
  // Props stand all over: wanted as near as can be.
  return model(file, { need: 'near' }).then((scene) => {
    const fit = fitted(scene, made, made.w ?? box.w, made.h ?? box.h, made.d ?? box.d);
    fit.updateMatrixWorld(true);
    let found: { geometry: THREE.BufferGeometry; material: THREE.Material } | null = null;
    fit.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (found || !mesh.isMesh || Array.isArray(mesh.material)) return;
      found = { geometry: baked(mesh.geometry, mesh.matrixWorld), material: mesh.material };
    });
    return found;
  });
}

/**
 * Swaps a made pack in for a pack's body once it has loaded: the same box, in the same place
 * against the carrier's back (the body's own bounds), so carrying, loading and stowing see no
 * difference.
 */
export function madePack(made: MadeModel | undefined, root: THREE.Object3D): void {
  const file = made && fileId(made.files[0]);
  if (!made || !file) return;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  trackPlaced(
    file,
    model(file, { need: 'near', at: whereIs(root) }).then((scene) => {
      const fit = fitted(scene, { ...made, sink: 0 }, size.x, size.y, size.z);
      fit.position.set(centre.x, box.min.y, centre.z);
      for (const child of [...root.children]) root.remove(child);
      root.add(fit);
    }),
  );
}
