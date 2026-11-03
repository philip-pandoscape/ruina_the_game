import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toon } from '../render/toon';
import { ATTACK_TIME, CROWD_SPEED } from './crowdSim';

// Draws thousands of fighters in three draw calls. Each fighter is one low-poly model whose
// joints (legs, arms, cape) are posed on the graphics card from four numbers per fighter.

// What the renderer needs each frame, whether the fighters come from the local sim or the server.
export interface CrowdSource {
  readonly n: number;
  readonly rx: Float32Array; // where to draw each fighter this frame
  readonly rz: Float32Array;
  readonly ryaw: Float32Array;
  readonly rspeed: Float32Array; // m/s, drives the run animation
  readonly down: Uint8Array; // 1 when knocked down
  readonly known: Uint8Array; // 0 until we've heard about this fighter
  readonly swings: Uint8Array | Uint16Array; // changes each time a fighter starts a swing
  readonly team: Uint8Array;
  readonly teleported?: Uint8Array; // set by the source when a fighter jumps; cleared here
}

// Fallen fighters lie for SINK_AFTER seconds, sink SINK_DEPTH metres over SINK_TIME, and rise
// back up over RISE_TIME when they respawn.
const SINK_AFTER = 1.1;
const SINK_TIME = 0.6;
const SINK_DEPTH = 1.8;
const RISE_TIME = 0.35;

const PART = { body: 0, legL: 1, legR: 2, armL: 3, armR: 4, cape: 5 };
const MAT = { fixed: 0, team: 1, hair: 2, skin: 3 };

function box(
  w: number, h: number, d: number,
  x: number, y: number, z: number,
  part: number, mat: number, color = 0xffffff, tiltX = 0,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (tiltX) g.rotateX(tiltX);
  g.translate(x, y, z);
  g.deleteAttribute('uv');
  const count = g.attributes.position.count;
  const c = new THREE.Color(color);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(count).fill(part), 1));
  g.setAttribute('aMat', new THREE.BufferAttribute(new Float32Array(count).fill(mat), 1));
  return g;
}

// Wraps a normal geometry so it can be drawn many times in one draw call.
function instanced(src: THREE.BufferGeometry, count: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.index = src.index;
  for (const [name, attr] of Object.entries(src.attributes)) g.setAttribute(name, attr);
  g.instanceCount = count;
  return g;
}

// Same proportions as the player's hero, in plain boxes (about 230 triangles).
function fighterGeometry(): THREE.BufferGeometry {
  const pants = 0x2f3e46;
  const boots = 0x4a3426;
  const dark = 0x1d2733;
  // The sword points forward and down at 45° from the hand, so an overhead chop reads well.
  const bladeDir = new THREE.Vector3(0, -Math.SQRT1_2, Math.SQRT1_2);
  const hand = new THREE.Vector3(-0.31, 0.65, 0);
  const at = (d: number) => hand.clone().addScaledVector(bladeDir, d);
  const blade = at(0.49);
  const guard = at(0.06);
  return mergeGeometries([
    box(0.4, 0.16, 0.26, 0, 0.64, 0, PART.body, MAT.fixed, pants),
    box(0.46, 0.44, 0.3, 0, 0.93, 0, PART.body, MAT.team),
    box(0.48, 0.07, 0.32, 0, 0.74, 0, PART.body, MAT.fixed, 0x6b4226),
    box(0.5, 0.46, 0.46, 0, 1.4, 0, PART.body, MAT.skin),
    // Team-coloured helmet and crest, so armies are easy to tell apart from above.
    box(0.56, 0.2, 0.52, 0, 1.61, -0.01, PART.body, MAT.team),
    box(0.08, 0.14, 0.42, 0, 1.76, -0.03, PART.body, MAT.team),
    box(0.55, 0.3, 0.15, 0, 1.42, -0.19, PART.body, MAT.hair),
    box(0.07, 0.11, 0.02, 0.11, 1.4, 0.235, PART.body, MAT.fixed, dark),
    box(0.07, 0.11, 0.02, -0.11, 1.4, 0.235, PART.body, MAT.fixed, dark),
    box(0.15, 0.5, 0.17, 0.12, 0.37, 0, PART.legL, MAT.fixed, pants),
    box(0.19, 0.13, 0.27, 0.12, 0.065, 0.04, PART.legL, MAT.fixed, boots),
    box(0.15, 0.5, 0.17, -0.12, 0.37, 0, PART.legR, MAT.fixed, pants),
    box(0.19, 0.13, 0.27, -0.12, 0.065, 0.04, PART.legR, MAT.fixed, boots),
    box(0.14, 0.42, 0.15, 0.31, 0.89, 0, PART.armL, MAT.team),
    box(0.12, 0.12, 0.12, 0.31, 0.65, 0, PART.armL, MAT.skin),
    box(0.14, 0.42, 0.15, -0.31, 0.89, 0, PART.armR, MAT.team),
    box(0.12, 0.12, 0.12, -0.31, 0.65, 0, PART.armR, MAT.skin),
    box(0.26, 0.05, 0.06, guard.x, guard.y, guard.z, PART.armR, MAT.fixed, 0xe0b84a, Math.PI / 4),
    box(0.07, 0.025, 0.86, blade.x, blade.y, blade.z, PART.armR, MAT.fixed, 0xdfe6ee, Math.PI / 4),
    box(0.42, 0.5, 0.04, 0, 0.87, -0.17, PART.cape, MAT.team),
  ])!;
}

// Shared GLSL: per-fighter data and the joint posing.
// aRoot = (x, y, z, yaw); aAnim = (run phase, run amount 0..1, swing 0..1 or -1, or -2 when down; team 0/1).
const CROWD_COMMON = /* glsl */ `
attribute vec4 aRoot;
attribute vec4 aAnim;
attribute float aPart;
attribute float aMat;
mat3 crowdRotX(float a) { float c = cos(a); float s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 crowdRotY(float a) { float c = cos(a); float s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
void crowdJoint(out vec3 pivot, out float ang) {
  float sw = sin(aAnim.x) * 0.85 * aAnim.y;
  float atk = aAnim.z;
  bool swinging = atk >= 0.0;
  pivot = vec3(0.0);
  ang = 0.0;
  if (aPart > 0.5 && aPart < 1.5) { pivot = vec3(0.12, 0.62, 0.0); ang = swinging ? -0.3 : sw; }
  else if (aPart > 1.5 && aPart < 2.5) { pivot = vec3(-0.12, 0.62, 0.0); ang = swinging ? 0.3 : -sw; }
  else if (aPart > 2.5 && aPart < 3.5) { pivot = vec3(0.31, 1.1, 0.0); ang = swinging ? -0.6 : -sw * 1.05 + 0.05; }
  else if (aPart > 3.5 && aPart < 4.5) {
    pivot = vec3(-0.31, 1.1, 0.0);
    if (swinging) {
      // Overhead chop: wind up behind the head, strike forward, settle back.
      float wind = smoothstep(0.0, 0.3, atk);
      float strike = smoothstep(0.3, 0.55, atk);
      float settle = smoothstep(0.65, 1.0, atk);
      ang = mix(mix(mix(-0.3, -3.5, wind), -0.5, strike), -0.3, settle);
    } else {
      ang = -0.3 + sw * 0.35;
    }
  }
  else if (aPart > 4.5) { pivot = vec3(0.0, 1.12, -0.16); ang = 0.15 + 0.8 * aAnim.y + sin(aAnim.x * 2.0) * 0.08 * aAnim.y; }
}
float crowdLean() { return aAnim.z < -1.5 ? -1.45 : 0.12 * aAnim.y; }
vec3 crowdTransform(vec3 p, vec3 pivot, float ang, float lean) {
  vec3 t = crowdRotX(ang) * (p - pivot) + pivot;
  vec3 feet = vec3(0.0, aAnim.z < -1.5 ? 0.15 : 0.0, 0.0);
  t = crowdRotX(lean) * (t - feet) + feet;
  t.y += abs(cos(aAnim.x)) * 0.06 * aAnim.y;
  return crowdRotY(aRoot.w) * t + aRoot.xyz;
}
vec3 crowdNormal(vec3 n, float ang, float lean) {
  return crowdRotY(aRoot.w) * (crowdRotX(lean) * (crowdRotX(ang) * n));
}
`;

const CROWD_COLOR = /* glsl */ `
#include <color_vertex>
#ifdef USE_COLOR
  float cH1 = fract(sin(float(gl_InstanceID) * 12.9898) * 43758.5453);
  float cH2 = fract(sin(float(gl_InstanceID) * 78.233) * 12345.6789);
  if (aMat > 0.5 && aMat < 1.5) vColor.xyz = mix(uTeamA, uTeamB, aAnim.w) * (0.85 + 0.3 * cH2);
  else if (aMat > 1.5 && aMat < 2.5) vColor.xyz = mix(uHairA, uHairB, cH1 * cH1);
  else if (aMat > 2.5) vColor.xyz = mix(uSkinA, uSkinB, cH2 * 0.8);
#endif
`;

export class CrowdView {
  readonly group = new THREE.Group();
  readonly trianglesPerFighter: number;
  updateMs = 0; // smoothed CPU cost of writing per-fighter data each frame
  private root: Float32Array;
  private anim: Float32Array;
  private rootAttr: THREE.InstancedBufferAttribute;
  private animAttr: THREE.InstancedBufferAttribute;
  private phase: Float32Array;
  private localSwing: Float32Array;
  private lastSwing: Uint16Array;
  private downSince: Float32Array; // when each fighter fell (-1 while standing)
  private spawnedAt: Float32Array; // when each fighter last (re)appeared
  private time = 0;

  constructor(private n: number, outlines = true) {
    this.root = new Float32Array(n * 4);
    this.anim = new Float32Array(n * 4);
    this.rootAttr = new THREE.InstancedBufferAttribute(this.root, 4).setUsage(THREE.DynamicDrawUsage);
    this.animAttr = new THREE.InstancedBufferAttribute(this.anim, 4).setUsage(THREE.DynamicDrawUsage);
    this.phase = new Float32Array(n);
    this.localSwing = new Float32Array(n).fill(-1);
    this.lastSwing = new Uint16Array(n);
    this.downSince = new Float32Array(n).fill(-1);
    this.spawnedAt = new Float32Array(n).fill(-100);

    const base = fighterGeometry();
    this.trianglesPerFighter = (base.index ? base.index.count : base.attributes.position.count) / 3;
    const geo = instanced(base, n);
    geo.setAttribute('aRoot', this.rootAttr);
    geo.setAttribute('aAnim', this.animAttr);

    const uniforms = {
      uTeamA: { value: new THREE.Color(0x3a6ea5) },
      uTeamB: { value: new THREE.Color(0xb33a3a) },
      uHairA: { value: new THREE.Color(0x2b1a10) },
      uHairB: { value: new THREE.Color(0xd9b26a) },
      uSkinA: { value: new THREE.Color(0xf1c27d) },
      uSkinB: { value: new THREE.Color(0x8d5524) },
    };
    const mat = toon(0xffffff, { vertexColors: true });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          ${CROWD_COMMON}
          uniform vec3 uTeamA; uniform vec3 uTeamB; uniform vec3 uHairA; uniform vec3 uHairB; uniform vec3 uSkinA; uniform vec3 uSkinB;`,
        )
        .replace('#include <color_vertex>', CROWD_COLOR)
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
          vec3 cPivot; float cAng; crowdJoint(cPivot, cAng); float cLean = crowdLean();
          objectNormal = crowdNormal(objectNormal, cAng, cLean);`,
        )
        .replace('#include <begin_vertex>', 'vec3 transformed = crowdTransform(position, cPivot, cAng, cLean);');
    };
    mat.customProgramCacheKey = () => 'crowd-fighter';
    const bodies = new THREE.Mesh(geo, mat);
    bodies.frustumCulled = false;
    this.group.add(bodies);

    if (outlines) {
      const outlineMat = new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          { uColor: { value: new THREE.Color(0x1d2733) }, uThickness: { value: 0.02 } },
        ]),
        vertexShader: /* glsl */ `
          #include <common>
          ${CROWD_COMMON}
          #include <fog_pars_vertex>
          uniform float uThickness;
          void main() {
            vec3 cPivot; float cAng; crowdJoint(cPivot, cAng); float cLean = crowdLean();
            vec3 n = crowdNormal(normal, cAng, cLean);
            vec3 p = crowdTransform(position, cPivot, cAng, cLean) + n * uThickness;
            vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mvPosition;
            #include <fog_vertex>
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          #include <common>
          #include <fog_pars_fragment>
          void main() {
            gl_FragColor = vec4(uColor, 1.0);
            #include <colorspace_fragment>
            #include <fog_fragment>
          }
        `,
        side: THREE.BackSide,
        fog: true,
      });
      const hulls = new THREE.Mesh(geo, outlineMat);
      hulls.frustumCulled = false;
      this.group.add(hulls);
    }

    // Soft round shadows under every fighter, faded out by distance like the fog.
    const blobGeo = instanced(new THREE.CircleGeometry(0.42, 10).rotateX(-Math.PI / 2), n);
    blobGeo.setAttribute('aRoot', this.rootAttr);
    const blobMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uOpacity: { value: 0.22 } }]),
      vertexShader: /* glsl */ `
        attribute vec4 aRoot;
        varying float vDepth;
        varying float vShow;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position + vec3(aRoot.x, 0.03, aRoot.z), 1.0);
          vDepth = -mvPosition.z;
          vShow = clamp(1.0 + aRoot.y, 0.0, 1.0); // fades out as a fighter sinks into the ground
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        uniform float fogNear;
        uniform float fogFar;
        varying float vDepth;
        varying float vShow;
        void main() {
          gl_FragColor = vec4(0.0, 0.0, 0.0, uOpacity * vShow * (1.0 - smoothstep(fogNear, fogFar, vDepth)));
        }
      `,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    const blobs = new THREE.Mesh(blobGeo, blobMat);
    blobs.frustumCulled = false;
    blobs.renderOrder = 1;
    this.group.add(blobs);
  }

  // A copy of every fighter's (x, y, z, yaw) as drawn this frame, for tests.
  roots(): Float32Array {
    return this.root.slice();
  }

  // Writes each fighter's position and animation state for this frame.
  update(src: CrowdSource, dt: number): void {
    const t0 = performance.now();
    this.time += dt;
    const { root, anim, phase, localSwing, lastSwing, downSince, spawnedAt, time } = this;
    const { rx, rz, ryaw, rspeed, down, known, team, swings, teleported } = src;
    for (let i = 0; i < this.n; i++) {
      const speed = rspeed[i];
      phase[i] += speed * dt * Math.PI; // one full stride every 2 m

      // Fallen fighters lie still, then sink into the ground before they're moved back to
      // respawn; they rise out of the ground where they reappear.
      if (down[i]) {
        if (downSince[i] < 0) downSince[i] = time;
      } else if (downSince[i] >= 0) {
        downSince[i] = -1;
        spawnedAt[i] = time;
      }
      if (teleported?.[i]) {
        teleported[i] = 0;
        spawnedAt[i] = time;
      }
      let y = 0;
      if (downSince[i] >= 0) y = -SINK_DEPTH * Math.min(1, Math.max(0, (time - downSince[i] - SINK_AFTER) / SINK_TIME));
      else if (time - spawnedAt[i] < RISE_TIME) y = -SINK_DEPTH * (1 - (time - spawnedAt[i]) / RISE_TIME);

      let swing = -1;
      if (down[i]) {
        swing = -2;
        localSwing[i] = -1;
      } else {
        // Start a local swing animation whenever the sim reports a new swing.
        if (swings[i] !== lastSwing[i]) {
          lastSwing[i] = swings[i];
          localSwing[i] = 0;
        } else if (localSwing[i] >= 0) {
          localSwing[i] += dt / ATTACK_TIME;
          if (localSwing[i] >= 1) localSwing[i] = -1;
        }
        swing = localSwing[i];
      }

      const k = i * 4;
      root[k] = rx[i];
      root[k + 1] = known[i] ? y : -1000; // fighters we haven't heard about yet stay hidden
      root[k + 2] = rz[i];
      root[k + 3] = ryaw[i];
      anim[k] = phase[i];
      anim[k + 1] = Math.min(1, speed / CROWD_SPEED);
      anim[k + 2] = swing;
      anim[k + 3] = team[i];
    }
    this.rootAttr.needsUpdate = true;
    this.animAttr.needsUpdate = true;
    const ms = performance.now() - t0;
    this.updateMs = this.updateMs === 0 ? ms : this.updateMs * 0.95 + ms * 0.05;
  }
}
