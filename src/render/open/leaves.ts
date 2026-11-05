import * as THREE from 'three';
import { makeRng, range } from '../../rng';
import { track } from '../assets';
import { toon } from '../toon';

// The new look's leaves. Two textures painted at load time (no files): a clump of broad leaves and
// a fir branch, in light greys so each tree's own colour tints them, with ragged alpha edges.
// Cards of them, set over a darker core, give the trees and bushes leafy outlines and light that
// breaks up across the canopy. The trunks wear real bark (CC0, Poly Haven: bark_brown_02,
// pine_bark). The cards sway a little in the wind.

const TAU = Math.PI * 2;

/** The wind's clock for the swaying cards (seconds), advanced by OpenStage. */
export const foliageTime = { value: 0 };

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function texture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

const grey = (l: number, warm = 0) => `rgb(${Math.round(255 * Math.min(1, l * (1 + warm)))},${Math.round(255 * Math.min(1, l))},${Math.round(255 * Math.min(1, l * (0.94 - warm)))})`;

let leafTex: THREE.CanvasTexture | null = null;

/** A round clump of broad leaves, dense and darker in the middle, pointing out and lighter at the top. */
export function leafClusterTexture(): THREE.CanvasTexture {
  if (leafTex) return leafTex;
  const S = 512;
  const [c, g] = canvas(S, S);
  const rng = makeRng(17);
  // A shaded heart, so a card never shows sky through its middle.
  const heart = g.createRadialGradient(S / 2, S / 2, S * 0.05, S / 2, S / 2, S * 0.3);
  heart.addColorStop(0, grey(0.42));
  heart.addColorStop(1, grey(0.5));
  g.fillStyle = heart;
  g.beginPath();
  g.arc(S / 2, S / 2, S * 0.28, 0, TAU);
  g.fill();
  const leaves: Array<{ x: number; y: number; len: number; w: number; ang: number; l: number; warm: number }> = [];
  for (let i = 0; i < 380; i++) {
    const a = rng() * TAU;
    const rr = Math.sqrt(rng()) * S * 0.43;
    const x = S / 2 + Math.cos(a) * rr;
    const y = S / 2 + Math.sin(a) * rr;
    const len = range(rng, 30, 50) * (1.05 - (rr / S) * 0.5);
    const top = 1 - y / S;
    leaves.push({ x, y, len, w: len * range(rng, 0.36, 0.5), ang: a + range(rng, -0.8, 0.8), l: 0.6 + 0.28 * rng() + 0.2 * top, warm: range(rng, -0.05, 0.08) });
  }
  // Lower leaves first, so the ones above overlap them as on a real bough.
  leaves.sort((p, q) => q.y - p.y);
  for (const f of leaves) {
    g.save();
    g.translate(f.x, f.y);
    g.rotate(f.ang);
    g.fillStyle = grey(f.l, f.warm);
    g.beginPath();
    g.moveTo(-f.len / 2, 0);
    g.quadraticCurveTo(0, -f.w, f.len / 2, 0);
    g.quadraticCurveTo(0, f.w, -f.len / 2, 0);
    g.fill();
    g.strokeStyle = grey(f.l * 0.72, f.warm);
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(-f.len / 2, 0);
    g.lineTo(f.len * 0.38, 0);
    g.stroke();
    g.restore();
  }
  return (leafTex = texture(c));
}

let firTex: THREE.CanvasTexture | null = null;

/**
 * A fir bough along the texture's width (trunk end at the left): a frond of needle tufts sweeping
 * forward from a spine, long at the base and short at the tip, lighter toward their ends, with gaps
 * between them so the bough's edge stays ragged.
 */
export function firBranchTexture(): THREE.CanvasTexture {
  if (firTex) return firTex;
  const W = 512;
  const H = 256;
  const [c, g] = canvas(W, H);
  const rng = makeRng(29);
  const spine = (t: number): [number, number] => [10 + t * (W - 34), H / 2 + 8 * t];
  const tufts: Array<{ x: number; y: number; len: number; w: number; ang: number; l: number }> = [];
  for (const side of [-1, 1])
    for (let i = 0; i < 30; i++) {
      const t = Math.min(0.97, (i + rng() * 0.6) / 30);
      const [x, y] = spine(t);
      const len = Math.pow(1 - t, 0.75) * 96 + 16;
      tufts.push({ x, y, len, w: range(rng, 4.5, 7) * (1 - t * 0.4), ang: side * (0.8 + 0.3 * t + range(rng, -0.12, 0.12)), l: range(rng, 0.52, 0.76) });
    }
  // A few tufts along the spine itself, pointing on toward the tip.
  for (let i = 0; i < 12; i++) {
    const t = i / 12;
    const [x, y] = spine(t);
    tufts.push({ x, y, len: 34 * (1 - t * 0.5), w: 8, ang: range(rng, -0.2, 0.2), l: 0.6 });
  }
  for (const f of tufts) {
    g.save();
    g.translate(f.x, f.y);
    g.rotate(f.ang);
    // Darker at the root of the tuft, lighter at its end.
    const grad = g.createLinearGradient(0, 0, f.len, 0);
    grad.addColorStop(0, grey(f.l * 0.62, 0.02));
    grad.addColorStop(1, grey(Math.min(1, f.l * 1.3), -0.02));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(f.len * 0.45, -f.w, f.len, 0);
    g.quadraticCurveTo(f.len * 0.45, f.w, 0, 0);
    g.fill();
    g.restore();
  }
  g.strokeStyle = grey(0.32, 0.1);
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(...spine(0));
  g.lineTo(...spine(0.9));
  g.stroke();
  return (firTex = texture(c));
}

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

// Light through the leaves: looking toward the sun through a crown, it glows a little.
const THROUGH = /* glsl */ `
  #if NUM_DIR_LIGHTS > 0
  {
    float through = pow(max(-dot(normalize(vViewPosition), directionalLights[0].direction), 0.0), 3.0);
    outgoingLight += diffuseColor.rgb * directionalLights[0].color * through * 0.32;
  }
  #endif
`;

/**
 * A tree's solid parts (trunks, the dark core of a crown, the whole crown far off): vertex colours,
 * dissolving near the camera. With `leafy`, the leaf texture is laid over it from three sides in
 * world space, so a crown reads as leaves even where no cards are drawn, and lets light through.
 */
export function solidMaterial(map: THREE.Texture | null = null, leafy = false): THREE.MeshToonMaterial {
  const mat = toon(0xffffff, { vertexColors: true, map });
  const uniforms = { tLeaf: { value: leafy ? leafClusterTexture() : null } };
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${DISSOLVE}`);
    if (!leafy) return;
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLeafPos;\nvarying vec3 vLeafNormal;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        {
          vec4 leafWorld = vec4(transformed, 1.0);
          mat3 leafTurn = mat3(modelMatrix);
          #ifdef USE_INSTANCING
            leafWorld = instanceMatrix * leafWorld;
            leafTurn = leafTurn * mat3(instanceMatrix);
          #endif
          vLeafPos = (modelMatrix * leafWorld).xyz;
          vLeafNormal = normalize(leafTurn * objectNormal);
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D tLeaf;\nvarying vec3 vLeafPos;\nvarying vec3 vLeafNormal;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec3 w = pow(abs(normalize(vLeafNormal)), vec3(4.0));
          w /= w.x + w.y + w.z;
          vec3 p = vLeafPos * 0.42;
          vec4 t = texture2D(tLeaf, p.zy) * w.x + texture2D(tLeaf, p.xz) * w.y + texture2D(tLeaf, p.xy) * w.z;
          diffuseColor.rgb *= mix(0.62, dot(t.rgb, vec3(0.333)) * 1.3, t.a);
        }`,
      )
      .replace('#include <opaque_fragment>', `${THROUGH}\n#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => `tree-solid:${map ? map.uuid : ''}:${leafy}`;
  return mat;
}

/**
 * Leaf cards: the texture's alpha cut out (smoothed by the multisampling), both sides lit as the
 * canopy around them is (the card's own facing is ignored), swaying with their height above the
 * ground, dissolving near the camera.
 */
export function cardMaterial(map: THREE.Texture, sway: number): THREE.MeshToonMaterial {
  const mat = toon(0xffffff, { map, vertexColors: true, alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = foliageTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          #ifdef USE_INSTANCING
            vec3 root = instanceMatrix[3].xyz;
          #else
            vec3 root = vec3(0.0);
          #endif
          float give = ${sway.toFixed(3)} * max(0.0, position.y - 1.0);
          transformed.x += sin(uTime * 1.3 + root.x * 0.21 + position.y * 0.45) * give;
          transformed.z += cos(uTime * 1.05 + root.z * 0.17 + position.x * 0.5) * give * 0.7;
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${DISSOLVE}`)
      .replace(
        '#include <alphatest_fragment>',
        `{
          // A card seen edge on is a smear of texture: it fades out, and the ones facing you show.
          vec3 facing = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
          diffuseColor.a *= smoothstep(0.12, 0.38, abs(dot(facing, normalize(vViewPosition))));
        }
        #include <alphatest_fragment>`,
      )
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  normal = normalize(vNormal);')
      .replace('#include <opaque_fragment>', `${THROUGH}\n#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => `tree-cards:${map.uuid}:${sway}`;
  return mat;
}

/** Writes a card (a quad) into the arrays: corners a..d, one normal per corner, uv 0..1, a shade per corner. */
function quad(out: Cards, corners: THREE.Vector3[], normals: THREE.Vector3[], shades: number[], uvs: Array<[number, number]>): void {
  for (const k of [0, 1, 2, 0, 2, 3]) {
    out.pos.push(corners[k].x, corners[k].y, corners[k].z);
    out.nor.push(normals[k].x, normals[k].y, normals[k].z);
    out.uv.push(uvs[k][0], uvs[k][1]);
    out.col.push(shades[k], shades[k], shades[k]);
  }
}

interface Cards {
  pos: number[];
  nor: number[];
  uv: number[];
  col: number[];
}

function geometry(c: Cards): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(c.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(c.nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(c.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(c.col, 3));
  g.computeBoundingSphere();
  return g;
}

/**
 * Leaf clumps over a canopy of lumps [x, y, z, r]: cards on each lump's surface, mostly on top and
 * outside, facing out with a twist. Their normals point out from the canopy's middle, and they are
 * darker low down and near the middle.
 */
export function leafCards(lumps: Array<[number, number, number, number]>, centre: THREE.Vector3, perArea: number, size: number, seed: number, low: number, high: number): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const out: Cards = { pos: [], nor: [], uv: [], col: [] };
  const dir = new THREE.Vector3();
  const n = new THREE.Vector3();
  const t = new THREE.Vector3();
  const b = new THREE.Vector3();
  const reach = Math.max(...lumps.map(([x, y, z, r]) => Math.hypot(x - centre.x, y - centre.y, z - centre.z) + r));
  for (const [x, y, z, r] of lumps) {
    const count = Math.max(3, Math.round(r * r * perArea));
    for (let i = 0; i < count; i++) {
      dir.set(range(rng, -1, 1), range(rng, -0.55, 1), range(rng, -1, 1)).normalize();
      const p = new THREE.Vector3(x, y, z).addScaledVector(dir, r * Math.sqrt(range(rng, 0.12, 1)));
      const s = r * size * range(rng, 0.7, 1.05);
      n.copy(dir).add(new THREE.Vector3(range(rng, -0.5, 0.5), range(rng, -0.3, 0.5), range(rng, -0.5, 0.5))).normalize();
      t.set(0, 1, 0).cross(n);
      if (t.lengthSq() < 1e-4) t.set(1, 0, 0);
      t.normalize().applyAxisAngle(n, rng() * TAU);
      b.copy(n).cross(t).normalize();
      const corners = [
        p.clone().addScaledVector(t, -s).addScaledVector(b, -s),
        p.clone().addScaledVector(t, s).addScaledVector(b, -s),
        p.clone().addScaledVector(t, s).addScaledVector(b, s),
        p.clone().addScaledVector(t, -s).addScaledVector(b, s),
      ];
      const normals = corners.map((c) => c.clone().sub(centre).normalize().lerp(dir, 0.35).normalize());
      const shades = corners.map((c) => {
        const up = THREE.MathUtils.clamp((c.y - low) / (high - low), 0, 1);
        const out2 = THREE.MathUtils.clamp(c.distanceTo(centre) / reach, 0, 1);
        return 0.62 + 0.38 * (0.6 * up + 0.4 * out2);
      });
      quad(out, corners, normals, shades, [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]);
    }
  }
  return geometry(out);
}

/**
 * Fir boughs: rings of branch cards out from the trunk at each tier, drooping, the texture's trunk
 * end at the trunk; a second, shorter ring between them; a few crossed cards at the crown.
 */
export function boughCards(tiers: Array<{ y: number; radius: number }>, top: number, seed: number): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const out: Cards = { pos: [], nor: [], uv: [], col: [] };
  const up = new THREE.Vector3(0, 1, 0);
  tiers.forEach(({ y, radius }, k) => {
    for (const ring of [0, 1]) {
      const count = Math.round((9 + radius * 3) * (ring ? 0.75 : 1));
      for (let i = 0; i < count; i++) {
        const a = ((i + (ring ? 0.5 : 0)) / count) * TAU + range(rng, -0.15, 0.15);
        const droop = range(rng, 0.32, 0.55) + (ring ? 0.12 : 0);
        const len = radius * (ring ? 0.78 : 1.12) * range(rng, 0.88, 1.08);
        const out3 = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
        const along = out3.clone().multiplyScalar(Math.cos(droop)).setY(-Math.sin(droop));
        // Across the bough, tilted a little off the horizontal so the rings don't all lie flat.
        const across = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)).applyAxisAngle(along, range(rng, -0.35, 0.35));
        const w = len * 0.52;
        const base = new THREE.Vector3(0, y + (ring ? 0.35 : 0), 0).addScaledVector(out3, 0.12);
        const tip = base.clone().addScaledVector(along, len);
        const corners = [base.clone().addScaledVector(across, -w / 2), tip.clone().addScaledVector(across, -w / 2), tip.clone().addScaledVector(across, w / 2), base.clone().addScaledVector(across, w / 2)];
        const normal = out3.clone().multiplyScalar(0.55).add(up).normalize();
        const tierLight = (0.7 + 0.3 * (k / Math.max(1, tiers.length - 1))) * range(rng, 0.85, 1.1);
        quad(out, corners, [normal, normal, normal, normal], [0.5 * tierLight, 1 * tierLight, 1 * tierLight, 0.5 * tierLight], [
          [0, 0.02],
          [1, 0.02],
          [1, 0.98],
          [0, 0.98],
        ]);
      }
    }
  });
  // The crown: three crossed upright cards.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI;
    const across = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const h = 2.2;
    const y0 = top - h;
    const corners = [new THREE.Vector3(0, y0, 0).addScaledVector(across, -0.5), new THREE.Vector3(0, top, 0).addScaledVector(across, -0.15), new THREE.Vector3(0, top, 0).addScaledVector(across, 0.15), new THREE.Vector3(0, y0, 0).addScaledVector(across, 0.5)];
    quad(out, corners, [up, up, up, up], [0.8, 1, 1, 0.8], [
      [0, 0.02],
      [1, 0.02],
      [1, 0.98],
      [0, 0.98],
    ]);
  }
  return geometry(out);
}
