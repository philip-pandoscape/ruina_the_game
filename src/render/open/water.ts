import * as THREE from 'three';
import type { Heightfield } from '../../sim/terrain';
import { NEW_LOOK, PALETTE } from '../look';

// The sea: one big flat plane, coloured by how deep the water is over the seabed (a texture baked
// from the heightfield), with toon ripples and foam breathing along the shore. Transparent in the
// shallows so the sand shows through, near-opaque out deep.

const DEPTH_RANGE = 30; // metres the depth texture spans

const vertex = /* glsl */ `
  #include <fog_pars_vertex>
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragment = /* glsl */ `
  uniform sampler2D uDepth;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSky;
  uniform float uGlints;
  uniform vec4 uBounds;
  uniform float uTime;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uFoam;
  uniform float uRipple;
  varying vec3 vWorld;
  #include <fog_pars_fragment>

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  void main() {
    vec2 uv = (vWorld.xz - uBounds.xy) / uBounds.zw;
    float d = 1.0;
    if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) d = texture2D(uDepth, uv).r;
    float depth = d * ${DEPTH_RANGE.toFixed(1)};
    vec3 col = mix(uShallow, uDeep, smoothstep(0.4, 11.0, depth));
    #ifdef GLINTS
      // Out deep the sea goes darker still, and the surface tips with two drifting swells: the sky
      // shows in it at a glance (more the flatter you look), and the sun sparkles on it.
      col = mix(col, uDeep * 0.55, smoothstep(10.0, 28.0, depth));
      float e = 0.35;
      vec2 p1 = vWorld.xz * 0.11 + vec2(uTime * 0.05, uTime * 0.03);
      vec2 p2 = vWorld.xz * 0.37 - vec2(uTime * 0.07, -uTime * 0.05);
      float h0 = noise(p1) + 0.5 * noise(p2);
      float hx = noise(p1 + vec2(e * 0.11, 0.0)) + 0.5 * noise(p2 + vec2(e * 0.37, 0.0));
      float hz = noise(p1 + vec2(0.0, e * 0.11)) + 0.5 * noise(p2 + vec2(0.0, e * 0.37));
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

    // Toon ripples: two drifting noise fields, thresholded into flat flecks of light.
    float n1 = noise(vWorld.xz * 0.16 + vec2(uTime * 0.32, uTime * 0.18));
    float n2 = noise(vWorld.xz * 0.29 - vec2(uTime * 0.22, -uTime * 0.27));
    float ripple = n1 * n2;
    col = mix(col, col * 1.16 + 0.05, step(0.43, ripple) * uRipple);
    col = mix(col, col * 0.9, step(ripple, 0.06) * uRipple);

    // Foam: a breathing line where the water meets the land, and a broken second line further out.
    float edge = 0.5 + 0.28 * sin(uTime * 1.25 + vWorld.x * 0.05 + vWorld.z * 0.04);
    float foam = 1.0 - smoothstep(edge * 0.55, edge, depth);
    float swell = 1.25 + 0.45 * sin(uTime * 0.85 + vWorld.x * 0.06 - vWorld.z * 0.03);
    float band = (1.0 - smoothstep(0.0, 0.12, abs(depth - swell))) * (1.0 - smoothstep(0.6, 2.6, depth));
    foam = max(foam, band * step(0.4, n1));
    foam = clamp(foam, 0.0, 1.0);
    col = mix(col, uFoam, foam);

    float alpha = mix(0.5, 0.94, smoothstep(0.0, 5.0, depth));
    #ifdef GLINTS
      alpha = mix(0.55, 1.0, smoothstep(0.0, 7.0, depth));
    #endif
    alpha = max(alpha, foam * 0.95);
    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export class WaterView {
  readonly mesh: THREE.Mesh;
  private uniforms: Record<string, THREE.IUniform>;

  constructor(hf: Heightfield) {
    const N = hf.cells;
    const data = new Uint8Array(N * N);
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const x = hf.min + (i + 0.5) * hf.cell;
        const z = hf.min + (j + 0.5) * hf.cell;
        const d = Math.max(0, Math.min(1, (hf.water - hf.height(x, z)) / DEPTH_RANGE));
        data[j * N + i] = Math.round(d * 255);
      }
    const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;

    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
    Object.assign(this.uniforms, {
      uDepth: { value: tex },
      uBounds: { value: new THREE.Vector4(hf.min, hf.min, hf.size, hf.size) },
      uTime: { value: 0 },
      uShallow: { value: new THREE.Color(PALETTE.sea.shallow) },
      uDeep: { value: new THREE.Color(PALETTE.sea.deep) },
      uFoam: { value: new THREE.Color(PALETTE.sea.foam) },
      // The flecks of light are a toon touch; the new look keeps them faint.
      uRipple: { value: NEW_LOOK ? 0.25 : 1 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3) },
      uSunColor: { value: new THREE.Color(0xffffff) },
      uSky: { value: new THREE.Color(PALETTE.sky.horizon) },
      uGlints: { value: 1 },
    });
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      // The new look's haze is laid on from the depth buffer, so the sea has to be in it.
      depthWrite: NEW_LOOK,
      fog: true,
      defines: NEW_LOOK ? { GLINTS: '' } : {},
    });
    const geo = new THREE.PlaneGeometry(9000, 9000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.y = hf.water;
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
  }

  update(time: number): void {
    this.uniforms.uTime.value = time;
  }

  /** The sun (or moon) and the sky the new look's sea reflects. */
  setSky(sunDir: THREE.Vector3, sun: THREE.Color, sky: THREE.Color, glints: number): void {
    (this.uniforms.uSunDir.value as THREE.Vector3).copy(sunDir);
    (this.uniforms.uSunColor.value as THREE.Color).copy(sun);
    (this.uniforms.uSky.value as THREE.Color).copy(sky);
    this.uniforms.uGlints.value = glints;
  }

  /** Dims the sea at night and warms it at dusk. */
  setBrightness(k: number, gold: number): void {
    const sea = PALETTE.sea;
    (this.uniforms.uShallow.value as THREE.Color).setHex(sea.shallow).lerp(new THREE.Color(sea.duskShallow), gold * 0.25).multiplyScalar(k);
    (this.uniforms.uDeep.value as THREE.Color).setHex(sea.deep).lerp(new THREE.Color(sea.duskDeep), gold * 0.2).multiplyScalar(k);
    (this.uniforms.uFoam.value as THREE.Color).setHex(sea.foam).multiplyScalar(0.5 + 0.5 * k);
  }
}
