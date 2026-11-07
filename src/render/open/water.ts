import * as THREE from 'three';
import type { Heightfield } from '../../engine/zone';
import { GRAPHICS, PALETTE } from '../look';
import { followOrigin, noiseShift, sceneOrigin, wrapTurn } from '../origin';
import { DEPTH_RANGE, seaDepths } from './seaDepths';

// The sea: one big flat plane round the camera, coloured by how deep the water is over the seabed
// (a texture baked from each region's grid: up to four of the nearest regions held), with faint
// ripples and foam breathing along the shore, and (above low quality) swells that show the sky and
// glint in the sun. Transparent in the shallows so the sand shows through, opaque out deep, and the
// open sea between the regions deep. Its ripples, swells and foam are laid in the world: drawn from
// positions relative to the scene's origin and what the origin is worth to each (src/render/origin.ts),
// so they stay put as the origin moves and keep their precision far from the world's origin.

/** How many regions' depths the sea reads at once: the nearest held. */
export const SEA_REGIONS = 4;
/** The sea's tiles: the plane moves with the camera in whole tiles, so its vertices stay put. */
const TILE = 50;
/** How far apart the places the plane stands are: a whole number of tiles, and Emberholm's sea where it always was. */
const STEP = 1000;
const SPAN = 9000;

const vertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragment = /* glsl */ `
  uniform sampler2D uDepth0;
  uniform sampler2D uDepth1;
  uniform sampler2D uDepth2;
  uniform sampler2D uDepth3;
  uniform vec4 uBounds[${SEA_REGIONS}];
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSky;
  uniform float uGlints;
  uniform float uTime;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uFoam;
  // Where the scene's origin stands for each of the noises (its lattice's fraction, and the hash's
  // phase for the rest), and for the foam's two waves.
  uniform vec3 uN11;
  uniform vec3 uN37;
  uniform vec3 uN16;
  uniform vec3 uN29;
  uniform vec2 uWaves;
  varying vec3 vWorld;

  float hash(vec2 p, float phase) { return fract(sin(dot(p, vec2(127.1, 311.7)) + phase) * 43758.5453); }
  float noise(vec2 p, float phase) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i, phase), hash(i + vec2(1.0, 0.0), phase), f.x), mix(hash(i + vec2(0.0, 1.0), phase), hash(i + vec2(1.0, 1.0), phase), f.x), f.y);
  }

  // How deep the water is here, as far as the depth range goes (1 out in the open sea).
  float depthIn(sampler2D t, vec4 b, inout float d, inout bool found) {
    vec2 uv = (vWorld.xz - b.xy) / b.zw;
    if (!found && b.z > 0.0 && uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) {
      d = texture2D(t, uv).r;
      found = true;
    }
    return d;
  }

  void main() {
    float d = 1.0;
    bool found = false;
    depthIn(uDepth0, uBounds[0], d, found);
    depthIn(uDepth1, uBounds[1], d, found);
    depthIn(uDepth2, uBounds[2], d, found);
    depthIn(uDepth3, uBounds[3], d, found);
    float depth = d * ${DEPTH_RANGE.toFixed(1)};
    vec3 col = mix(uShallow, uDeep, smoothstep(0.4, 11.0, depth));
    // Out deep the sea goes darker still.
    col = mix(col, uDeep * 0.55, smoothstep(10.0, 28.0, depth));
    #ifdef GLINTS
      // The surface tips with two drifting swells: the sky shows in it at a glance (more the
      // flatter you look), and the sun sparkles on it.
      float e = 0.35;
      vec2 p1 = vWorld.xz * 0.11 + uN11.xy + vec2(uTime * 0.05, uTime * 0.03);
      vec2 p2 = vWorld.xz * 0.37 + uN37.xy - vec2(uTime * 0.07, -uTime * 0.05);
      float h0 = noise(p1, uN11.z) + 0.5 * noise(p2, uN37.z);
      float hx = noise(p1 + vec2(e * 0.11, 0.0), uN11.z) + 0.5 * noise(p2 + vec2(e * 0.37, 0.0), uN37.z);
      float hz = noise(p1 + vec2(0.0, e * 0.11), uN11.z) + 0.5 * noise(p2 + vec2(0.0, e * 0.37), uN37.z);
      // Far off the swells are finer than a pixel: flatten them there, or they shimmer as noise.
      float near = 1.0 - smoothstep(40.0, 320.0, length(cameraPosition - vWorld));
      vec3 n = normalize(vec3(-(hx - h0) / e * 1.6 * near, 1.0, -(hz - h0) / e * 1.6 * near));
      vec3 v = normalize(cameraPosition - vWorld);
      float fresnel = 0.03 + 0.97 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
      col = mix(col, uSky, clamp(fresnel, 0.0, 1.0) * 0.75);
      vec3 r = reflect(-v, n);
      float sun = max(dot(r, normalize(uSunDir)), 0.0);
      col += uSunColor * (pow(sun, 900.0) * 6.0 * near + pow(sun, 60.0) * 0.25) * uGlints;
    #endif

    // Ripples: two drifting noise fields, thresholded into faint flat flecks of light.
    float n1 = noise(vWorld.xz * 0.16 + uN16.xy + vec2(uTime * 0.32, uTime * 0.18), uN16.z);
    float n2 = noise(vWorld.xz * 0.29 + uN29.xy - vec2(uTime * 0.22, -uTime * 0.27), uN29.z);
    float ripple = n1 * n2;
    col = mix(col, col * 1.16 + 0.05, step(0.43, ripple) * 0.25);
    col = mix(col, col * 0.9, step(ripple, 0.06) * 0.25);

    // Foam: a breathing line where the water meets the land, and a broken second line further out.
    // The lines are drawn by depth, so far off, or seen flat, one is narrower than a pixel and would
    // pop on and off as the camera turns. fw is how much the depth changes across a pixel: each
    // line's edges soften over at least that, and a line thinner than that spreads into a fainter
    // one as wide as the pixel, so it holds still.
    float fw = max(fwidth(depth), 1e-4);
    float edge = 0.5 + 0.28 * sin(uTime * 1.25 + vWorld.x * 0.05 + vWorld.z * 0.04 + uWaves.x);
    float foam = 1.0 - smoothstep(edge * 0.55 - 0.5 * fw, edge + 0.5 * fw, depth);
    float swell = 1.25 + 0.45 * sin(uTime * 0.85 + vWorld.x * 0.06 - vWorld.z * 0.03 + uWaves.y);
    float band = (1.0 - smoothstep(0.0, 0.12 + fw, abs(depth - swell))) * (0.12 / max(0.12, fw)) * (1.0 - smoothstep(0.6, 2.6, depth));
    float fn = fwidth(n1);
    foam = max(foam, band * smoothstep(0.4 - fn, 0.4 + fn, n1));
    foam = clamp(foam, 0.0, 1.0);
    col = mix(col, uFoam, foam);

    float alpha = mix(0.55, 1.0, smoothstep(0.0, 7.0, depth));
    alpha = max(alpha, foam * 0.95);
    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }
`;

/** A region's depths as the sea reads them: a texture over its grid. */
export interface SeaDepth {
  texture: THREE.DataTexture;
  /** Its grid's corner in the world and its size. */
  minX: number;
  minZ: number;
  size: number;
}

/** A region's sea depths as a texture (seaDepths, baked by the page's worker or here). */
export function seaDepthTexture(hf: Heightfield, depths: Uint8Array = seaDepths(hf)): SeaDepth {
  const N = hf.cells;
  const texture = new THREE.DataTexture(depths, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return { texture, minX: hf.minX, minZ: hf.minZ, size: hf.size };
}

/** Out in the open sea: deep everywhere, for the regions the sea isn't reading. */
const OPEN_SEA = (() => {
  const t = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
})();

export class WaterView {
  readonly mesh: THREE.Mesh;
  private uniforms: Record<string, THREE.IUniform>;
  /** The regions whose depths it reads, nearest the camera first. */
  private depths: SeaDepth[] = [];

  constructor(water: number) {
    this.uniforms = {
      uDepth0: { value: OPEN_SEA },
      uDepth1: { value: OPEN_SEA },
      uDepth2: { value: OPEN_SEA },
      uDepth3: { value: OPEN_SEA },
      uBounds: { value: Array.from({ length: SEA_REGIONS }, () => new THREE.Vector4(0, 0, 0, 0)) },
      uTime: { value: 0 },
      uShallow: { value: new THREE.Color(PALETTE.sea.shallow) },
      uDeep: { value: new THREE.Color(PALETTE.sea.deep) },
      uFoam: { value: new THREE.Color(PALETTE.sea.foam) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3) },
      uSunColor: { value: new THREE.Color(0xffffff) },
      uSky: { value: new THREE.Color(PALETTE.sky.horizon) },
      uGlints: { value: 1 },
      uN11: { value: new THREE.Vector3() },
      uN37: { value: new THREE.Vector3() },
      uN16: { value: new THREE.Vector3() },
      uN29: { value: new THREE.Vector3() },
      uWaves: { value: new THREE.Vector2() },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      // The haze is laid on from the depth buffer, so the sea has to be in it.
      depthWrite: true,
      defines: GRAPHICS.seaGlints ? { GLINTS: '' } : {},
    });
    // In tiles of 50 m, not one sheet: the world position the depth and the foam are read at is
    // interpolated across each triangle, and across a 9 km triangle that is off by metres and
    // jumps as the camera turns, so the foam along the shore strobed thick and thin.
    const geo = new THREE.PlaneGeometry(SPAN, SPAN, SPAN / TILE, SPAN / TILE);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.y = water;
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    // Its patterns stay where they are in the world as the scene's origin moves.
    followOrigin((ox, oz) => this.rebase(ox, oz));
  }

  /** The regions whose depths it reads: the nearest few held (stage.ts), their bounds relative to the scene's origin. */
  setDepths(depths: SeaDepth[]): void {
    this.depths = depths.slice(0, SEA_REGIONS);
    const [ox, oz] = sceneOrigin();
    this.rebase(ox, oz);
  }

  /** The plane under the camera, moved in whole kilometres (whole tiles) so its vertices stay put. */
  follow(x: number, z: number): void {
    this.mesh.position.x = Math.round(x / STEP) * STEP;
    this.mesh.position.z = Math.round(z / STEP) * STEP;
  }

  private rebase(ox: number, oz: number): void {
    const u = this.uniforms;
    for (let i = 0; i < SEA_REGIONS; i++) {
      const d = this.depths[i];
      u[`uDepth${i}`].value = d?.texture ?? OPEN_SEA;
      (u.uBounds.value as THREE.Vector4[])[i].set(d ? d.minX - ox : 0, d ? d.minZ - oz : 0, d?.size ?? 0, d?.size ?? 0);
    }
    for (const [name, f] of [
      ['uN11', 0.11],
      ['uN37', 0.37],
      ['uN16', 0.16],
      ['uN29', 0.29],
    ] as const) {
      const s = noiseShift(ox, oz, f);
      (u[name].value as THREE.Vector3).set(s.x, s.z, s.phase);
    }
    (u.uWaves.value as THREE.Vector2).set(wrapTurn(ox * 0.05 + oz * 0.04), wrapTurn(ox * 0.06 - oz * 0.03));
  }

  update(time: number): void {
    this.uniforms.uTime.value = time;
  }

  /** The sun (or moon) and the sky the sea reflects. */
  setSky(sunDir: THREE.Vector3, sun: THREE.Color, sky: THREE.Color, glints: number): void {
    (this.uniforms.uSunDir.value as THREE.Vector3).copy(sunDir);
    (this.uniforms.uSunColor.value as THREE.Color).copy(sun);
    (this.uniforms.uSky.value as THREE.Color).copy(sky);
    this.uniforms.uGlints.value = glints;
  }

  /** Dims the sea at night and warms it at dusk. */
  setBrightness(k: number, gold: number): void {
    const sea = PALETTE.sea;
    (this.uniforms.uShallow.value as THREE.Color)
      .setHex(sea.shallow)
      .lerp(new THREE.Color(sea.duskShallow), gold * 0.25)
      .multiplyScalar(k);
    (this.uniforms.uDeep.value as THREE.Color)
      .setHex(sea.deep)
      .lerp(new THREE.Color(sea.duskDeep), gold * 0.2)
      .multiplyScalar(k);
    (this.uniforms.uFoam.value as THREE.Color).setHex(sea.foam).multiplyScalar(0.5 + 0.5 * k);
  }
}
