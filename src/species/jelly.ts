import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SPECIES_GLSL, instanced, writeFrame } from './crowd';
import { buildPoseTexture } from './pose';
import { MATRIX_STRIDE, clipRows, type SpeciesDef } from './types';
import { TAU } from '../util/math';

// The new look's slimes (src/render/look.ts): a gumdrop of glossy jelly the sun shines through,
// whatever it swallowed floating inside, and a face painted on its front that
// changes with what it is doing. The same skeleton and baked clips as the box slime
// (builtin/slime.ts), so they move exactly as the rules expect; four draw calls per size (the soft
// pool of light under it, what's inside, the jelly's far side, its near side) however many are out.

/** What a size of slime carries inside, and what it wears. */
interface JellyLook {
  inside: Array<'leaf' | 'pebble' | 'coins' | 'dagger' | 'gems'>;
  crown?: boolean;
}

// By actor kind (shared/actors.json). Things inside are authored at about their real size, divided
// by the kind's scale, so a great slime's coins are coin-sized.
const LOOKS: Record<string, JellyLook> = {
  slimelet: { inside: [] },
  slime: { inside: ['leaf', 'pebble'] },
  'great-slime': { inside: ['coins', 'dagger'] },
  'slime-monarch': { inside: ['gems'], crown: true },
};

/** Faces by clip: 1 set to pounce, 2 dazed, 3 dead; anything else is the usual face. */
const MOODS: Record<string, number> = { windup: 1, leap: 1, gather: 1, dazed: 2, die: 3 };
/** The gumdrop's widest radius and height, in the slime's bind space (metres at scale 1). */
const R = 0.38;
const H = 0.62;

/**
 * The jelly: a lathed gumdrop, widest a third of the way up, domed on top, its underside curling
 * in to a small flat patch on the ground, so its edge is round where it meets the grass.
 */
function shellGeometry(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const mid = 0.2; // height of the widest point
  for (let i = 0; i <= 10; i++) {
    const a = -Math.PI / 2 + (i / 10) * (Math.PI / 2);
    pts.push(new THREE.Vector2(R * Math.pow(Math.cos(a), 0.62), mid * (1 + Math.sin(a))));
  }
  for (let i = 1; i <= 14; i++) {
    const a = (i / 14) * (Math.PI / 2);
    pts.push(new THREE.Vector2(R * Math.pow(Math.cos(a), 0.78), mid + (H - mid) * Math.sin(a)));
  }
  pts[0].x = 0;
  pts[pts.length - 1].x = 0;
  // Bottom to top, so the lathe winds its faces outward.
  const g = new THREE.LatheGeometry(pts, 36);
  g.computeVertexNormals();
  return g;
}

function tag(g: THREE.BufferGeometry, joint: number, mat: number, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
  const n = geo.attributes.position.count;
  geo.setAttribute('aJoint', new THREE.BufferAttribute(new Float32Array(n).fill(joint), 1));
  geo.setAttribute('aMat', new THREE.BufferAttribute(new Float32Array(n).fill(mat), 1));
  const c = new THREE.Color(color);
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/** Places a part: scale, then turn (Euler, radians), then move. */
function put(g: THREE.BufferGeometry, at: [number, number, number], turn: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1]): THREE.BufferGeometry {
  g.scale(...scale);
  g.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...turn)));
  g.translate(...at);
  return g;
}

function leaf(len: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-len / 2, 0);
  s.quadraticCurveTo(0, len * 0.32, len / 2, 0);
  s.quadraticCurveTo(0, -len * 0.32, -len / 2, 0);
  return new THREE.ShapeGeometry(s, 6);
}

/** A rusty dagger along +Y, its parts with their colours. */
function dagger(len: number): Array<[THREE.BufferGeometry, number]> {
  const blade = new THREE.OctahedronGeometry(1, 0);
  blade.scale(len * 0.09, len * 0.34, len * 0.022);
  blade.translate(0, len * 0.24, 0);
  const guard = new THREE.BoxGeometry(len * 0.3, len * 0.045, len * 0.06);
  guard.translate(0, -len * 0.08, 0);
  const grip = new THREE.CylinderGeometry(len * 0.03, len * 0.034, len * 0.22, 6);
  grip.translate(0, -len * 0.2, 0);
  const pommel = new THREE.IcosahedronGeometry(len * 0.05, 0);
  pommel.translate(0, -len * 0.33, 0);
  return [[blade, 0x8a5a3a], [guard, 0x6b4b2e], [grip, 0x4a3020], [pommel, 0x6b4b2e]];
}

function crown(core: number): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const r = 0.1;
  const base = H - 0.02;
  const band = new THREE.CylinderGeometry(r, r * 0.96, 0.05, 20, 1, true);
  band.translate(0, base + 0.02, 0);
  parts.push(tag(band, core, 0, 0xe2b13c));
  const rim = new THREE.TorusGeometry(r * 0.98, 0.009, 5, 24);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, base, 0);
  parts.push(tag(rim, core, 0, 0xc8952a));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + Math.PI / 2;
    const spike = new THREE.ConeGeometry(0.026, 0.08, 5);
    spike.translate(Math.cos(a) * r * 0.95, base + 0.085, Math.sin(a) * r * 0.95);
    parts.push(tag(spike, core, 0, 0xe2b13c));
    const ball = new THREE.IcosahedronGeometry(0.014, 1);
    ball.translate(Math.cos(a) * r * 0.95, base + 0.128, Math.sin(a) * r * 0.95);
    parts.push(tag(ball, core, 0, 0xf4d06a));
  }
  const jewel = new THREE.OctahedronGeometry(0.02, 0);
  jewel.scale(1, 1.3, 0.6);
  jewel.translate(0, base + 0.025, r + 0.004);
  parts.push(tag(jewel, core, 0, 0xc0283a));
  return parts;
}

/** What floats inside a size of slime, bound to the core so it squashes with the jelly. */
function insideGeometry(look: JellyLook, scale: number, core: number): THREE.BufferGeometry {
  const k = 1.5 / scale; // real sizes into bind space, half as big again so they read from the camera
  const parts: THREE.BufferGeometry[] = [];
  for (const what of look.inside) {
    if (what === 'leaf') parts.push(tag(put(leaf(0.13 * k), [0.15, 0.15, 0.13], [0.2, -0.35, 0.7]), core, 0, 0xb5652a));
    if (what === 'pebble') parts.push(tag(put(new THREE.IcosahedronGeometry(1, 1), [-0.12, 0.13, 0.12], [0.3, 0.6, 0], [0.05 * k, 0.034 * k, 0.042 * k]), core, 0, 0x8d8f91));
    if (what === 'coins') {
      const spots: Array<[number, number, number]> = [[-0.15, 0.12, 0.1], [-0.04, 0.07, 0.17], [0.13, 0.15, 0.1], [0.02, 0.3, 0.08], [-0.09, 0.27, 0.12]];
      spots.forEach((at, i) => parts.push(tag(put(new THREE.CylinderGeometry(0.026 * k, 0.026 * k, 0.006 * k, 14), at, [1.2 + i * 0.5, i * 0.9, 0.4 * i]), core, 0, i === 2 ? 0xc9ccd0 : 0xe0b448)));
    }
    if (what === 'dagger') for (const [p, c] of dagger(0.34 * k)) parts.push(tag(put(p, [0.13, 0.15, 0.06], [0.2, 0.3, -1.1]), core, 0, c));
    if (what === 'gems') {
      const gems: Array<[[number, number, number], number]> = [
        [[-0.17, 0.2, 0.08], 0xd8344a],
        [[0.15, 0.27, 0.09], 0x3a7be0],
        [[-0.04, 0.12, 0.18], 0x2fb26a],
        [[0.08, 0.36, 0.05], 0xf0a030],
        [[-0.11, 0.37, 0.02], 0xe070c0],
      ];
      gems.forEach(([at, c], i) => parts.push(tag(put(new THREE.OctahedronGeometry(1, 0), at, [0.4 * i, 0.7 * i, 0.2], [0.03 * k, 0.042 * k, 0.03 * k]), core, 0, c)));
    }
  }
  if (look.crown) parts.push(...crown(core));
  if (!parts.length) parts.push(tag(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3)).setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(9), 3)), core, 0, 0xffffff));
  const merged = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
  if (!merged) throw new Error('jelly: inside parts did not merge');
  return merged;
}

// Painted on the jelly's front, in its own bind space, so the face squashes with the body.
const FACE = /* glsl */ `
float jEllipse(vec2 p, vec2 r) { return (length(p / r) - 1.0) * min(r.x, r.y); }
float jCapsule(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
// x: ink (eyes, mouth), y: shine (the eyes' highlights), each 0..1 with soft edges.
vec2 jFace(vec3 p, vec3 n, float mood) {
  if (n.z < 0.1) return vec2(0.0);
  float ink = 1e3;
  float shine = 1e3;
  for (int i = 0; i < 2; i++) {
    float side = i == 0 ? -1.0 : 1.0;
    vec2 e = p.xy - vec2(0.125 * side, 0.36);
    if (mood < 0.5) {
      ink = min(ink, jEllipse(e, vec2(0.043, 0.062)));
      shine = min(shine, length(e - vec2(-0.013, 0.022)) - 0.0165);
      shine = min(shine, length(e - vec2(0.014, -0.026)) - 0.0075);
    } else if (mood < 1.5) {
      // Set to pounce: the eyes cut off by a frown sloping down to the middle.
      float d = jEllipse(e, vec2(0.043, 0.058));
      float brow = e.y - (0.006 + 0.6 * e.x * side);
      ink = min(ink, max(d, brow));
      shine = min(shine, max(length(e - vec2(-0.01, -0.008)) - 0.012, brow + 0.012));
    } else if (mood < 2.5) {
      ink = min(ink, jCapsule(e, vec2(-0.038, 0.005), vec2(0.0, -0.008), 0.009));
      ink = min(ink, jCapsule(e, vec2(0.0, -0.008), vec2(0.038, 0.005), 0.009));
    } else {
      ink = min(ink, jCapsule(e, vec2(-0.034, -0.034), vec2(0.034, 0.034), 0.0095));
      ink = min(ink, jCapsule(e, vec2(-0.034, 0.034), vec2(0.034, -0.034), 0.0095));
    }
  }
  vec2 m = p.xy - vec2(0.0, 0.27);
  if (mood < 0.5) ink = min(ink, max(abs(length(m - vec2(0.0, 0.032)) - 0.033) - 0.007, m.y - 0.014));
  else if (mood < 1.5) ink = min(ink, jEllipse(m, vec2(0.02, 0.026)));
  else if (mood < 2.5) ink = min(ink, jCapsule(m, vec2(-0.022, 0.0), vec2(0.022, 0.0), 0.0065));
  else ink = min(ink, jEllipse(m, vec2(0.016, 0.016)));
  float aa = max(fwidth(p.x), fwidth(p.y)) * 1.2;
  return vec2(1.0 - smoothstep(-aa, aa, ink), 1.0 - smoothstep(-aa, aa, shine));
}
`;

export interface JellyOptions {
  /** The actor kind (shared/actors.json), for what floats inside. */
  kind: string;
  palette?: { teamA: number; teamB: number };
  scale?: number;
}

/** Draws any number of one size of slime as jelly; the same calls as SpeciesCrowd. */
export class JellyCrowd {
  readonly group = new THREE.Group();
  readonly species: SpeciesDef;
  readonly root: Float32Array;
  readonly pose: Float32Array;
  readonly flash: Float32Array;
  private mood: Float32Array;
  private attrs: THREE.InstancedBufferAttribute[];
  private rows: number[];
  private moods: number[];
  private meshes: THREE.Mesh[] = [];
  private uniforms: Record<string, THREE.IUniform>;
  private core: number;

  constructor(species: SpeciesDef, readonly capacity: number, opts: JellyOptions) {
    this.species = species;
    this.rows = clipRows(species);
    this.moods = species.clips.map((c) => MOODS[c.name] ?? 0);
    this.root = new Float32Array(capacity * 4);
    this.pose = new Float32Array(capacity * 4);
    this.flash = new Float32Array(capacity);
    this.mood = new Float32Array(capacity);
    const rootAttr = new THREE.InstancedBufferAttribute(this.root, 4).setUsage(THREE.DynamicDrawUsage);
    const poseAttr = new THREE.InstancedBufferAttribute(this.pose, 4).setUsage(THREE.DynamicDrawUsage);
    const flashAttr = new THREE.InstancedBufferAttribute(this.flash, 1).setUsage(THREE.DynamicDrawUsage);
    const moodAttr = new THREE.InstancedBufferAttribute(this.mood, 1).setUsage(THREE.DynamicDrawUsage);
    this.attrs = [rootAttr, poseAttr, flashAttr, moodAttr];

    const core = species.joints.findIndex((j) => j.name === 'core');
    if (core < 0) throw new Error(`jelly: species ${species.id} has no core joint`);
    this.core = core;
    const { texture, width, height } = buildPoseTexture(grounded(species, core));
    const palette = opts.palette ?? { teamA: 0x5fa054, teamB: 0x4b8c4a };
    this.uniforms = {
      uPose: { value: texture },
      uPoseSize: { value: new THREE.Vector2(width, height) },
      uScale: { value: opts.scale ?? 1 },
      uBody: { value: new THREE.Color(palette.teamA) },
      uDeep: { value: new THREE.Color(palette.teamB) },
    };

    const withInstances = (g: THREE.BufferGeometry) => {
      const geo = instanced(g, capacity);
      geo.setAttribute('aRoot', rootAttr);
      geo.setAttribute('aPose', poseAttr);
      geo.setAttribute('aFlash', flashAttr);
      geo.setAttribute('aMood', moodAttr);
      return geo;
    };
    const shellGeo = withInstances(tag(shellGeometry(), core, 1, 0xffffff));
    const look = LOOKS[opts.kind] ?? LOOKS.slime;
    const insideGeo = withInstances(insideGeometry(look, opts.scale ?? 1, core));

    const pool = new THREE.Mesh(withInstances(tag(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), 0, 0, 0xffffff)), this.poolMaterial());
    const inside = new THREE.Mesh(insideGeo, this.insideMaterial());
    const back = new THREE.Mesh(shellGeo, this.shellMaterial(true));
    const front = new THREE.Mesh(shellGeo, this.shellMaterial(false));
    pool.renderOrder = 1;
    back.renderOrder = 2;
    front.renderOrder = 3;
    for (const m of [pool, inside, back, front]) {
      m.frustumCulled = false;
      this.group.add(m);
      this.meshes.push(m);
    }
  }

  /** The vertex half every material shares: pose the vertex, keep its bind-space place for the face. */
  private vertex(shader: { vertexShader: string; uniforms: Record<string, THREE.IUniform> }, face: boolean): void {
    Object.assign(shader.uniforms, this.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        #define CROWD_SMOOTH
        ${SPECIES_GLSL}
        attribute float aFlash;
        attribute float aMood;
        uniform vec3 uBody;
        uniform vec3 uDeep;
        varying vec3 vJTint;
        varying float vJFlash;
        varying vec3 vJBindN;
        ${face ? 'varying vec3 vJBind; varying float vJMood;' : ''}`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        mat4 cPose = speciesPose();
        objectNormal = speciesNormal(objectNormal, cPose);
        vJBindN = normal;
        ${face ? 'vJBind = position; vJMood = aMood;' : ''}
        float jH = fract(sin(float(gl_InstanceID) * 78.233) * 12345.6789);
        vJTint = (0.93 + 0.14 * jH) * (aMat > 0.5 ? uBody * 1.12 * color : color);
        vJFlash = aFlash;`,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = speciesTransform(position, cPose);');
  }

  private insideMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide, vertexColors: true });
    mat.onBeforeCompile = (shader) => {
      this.vertex(shader, false);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vJTint;\nvarying float vJFlash;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vJTint;')
        .replace('#include <opaque_fragment>', 'outgoingLight += vJTint * 0.25;\noutgoingLight = mix(outgoingLight, vec3(1.0), clamp(vJFlash, 0.0, 1.0) * 0.6);\n#include <opaque_fragment>');
    };
    mat.customProgramCacheKey = () => 'jelly-inside';
    return mat;
  }

  /** The jelly itself: its far side first (deeper, dimmer), then its near side with the face. */
  private shellMaterial(back: boolean): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.85,
      metalness: 0,
      vertexColors: true,
      transparent: true,
      depthWrite: !back,
      side: back ? THREE.BackSide : THREE.FrontSide,
    });
    mat.onBeforeCompile = (shader) => {
      this.vertex(shader, !back);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vJTint;
          varying float vJFlash;
          varying vec3 vJBindN;
          ${back ? '' : `varying vec3 vJBind; varying float vJMood;\n${FACE}`}`,
        )
        .replace(
          '#include <color_fragment>',
          back
            ? '#include <color_fragment>\nif (normalize(vJBindN).y < -0.35) discard;\ndiffuseColor.rgb = vJTint * 0.8;'
            : `#include <color_fragment>
            vec2 jF = jFace(vJBind, normalize(vJBindN), vJMood);
            diffuseColor.rgb = mix(vJTint, vec3(0.035, 0.04, 0.05), jF.x);`,
        )
        .replace(
          '#include <opaque_fragment>',
          `{
            vec3 jV = normalize(vViewPosition);
            float jFres = pow(1.0 - clamp(abs(dot(normal, jV)), 0.0, 1.0), 2.5);
            // Light scattered inside: jelly glows with its own colour, most where the sun is behind it.
            float jLit = ${back ? '1.0' : '1.0 - jF.x'};
            #if NUM_DIR_LIGHTS > 0
              float jThrough = pow(max(-dot(jV, directionalLights[0].direction), 0.0), 2.0);
              outgoingLight += jLit * vJTint * vJTint * directionalLights[0].color * (0.2 + 0.6 * jThrough) * (1.0 - 0.4 * jFres);
            #endif
            #if NUM_HEMI_LIGHTS > 0
              outgoingLight += jLit * vJTint * hemisphereLights[0].skyColor * 0.12;
            #endif
            ${
              back
                ? 'outgoingLight = vJTint * 0.5; diffuseColor.a = 0.3;'
                : `// Gloss: a soft window of light up and to the left whatever the sun is doing, and a bright rim.
                  float jWin = smoothstep(0.8, 0.95, dot(normal, normalize(vec3(-0.5, 0.6, 0.62))));
                  outgoingLight += jLit * (vec3(jWin * 0.75) + vJTint * jFres * 0.45);
                  float jGlint = 0.0;
                  #if NUM_DIR_LIGHTS > 0
                    jGlint = smoothstep(0.986, 0.996, dot(normal, normalize(directionalLights[0].direction + jV)));
                    outgoingLight += jLit * directionalLights[0].color * jGlint * 0.9;
                  #endif
                  outgoingLight = mix(outgoingLight, vec3(1.3), jF.y);
                  diffuseColor.a = max(max(mix(0.3, 0.95, jFres), max(jWin * 0.8, jGlint)), max(jF.x, jF.y));`
            }
            outgoingLight = mix(outgoingLight, vec3(1.0), clamp(vJFlash, 0.0, 1.0) * 0.7);
            diffuseColor.a = max(diffuseColor.a, clamp(vJFlash, 0.0, 1.0) * 0.8);
          }
          #include <opaque_fragment>`,
        );
    };
    mat.customProgramCacheKey = () => `jelly-shell-${back ? 'back' : 'front'}`;
    return mat;
  }

  /**
   * The light through a jelly is green and soft, so it gets a soft green pool on the ground rather
   * than a hard shadow (which, seen through the jelly, cut the grass behind it into light and dark).
   */
  private poolMaterial(): THREE.ShaderMaterial {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      vertexShader: /* glsl */ `
        #define CROWD_SMOOTH
        ${SPECIES_GLSL}
        uniform vec3 uBody;
        varying vec2 vUv;
        varying float vFade;
        void main() {
          // How high the jelly's base has hopped (grounded() puts it where the root is), and how
          // wide it is spread.
          mat4 core = speciesRow(${this.core.toFixed(1)}, aPose.x);
          float up = core[3].y;
          float wide = length(core[0].xyz);
          float k = 1.0 - 0.5 * clamp(up / 0.9, 0.0, 1.0);
          vUv = position.xz * 2.0;
          vFade = k;
          vec3 p = vec3(position.x, 0.0, position.z) * ${(R * 2.5).toFixed(3)} * wide * k * uScale;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p + aRoot.xyz + vec3(0.0, 0.01, 0.0), 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uBody;
        varying vec2 vUv;
        varying float vFade;
        void main() {
          float d = length(vUv);
          float a = (1.0 - smoothstep(0.2, 1.0, d)) * 0.6 * vFade;
          gl_FragColor = vec4(uBody * 0.22, a);
          #include <colorspace_fragment>
        }
      `,
    });
    return mat;
  }

  setCount(n: number): void {
    const count = Math.max(0, Math.min(n, this.capacity));
    for (const m of this.meshes) (m.geometry as THREE.InstancedBufferGeometry).instanceCount = count;
  }

  place(i: number, x: number, y: number, z: number, yaw: number): void {
    this.root.set([x, y, z, yaw], i * 4);
  }

  animate(i: number, clip: number, seconds: number, team = 0): void {
    const c = this.species.clips[clip];
    if (!c) return;
    writeFrame(this.pose, i, c, this.rows[clip], seconds, team);
    this.mood[i] = this.moods[clip];
  }

  flush(): void {
    for (const a of this.attrs) a.needsUpdate = true;
  }

  dispose(): void {
    const done = new Set<unknown>();
    for (const m of this.meshes) {
      for (const d of [m.geometry, m.material as THREE.Material]) {
        if (d && !done.has(d)) {
          done.add(d);
          d.dispose();
        }
      }
    }
    (this.uniforms.uPose.value as THREE.Texture).dispose();
  }
}

/**
 * The clips with every frame lifted or lowered so the jelly's base sits where the root is. The box
 * slime squashes about its middle, which would leave a squashed jelly hanging in the air.
 */
function grounded(species: SpeciesDef, core: number): SpeciesDef {
  const n = species.joints.length;
  const clips = species.clips.map((c) => {
    const m = c.matrices.slice();
    for (let f = 0; f < c.frames; f++) {
      // A joint's matrix maps bind space to posed space, so its translation is where the bind
      // origin (the middle of the jelly's base) ends up; the root's is where the ground is.
      const lift = m[f * n * MATRIX_STRIDE + 7] - m[(f * n + core) * MATRIX_STRIDE + 7];
      for (let j = 0; j < n; j++) m[(f * n + j) * MATRIX_STRIDE + 7] += lift;
    }
    return { ...c, matrices: m };
  });
  return { ...species, clips };
}
