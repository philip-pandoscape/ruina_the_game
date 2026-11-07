import * as THREE from 'three';
import { asset } from '../../assets/manifest';
import { gltf, track } from '../assets';
import type { RigDef } from '../../content/rig';
import type { Fitted } from './fit';
import { madeBody } from './madeBody';
import { bakeCycle, setMotion, type Move } from './mocap';
import { bake, type Baked } from './retarget';
import { HERO_MOVES, HERO_MOVE_SETS, type MoveClip } from './moves';
import { madeWeapons, type MadeWeapons } from './madeWeapons';

// The hero's body: a made, rigged model (src/render/assets/models/hero.glb, from Meshy) worn on the
// hero rig, the rig measured to it (madeBody.ts, fit.ts). Fitted once; every hero wears the same
// one. Until it has loaded, and for good if it can't, the box hero stands in.

const HEIGHT = 1.78;

// Its files, by id in the asset manifest (src/assets/catalog.ts): part of the title screen's first
// download, as character select shows the hero. Under Node there are no files and no made hero.
const file = (name: string): string | null => (asset(`models/${name}`) ? `models/${name}` : null);
const FRONT = { need: 'front' } as const;
/** Trying another body without shipping it: ?heroModel=/path/to/model.glb (and &heroHeight=1.7). */
const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const TRIED = params?.get('heroModel') ?? null;
const BODY = file('hero');
/** Its captured walk and run (Meshy's, on the same skeleton), which move its upper body. */
const WALK = file('hero_walk');
const RUN = file('hero_run');
/**
 * Its moves (moves.ts): per weapon (by id) a set of clips from animation libraries, retargeted onto
 * it, or its keyframed swings. ?swordMoves=keyed|meshy|quaternius (clubMoves=, ...) plays another set.
 */
const MOVES = Object.entries(HERO_MOVES)
  .flatMap(([weapon, sets]) => (sets[params?.get(`${weapon}Moves`) ?? HERO_MOVE_SETS[weapon] ?? 'keyed'] ?? []).map((m, hit) => ({ weapon, hit, m })))
  .filter((x) => x.m) as Array<{
  weapon: string;
  hit: number;
  m: MoveClip;
}>;

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

/** Loads and fits the made hero body (once); null without a model. */
export function madeHero(): Promise<MadeHero | null> | null {
  if (!TRIED && !BODY) return null;
  const clips = !TRIED && WALK && RUN ? [track(gltf(WALK, FRONT)), track(gltf(RUN, FRONT))] : [];
  const files = TRIED ? [] : [...new Set(MOVES.map((x) => x.m.file))];
  const libraries = Promise.all(files.map((f) => (file(f) ? track(gltf(file(f)!, FRONT)) : undefined)));
  const height = Number(params?.get('heroHeight')) || HEIGHT;
  const body = madeBody(TRIED ?? 'hero', height, 0, FRONT);
  loading ??= Promise.all([body, madeWeapons(), libraries, ...clips]).then(([worn, made, loaded, walk, run]) => {
    if (!worn) return null;
    const weapons = (made as MadeWeapons | null) ?? null;
    const { fitted } = worn;
    const def: RigDef = { ...worn.def, bow: weapons?.bow };
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

/** The moves' clips, baked for the made body, by weapon id and combo hit ("sword:1"); a clip a move shares baked once. */
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
