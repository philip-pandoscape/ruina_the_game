import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// Files the new look loads after the world is up (ground textures, models). The world is drawn
// at once in its plain shapes and colours, and each piece is swapped in as it arrives; the tests
// wait for all of them (window.__game.assetsReady) before they look.

let pending = 0;
let failed: string[] = [];

/** Counts a load until it settles. A failure is logged and remembered, never thrown at the game. */
export function track<T>(load: Promise<T>): Promise<T | undefined> {
  pending++;
  return load
    .catch((e: unknown) => {
      failed.push(String(e));
      console.warn('asset failed to load', e);
      return undefined;
    })
    .finally(() => {
      pending--;
    });
}

export function assetsReady(): boolean {
  return pending === 0;
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const models = new Map<string, Promise<THREE.Group>>();

/** Loads a file whole, animations and all (once), for a captured motion rather than a model. */
export function loadGltf(url: string): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> {
  return loader.loadAsync(url);
}

/** Loads a model once; every caller gets the same scene, to clone. */
export function loadModel(url: string): Promise<THREE.Group> {
  let p = models.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((gltf) => gltf.scene);
    models.set(url, p);
  }
  return p;
}
