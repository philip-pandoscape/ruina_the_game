import * as THREE from 'three';
import { loadGltf, loadModel, track } from '../assets';
import { NEW_LOOK } from '../look';
import { toon } from '../toon';
import type { RigDef } from '../../content/rig';
import { HERO_RIG } from '../../content/creatures/hero';
import { fit, hull, type Fitted } from './fit';
import { bakeCycle, setMotion, type Move } from './mocap';
import { bake, type Baked } from './retarget';
import { HERO_MOVES, HERO_MOVE_SETS, WEAPON_KEYS, type MoveClip } from './moves';
import { madeWeapons, type MadeWeapons } from './madeWeapons';

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
/**
 * Its moves (moves.ts): per weapon a set of clips from animation libraries, retargeted onto it, or
 * its keyframed swings. ?swordMoves=keyed|meshy|quaternius (clubMoves=, ...) plays another set.
 */
const SETS = Object.fromEntries(WEAPON_KEYS.map((w) => [w, params?.get(`${w}Moves`) ?? HERO_MOVE_SETS[w] ?? 'keyed']));
const MOVES = WEAPON_KEYS.flatMap((w, weapon) => (HERO_MOVES[w]?.[SETS[w]] ?? []).map((m, hit) => ({ weapon, hit, m }))).filter((x) => x.m) as Array<{ weapon: number; hit: number; m: MoveClip }>;

export interface MadeHero {
  fitted: Fitted;
  /** The hero rig measured to the body, with hidden parts for its bulk. */
  def: RigDef;
  /** The weapons it carries, made too (none that failed to load: the box hero's stand in). */
  weapons: MadeWeapons | null;
}

let loading: Promise<MadeHero | null> | null = null;
let ready: MadeHero | null = null;

/** The made hero body, once it has loaded (null until then, and for good without one). */
export const madeHeroNow = (): MadeHero | null => ready;

/** Loads and fits the made hero body (once); null in the classic look or without a model. */
export function madeHero(): Promise<MadeHero | null> | null {
  if (!NEW_LOOK || !URL) return null;
  const clips = !params?.has('heroModel') && WALK && RUN ? [track(loadGltf(WALK)), track(loadGltf(RUN))] : [];
  const files = params?.has('heroModel') ? [] : [...new Set(MOVES.map((x) => x.m.file))];
  const libraries = Promise.all(files.map((f) => (file(f) ? track(loadGltf(file(f)!)) : undefined)));
  loading ??= Promise.all([track(loadModel(URL)), madeWeapons(), libraries, ...clips]).then(([scene, made, loaded, walk, run]) => {
    if (!scene) return null;
    const weapons = (made as MadeWeapons | null) ?? null;
    const height = Number(params?.get('heroHeight')) || HEIGHT;
    const fitted = fit(scene as THREE.Group, height, HERO_RIG);
    // Shaded as the rest of the new look is: the painted texture, the island's soft toon light.
    const src = (Array.isArray(fitted.material) ? fitted.material[0] : fitted.material) as THREE.MeshStandardMaterial;
    fitted.material = toon(0xffffff, { map: src.map ?? null });
    const def: RigDef = { ...HERO_RIG, joints: fitted.joints, parts: hull(fitted.joints, fitted.feet.ankle), feet: fitted.feet, bow: weapons?.bow };
    const w = walk as { scene: THREE.Group; animations: THREE.AnimationClip[] } | undefined;
    const r = run as { scene: THREE.Group; animations: THREE.AnimationClip[] } | undefined;
    // ?heroGait=box keeps the box hero's gait on the made body, to compare.
    if (w?.animations[0] && r?.animations[0] && params?.get('heroGait') !== 'box') {
      def.gait = 'made';
      setMotion(def, {
        walk: bakeCycle(w.scene, w.animations[0], fitted.joints, fitted.bind, fitted.scale),
        run: bakeCycle(r.scene, r.animations[0], fitted.joints, fitted.bind, fitted.scale),
        moves: bakeMoves(files, loaded as Array<{ scene: THREE.Group; animations: THREE.AnimationClip[] } | undefined>, fitted),
      });
    }
    return (ready = { fitted, def, weapons });
  }) as Promise<MadeHero | null>;
  return loading;
}

/** The moves' clips, baked for the made body, by weapon and combo hit ("0:1"); a clip a move shares baked once. */
function bakeMoves(files: string[], loaded: Array<{ scene: THREE.Group; animations: THREE.AnimationClip[] } | undefined>, fitted: Fitted): Map<string, Move> {
  const moves = new Map<string, Move>();
  const baked = new Map<string, Baked>();
  for (const { weapon, hit, m } of MOVES) {
    const lib = loaded[files.indexOf(m.file)];
    if (!lib) continue;
    const key = JSON.stringify([m.file, m.parts, m.strikes ?? 1]);
    let clip = baked.get(key);
    if (!clip) baked.set(key, (clip = bake(lib.scene, lib.animations, m.parts, { joints: fitted.joints, bind: fitted.bind }, m.strikes ?? 1)));
    moves.set(`${weapon}:${hit}`, { clip, strike: clip.strikes[m.strike ?? 0] });
  }
  return moves;
}
