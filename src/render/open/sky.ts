import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, range } from '../../rng';
import { toon } from '../toon';

// Sky dome, sun, drifting clouds and the world tree standing over the horizon.

export const SKY_HORIZON = 0xcde9f3;
const SKY_TOP = 0x7fbde9;

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
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = mix(uHorizon, uTop, pow(smoothstep(-0.02, 0.55, h), 0.75));
    float s = max(dot(d, normalize(uSunDir)), 0.0);
    col += uSun * (step(0.9993, s) * 0.9 + pow(s, 24.0) * 0.22 + pow(s, 4.0) * 0.05) * (1.0 - uNight);
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

  constructor(sunDir: THREE.Vector3) {
    this.uniforms = {
      uTop: { value: new THREE.Color(SKY_TOP) },
      uHorizon: { value: new THREE.Color(SKY_HORIZON) },
      uSunDir: { value: sunDir.clone().normalize() },
      uSun: { value: new THREE.Color(0xfff3d6) },
      uMoonDir: { value: new THREE.Vector3(-0.4, 0.55, -0.7).normalize() },
      uNight: { value: 0 },
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
    const cloudGeo = mergeGeometries([
      puff(0, 0, 0, 9),
      puff(9, -1.5, 2, 7),
      puff(-9, -2, -1, 6.5),
      puff(4, 3.5, -3, 6),
      puff(-4, 2.5, 3, 5.5),
      puff(15, -3, -2, 4.5),
    ]);
    const p = cloudGeo.attributes.position;
    for (let i = 0; i < p.count; i++) if (p.getY(i) < -2.5) p.setY(i, -2.5 + (p.getY(i) + 2.5) * 0.25);
    cloudGeo.computeVertexNormals();
    const rng = makeRng(4242);
    const count = 46;
    this.clouds = new THREE.InstancedMesh(cloudGeo, toon(0xffffff, { emissive: 0x9fb8c8, emissiveIntensity: 0.35 }), count);
    for (let i = 0; i < count; i++) {
      this.cloudBase.push({ x: range(rng, -1300, 1300), y: range(rng, 170, 290), z: range(rng, -1300, 1300), s: range(rng, 0.8, 2.1), r: rng() * Math.PI * 2 });
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
    this.group.add(worldTree());
    this.update(0, 0, 0);
  }

  /** Sky colours, sun and moon for the time of day (night 0..1). */
  setLight(top: THREE.Color, horizon: THREE.Color, sunDir: THREE.Vector3, sun: THREE.Color, night: number, moonDir: THREE.Vector3): void {
    (this.uniforms.uTop.value as THREE.Color).copy(top);
    (this.uniforms.uHorizon.value as THREE.Color).copy(horizon);
    (this.uniforms.uSunDir.value as THREE.Vector3).copy(sunDir);
    (this.uniforms.uSun.value as THREE.Color).copy(sun);
    (this.uniforms.uMoonDir.value as THREE.Vector3).copy(moonDir);
    this.uniforms.uNight.value = night;
    (this.stars.material as THREE.PointsMaterial).opacity = Math.max(0, night - 0.15) * 1.1;
    this.stars.visible = night > 0.15;
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

// The tree the world is named for: a hazy giant far to the north, past the sea. No fog on it -
// the haze is painted in - so it stays a silhouette however far the fog is set.
function worldTree(): THREE.Group {
  const tree = new THREE.Group();
  const facet = (g: THREE.BufferGeometry) => {
    const n = g.toNonIndexed();
    n.computeVertexNormals();
    return n;
  };
  const trunk = new THREE.Mesh(facet(new THREE.CylinderGeometry(5, 10, 44, 9)), toon(0xbccdd3, { fog: false }));
  trunk.position.y = 22;
  tree.add(trunk);
  const leaf = toon(0xb9d4cb, { fog: false });
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
