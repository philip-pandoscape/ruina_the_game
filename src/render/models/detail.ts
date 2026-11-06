import * as THREE from 'three';
import { track } from '../assets';
import { GRAPHICS } from '../look';
import { toon } from '../toon';

// The grain of built things drawn in vertex colours (buildings, vehicles, docks, props, packs),
// above low quality (src/render/look.ts): each surface takes the grain its colour suggests: warm
// browns get wood planks, greys and stone colours get rubble stone, the rest (plaster, canvas,
// paint) a faint plaster tooth. Projected from three sides in world space, so no model needs
// texture coordinates. One texture holds all three, a channel each (CC0, Poly Haven:
// brown_planks_05, stone_wall, plastered_wall). Creatures keep the plain vertex-colour material.

/** Each channel's average, so the grain multiplies colours without darkening them on the whole. */
const MEAN = [0.771, 0.555, 0.638];
/** Grain repeats per metre: wood, stone, plaster. */
const SCALE = 0.55;

// Under Node (tests that import the game's modules) there is no Vite to hand out the file's URL.
const detailUrl = (
  typeof window !== 'undefined' ? Object.values(import.meta.glob('../assets/detail.jpg', { query: '?url', import: 'default', eager: true }))[0] : undefined
) as string | undefined;

let texture: THREE.Texture | null = null;

function detailTexture(): THREE.Texture {
  if (texture) return texture;
  const t = new THREE.Texture();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  if (detailUrl)
    track(
      new THREE.TextureLoader().loadAsync(detailUrl).then((loaded) => {
        t.image = loaded.image;
        t.needsUpdate = true;
      }),
    );
  return (texture = t);
}

const vertexHead = /* glsl */ `
  varying vec3 vDetailPos;
  varying vec3 vDetailNormal;
`;

const vertexBody = /* glsl */ `
  vDetailPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vDetailNormal = normalize(mat3(modelMatrix) * objectNormal);
`;

const fragmentHead = /* glsl */ `
  uniform sampler2D tDetail;
  uniform float uDetailOn;
  varying vec3 vDetailPos;
  varying vec3 vDetailNormal;
`;

const fragmentBody = /* glsl */ `
  #ifdef USE_COLOR
  {
    vec3 c = vColor.rgb;
    float hi = max(c.r, max(c.g, c.b));
    float lo = min(c.r, min(c.g, c.b));
    float sat = (hi - lo) / max(hi, 1e-3);
    // Warm and not too pale: wood. Grey and not too dark: stone. Anything else: plaster.
    float wood = smoothstep(0.18, 0.4, sat) * step(c.b, c.g) * step(c.g * 0.92, c.r) * (1.0 - smoothstep(0.55, 0.85, hi));
    float stone = (1.0 - smoothstep(0.1, 0.24, sat)) * smoothstep(0.03, 0.09, hi) * (1.0 - wood);
    vec3 n = normalize(vDetailNormal);
    vec3 w = pow(abs(n), vec3(4.0));
    w /= w.x + w.y + w.z;
    vec3 p = vDetailPos * ${SCALE.toFixed(2)};
    vec3 t = texture2D(tDetail, p.zy).rgb * w.x + texture2D(tDetail, p.xz).rgb * w.y + texture2D(tDetail, p.xy).rgb * w.z;
    t /= vec3(${MEAN.map((m) => m.toFixed(3)).join(', ')});
    float d = mix(mix(1.0 + (t.b - 1.0) * 0.45, t.g, stone), t.r, wood);
    diffuseColor.rgb *= mix(1.0, d, 0.75 * uDetailOn);
  }
  #endif
`;

function withGrain(material: THREE.MeshToonMaterial): THREE.MeshToonMaterial {
  const uniforms = { tDetail: { value: detailTexture() }, uDetailOn: { value: 1 } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexHead}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n${vertexBody}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentHead}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${fragmentBody}`);
  };
  material.customProgramCacheKey = () => `grain:${material.side}`;
  return material;
}

let built: THREE.MeshToonMaterial | null = null;
let builtCloth: THREE.MeshToonMaterial | null = null;

/** Vertex colours with the grain of what they're made of; at low quality just vertex colours. */
export function grainMaterial(plain: THREE.MeshToonMaterial): THREE.MeshToonMaterial {
  if (!GRAPHICS.grain) return plain;
  if (plain.side === THREE.DoubleSide) return (builtCloth ??= withGrain(toon(0xffffff, { vertexColors: true, side: THREE.DoubleSide })));
  return (built ??= withGrain(toon(0xffffff, { vertexColors: true })));
}

/** Gives a built model (not a creature) the grain: its plain vertex-colour meshes take the grain material. */
export function grainify(root: THREE.Object3D): void {
  if (!GRAPHICS.grain) return;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.Material;
    if (mat instanceof THREE.MeshToonMaterial && mat.vertexColors && !mat.map && mat !== built && mat !== builtCloth) m.material = grainMaterial(mat);
  });
}
