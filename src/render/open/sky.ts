import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, range } from '../../rng';
import { NEW_LOOK, PALETTE, POST } from '../look';
import { toon } from '../toon';

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
  /** The new look's world tree: partly lit from within by day, dark against the night. */
  private selfLit: SelfLit[] = [];
  /** The new look's clouds: painted light, bright tops and blue-grey bellies, never brighter than white. */
  private cloudLight = cloudShading();

  constructor(sunDir: THREE.Vector3) {
    this.uniforms = {
      uTop: { value: new THREE.Color(SKY_TOP) },
      uHorizon: { value: new THREE.Color(SKY_HORIZON) },
      uSunDir: { value: sunDir.clone().normalize() },
      uSun: { value: new THREE.Color(0xfff3d6) },
      uMoonDir: { value: new THREE.Vector3(-0.4, 0.55, -0.7).normalize() },
      uNight: { value: 0 },
      // The new look's sun is brighter than white, so its bloom catches it.
      uDisc: { value: NEW_LOOK ? POST.sunDisc : 0.9 },
      // The classic look keeps the horizon colour all the way down.
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

    // Clouds: a few lumpy puffs each, flat-bottomed, scattered high over the isle.
    const puff = (x: number, y: number, z: number, r: number) => {
      const g = new THREE.IcosahedronGeometry(r, 1);
      g.translate(x, y, z);
      return g;
    };
    const cloudGeo = NEW_LOOK
      ? cumulus()
      : mergeGeometries([puff(0, 0, 0, 9), puff(9, -1.5, 2, 7), puff(-9, -2, -1, 6.5), puff(4, 3.5, -3, 6), puff(-4, 2.5, 3, 5.5), puff(15, -3, -2, 4.5)]);
    if (!NEW_LOOK) {
      const p = cloudGeo.attributes.position;
      for (let i = 0; i < p.count; i++) if (p.getY(i) < -2.5) p.setY(i, -2.5 + (p.getY(i) + 2.5) * 0.25);
      cloudGeo.computeVertexNormals();
    }
    const rng = makeRng(4242);
    const count = NEW_LOOK ? 58 : 46;
    const cl = PALETTE.clouds;
    const cloudMat = NEW_LOOK ? this.cloudLight.material : toon(cl.color, { emissive: cl.emissive, emissiveIntensity: cl.emissiveIntensity });
    this.clouds = new THREE.InstancedMesh(cloudGeo, cloudMat, count);
    for (let i = 0; i < count; i++) {
      this.cloudBase.push({ x: range(rng, -1300, 1300), y: range(rng, 170, 290), z: range(rng, -1300, 1300), s: range(rng, 0.8, 2.1) * (NEW_LOOK ? 1.25 : 1), r: rng() * Math.PI * 2 });
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
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false }));
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -9;
    this.group.add(this.stars);
    this.group.add(worldTree(this.selfLit));
    this.update(0, 0, 0);
  }

  /** Sky colours, sun and moon for the time of day (night 0..1). */
  setLight(top: THREE.Color, horizon: THREE.Color, sunDir: THREE.Vector3, sun: THREE.Color, night: number, moonDir: THREE.Vector3): void {
    (this.uniforms.uTop.value as THREE.Color).copy(top);
    (this.uniforms.uHorizon.value as THREE.Color).copy(horizon);
    (this.uniforms.uSeaFar.value as THREE.Color).copy(NEW_LOOK ? seaFar(horizon, night) : horizon);
    (this.uniforms.uSunDir.value as THREE.Vector3).copy(sunDir);
    (this.uniforms.uSun.value as THREE.Color).copy(sun);
    (this.uniforms.uMoonDir.value as THREE.Vector3).copy(moonDir);
    this.uniforms.uNight.value = night;
    (this.stars.material as THREE.PointsMaterial).opacity = Math.max(0, night - 0.15) * 1.1;
    this.stars.visible = night > 0.15;
    const cu = this.cloudLight.uniforms;
    (cu.uSunDir.value as THREE.Vector3).copy(sunDir).normalize();
    (cu.uLit.value as THREE.Color).setRGB(1.12, 1.1, 1.06).lerp(sun, 0.25).multiplyScalar(1 - night * 0.82);
    (cu.uShade.value as THREE.Color).copy(top).lerp(horizon, 0.55).lerp(new THREE.Color(0x9aa6b8), 0.5).multiplyScalar(1 - night * 0.78);
    for (const s of this.selfLit) {
      s.mat.emissiveIntensity = s.glow * (1 - night * 0.85);
      s.mat.color.copy(s.color).multiplyScalar(1 - night * 0.7);
    }
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

// The new look's clouds: a cauliflower of lumps with a flat belly, its normals leaning out from the
// middle, lit by a shader that keeps them below the bloom: white where the sun falls, the sky's
// blue-grey underneath.
function cumulus(): THREE.BufferGeometry {
  const rng = makeRng(77);
  const lumps: THREE.BufferGeometry[] = [];
  const centre = new THREE.Vector3(0, 2, 0);
  for (let k = 0; k < 15; k++) {
    const a = rng() * Math.PI * 2;
    const d = k === 0 ? 0 : range(rng, 3, 15);
    const r = k === 0 ? 10 : range(rng, 4.5, 8.5) * (1 - d / 30);
    const g = new THREE.IcosahedronGeometry(r, 2);
    g.translate(Math.cos(a) * d * 1.3, range(rng, -1, 4) + (1 - d / 15) * 3, Math.sin(a) * d * 0.8);
    lumps.push(g);
  }
  const g = mergeGeometries(lumps);
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) < -2.5) p.setY(i, -2.5 + (p.getY(i) + 2.5) * 0.2);
    v.fromBufferAttribute(p, i).sub(centre).multiply(new THREE.Vector3(0.6, 1, 0.8)).normalize();
    v.lerp(new THREE.Vector3(n.getX(i), n.getY(i), n.getZ(i)), 0.5).normalize();
    n.setXYZ(i, v.x, v.y, v.z);
  }
  return g;
}

function cloudShading(): { material: THREE.ShaderMaterial; uniforms: Record<string, THREE.IUniform> } {
  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uLit: { value: new THREE.Color(1, 1, 1) },
    uShade: { value: new THREE.Color(0.7, 0.75, 0.82) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying float vUp;
      void main() {
        vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        vUp = clamp((position.y + 2.5) / 16.0, 0.0, 1.0);
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
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

// The tree the world is named for: a hazy giant far to the north, past the sea. No fog on it -
// the haze is painted in - so it stays a silhouette however far the fog is set. The new look lays
// its haze on from the depth buffer, so there the tree stays out of it (it is far behind everything).
interface SelfLit {
  mat: THREE.MeshToonMaterial;
  glow: number;
  color: THREE.Color;
}

/** The far sea as seen from the air: the deep sea's blue under the horizon's haze. */
export function seaFar(horizon: THREE.Color, night: number): THREE.Color {
  return new THREE.Color(PALETTE.sea.deep).multiplyScalar(1 - night * 0.6).lerp(horizon, 0.45);
}

const selfLit = (mat: THREE.MeshToonMaterial): SelfLit => ({ mat, glow: mat.emissiveIntensity, color: mat.color.clone() });

function worldTree(lit: SelfLit[]): THREE.Group {
  const tree = new THREE.Group();
  // Flat facets in the classic look; in the new one normals out from each crown's middle, so it
  // reads as a soft mass of leaves.
  const facet = (g: THREE.BufferGeometry) => {
    const n = g.toNonIndexed();
    n.computeVertexNormals();
    if (NEW_LOOK && g.type === 'IcosahedronGeometry') {
      const p = n.attributes.position;
      const v = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).normalize();
        n.attributes.normal.setXYZ(i, v.x, v.y, v.z);
      }
    }
    return n;
  };
  const wt = PALETTE.worldTree;
  // In the new look it is mostly lit from within, as something seen through miles of air is.
  const haze = (hex: number) => (NEW_LOOK ? { emissive: hex, emissiveIntensity: 0.55 } : {});
  const trunkMat = toon(wt.trunk, { fog: false, depthWrite: !NEW_LOOK, ...haze(wt.trunk) });
  const trunk = new THREE.Mesh(facet(new THREE.CylinderGeometry(5, 10, 44, 9)), trunkMat);
  trunk.position.y = 22;
  tree.add(trunk);
  const leaf = toon(wt.leaves, { fog: false, depthWrite: !NEW_LOOK, ...haze(wt.leaves) });
  if (NEW_LOOK) lit.push(selfLit(trunkMat), selfLit(leaf));
  const blobs: Array<[number, number, number, number]> = [
    [0, 44, 0, 18],
    [-19, 39, 6, 12],
    [18, 40, -4, 13],
    [6, 53, 4, 11],
    [-9, 50, -10, 11],
    [12, 30, 10, 8],
  ];
  for (const [x, y, z, r] of blobs) {
    const m = new THREE.Mesh(facet(new THREE.IcosahedronGeometry(r, 0)), leaf);
    m.position.set(x, y, z);
    tree.add(m);
  }
  tree.position.set(-520, -40, 1900);
  tree.scale.setScalar(8.5);
  return tree;
}
