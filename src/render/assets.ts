import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { loader as files, want, type Wanted } from '../assets/loader';

// Files loaded after the world is up (ground textures, models), through the loader
// (src/assets/loader.ts), which fetches the most needed first. The world is drawn at once in its
// plain shapes and colours, and each piece is swapped in as it arrives; the tests wait for all of
// them (window.__game.assetsReady) before they look.

let pending = 0;
const failed: string[] = [];

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

/** Whether everything asked for has arrived (bar files waiting for the camera to come near them). */
export function assetsReady(): boolean {
  return pending === 0 && files.pending() === 0;
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const models = new Map<string, Promise<THREE.Group>>();

/** A glTF file from the manifest by id (`models/hero_walk`), animations and all, loaded once. */
export function gltf(id: string, wanted?: Wanted): Promise<GLTF> {
  return want(id, (url) => loader.loadAsync(url), wanted);
}

/** A model from the manifest by id (`models/well`), loaded once; every caller gets the same scene, to clone. */
export function model(id: string, wanted?: Wanted): Promise<THREE.Group> {
  return gltf(id, wanted).then((g) => g.scene);
}

/** A picture from the manifest by id (`ground/grass`), loaded once. */
export function picture(id: string, wanted?: Wanted): Promise<HTMLImageElement> {
  return want(id, (url) => new THREE.ImageLoader().loadAsync(url), wanted);
}

/** Loads a file by address whole, animations and all, for one not in the manifest (a developer's ?url=). */
export function loadGltf(url: string): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> {
  return loader.loadAsync(url);
}

/** Loads a model by address once (a developer's ?heroModel=); every caller gets the same scene, to clone. */
export function loadModel(url: string): Promise<THREE.Group> {
  let p = models.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((g) => g.scene);
    models.set(url, p);
  }
  return p;
}
