import * as THREE from 'three';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GRAPHICS, LOOK_DEBUG_AO, POST } from '../look';

// The screen effects. Each frame:
//   1. the scene is drawn into a high-range buffer that keeps its depth (multisampled, above low
//      quality);
//   2. ambient occlusion is worked out from that depth alone (three's GTAO; no second scene draw;
//      at high quality only);
//   3. one pass darkens the occluded corners and lays haze over the distance: fog that is thick
//      over the sea, thins with height, and glows toward the sun;
//   4. bloom on whatever is brighter than white (above low quality), then tone mapping and the
//      colour grade, to the screen.
// Which of them the quality draws is in src/render/look.ts (GRAPHICS).
// The sky dome is left as it is (it already fades to the horizon colour the haze uses).

const quadVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const atmosphereFragment = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform sampler2D tAO;
  uniform mat4 uProjInv;
  uniform mat4 uCamWorld;
  uniform vec3 uCamPos;
  uniform vec3 uFogColor;
  uniform vec3 uSeaFar;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform float uDensity;
  uniform float uFalloff;
  uniform float uBase;
  uniform float uHaze;
  uniform float uSunGlow;
  uniform float uAO;
  uniform float uFar;
  varying vec2 vUv;

  void main() {
    vec4 src = texture2D(tColor, vUv);
    float depth = texture2D(tDepth, vUv).x;
    // Only the cleared far plane is sky: the sea a couple of kilometres out is already within a
    // hair of it, and must still be hazed.
    if (depth >= 1.0) {
      gl_FragColor = src;
      return;
    }
    vec4 view = uProjInv * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec3 world = (uCamWorld * vec4(view.xyz / view.w, 1.0)).xyz;
    vec3 ray = world - uCamPos;
    float dist = length(ray);
    vec3 rd = ray / max(dist, 1e-4);

    float ao = texture2D(tAO, vUv).r;
    #ifdef SHOW_AO
      gl_FragColor = vec4(vec3(ao), 1.0);
      return;
    #endif
    // Far off the depth buffer is too coarse for occlusion to mean anything; let it fade out.
    vec3 col = src.rgb * mix(1.0, ao, uAO * (1.0 - smoothstep(90.0, 220.0, dist)));

    // Fog whose density falls off exponentially with height, integrated along the view ray, plus a
    // thin haze everywhere so the far isle and clouds soften too.
    float k = rd.y * uFalloff;
    float column = abs(k) > 1e-5 ? (1.0 - exp(-dist * k)) / k : dist;
    float optical = uDensity * exp(-uFalloff * (uCamPos.y - uBase)) * column + uHaze * dist;
    // Whatever reaches the edge of the view (the sea, mostly) is all haze by then, so it meets
    // the sky without a seam.
    float fog = 1.0 - exp(-optical);
    float toSun = max(dot(rd, uSunDir), 0.0);
    vec3 fogColor = mix(uFogColor, uSunColor, pow(toSun, 6.0) * uSunGlow);
    col = mix(col, fogColor, fog);
    vec3 edge = rd.y < 0.0 ? mix(uSeaFar, uFogColor, exp(rd.y * 40.0)) : uFogColor;
    gl_FragColor = vec4(mix(col, edge, smoothstep(uFar * 0.55, uFar * 0.95, dist)), 1.0);
  }
`;

const finishFragment = /* glsl */ `
  uniform sampler2D tColor;
  uniform float uExposure;
  uniform float uSaturation;
  uniform float uContrast;
  uniform vec3 uLift;
  uniform vec3 uGain;
  uniform float uVignette;
  varying vec2 vUv;

  // Khronos PBR Neutral: rolls the highlights off while keeping the hues the palette chose.
  vec3 neutralTone(vec3 color) {
    const float startCompression = 0.8 - 0.04;
    const float desaturation = 0.15;
    float x = min(color.r, min(color.g, color.b));
    float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    color -= offset;
    float peak = max(color.r, max(color.g, color.b));
    if (peak < startCompression) return color;
    float d = 1.0 - startCompression;
    float newPeak = 1.0 - d * d / (peak + d - startCompression);
    color *= newPeak / peak;
    float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
    return mix(color, vec3(newPeak), g);
  }

  void main() {
    vec3 c = neutralTone(texture2D(tColor, vUv).rgb * uExposure);
    c = sRGBTransferOETF(vec4(max(c, 0.0), 1.0)).rgb;
    // The grade works on what the eye sees: saturation, contrast about the middle, cool shadows and
    // warm highlights, and corners a little darker.
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, uSaturation);
    c = (c - 0.5) * uContrast + 0.5;
    c = c * uGain + uLift * (1.0 - c);
    vec2 q = vUv - 0.5;
    c *= 1.0 - uVignette * smoothstep(0.1, 0.55, length(q));
    // A little noise against banding in the long gradients of sky and haze.
    c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }
`;

let whiteTexture: THREE.DataTexture | null = null;

/** One white texel: no occlusion anywhere. */
function white(): THREE.DataTexture {
  if (!whiteTexture) {
    whiteTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    whiteTexture.needsUpdate = true;
  }
  return whiteTexture;
}

export interface Atmosphere {
  /** The haze colour (the horizon's), the sun's colour and where it is, all for the hour. */
  fog: THREE.Color;
  /** The far sea seen from the air (OpenStage: the sky dome below its horizon shows the same). */
  seaFar: THREE.Color;
  sun: THREE.Color;
  sunDir: THREE.Vector3;
  /** How much the haze glows toward the sun (less by moonlight). */
  sunGlow: number;
  /** Brightness before tone mapping. */
  exposure: number;
}

export class WorldPost {
  private size = new THREE.Vector2();
  private sceneTarget: THREE.WebGLRenderTarget | null = null;
  private litTarget: THREE.WebGLRenderTarget | null = null;
  private ao: GTAOPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private atmosphere: FullScreenQuad;
  private finish: FullScreenQuad;
  private atmosphereMat: THREE.ShaderMaterial;
  private finishMat: THREE.ShaderMaterial;
  /** Sea level: where the fog is as thick as POST.fog.density says. */
  base = 0;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
  ) {
    const f = POST.fog;
    this.atmosphereMat = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        tAO: { value: null },
        uProjInv: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uFogColor: { value: new THREE.Color() },
        uSeaFar: { value: new THREE.Color() },
        uSunColor: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uDensity: { value: f.density },
        uFalloff: { value: f.falloff },
        uBase: { value: 0 },
        uHaze: { value: f.haze },
        uSunGlow: { value: f.sunGlow },
        uAO: { value: POST.ao.strength },
        uFar: { value: 1000 },
      },
      vertexShader: quadVertex,
      fragmentShader: atmosphereFragment,
      defines: LOOK_DEBUG_AO ? { SHOW_AO: '' } : {},
      depthTest: false,
      depthWrite: false,
    });
    const g = POST.grade;
    this.finishMat = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        uExposure: { value: POST.exposure },
        uSaturation: { value: g.saturation },
        uContrast: { value: g.contrast },
        uLift: { value: new THREE.Vector3(...g.lift) },
        uGain: { value: new THREE.Vector3(...g.gain) },
        uVignette: { value: g.vignette },
      },
      vertexShader: quadVertex,
      fragmentShader: finishFragment,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.atmosphere = new FullScreenQuad(this.atmosphereMat);
    this.finish = new FullScreenQuad(this.finishMat);
  }

  /** The light of the hour, from OpenStage.setTime. */
  setAtmosphere(a: Atmosphere): void {
    const u = this.atmosphereMat.uniforms;
    (u.uFogColor.value as THREE.Color).copy(a.fog);
    (u.uSeaFar.value as THREE.Color).copy(a.seaFar);
    (u.uSunColor.value as THREE.Color).copy(a.sun);
    (u.uSunDir.value as THREE.Vector3).copy(a.sunDir).normalize();
    u.uSunGlow.value = a.sunGlow;
    this.finishMat.uniforms.uExposure.value = a.exposure;
  }

  /** Builds (or rebuilds, after a resize) the buffers at the canvas's real pixel size. */
  private prepare(camera: THREE.PerspectiveCamera): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (this.sceneTarget && this.camera === camera && size.equals(this.size)) return;
    this.size.copy(size);
    this.camera = camera;
    const { x: w, y: h } = size;
    this.sceneTarget?.dispose();
    this.litTarget?.dispose();
    this.ao?.dispose();
    this.bloom?.dispose();
    const depth = new THREE.DepthTexture(w, h);
    this.sceneTarget = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: GRAPHICS.multisample ? 4 : 0, depthTexture: depth });
    this.litTarget = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
    // Occlusion is soft and slow-changing, so it is worked out at half size (a quarter of the cost)
    // from the full-size depth, and smoothed back up where it is laid on.
    // Below high quality there is no occlusion pass at all: the haze pass reads plain white instead.
    this.ao = GRAPHICS.occlusion ? new GTAOPass(this.scene, camera, Math.ceil(w / 2), Math.ceil(h / 2), { depthTexture: depth }) : null;
    if (this.ao) {
      this.ao.output = GTAOPass.OUTPUT.Off;
      this.ao.updateGtaoMaterial({ radius: POST.ao.radius, distanceExponent: 2, thickness: 2, scale: POST.ao.darken, samples: 16, screenSpaceRadius: false });
      this.ao.updatePdMaterial({ radius: 4, rings: 2, samples: 16 });
    }
    const b = POST.bloom;
    this.bloom = GRAPHICS.bloom ? new UnrealBloomPass(new THREE.Vector2(w, h), b.strength, b.radius, b.threshold) : null;
    const u = this.atmosphereMat.uniforms;
    u.tColor.value = this.sceneTarget.texture;
    u.tDepth.value = this.sceneTarget.depthTexture;
    u.tAO.value = this.ao ? this.ao.pdRenderTarget.texture : white();
    u.uAO.value = this.ao ? POST.ao.strength : 0;
    this.finishMat.uniforms.tColor.value = this.litTarget.texture;
  }

  render(camera: THREE.PerspectiveCamera): void {
    this.prepare(camera);
    const r = this.renderer;
    const sceneTarget = this.sceneTarget!;
    const litTarget = this.litTarget!;
    // Count the whole frame (scene and effects) for the stats line, not just the last pass.
    r.info.autoReset = false;
    r.info.reset();
    r.setRenderTarget(sceneTarget);
    r.render(this.scene, camera);
    this.ao?.render(r, null as unknown as THREE.WebGLRenderTarget, sceneTarget, 0, false);

    const u = this.atmosphereMat.uniforms;
    (u.uProjInv.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (u.uCamWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
    (u.uCamPos.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
    u.uBase.value = this.base;
    u.uFar.value = camera.far;
    r.setRenderTarget(litTarget);
    this.atmosphere.render(r);
    this.bloom?.render(r, null as unknown as THREE.WebGLRenderTarget, litTarget, 0, false);

    r.setRenderTarget(null);
    this.finish.render(r);
  }

  dispose(): void {
    this.sceneTarget?.dispose();
    this.litTarget?.dispose();
    this.ao?.dispose();
    this.bloom?.dispose();
    this.atmosphere.dispose();
    this.finish.dispose();
  }
}
