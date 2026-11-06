import * as THREE from 'three';
import { toon } from '../render/toon';
import { buildPoseTexture } from './pose';
import { buildProxyGeometry, proxyTriangles } from './proxy';
import { clipRows, type Clip, type SpeciesDef } from './types';

// Draws any number of one species in one draw call, whatever its skeleton is. A vertex
// knows which joint drives it; the pose texture knows where that joint is on a given frame of a
// given clip. Nothing in the shader knows what a leg is, which is what lets the same code draw a
// slime, a quadruped and a rig with fingers.

export interface CrowdPalette {
  teamA?: THREE.ColorRepresentation;
  teamB?: THREE.ColorRepresentation;
  hairA?: THREE.ColorRepresentation;
  hairB?: THREE.ColorRepresentation;
  skinA?: THREE.ColorRepresentation;
  skinB?: THREE.ColorRepresentation;
}

export interface SpeciesCrowdOptions {
  /** Blend between the two nearest baked frames. Off costs three fewer texture reads a vertex. */
  smooth?: boolean;
  /** Adds a per-instance hit flash. Off by default, so a crowd that never flashes pays nothing. */
  tint?: boolean;
  palette?: CrowdPalette;
  /** Draws every instance this many times its authored size: one body for a creature's sizes. */
  scale?: number;
}

// aRoot = (x, y, z, yaw); aPose = (row, nextRow, mix, team 0/1). Shared with the jelly slimes
// (jelly.ts), which pose their own shapes with the same clips.
export const SPECIES_GLSL = /* glsl */ `
attribute vec4 aRoot;
attribute vec4 aPose;
attribute float aJoint;
attribute float aMat;
#ifdef CROWD_TINT
  attribute float aFlash;
#endif
uniform sampler2D uPose;
uniform vec2 uPoseSize;
uniform float uScale;

mat4 speciesRow(float joint, float row) {
  vec2 inv = 1.0 / uPoseSize;
  float x = joint * 3.0;
  float v = (row + 0.5) * inv.y;
  vec4 r0 = texture2D(uPose, vec2((x + 0.5) * inv.x, v));
  vec4 r1 = texture2D(uPose, vec2((x + 1.5) * inv.x, v));
  vec4 r2 = texture2D(uPose, vec2((x + 2.5) * inv.x, v));
  // The texture holds rows of a 3x4; a mat4 is built from columns.
  return mat4(r0.x, r1.x, r2.x, 0.0,
              r0.y, r1.y, r2.y, 0.0,
              r0.z, r1.z, r2.z, 0.0,
              r0.w, r1.w, r2.w, 1.0);
}

mat4 speciesPose() {
  mat4 a = speciesRow(aJoint, aPose.x);
  #ifdef CROWD_SMOOTH
    mat4 b = speciesRow(aJoint, aPose.y);
    // Adjacent frames of one clip are close enough that lerping the matrices outright reads as
    // smooth; it saves decomposing a rotation per vertex.
    return mat4(mix(a[0], b[0], aPose.z), mix(a[1], b[1], aPose.z),
                mix(a[2], b[2], aPose.z), mix(a[3], b[3], aPose.z));
  #else
    return a;
  #endif
}

mat3 speciesYaw(float a) {
  float c = cos(a); float s = sin(a);
  return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}
vec3 speciesTransform(vec3 p, mat4 pose) {
  return speciesYaw(aRoot.w) * ((pose * vec4(p, 1.0)).xyz * uScale) + aRoot.xyz;
}
vec3 speciesNormal(vec3 n, mat4 pose) {
  return speciesYaw(aRoot.w) * normalize(mat3(pose) * n);
}
`;

const COLOR = /* glsl */ `
#include <color_vertex>
#ifdef USE_COLOR
  float cH1 = fract(sin(float(gl_InstanceID) * 12.9898) * 43758.5453);
  float cH2 = fract(sin(float(gl_InstanceID) * 78.233) * 12345.6789);
  if (aMat > 0.5 && aMat < 1.5) vColor.xyz = mix(uTeamA, uTeamB, aPose.w) * (0.85 + 0.3 * cH2);
  else if (aMat > 1.5 && aMat < 2.5) vColor.xyz = mix(uHairA, uHairB, cH1 * cH1);
  else if (aMat > 2.5) vColor.xyz = mix(uSkinA, uSkinB, cH2 * 0.8);
  #ifdef CROWD_TINT
    vColor.xyz = mix(vColor.xyz, vec3(1.0), clamp(aFlash, 0.0, 1.0));
  #endif
#endif
`;

/** Writes an instance's (row, nextRow, mix, team) for a clip that starts on row `base`, at a time in seconds. */
export function writeFrame(pose: Float32Array, i: number, c: Clip, base: number, seconds: number, team = 0): void {
  const t = seconds * c.fps;
  let f = c.loop ? t % c.frames : Math.min(t, c.frames - 1);
  if (f < 0) f += c.frames;
  const a = Math.floor(f);
  const b = c.loop ? (a + 1) % c.frames : Math.min(a + 1, c.frames - 1);
  const at = i * 4;
  pose[at] = base + a;
  pose[at + 1] = base + b;
  pose[at + 2] = f - a;
  pose[at + 3] = team;
}

export function instanced(src: THREE.BufferGeometry, count: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.index = src.index;
  for (const [name, attr] of Object.entries(src.attributes)) g.setAttribute(name, attr);
  g.instanceCount = count;
  return g;
}

export class SpeciesCrowd {
  readonly group = new THREE.Group();
  readonly trianglesPerInstance: number;
  readonly species: SpeciesDef;
  /** (x, y, z, yaw) per instance; write directly and call flush(). */
  readonly root: Float32Array;
  /** (row, nextRow, mix, team) per instance. Prefer pose(); this is the raw buffer. */
  readonly pose: Float32Array;
  /** 0..1 hit flash per instance, when the crowd was built with `tint`. */
  readonly flash: Float32Array | null;
  private flashAttr: THREE.InstancedBufferAttribute | null = null;
  /** The live (x, y, z, yaw) attribute, so a caller can hang its own instanced mesh off it. */
  readonly rootAttribute: THREE.InstancedBufferAttribute;
  private rootAttr: THREE.InstancedBufferAttribute;
  private poseAttr: THREE.InstancedBufferAttribute;
  private rows: number[];
  private meshes: THREE.Mesh[] = [];

  constructor(species: SpeciesDef, readonly capacity: number, opts: SpeciesCrowdOptions = {}) {
    this.species = species;
    this.rows = clipRows(species);
    this.root = new Float32Array(capacity * 4);
    this.pose = new Float32Array(capacity * 4);
    this.rootAttr = new THREE.InstancedBufferAttribute(this.root, 4).setUsage(THREE.DynamicDrawUsage);
    this.poseAttr = new THREE.InstancedBufferAttribute(this.pose, 4).setUsage(THREE.DynamicDrawUsage);
    this.rootAttribute = this.rootAttr;

    this.flash = opts.tint ? new Float32Array(capacity) : null;
    if (this.flash) this.flashAttr = new THREE.InstancedBufferAttribute(this.flash, 1).setUsage(THREE.DynamicDrawUsage);

    const base = buildProxyGeometry(species);
    this.trianglesPerInstance = proxyTriangles(base);
    const geo = instanced(base, capacity);
    geo.setAttribute('aRoot', this.rootAttr);
    geo.setAttribute('aPose', this.poseAttr);
    if (this.flashAttr) geo.setAttribute('aFlash', this.flashAttr);

    const { texture, width, height } = buildPoseTexture(species);
    const p = opts.palette ?? {};
    const uniforms = {
      uPose: { value: texture },
      uPoseSize: { value: new THREE.Vector2(width, height) },
      uScale: { value: opts.scale ?? 1 },
      uTeamA: { value: new THREE.Color(p.teamA ?? 0x3a6ea5) },
      uTeamB: { value: new THREE.Color(p.teamB ?? 0xb33a3a) },
      uHairA: { value: new THREE.Color(p.hairA ?? 0x2b1a10) },
      uHairB: { value: new THREE.Color(p.hairB ?? 0xd9b26a) },
      uSkinA: { value: new THREE.Color(p.skinA ?? 0xf1c27d) },
      uSkinB: { value: new THREE.Color(p.skinB ?? 0x8d5524) },
    };
    const smooth = opts.smooth !== false;
    const defines = (smooth ? '#define CROWD_SMOOTH\n' : '') + (opts.tint ? '#define CROWD_TINT\n' : '');

    const mat = toon(0xffffff, { vertexColors: true });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          ${defines}${SPECIES_GLSL}
          uniform vec3 uTeamA; uniform vec3 uTeamB; uniform vec3 uHairA; uniform vec3 uHairB; uniform vec3 uSkinA; uniform vec3 uSkinB;`,
        )
        .replace('#include <color_vertex>', COLOR)
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
          mat4 cPose = speciesPose();
          objectNormal = speciesNormal(objectNormal, cPose);`,
        )
        .replace('#include <begin_vertex>', 'vec3 transformed = speciesTransform(position, cPose);');
    };
    mat.customProgramCacheKey = () => `species-${species.id}-${smooth ? 's' : 'h'}${opts.tint ? 't' : ''}`;
    const bodies = new THREE.Mesh(geo, mat);
    bodies.frustumCulled = false;
    this.group.add(bodies);
    this.meshes.push(bodies);
  }

  setCount(n: number): void {
    const count = Math.max(0, Math.min(n, this.capacity));
    for (const m of this.meshes) (m.geometry as THREE.InstancedBufferGeometry).instanceCount = count;
  }

  place(i: number, x: number, y: number, z: number, yaw: number): void {
    const at = i * 4;
    this.root[at] = x;
    this.root[at + 1] = y;
    this.root[at + 2] = z;
    this.root[at + 3] = yaw;
  }

  /** Picks the frame pair for a clip at a time in seconds, and the team tint 0..1. */
  animate(i: number, clip: number, seconds: number, team = 0): void {
    const c = this.species.clips[clip];
    if (!c) return;
    writeFrame(this.pose, i, c, this.rows[clip], seconds, team);
  }

  flush(): void {
    this.rootAttr.needsUpdate = true;
    this.poseAttr.needsUpdate = true;
    if (this.flashAttr) this.flashAttr.needsUpdate = true;
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
