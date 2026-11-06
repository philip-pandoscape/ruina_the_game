import * as THREE from 'three';
import { asset } from '../../assets/manifest';
import { loadModel, model, track } from '../assets';
import { baked } from '../models/glb';
import type { BowString } from '../../content/rig';
import type { DetailRig } from './rig';

// The hero's weapons: made models (src/render/assets/models/weapon_*.glb) in the made hero's
// hands in place of the box hero's. Each goes where the box hero's went - its grip at the hand, the
// weapon down the hand's -Y, as long - so reaches, trails and stowing work as they did. The bow's
// limbs run along the hand's Z with the string's side toward +Y; its string is the game's own, to
// be drawn back, so the model's was cut off (tools/models/weaponprep.mjs).

export type WeaponName = 'sword' | 'club' | 'staff' | 'bow';

/** A long weapon as it comes, lengthwise along the model's Y. */
interface Long {
  /** The end of the model's Y that strikes (the blade's point, the club's head, the orb): 1 the top. */
  tip: 1 | -1;
  /** End to end in the hand, metres. */
  length: number;
  /** Where the hand closes round it, from the butt (0) to the tip (1). */
  grip: number;
}

// Measured off the models: the sword's grip between its guard and pommel, the club's leather
// wrap. The staff is held where the box hero holds its own, a third of the way up.
const LONG: Record<Exclude<WeaponName, 'bow'>, Long> = {
  sword: { tip: -1, length: 1.24, grip: 0.153 },
  club: { tip: 1, length: 0.74, grip: 0.15 },
  staff: { tip: 1, length: 1.79, grip: 0.28 },
};

/**
 * The bow as it comes: its limbs along the model's Y, bending toward its +X, where the string was
 * tied; the middle of its grip and the string's line at the tips, along the model's X. Tip to tip
 * in the hand, metres.
 */
const BOW = { gripX: -0.056, stringX: 0.062, length: 1.2 };

/** How much of the sky's and the ground's light steel and gold give back. */
const SHINE = 1.6;

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;

/** The made weapons, each fitted into its attachment's space, and the made bow's string. */
export interface MadeWeapons {
  parts: Partial<Record<WeaponName, Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }>>>;
  bow?: BowString;
}

let loading: Promise<MadeWeapons> | null = null;

/**
 * Loads and fits the made weapons (once); null with ?heroWeapons=box (the box hero's, to
 * compare). Trying another model without shipping it: ?sword=/path/model.glb,tip,grip
 * (tip 1 if it points up; grip as in LONG).
 */
export function madeWeapons(): Promise<MadeWeapons> | null {
  if (params?.get('heroWeapons') === 'box') return null;
  loading ??= (async () => {
    const out: MadeWeapons = { parts: {} };
    const names: WeaponName[] = ['sword', 'club', 'staff', 'bow'];
    await Promise.all(
      names.map(async (name) => {
        const [tried, tip, grip] = (params?.get(name) ?? '').split(',');
        // Part of the title screen's first download: character select's hero holds one (under Node there are no files).
        const id = `models/weapon_${name}`;
        if (!tried && !asset(id)) return;
        const scene = await track(tried ? loadModel(tried) : model(id, { need: 'front' }));
        if (!scene) return;
        if (name === 'bow') {
          const { parts, string } = fitBow(scene);
          out.parts.bow = parts;
          out.bow = string;
        } else {
          const f = tried ? ({ ...LONG[name], tip: Number(tip) < 0 ? -1 : 1, grip: Number(grip) || LONG[name].grip } as Long) : LONG[name];
          out.parts[name] = fitLong(scene, f);
        }
      }),
    );
    return out;
  })();
  return loading;
}

/** Puts the made weapons in a rig's attachments in place of its own, keeping the bow's string. */
export function dressWeapons(rig: DetailRig, weapons: MadeWeapons): void {
  const strings = new Set(rig.built.filter((b) => b.mat === 'string').map((b) => b.mesh));
  for (const [name, parts] of Object.entries(weapons.parts)) {
    const g = rig.attachment(name);
    for (const child of [...g.children]) if (!strings.has(child as THREE.Mesh)) g.remove(child);
    for (const p of parts) {
      const mesh = new THREE.Mesh(p.geometry, p.material);
      mesh.castShadow = true;
      g.add(mesh);
    }
  }
}

/** Every mesh in a model, baked into one space by `fit` (model to hand), with its weapon material. */
function bake(scene: THREE.Object3D, fit: THREE.Matrix4): Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }> {
  const parts: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }> = [];
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const geometry = baked(mesh.geometry, new THREE.Matrix4().multiplyMatrices(fit, mesh.matrixWorld));
    parts.push({ geometry, material: weaponMaterial(mesh.material) });
  });
  return parts;
}

/** The model's bounds, its meshes' points as they stand (meshopt keeps them scaled into nodes). */
function bounds(scene: THREE.Object3D): THREE.Box3 {
  scene.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(scene, true);
}

function fitLong(scene: THREE.Object3D, f: Long): Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }> {
  const box = bounds(scene);
  const height = box.max.y - box.min.y;
  const butt = f.tip > 0 ? box.min.y : box.max.y;
  const grip = new THREE.Vector3((box.min.x + box.max.x) / 2, butt + f.tip * f.grip * height, (box.min.z + box.max.z) / 2);
  // The grip to the hand, scaled to length, turned tip-down if it came up (about Z, which keeps a
  // blade's flats facing the way they did).
  const fit = new THREE.Matrix4().makeScale(f.length / height, f.length / height, f.length / height);
  if (f.tip > 0) fit.multiply(new THREE.Matrix4().makeRotationZ(Math.PI));
  fit.multiply(new THREE.Matrix4().makeTranslation(-grip.x, -grip.y, -grip.z));
  return bake(scene, fit);
}

function fitBow(scene: THREE.Object3D): { parts: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }>; string: BowString } {
  const box = bounds(scene);
  const s = BOW.length / (box.max.y - box.min.y);
  const midY = (box.min.y + box.max.y) / 2;
  const midZ = (box.min.z + box.max.z) / 2;
  // The model's X (toward the string) to the hand's Y, its Y (along the limbs) to the hand's Z, its
  // Z to the hand's X; the grip at the hand.
  const fit = new THREE.Matrix4()
    .makeBasis(new THREE.Vector3(0, s, 0), new THREE.Vector3(0, 0, s), new THREE.Vector3(s, 0, 0))
    .multiply(new THREE.Matrix4().makeTranslation(-BOW.gripX, -midY, -midZ));
  const brace = (BOW.stringX - BOW.gripX) * s;
  // Tied a little in from the very ends, in the tips' notches.
  const half = BOW.length / 2 - 0.012;
  return {
    parts: bake(scene, fit),
    string: {
      nock: [0, brace, 0],
      tips: [
        [0, brace, half],
        [0, brace, -half],
      ],
      arrowNock: 0.3,
      maxDraw: 0.72,
    },
  };
}

const materials = new Map<THREE.Material, THREE.Material>();

/**
 * The model's own material, its metal catching the island's light: the sun's glint, and where
 * steel or gold faces up or down, the sky's colour or the ground's brightness - the hemisphere
 * light's, so it dims at night with everything else. The ground's brightness, not its colour: steel
 * giving back Emberholm's grass all along its side read as a green blade.
 */
function weaponMaterial(m: THREE.Material): THREE.Material {
  let out = materials.get(m);
  if (out) return out;
  const mat = (m as THREE.MeshStandardMaterial).clone();
  mat.side = THREE.FrontSide;
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_maps>',
      /* glsl */ `#include <lights_fragment_maps>
      #if defined( RE_IndirectSpecular ) && NUM_HEMI_LIGHTS > 0
        {
          vec3 r = reflect( - geometryViewDir, geometryNormal );
          float up = smoothstep( -0.6, 0.3, dot( r, hemisphereLights[ 0 ].direction ) );
          vec3 below = vec3( dot( hemisphereLights[ 0 ].groundColor, vec3( 0.299, 0.587, 0.114 ) ) );
          radiance += mix( below, hemisphereLights[ 0 ].skyColor, up ) * ( ${SHINE.toFixed(2)} * RECIPROCAL_PI );
        }
      #endif`,
    );
  };
  mat.customProgramCacheKey = () => 'weaponShine';
  materials.set(m, (out = mat));
  return out;
}
