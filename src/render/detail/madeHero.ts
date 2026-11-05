import * as THREE from 'three';
import { loadModel, track } from '../assets';
import { NEW_LOOK } from '../look';
import { toon } from '../toon';
import type { RigDef } from '../../content/rig';
import { HERO_RIG } from '../../content/creatures/hero';
import { fit, hull, type Fitted } from './fit';

// The new look's hero body: a made, rigged model (src/render/assets/models/hero.glb, from Meshy)
// worn on the hero rig, the rig measured to it (fit.ts). Fitted once; every hero wears the same
// one. The classic look, and a game without the file, keep the box hero.

const HEIGHT = 1.78;

// Vite turns this into a file URL; under Node there is no glob and no made hero.
const urls = (typeof window !== 'undefined' ? import.meta.glob('../assets/models/hero.glb', { query: '?url', import: 'default', eager: true }) : {}) as Record<string, string>;
/** Trying another body without shipping it: ?heroModel=/path/to/model.glb (and &heroHeight=1.7). */
const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const URL = params?.get('heroModel') ?? Object.values(urls)[0] ?? null;

export interface MadeHero {
  fitted: Fitted;
  /** The hero rig measured to the body, with hidden parts for its bulk. */
  def: RigDef;
}

let loading: Promise<MadeHero | null> | null = null;
let ready: MadeHero | null = null;

/** The made hero body, once it has loaded (null until then, and for good without one). */
export const madeHeroNow = (): MadeHero | null => ready;

/** Loads and fits the made hero body (once); null in the classic look or without a model. */
export function madeHero(): Promise<MadeHero | null> | null {
  if (!NEW_LOOK || !URL) return null;
  loading ??= track(loadModel(URL)).then((scene) => {
    if (!scene) return null;
    const fitted = fit(scene, Number(params?.get('heroHeight')) || HEIGHT, HERO_RIG);
    // Shaded as the rest of the new look is: the painted texture, the island's soft toon light.
    const src = (Array.isArray(fitted.material) ? fitted.material[0] : fitted.material) as THREE.MeshStandardMaterial;
    fitted.material = toon(0xffffff, { map: src.map ?? null });
    const def: RigDef = { ...HERO_RIG, joints: fitted.joints, parts: hull(fitted.joints, fitted.feet.ankle), feet: fitted.feet };
    return (ready = { fitted, def });
  }) as Promise<MadeHero | null>;
  return loading;
}
