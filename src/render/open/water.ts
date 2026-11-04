import * as THREE from 'three';
import type { Heightfield } from '../../sim/terrain';

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
  uniform vec4 uBounds;
  uniform float uTime;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uFoam;
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

    // Toon ripples: two drifting noise fields, thresholded into flat flecks of light.
    float n1 = noise(vWorld.xz * 0.16 + vec2(uTime * 0.32, uTime * 0.18));
    float n2 = noise(vWorld.xz * 0.29 - vec2(uTime * 0.22, -uTime * 0.27));
    float ripple = n1 * n2;
    col = mix(col, col * 1.16 + 0.05, step(0.43, ripple));
    col = mix(col, col * 0.9, step(ripple, 0.06));

    // Foam: a breathing line where the water meets the land, and a broken second line further out.
    float edge = 0.5 + 0.28 * sin(uTime * 1.25 + vWorld.x * 0.05 + vWorld.z * 0.04);
    float foam = 1.0 - smoothstep(edge * 0.55, edge, depth);
    float swell = 1.25 + 0.45 * sin(uTime * 0.85 + vWorld.x * 0.06 - vWorld.z * 0.03);
    float band = (1.0 - smoothstep(0.0, 0.12, abs(depth - swell))) * (1.0 - smoothstep(0.6, 2.6, depth));
    foam = max(foam, band * step(0.4, n1));
    foam = clamp(foam, 0.0, 1.0);
    col = mix(col, uFoam, foam);

    float alpha = mix(0.5, 0.94, smoothstep(0.0, 5.0, depth));
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
      uShallow: { value: new THREE.Color(0x63d6cf) },
      uDeep: { value: new THREE.Color(0x2c6fb4) },
      uFoam: { value: new THREE.Color(0xf4fbff) },
    });
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      fog: true,
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

  /** Dims the sea at night and warms it at dusk. */
  setBrightness(k: number, gold: number): void {
    (this.uniforms.uShallow.value as THREE.Color).setHex(0x63d6cf).lerp(new THREE.Color(0xe9b98a), gold * 0.25).multiplyScalar(k);
    (this.uniforms.uDeep.value as THREE.Color).setHex(0x2c6fb4).lerp(new THREE.Color(0x8a6aa8), gold * 0.2).multiplyScalar(k);
    (this.uniforms.uFoam.value as THREE.Color).setHex(0xf4fbff).multiplyScalar(0.5 + 0.5 * k);
  }
}
