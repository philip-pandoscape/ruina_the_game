import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, range } from '../../util/rng';
import { GRAPHICS, PALETTE, POST } from '../look';

// Sky dome, sun, drifting clouds and the world tree standing over the horizon.

export const SKY_HORIZON = PALETTE.sky.horizon;
const SKY_TOP = PALETTE.sky.top;

const vertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * p;
    gl_Position.z = gl_Position.w; // always at the far plane
  }
`;

const fragment = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uSunDir;
  uniform vec3 uSun;
  uniform vec3 uMoonDir;
  uniform float uNight;
  uniform float uDisc;
  uniform vec3 uSeaFar;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = mix(uHorizon, uTop, pow(smoothstep(-0.02, 0.55, h), 0.75));
    // Under the horizon: the sea, far off and hazy, fading into the horizon at the line itself.
    if (h < 0.0) col = mix(uSeaFar, uHorizon, exp(h * 40.0));
    float s = max(dot(d, normalize(uSunDir)), 0.0);
    col += uSun * (step(0.9993, s) * uDisc + pow(s, 24.0) * 0.22 + pow(s, 4.0) * 0.05) * (1.0 - uNight);
    float m = max(dot(d, normalize(uMoonDir)), 0.0);
    col += vec3(0.86, 0.9, 1.0) * (step(0.9996, m) * 0.85 + pow(m, 60.0) * 0.12) * uNight;
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export class SkyView {
  readonly group = new THREE.Group();
  private dome: THREE.Mesh;
  private uniforms: Record<string, THREE.IUniform>;
  private stars: THREE.Points;
  private clouds: THREE.InstancedMesh;
  private cloudBase: Array<{ x: number; y: number; z: number; s: number; r: number }> = [];
  private dummy = new THREE.Object3D();
  /** The clouds: painted light, bright tops and blue-grey bellies, never brighter than white. */
  private cloudLight = cloudShading();
  /** The world tree, shaded the same way in the haze's colours (depth not written: the screen
   *  haze treats it as sky, so its haze is painted in here). */
  private treeLight = (() => {
    const t = cloudShading(10, 55);
    t.material.depthWrite = false;
    // Past the end of the view (a short one, at low quality) it is drawn on the far plane, as the
    // sky is, rather than cut off.
    t.material.defines = { HOLD_AT_FAR: '' };
    return t;
  })();

  constructor(sunDir: THREE.Vector3) {
    this.uniforms = {
      uTop: { value: new THREE.Color(SKY_TOP) },
      uHorizon: { value: new THREE.Color(SKY_HORIZON) },
      uSunDir: { value: sunDir.clone().normalize() },
      uSun: { value: new THREE.Color(0xfff3d6) },
      uMoonDir: { value: new THREE.Vector3(-0.4, 0.55, -0.7).normalize() },
      uNight: { value: 0 },
      // The sun is brighter than white, so the bloom catches it.
      uDisc: { value: POST.sunDisc },
      // The far sea under the horizon (seaFar).
      uSeaFar: { value: new THREE.Color(SKY_HORIZON) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vertex,
      fragmentShader: fragment,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), mat);
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    this.group.add(this.dome);

    // Clouds: lumpy and flat-bottomed, scattered high over the isle; how many is the quality's.
    const rng = makeRng(4242);
    const { count, detail } = GRAPHICS.clouds;
    this.clouds = new THREE.InstancedMesh(cumulus(detail), this.cloudLight.material, count);
    for (let i = 0; i < count; i++) {
      this.cloudBase.push({
        x: range(rng, -1300, 1300),
        y: range(rng, 170, 290),
        z: range(rng, -1300, 1300),
        s: range(rng, 0.8, 2.1) * 1.25,
        r: rng() * Math.PI * 2,
      });
    }
    this.clouds.frustumCulled = false;
    this.clouds.castShadow = false;
    this.group.add(this.clouds);
    // Stars, for the nights.
    const starPos = new Float32Array(900 * 3);
    for (let i = 0; i < 900; i++) {
      const a = rng() * Math.PI * 2;
      const y = 0.08 + rng() * 0.92;
      const r = Math.sqrt(1 - y * y);
      starPos.set([Math.cos(a) * r * 1300, y * 1300, Math.sin(a) * r * 1300], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.stars = new THREE.Points(
      sg,
      new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false }),
    );
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -9;
    this.group.add(this.stars);
    this.group.add(worldTree(this.treeLight.material));
    this.update(0, 0, 0);
  }

  /** Sky colours, sun and moon for the time of day (night 0..1). */
  setLight(top: THREE.Color, horizon: THREE.Color, sunDir: THREE.Vector3, sun: THREE.Color, night: number, moonDir: THREE.Vector3): void {
    (this.uniforms.uTop.value as THREE.Color).copy(top);
    (this.uniforms.uHorizon.value as THREE.Color).copy(horizon);
    (this.uniforms.uSeaFar.value as THREE.Color).copy(seaFar(horizon, night));
    (this.uniforms.uSunDir.value as THREE.Vector3).copy(sunDir);
    (this.uniforms.uSun.value as THREE.Color).copy(sun);
    (this.uniforms.uMoonDir.value as THREE.Vector3).copy(moonDir);
    this.uniforms.uNight.value = night;
    (this.stars.material as THREE.PointsMaterial).opacity = Math.max(0, night - 0.15) * 1.1;
    this.stars.visible = night > 0.15;
    const cu = this.cloudLight.uniforms;
    (cu.uSunDir.value as THREE.Vector3).copy(sunDir).normalize();
    (cu.uLit.value as THREE.Color)
      .setRGB(1.12, 1.1, 1.06)
      .lerp(sun, 0.25)
      .multiplyScalar(1 - night * 0.82);
    (cu.uShade.value as THREE.Color)
      .copy(top)
      .lerp(horizon, 0.55)
      .lerp(new THREE.Color(0x9aa6b8), 0.5)
      .multiplyScalar(1 - night * 0.78);
    const tu = this.treeLight.uniforms;
    const leaves = new THREE.Color(PALETTE.worldTree.leaves);
    (tu.uSunDir.value as THREE.Vector3).copy(sunDir).normalize();
    (tu.uLit.value as THREE.Color)
      .copy(leaves)
      .lerp(horizon, 0.5)
      .lerp(sun, 0.1)
      .multiplyScalar(1.05 * (1 - night * 0.8));
    (tu.uShade.value as THREE.Color)
      .copy(leaves)
      .multiplyScalar(0.55)
      .lerp(horizon, 0.62)
      .lerp(top, 0.1)
      .multiplyScalar(1 - night * 0.8);
  }

  /** Keeps the dome around the camera and drifts the clouds with the wind. */
  update(time: number, cx: number, cz: number, windX = 1, windZ = 0.35): void {
    this.dome.position.set(cx, 0, cz);
    this.stars.position.set(cx, 0, cz);
    const drift = time * 2.2;
    const span = 2600;
    this.cloudBase.forEach((c, i) => {
      let x = c.x + windX * drift;
      let z = c.z + windZ * drift;
      x = ((((x - cx + span / 2) % span) + span) % span) + cx - span / 2;
      z = ((((z - cz + span / 2) % span) + span) % span) + cz - span / 2;
      this.dummy.position.set(x, c.y, z);
      this.dummy.rotation.set(0, c.r, 0);
      this.dummy.scale.set(c.s, c.s * 0.75, c.s);
      this.dummy.updateMatrix();
      this.clouds.setMatrixAt(i, this.dummy.matrix);
    });
    this.clouds.instanceMatrix.needsUpdate = true;
  }
}

// A cloud: a cauliflower of lumps with a flat belly, its normals leaning out from the middle, lit
// by a shader that keeps it below the bloom: white where the sun falls, the sky's blue-grey
// underneath. `detail` is how finely each lump is cut (an icosahedron's).
function cumulus(detail: number): THREE.BufferGeometry {
  const rng = makeRng(77);
  const lumps: THREE.BufferGeometry[] = [];
  const centre = new THREE.Vector3(0, 2, 0);
  for (let k = 0; k < 15; k++) {
    const a = rng() * Math.PI * 2;
    const d = k === 0 ? 0 : range(rng, 3, 15);
    const r = k === 0 ? 10 : range(rng, 4.5, 8.5) * (1 - d / 30);
    const g = new THREE.IcosahedronGeometry(r, detail);
    g.translate(Math.cos(a) * d * 1.3, range(rng, -1, 4) + (1 - d / 15) * 3, Math.sin(a) * d * 0.8);
    lumps.push(g);
  }
  const g = mergeGeometries(lumps);
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) < -2.5) p.setY(i, -2.5 + (p.getY(i) + 2.5) * 0.2);
    v.fromBufferAttribute(p, i)
      .sub(centre)
      .multiply(new THREE.Vector3(0.6, 1, 0.8))
      .normalize();
    v.lerp(new THREE.Vector3(n.getX(i), n.getY(i), n.getZ(i)), 0.5).normalize();
    n.setXYZ(i, v.x, v.y, v.z);
  }
  return g;
}

function cloudShading(upFrom = -2.5, upSpan = 16): { material: THREE.ShaderMaterial; uniforms: Record<string, THREE.IUniform> } {
  const uniforms = {
    uUpFrom: { value: upFrom },
    uUpSpan: { value: upSpan },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uLit: { value: new THREE.Color(1, 1, 1) },
    uShade: { value: new THREE.Color(0.7, 0.75, 0.82) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      uniform float uUpFrom;
      uniform float uUpSpan;
      varying vec3 vN;
      varying float vUp;
      void main() {
        #ifdef USE_INSTANCING
          vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        #else
          vN = normalize(mat3(modelMatrix) * normal);
        #endif
        vUp = clamp((position.y - uUpFrom) / uUpSpan, 0.0, 1.0);
        #ifdef USE_INSTANCING
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        #else
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
        #endif
        #ifdef HOLD_AT_FAR
          gl_Position.z = min(gl_Position.z, gl_Position.w);
        #endif
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform vec3 uLit;
      uniform vec3 uShade;
      varying vec3 vN;
      varying float vUp;
      void main() {
        float sun = max(dot(normalize(vN), uSunDir), 0.0);
        float k = clamp(0.15 + sun * 0.55 + vUp * 0.45, 0.0, 1.0);
        gl_FragColor = vec4(mix(uShade, uLit, k), 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  return { material, uniforms };
}

/** The far sea as seen from the air: the deep sea's blue under the horizon's haze. */
export function seaFar(horizon: THREE.Color, night: number): THREE.Color {
  return new THREE.Color(PALETTE.sea.deep).multiplyScalar(1 - night * 0.6).lerp(horizon, 0.45);
}

// The tree the world is named for: a hazy giant far to the north, past the sea. The screen haze
// (post.ts) is laid on from the depth buffer, which the tree doesn't write (it is far behind
// everything), so it paints its own haze in.

/** The world tree: lumps of crown and a flared trunk, in one geometry, in its local metres. */
function giantTree(): THREE.BufferGeometry {
  const rng = makeRng(911);
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(4.5, 11, 46, 14, 4);
  const tp = trunk.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    // Buttress roots: the foot flares out in ribs.
    const y = tp.getY(i);
    const a = Math.atan2(tp.getZ(i), tp.getX(i));
    const flare = 1 + Math.max(0, (-y - 8) / 15) * (0.35 + 0.35 * Math.cos(a * 5));
    tp.setX(i, tp.getX(i) * flare);
    tp.setZ(i, tp.getZ(i) * flare);
  }
  trunk.translate(0, 23, 0);
  parts.push(trunk.toNonIndexed());
  for (let k = 0; k < 26; k++) {
    const a = rng() * Math.PI * 2;
    const d = k < 3 ? range(rng, 0, 6) : range(rng, 8, 30);
    const r = k < 3 ? range(rng, 14, 17) : range(rng, 7, 12) * (1 - d / 60);
    const g = new THREE.IcosahedronGeometry(r, 2);
    g.translate(Math.cos(a) * d, 46 + range(rng, -4, 9) + (1 - d / 30) * 6, Math.sin(a) * d);
    parts.push(g.toNonIndexed());
  }
  const g = mergeGeometries(parts);
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const v = new THREE.Vector3();
  const centre = new THREE.Vector3(0, 48, 0);
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) < 40) continue;
    v.fromBufferAttribute(p, i).sub(centre).normalize();
    v.lerp(new THREE.Vector3(n.getX(i), n.getY(i), n.getZ(i)), 0.5).normalize();
    n.setXYZ(i, v.x, v.y, v.z);
  }
  return g;
}

function worldTree(material: THREE.Material): THREE.Group {
  const tree = new THREE.Group();
  const giant = new THREE.Mesh(giantTree(), material);
  giant.frustumCulled = false;
  tree.add(giant);
  tree.position.set(-520, -40, 1900);
  tree.scale.setScalar(8.5);
  return tree;
}
