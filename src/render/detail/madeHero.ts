import * as THREE from 'three';
import { loadGltf, loadModel, track } from '../assets';
import { NEW_LOOK } from '../look';
import { toon } from '../toon';
import type { RigDef } from '../../content/rig';
import { HERO_RIG } from '../../content/creatures/hero';
import { fit, hull, type Fitted } from './fit';
import { bakeCycle, setMotion } from './mocap';

// The new look's hero body: a made, rigged model (src/render/assets/models/hero.glb, from Meshy)
// worn on the hero rig, the rig measured to it (fit.ts). Fitted once; every hero wears the same
// one. The classic look, and a game without the file, keep the box hero.

const HEIGHT = 1.78;

// Vite turns this into a file URL; under Node there is no glob and no made hero.
const urls = (typeof window !== 'undefined' ? import.meta.glob('../assets/models/hero*.glb', { query: '?url', import: 'default', eager: true }) : {}) as Record<string, string>;
const file = (name: string): string | null => Object.entries(urls).find(([k]) => k.endsWith(`/${name}.glb`))?.[1] ?? null;
/** Trying another body without shipping it: ?heroModel=/path/to/model.glb (and &heroHeight=1.7). */
const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const URL = params?.get('heroModel') ?? file('hero');
/** Its captured walk and run (Meshy's, on the same skeleton), which move its upper body. */
const WALK = file('hero_walk');
const RUN = file('hero_run');

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
  const clips = !params?.has('heroModel') && WALK && RUN ? [track(loadGltf(WALK)), track(loadGltf(RUN))] : [];
  loading ??= Promise.all([track(loadModel(URL)), ...clips]).then(([scene, walk, run]) => {
    if (!scene) return null;
    const height = Number(params?.get('heroHeight')) || HEIGHT;
    const fitted = fit(scene as THREE.Group, height, HERO_RIG);
    // Shaded as the rest of the new look is: the painted texture, the island's soft toon light.
    const src = (Array.isArray(fitted.material) ? fitted.material[0] : fitted.material) as THREE.MeshStandardMaterial;
    fitted.material = toon(0xffffff, { map: src.map ?? null });
    const def: RigDef = { ...HERO_RIG, joints: fitted.joints, parts: hull(fitted.joints, fitted.feet.ankle), feet: fitted.feet };
    const w = walk as { scene: THREE.Group; animations: THREE.AnimationClip[] } | undefined;
    const r = run as { scene: THREE.Group; animations: THREE.AnimationClip[] } | undefined;
    // ?heroGait=box keeps the box hero's gait on the made body, to compare.
    if (w?.animations[0] && r?.animations[0] && params?.get('heroGait') !== 'box') {
      def.gait = 'made';
      setMotion(def, {
        walk: bakeCycle(w.scene, w.animations[0], fitted.joints, fitted.bind, fitted.scale),
        run: bakeCycle(r.scene, r.animations[0], fitted.joints, fitted.bind, fitted.scale),
      });
    }
    return (ready = { fitted, def });
  }) as Promise<MadeHero | null>;
  return loading;
}
