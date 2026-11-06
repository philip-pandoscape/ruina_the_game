import * as THREE from 'three';
import { makeRng, range } from '../../rng';
import { toon } from '../toon';
import { foliageTime } from './leaves';
import { TAU } from '../../util/math';

// The new look's crowns: soft, painterly masses of foliage, as in the island's reference picture.
// Each crown is a few hundred small clumps of leaves (or tufts of needles, for the pines) scattered
// over the surface of a rough shape, every clump turned to face the camera, so the crown never shows
// a flat card edge on. Each clump is lit with the normal of the shape at that point, so the whole
// crown shades as one rounded mass: sunlit on top, dark underneath and inside, glowing a little
// where the sun shines through. Far off, fewer and bigger clumps make the same shape.

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
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

const grey = (l: number) => {
  const v = Math.round(255 * Math.max(0, Math.min(1, l)));
  return `rgb(${v},${v},${v})`;
};

let clumpTex: THREE.CanvasTexture | null = null;

/**
 * A clump of broad leaves: an even mass with leaves standing out all round its edge and a little
 * light and shade between the leaves, but no shading of its own as a whole: the crown's normals
 * light it, so neighbouring clumps run together into one mass. Greys: the tree's colour tints it.
 */
export function clumpTexture(): THREE.CanvasTexture {
  if (clumpTex) return clumpTex;
  const S = 512;
  const [c, g] = canvas(S);
  const rng = makeRng(61);
  const cx = S / 2;
  const cy = S / 2;
  const R = S * 0.4;
  g.fillStyle = grey(0.8);
  g.beginPath();
  // A lobed heart, not a disc.
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * TAU;
    const r = R * (0.62 + 0.08 * Math.sin(a * 5 + 1.3) + 0.05 * Math.sin(a * 9 + 0.4));
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.fill();
  const leaves: Array<{ x: number; y: number; len: number; w: number; ang: number; l: number }> = [];
  for (let i = 0; i < 300; i++) {
    const rim = rng() < 0.7;
    const a = rng() * TAU;
    const rr = rim ? R * (0.55 + 0.45 * Math.sqrt(rng())) : R * 0.6 * Math.sqrt(rng());
    const len = range(rng, 34, 56);
    leaves.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr, len, w: len * range(rng, 0.42, 0.56), ang: a + range(rng, -0.8, 0.8), l: range(rng, 0.7, 0.96) });
  }
  leaves.sort((p, q) => p.l - q.l);
  for (const f of leaves) {
    g.save();
    g.translate(f.x, f.y);
    g.rotate(f.ang);
    g.fillStyle = grey(f.l);
    g.beginPath();
    g.moveTo(-f.len / 2, 0);
    g.quadraticCurveTo(-f.len * 0.05, -f.w, f.len / 2, 0);
    g.quadraticCurveTo(-f.len * 0.05, f.w, -f.len / 2, 0);
    g.fill();
    g.strokeStyle = grey(f.l * 0.84);
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(-f.len / 2, 0);
    g.lineTo(f.len * 0.35, 0);
    g.stroke();
    g.restore();
  }
  return (clumpTex = texture(c));
}

let tuftTex: THREE.CanvasTexture | null = null;

/**
 * A bough's tip seen from the side: a drooping arch of twig with needles hanging from it in a
 * ragged fringe, a few sticking up, lighter at their ends. Drawn twice as wide as tall, so the
 * pine's clumps (also twice as wide as tall) lie along its tiers as layered, drooping boughs.
 * Greys: the pine's colour tints it.
 */
export function tuftTexture(): THREE.CanvasTexture {
  if (tuftTex) return tuftTex;
  const S = 512;
  const [c, g] = canvas(S);
  const rng = makeRng(67);
  g.lineCap = 'round';
  // The twig: an arch across the middle, drooping at both ends.
  const twig = (u: number): [number, number] => [S * (0.06 + 0.88 * u), S * (0.42 + 0.22 * (2 * u - 1) ** 2)];
  const needles: Array<{ x: number; y: number; a: number; len: number; w: number; l: number }> = [];
  for (let i = 0; i < 700; i++) {
    const u = rng();
    const [x, y] = twig(u);
    const up = rng() < 0.18;
    // Hanging needles splay out from straight down; a few rise from the twig's top.
    const a = up ? -Math.PI / 2 + range(rng, -0.9, 0.9) : Math.PI / 2 + range(rng, -0.75, 0.75) + (u - 0.5) * 0.6;
    const ends = 1 - Math.abs(2 * u - 1) * 0.45;
    const len = S * (up ? range(rng, 0.05, 0.12) : range(rng, 0.12, 0.3)) * ends;
    needles.push({ x, y, a, len, w: range(rng, 3, 4.4), l: range(rng, 0.6, 0.92) });
  }
  needles.sort((p, q) => p.l - q.l);
  for (const n of needles) {
    const ex = n.x + Math.cos(n.a) * n.len;
    const ey = n.y + Math.sin(n.a) * n.len;
    const grad = g.createLinearGradient(n.x, n.y, ex, ey);
    grad.addColorStop(0, grey(n.l * 0.78));
    grad.addColorStop(1, grey(Math.min(1, n.l * 1.1)));
    g.strokeStyle = grad;
    g.lineWidth = n.w;
    g.beginPath();
    g.moveTo(n.x, n.y);
    g.lineTo(ex, ey);
    g.stroke();
  }
  g.strokeStyle = grey(0.42);
  g.lineWidth = 6;
  g.beginPath();
  for (let i = 0; i <= 32; i++) {
    const [x, y] = twig(i / 32);
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.stroke();
  return (tuftTex = texture(c));
}

/** One clump to be: where it sits (the shape's surface), its normal, half its size, its turn, its shade. */
interface Clump {
  at: THREE.Vector3;
  normal: THREE.Vector3;
  size: number;
  spin: number;
  shade: [number, number, number];
}

function geometry(clumps: Clump[]): THREE.BufferGeometry {
  const n = clumps.length;
  const pos = new Float32Array(n * 12);
  const nor = new Float32Array(n * 12);
  const col = new Float32Array(n * 12);
  const uv = new Float32Array(n * 8);
  const corner = new Float32Array(n * 8);
  const size = new Float32Array(n * 4);
  const spin = new Float32Array(n * 4);
  const idx = new Uint32Array(n * 6);
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  clumps.forEach((c, i) => {
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      pos.set([c.at.x, c.at.y, c.at.z], v * 3);
      nor.set([c.normal.x, c.normal.y, c.normal.z], v * 3);
      col.set(c.shade, v * 3);
      corner.set(corners[k], v * 2);
      uv.set([(corners[k][0] + 1) / 2, (corners[k][1] + 1) / 2], v * 2);
      size[v] = c.size;
      spin[v] = c.spin;
    }
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
  g.setAttribute('size', new THREE.BufferAttribute(size, 1));
  g.setAttribute('spin', new THREE.BufferAttribute(spin, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  // The clumps stand out of the shape by up to their size: bound generously.
  g.computeBoundingBox();
  g.boundingBox!.expandByScalar(Math.max(...clumps.map((c) => c.size)) * 1.5);
  g.boundingSphere = g.boundingBox!.getBoundingSphere(new THREE.Sphere());
  return g;
}

/** A clump's own hue over its shade: mostly as it is, now and then sunnier or cooler. */
function hued(rng: () => number, k: number): [number, number, number] {
  const r = rng();
  if (r < 0.16) return [k * 1.06, k * 1.03, k * 0.88];
  if (r < 0.3) return [k * 0.95, k * 0.99, k * 1.04];
  return [k, k, k];
}

/** A crown's rough shape: balls [x, y, z, r] round a middle. */
export interface CrownShape {
  lumps: Array<[number, number, number, number]>;
  middle: THREE.Vector3;
}

/**
 * Leaf clumps over a crown's balls: most on their outer surface (not where another ball covers
 * them), some deeper in so no sky shows through; darker low down and inside.
 */
export function crownClumps(shape: CrownShape, density: number, size: [number, number], seed: number): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const { lumps, middle } = shape;
  const low = Math.min(...lumps.map(([, y, , r]) => y - r));
  const high = Math.max(...lumps.map(([, y, , r]) => y + r));
  const reach = Math.max(...lumps.map(([x, y, z, r]) => Math.hypot(x - middle.x, y - middle.y, z - middle.z) + r));
  const clumps: Clump[] = [];
  const dir = new THREE.Vector3();
  lumps.forEach(([x, y, z, r], li) => {
    const centre = new THREE.Vector3(x, y, z);
    const count = Math.round(4 * Math.PI * r * r * density);
    for (let i = 0; i < count; i++) {
      dir.set(range(rng, -1, 1), range(rng, -1, 1), range(rng, -1, 1));
      if (dir.lengthSq() > 1 || dir.lengthSq() < 0.01) {
        i--;
        continue;
      }
      dir.normalize();
      const deep = rng() < 0.16;
      const at = centre.clone().addScaledVector(dir, r * (deep ? range(rng, 0.35, 0.7) : range(rng, 0.84, 1.0)));
      // A clump on the surface that another ball covers is never seen: leave it out.
      if (!deep && lumps.some(([ox, oy, oz, orr], oi) => oi !== li && at.distanceTo(new THREE.Vector3(ox, oy, oz)) < orr * 0.86)) continue;
      const normal = at.clone().sub(centre).normalize().multiplyScalar(0.55).add(at.clone().sub(middle).normalize().multiplyScalar(0.45)).normalize();
      const up = THREE.MathUtils.clamp((at.y - low) / (high - low), 0, 1);
      const out = THREE.MathUtils.clamp(at.distanceTo(middle) / reach, 0, 1);
      const k = (0.56 + 0.44 * (0.6 * up + 0.4 * out)) * (deep ? 0.74 : 1);
      clumps.push({ at, normal, size: range(rng, size[0], size[1]), spin: rng() * TAU, shade: hued(rng, k) });
    }
  });
  return geometry(clumps);
}

/** A pine's tiers: each a skirt of boughs from its top down to a drooping rim. */
export interface PineShape {
  tiers: Array<{ y0: number; radius: number; height: number }>;
  top: number;
}

/**
 * Needle tufts over a pine's tiers: thickest along each drooping rim, thinner up each skirt toward
 * the trunk, a few deeper in; darker underneath and toward the trunk, lighter at the tips.
 */
export function pineClumps(shape: PineShape, density: number, size: [number, number], seed: number): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const clumps: Clump[] = [];
  shape.tiers.forEach(({ y0, radius, height }, k) => {
    const count = Math.round(radius * radius * density + 6);
    const tierLight = 0.72 + 0.28 * (k / Math.max(1, shape.tiers.length - 1));
    for (let i = 0; i < count; i++) {
      // t: 0 at the tier's top (at the trunk), 1 at its rim; most of them out along the rim.
      const t = Math.cbrt(range(rng, 0.02, 1));
      const a = rng() * TAU;
      const deep = rng() < 0.12;
      const r = radius * t * (deep ? 0.55 : range(rng, 0.92, 1.04));
      const y = y0 + height * (1 - t) - 0.45 * t * t + range(rng, -0.12, 0.12);
      const at = new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
      const normal = new THREE.Vector3(Math.cos(a), 0.75 - 0.35 * t, Math.sin(a)).normalize();
      const k2 = (0.5 + 0.5 * t * t) * tierLight * (deep ? 0.7 : 1);
      const s = range(rng, size[0], size[1]) * (0.75 + 0.35 * Math.min(1, radius / 3));
      clumps.push({ at, normal, size: s, spin: range(rng, -0.12, 0.12), shade: hued(rng, k2) });
    }
  });
  // The leader at the very top.
  for (let i = 0; i < 4; i++) {
    const at = new THREE.Vector3(range(rng, -0.1, 0.1), shape.top - 0.5 - i * 0.45, range(rng, -0.1, 0.1));
    clumps.push({ at, normal: new THREE.Vector3(0, 1, 0), size: range(rng, size[0], size[1]) * 0.6, spin: range(rng, -0.2, 0.2), shade: hued(rng, 0.9) });
  }
  return geometry(clumps);
}

/** Bushes: clumps over a few low balls. */
export function bushClumps(shape: CrownShape, density: number, size: [number, number], seed: number): THREE.BufferGeometry {
  return crownClumps(shape, density, size, seed);
}

// The clump faces the camera: its corners are set out in view space round where it sits, turned by
// its spin, scaled with the tree. Under the wind each clump sways with its height.
const billboard = (sway: boolean, aspect: [number, number]) => /* glsl */ `
  vec4 mvPosition = vec4(transformed, 1.0);
  float treeScale = 1.0;
  #ifdef USE_INSTANCING
    treeScale = length(instanceMatrix[0].xyz);
    ${sway ? 'vec3 root = instanceMatrix[3].xyz;' : ''}
    mvPosition = instanceMatrix * mvPosition;
  #else
    ${sway ? 'vec3 root = vec3(0.0);' : ''}
  #endif
  ${
    sway
      ? `{
    float give = 0.018 * max(0.0, transformed.y - 1.5) * treeScale;
    mvPosition.x += sin(uTime * 1.3 + root.x * 0.21 + transformed.y * 0.5) * give;
    mvPosition.z += cos(uTime * 1.05 + root.z * 0.17 + transformed.x * 0.6) * give * 0.7;
  }`
      : ''
  }
  mvPosition = modelViewMatrix * mvPosition;
  {
    vec2 c = corner * size * treeScale * vec2(${aspect[0].toFixed(3)}, ${aspect[1].toFixed(3)});
    float cs = cos(spin);
    float sn = sin(spin);
    mvPosition.xy += vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs);
  }
  gl_Position = projectionMatrix * mvPosition;
`;

const HEAD = /* glsl */ `
  attribute vec2 corner;
  attribute float size;
  attribute float spin;
  uniform float uTime;
`;

// Keeps the texture's edge as solid far off as near: as the mip levels blur its alpha toward the
// clear surround, the alpha is pushed back up (Ben Golus's mip-level alpha scaling).
const KEEP_EDGES = /* glsl */ `
  #ifdef USE_MAP
  {
    vec2 texel = vMapUv * 512.0;
    float lod = 0.5 * log2(max(dot(dFdx(texel), dFdx(texel)), dot(dFdy(texel), dFdy(texel))));
    diffuseColor.a *= 1.0 + max(0.0, lod) * 0.22;
  }
  #endif
`;

const DISSOLVE = /* glsl */ `
  {
    float near = smoothstep(1.2, 3.6, length(vViewPosition));
    float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (dither > near) discard;
  }
`;

const THROUGH = /* glsl */ `
  #if NUM_DIR_LIGHTS > 0
  {
    float through = pow(max(-dot(normalize(vViewPosition), directionalLights[0].direction), 0.0), 3.0);
    outgoingLight += diffuseColor.rgb * directionalLights[0].color * through * 0.35;
  }
  #endif
`;

const materials = new Map<string, THREE.MeshToonMaterial>();

/**
 * The crowns' material: camera-facing clumps, lit by the shape's normals, swaying, cut out by the
 * texture; `aspect` widens or flattens every clump (a pine's boughs are twice as wide as tall).
 */
export function clumpMaterial(map: THREE.Texture, aspect: [number, number] = [1, 1]): THREE.MeshToonMaterial {
  const key = `${map.uuid}:${aspect.join(',')}`;
  let mat = materials.get(key);
  if (mat) return mat;
  mat = toon(0xffffff, { map, vertexColors: true, alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = foliageTime;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${HEAD}`).replace('#include <project_vertex>', billboard(true, aspect));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${DISSOLVE}`)
      .replace('#include <alphatest_fragment>', `${KEEP_EDGES}\n#include <alphatest_fragment>`)
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  normal = normalize(vNormal);')
      .replace('#include <opaque_fragment>', `${THROUGH}\n#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => `crown-clumps:${key}`;
  materials.set(key, mat);
  return mat;
}

const depthMaterials = new Map<string, THREE.MeshDepthMaterial>();

/** The crowns' shadows: the same clumps, turned to face the sun, cut out by the same texture. */
export function clumpDepthMaterial(map: THREE.Texture, aspect: [number, number] = [1, 1]): THREE.MeshDepthMaterial {
  const key = `${map.uuid}:${aspect.join(',')}`;
  let mat = depthMaterials.get(key);
  if (mat) return mat;
  mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.5 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = foliageTime;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${HEAD}`).replace('#include <project_vertex>', billboard(false, aspect));
  };
  mat.customProgramCacheKey = () => `crown-clumps-depth:${key}`;
  depthMaterials.set(key, mat);
  return mat;
}
