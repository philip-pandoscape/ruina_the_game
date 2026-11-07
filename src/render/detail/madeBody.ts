import * as THREE from 'three';
import { asset } from '../../assets/manifest';
import type { Wanted } from '../../assets/loader';
import type { RigDef } from '../../content/rig';
import { loadModel, model, track, trackPlaced } from '../assets';
import { HERO_RIG } from '../creatures/heroBody';
import { toon } from '../toon';
import { fit, hull, type Fitted } from './fit';

// A made, rigged body (a model with a humanoid skeleton: Meshy's, Tripo's, Mixamo's) worn on the
// hero's rig: the rig measured to it and its skin moved onto our joints (fit.ts), painted as the
// rest of the world is. The hero wears one (madeHero.ts), and so may any townsperson
// (src/render/models/villagers.ts); a body is loaded and fitted once for every one who wears it.

export interface WornBody {
  fitted: Fitted;
  /** The hero rig measured to the body, with hidden parts for its bulk. */
  def: RigDef;
}

/**
 * Fits the hero's rig to a loaded body standing `height` metres tall, turned `yaw` radians about
 * the vertical first (a model whose front isn't +Z). Throws on a body it can't wear (no skinned
 * mesh, a bone missing: fit.ts readBody).
 */
export function fitBody(scene: THREE.Object3D, height: number, yaw = 0): WornBody {
  let fitted: Fitted;
  if (yaw) {
    // Turned in a holder of its own, so a scene other bodies share is left as it was.
    const parent = scene.parent;
    const turn = new THREE.Group();
    turn.rotation.y = yaw;
    turn.add(scene);
    try {
      fitted = fit(turn, height, HERO_RIG);
    } finally {
      turn.remove(scene);
      parent?.add(scene);
    }
  } else fitted = fit(scene, height, HERO_RIG);
  // Shaded as the rest of the world is: the painted texture in its soft light.
  const src = (Array.isArray(fitted.material) ? fitted.material[0] : fitted.material) as THREE.MeshStandardMaterial;
  fitted.material = toon(0xffffff, { map: src.map ?? null });
  return { fitted, def: { ...HERO_RIG, joints: fitted.joints, parts: hull(fitted.joints, fitted.feet.ankle), feet: fitted.feet } };
}

/** Where a body comes from: a file of the game's by name (`npc_mara`), or a developer's address. */
const isAddress = (source: string): boolean => /[/:]/.test(source);

const loads = new Map<string, Promise<WornBody | null>>();
const ready = new Map<string, WornBody | null>();
const keyOf = (source: string, height: number, yaw: number) => `${source}|${height}|${yaw}`;

/** A body already loaded and fitted (null for one that failed), or undefined while it isn't yet. */
export function madeBodyNow(source: string, height: number, yaw = 0): WornBody | null | undefined {
  return ready.get(keyOf(source, height, yaw));
}

/**
 * Loads a made body (a file in src/render/assets/models by name, or by address) and fits it at
 * `height` metres, once; null without the file (under Node there are no files) and, once it has
 * failed to load or fit, for good. `wanted` is how much it's needed and where it stands, for the
 * loader (src/assets/loader.ts); one placed in the world doesn't hold the tests up while it waits
 * for the camera to come near.
 */
export function madeBody(source: string, height: number, yaw = 0, wanted?: Wanted): Promise<WornBody | null> | null {
  const address = isAddress(source);
  const id = `models/${source}`;
  if (!address && !asset(id)) return null;
  const key = keyOf(source, height, yaw);
  let load = loads.get(key);
  if (!load) {
    const scene = address ? loadModel(source) : model(id, wanted);
    const fitted = scene.then((s) => fitBody(s, height, yaw));
    const counted = wanted?.at && !address ? trackPlaced(id, fitted) : track(fitted);
    load = counted.then((b) => {
      ready.set(key, b ?? null);
      return b ?? null;
    });
    loads.set(key, load);
  }
  return load;
}
