import * as THREE from 'three';
import { asset } from '../../assets/manifest';
import { SURFACE } from '../../engine/zone';
import { picture, track } from '../assets';
import { followOrigin, fract, repeatShift } from '../origin';

// The ground: real textures (CC0, CREDITS.md) laid over the island's surfaces. Each
// texture brings only its detail, its own average colour divided out, so the palette in
// src/render/look.ts still decides the colours and textures from different sources sit together.
// Steep slopes turn to rock whatever their surface, projected from three sides so cliffs don't
// smear. Until the textures arrive, and at low quality without them, the ground is drawn in its
// plain colours. The textures are laid in the world: drawn from positions relative to the scene's
// origin, shifted by what the origin is worth in repeats (src/render/origin.ts), so they stay put as
// it moves and keep their precision far from the world's origin.

const LAYERS = ['grass', 'road', 'sand', 'rock', 'soil', 'plaza', 'forest'] as const;
/** Texture repeats per metre, per surface. */
const SCALE: Record<(typeof LAYERS)[number], number> = { grass: 1 / 4.5, road: 1 / 3.5, sand: 1 / 4, rock: 1 / 9, soil: 1 / 3, plaza: 1 / 2.6, forest: 1 / 4 };
const COLOR_SIZE = 1024;
const NORMAL_SIZE = 512;

if (LAYERS.some((l, i) => SURFACE[l] !== i)) throw new Error('ground layers out of SURFACE order');

const toLinear = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/**
 * Stacks one image per surface into an array texture; with `means`, also each one's average linear
 * colour. The ground is under everything, so its textures come before what stands on it.
 */
async function stack(names: string[], size: number, srgb: boolean, means?: THREE.Vector3[]): Promise<THREE.DataArrayTexture> {
  const images = await Promise.all(names.map((n) => picture(`ground/${n}`, { need: 'zone' })));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const data = new Uint8Array(size * size * 4 * images.length);
  images.forEach((img, layer) => {
    ctx.drawImage(img, 0, 0, size, size);
    const px = ctx.getImageData(0, 0, size, size).data;
    data.set(px, layer * size * size * 4);
    if (means) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < px.length; i += 16) {
        r += toLinear[px[i]];
        g += toLinear[px[i + 1]];
        b += toLinear[px[i + 2]];
      }
      const n = px.length / 16;
      means[layer] = new THREE.Vector3(r / n, g / n, b / n);
    }
  });
  const tex = new THREE.DataArrayTexture(data, size, size, images.length);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function placeholder(): THREE.DataArrayTexture {
  const data = new Uint8Array(4 * LAYERS.length).fill(255);
  const tex = new THREE.DataArrayTexture(data, 1, 1, LAYERS.length);
  tex.needsUpdate = true;
  return tex;
}

const vertexHead = /* glsl */ `
  attribute vec4 splatA;
  attribute vec4 splatB;
  varying vec4 vSplatA;
  varying vec4 vSplatB;
  varying vec3 vGroundPos;
  varying vec3 vGroundNormal;
`;

const vertexBody = /* glsl */ `
  vSplatA = splatA;
  vSplatB = splatB;
  vGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vGroundNormal = normalize(mat3(modelMatrix) * objectNormal);
`;

const fragmentHead = /* glsl */ `
  uniform sampler2DArray tGround;
  uniform sampler2DArray tGroundN;
  uniform vec3 uGroundMean[${LAYERS.length}];
  uniform float uGroundScale[${LAYERS.length}];
  uniform float uGroundOn;
  uniform vec3 uRockTint;
  // Where the scene's origin stands in each surface's repeats: the second, turned grass sample's too.
  uniform vec2 uGroundShift[${LAYERS.length}];
  uniform vec2 uGrassShift[${LAYERS.length}];
  varying vec4 vSplatA;
  varying vec4 vSplatB;
  varying vec3 vGroundPos;
  varying vec3 vGroundNormal;

  // Set in the colour step, used again for the normal.
  vec3 groundNormalW;
`;

// Replaces three's vertex-colour step: the surfaces' textures, blended by weight, each one's detail
// on top of the vertex colour (the palette).
const fragmentColor = /* glsl */ `
  {
    vec3 N = normalize(vGroundNormal);
    float w[${LAYERS.length}] = float[${LAYERS.length}](vSplatA.x, vSplatA.y, vSplatA.z, vSplatA.w, vSplatB.x, vSplatB.y, vSplatB.z);
    float steep = smoothstep(0.82, 0.64, N.y);
    for (int i = 0; i < ${LAYERS.length}; i++) w[i] *= 1.0 - steep;
    w[3] += steep;
    vec2 base = vGroundPos.xz;
    vec2 bdx = dFdx(base);
    vec2 bdy = dFdy(base);
    vec3 pdx = dFdx(vGroundPos);
    vec3 pdy = dFdy(vGroundPos);
    vec3 tri = pow(abs(N), vec3(4.0));
    tri /= tri.x + tri.y + tri.z;
    vec3 detail = vec3(0.0);
    vec3 bend = vec3(0.0);
    float total = 0.0;
    for (int i = 0; i < ${LAYERS.length}; i++) {
      if (w[i] < 0.02) continue;
      float s = uGroundScale[i];
      vec3 c;
      vec3 b;
      if (i == 3) {
        // Rock: from above and from both sides, so cliffs keep their grain.
        vec2 sh = uGroundShift[3];
        vec2 uvY = vGroundPos.xz * s + sh;
        vec2 uvZ = vGroundPos.xy * s + vec2(sh.x, 0.0);
        vec2 uvX = vGroundPos.zy * s + vec2(sh.y, 0.0);
        c = textureGrad(tGround, vec3(uvY, 3.0), pdx.xz * s, pdy.xz * s).rgb * tri.y
          + textureGrad(tGround, vec3(uvZ, 3.0), pdx.xy * s, pdy.xy * s).rgb * tri.z
          + textureGrad(tGround, vec3(uvX, 3.0), pdx.zy * s, pdy.zy * s).rgb * tri.x;
        vec2 nY = textureGrad(tGroundN, vec3(uvY, 3.0), pdx.xz * s, pdy.xz * s).xy * 2.0 - 1.0;
        vec2 nZ = textureGrad(tGroundN, vec3(uvZ, 3.0), pdx.xy * s, pdy.xy * s).xy * 2.0 - 1.0;
        vec2 nX = textureGrad(tGroundN, vec3(uvX, 3.0), pdx.zy * s, pdy.zy * s).xy * 2.0 - 1.0;
        b = vec3(nY.x, 0.0, -nY.y) * tri.y + vec3(nZ.x, nZ.y, 0.0) * tri.z + vec3(0.0, nX.y, nX.x) * tri.x;
      } else {
        vec2 uv = base * s + uGroundShift[i];
        c = textureGrad(tGround, vec3(uv, float(i)), bdx * s, bdy * s).rgb;
        vec2 n = textureGrad(tGroundN, vec3(uv, float(i)), bdx * s, bdy * s).xy * 2.0 - 1.0;
        if (i == 0 || i == 6) {
          // Grass again at a third of the size, turned, so its repeats don't show across a meadow.
          vec2 uv2 = mat2(0.8, -0.6, 0.6, 0.8) * (base * s) * 0.31 + uGrassShift[i];
          c = mix(c, textureGrad(tGround, vec3(uv2, float(i)), bdx * s * 0.31, bdy * s * 0.31).rgb, 0.5);
        }
        b = vec3(n.x, 0.0, -n.y);
      }
      detail += c / uGroundMean[i] * w[i];
      bend += b * w[i];
      total += w[i];
    }
    detail /= max(total, 1e-4);
    bend /= max(total, 1e-4);
    // Keep the texture's light and shade, and only some of its own hue.
    float l = dot(detail, vec3(0.2126, 0.7152, 0.0722));
    detail = mix(vec3(l), detail, 0.55);
    vec3 tint = mix(vColor.rgb, uRockTint, steep);
    diffuseColor.rgb *= mix(vColor.rgb, tint * detail, uGroundOn);
    // The texture's bumps tip the normal: across the slope for ground seen from above, out of the
    // face for the rock's side projections.
    groundNormalW = normalize(N + bend * 0.9 * uGroundOn);
  }
`;

const fragmentNormal = /* glsl */ `
  normal = normalize((viewMatrix * vec4(groundNormalW, 0.0)).xyz);
`;

/** Turns the terrain's vertex-coloured material into the textured ground, loading the textures. */
export function texturedGround(material: THREE.MeshToonMaterial, rockTint: number): void {
  const uniforms = {
    tGround: { value: placeholder() as THREE.Texture },
    tGroundN: { value: placeholder() as THREE.Texture },
    uGroundMean: { value: LAYERS.map(() => new THREE.Vector3(1, 1, 1)) },
    uGroundScale: { value: LAYERS.map((l) => SCALE[l]) },
    uGroundOn: { value: 0 },
    uRockTint: { value: new THREE.Color(rockTint) },
    uGroundShift: { value: LAYERS.map(() => new THREE.Vector2()) },
    uGrassShift: { value: LAYERS.map(() => new THREE.Vector2(0.37, 0.37)) },
  };
  // The patterns stay where they are in the world as the scene's origin moves.
  followOrigin((ox, oz) => {
    LAYERS.forEach((l, i) => {
      const s = SCALE[l];
      uniforms.uGroundShift.value[i].set(repeatShift(ox, s), repeatShift(oz, s));
      // The turned sample's: the origin in repeats, turned and shrunk as the shader turns them, plus its offset.
      const [u, v] = [ox * s, oz * s];
      uniforms.uGrassShift.value[i].set(fract((0.8 * u + 0.6 * v) * 0.31 + 0.37), fract((-0.6 * u + 0.8 * v) * 0.31 + 0.37));
    });
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexHead}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n${vertexBody}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentHead}`)
      .replace('#include <color_fragment>', fragmentColor)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${fragmentNormal}`);
  };
  material.customProgramCacheKey = () => 'textured-ground';
  // Under Node (tests importing the game's modules) there are no files: the plain colours stay.
  if (!asset('ground/grass')) return;
  const means: THREE.Vector3[] = [];
  track(
    Promise.all([
      stack([...LAYERS], COLOR_SIZE, true, means),
      stack(
        LAYERS.map((l) => `${l}_n`),
        NORMAL_SIZE,
        false,
      ),
    ]).then(([color, normal]) => {
      uniforms.tGround.value = color;
      uniforms.tGroundN.value = normal;
      uniforms.uGroundMean.value = means;
      uniforms.uGroundOn.value = 1;
    }),
  );
}

/** The splat weights of one vertex: the share of each surface among the four cells around it. */
export function splatWeights(surfaces: number[], outA: number[], outB: number[]): void {
  const w = new Array(8).fill(0);
  for (const s of surfaces) w[s] += 1 / surfaces.length;
  outA[0] = w[0];
  outA[1] = w[1];
  outA[2] = w[2];
  outA[3] = w[3];
  outB[0] = w[4];
  outB[1] = w[5];
  outB[2] = w[6];
  outB[3] = 0;
}
