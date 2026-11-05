import * as THREE from 'three';
import { track } from '../assets';
import { toon } from '../toon';

// The new look's trees: the wind's clock, the trunks' bark (CC0, Poly Haven: bark_brown_02,
// pine_bark) and the material for a tree's solid parts. The crowns are src/render/open/canopy.ts.

/** The wind's clock for the swaying crowns (seconds), advanced by OpenStage. */
export const foliageTime = { value: 0 };

// Vite hands out the bark files' URLs; under Node (tests that import the game's modules) there are none.
const barkUrls = (typeof window !== 'undefined' ? import.meta.glob('../assets/bark_*.jpg', { query: '?url', import: 'default', eager: true }) : {}) as Record<string, string>;
const barks = new Map<string, THREE.Texture>();

/** Bark for trunks: wraps once and a half round, repeats every two metres up. */
export function barkTexture(kind: 'broadleaf' | 'pine'): THREE.Texture {
  let t = barks.get(kind);
  if (t) return t;
  const tex = new THREE.Texture();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1.5, kind === 'pine' ? 5 : 3);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const url = barkUrls[`../assets/bark_${kind}.jpg`];
  if (url)
    track(
      new THREE.TextureLoader().loadAsync(url).then((loaded) => {
        tex.image = loaded.image;
        tex.needsUpdate = true;
      }),
    );
  barks.set(kind, (t = tex));
  return t;
}

const DISSOLVE = /* glsl */ `
  {
    // Next to the camera, dissolve (a dither, so no sorting) rather than fill the screen.
    float near = smoothstep(1.2, 3.6, length(vViewPosition));
    float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (dither > near) discard;
  }
`;

/** A tree's solid parts (trunks): vertex colours over a bark texture, dissolving near the camera. */
export function solidMaterial(map: THREE.Texture | null = null): THREE.MeshToonMaterial {
  const mat = toon(0xffffff, { vertexColors: true, map });
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${DISSOLVE}`);
  };
  mat.customProgramCacheKey = () => `tree-solid:${map ? map.uuid : ''}`;
  return mat;
}
