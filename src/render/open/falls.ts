import * as THREE from 'three';
import type { WaterfallInfo } from '../../engine/zone';

// The world's waterfalls (the engine's generator cuts their slots, crates/engine/src/open/generate.rs): the spring pool spills down a
// runnel to the lip, the water falls free in a curtain that fans out as it drops, and lands in the
// plunge pool in a churn of foam and a cloud of mist. Two layers of water, streaked white and
// scrolling down faster the further they fall, so it reads as thick, moving water from any side.
// Behind it, where the goblins' lanterns are, a warm glow shows through. Drawing only: the rules see
// a slot, a ledge and two shallow pools.

const G = 9.81;

const noiseGlsl = /* glsl */ `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
`;

const curtainVertex = /* glsl */ `
  attribute vec2 aWater;
  uniform float uTime;
  uniform vec3 uOut;
  varying vec2 vWater;
  varying float vFall;
  varying vec3 vWorld;
  ${noiseGlsl}
  void main() {
    vWater = aWater;
    vFall = uv.y;
    vec4 world = modelMatrix * vec4(position, 1.0);
    // The sheet billows a little in and out as it falls.
    float b = (noise(vec2(aWater.x * 1.7, aWater.y * 0.08 - uTime * 0.6)) - 0.5) * 0.9 * uv.y;
    world.xyz += uOut * b;
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const curtainFragment = /* glsl */ `
  uniform float uTime;
  uniform float uBright;
  uniform float uLayer;
  uniform vec3 uWater;
  uniform vec3 uFoam;
  uniform vec3 uGlow;
  uniform vec2 uGlowY;
  varying vec2 vWater;
  varying float vFall;
  varying vec3 vWorld;
  ${noiseGlsl}
  void main() {
    // vWater: across (-1..1) and how far down the water has come (metres); vFall: 0 at the lip, 1 in the pool.
    float across = vWater.x;
    float down = vWater.y;
    float rush = 0.7 + vFall * 2.6;
    float n1 = noise(vec2(across * 6.0 + uLayer * 17.0, down * 0.09 - uTime * rush));
    float n2 = noise(vec2(across * 21.0 + uLayer * 5.0, down * 0.3 - uTime * rush * 2.2));
    float n3 = noise(vec2(across * 2.5, down * 0.03 - uTime * 0.35));
    float streak = n1 * 0.55 + n2 * 0.3 + n3 * 0.25;
    // Glassy and dark over the lip, breaking white as it falls.
    float white = smoothstep(0.42, 0.78, streak + vFall * 0.42 - 0.05);
    vec3 col = mix(uWater, uFoam, white);
    float edge = 1.0 - smoothstep(0.78, 1.0, abs(across) + (n2 - 0.5) * 0.18);
    float alpha = mix(0.58, 0.95, white) * edge;
    alpha *= mix(0.75, 1.0, uLayer);
    // Thinning to spray at its sides and as it hits the pool.
    alpha *= 1.0 - smoothstep(0.96, 1.0, vFall) * 0.6;
    // The lanterns on the ledge behind, a warm smudge through the water.
    float g = smoothstep(uGlowY.x - 3.0, uGlowY.x + 0.5, vWorld.y) * (1.0 - smoothstep(uGlowY.y - 1.0, uGlowY.y + 2.5, vWorld.y));
    g *= 1.0 - smoothstep(0.15, 0.75, abs(across));
    float flicker = 0.8 + 0.12 * sin(uTime * 7.3) * sin(uTime * 2.9 + 1.3);
    col = col * uBright + uGlow * g * flicker * (1.0 - white * 0.5);
    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }
`;

const poolVertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const poolFragment = /* glsl */ `
  uniform float uTime;
  uniform float uBright;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uFoam;
  uniform vec3 uSky;
  uniform vec3 uCentre;
  uniform vec2 uSize;
  uniform vec3 uOut;
  uniform vec3 uAcross;
  uniform vec3 uSplash;
  uniform float uChurn;
  varying vec3 vWorld;
  ${noiseGlsl}
  void main() {
    vec3 d = vWorld - uCentre;
    vec2 q = vec2(dot(d, uOut) / uSize.x, dot(d, uAcross) / uSize.y);
    float e = length(q);
    vec3 col = mix(uDeep, uShallow, smoothstep(0.35, 1.0, e));
    // Ripples, and the sky in them.
    float n1 = noise(vWorld.xz * 0.9 + vec2(uTime * 0.4, uTime * 0.25));
    float n2 = noise(vWorld.xz * 1.7 - vec2(uTime * 0.3, -uTime * 0.45));
    float ripple = n1 * n2;
    col = mix(col, uSky, 0.18 + 0.12 * ripple);
    col = mix(col, col * 1.18 + 0.04, step(0.42, ripple) * 0.5);
    // Where the falls come down: churning foam, and rings running out from it.
    float r = length((vWorld - uSplash).xz);
    float churn = (1.0 - smoothstep(1.5, 4.8, r + (n1 - 0.5) * 2.2)) * uChurn;
    float rings = smoothstep(0.75, 0.95, sin(r * 2.2 - uTime * 4.0) * 0.5 + 0.5) * (1.0 - smoothstep(2.0, 7.0, r)) * uChurn;
    float foam = clamp(churn * (0.6 + 0.6 * n2) + rings * 0.35, 0.0, 1.0);
    // A rim of foam where the pool meets its stones.
    foam = max(foam, smoothstep(0.9, 1.0, e) * 0.55 * step(0.35, n2));
    col = mix(col, uFoam, foam) * uBright;
    float alpha = mix(0.86, 0.7, smoothstep(0.6, 1.0, e));
    alpha = max(alpha, foam);
    gl_FragColor = vec4(col, alpha * (1.0 - smoothstep(0.97, 1.0, e)));
    #include <colorspace_fragment>
  }
`;

const mistVertex = /* glsl */ `
  attribute float aSeed;
  uniform float uTime;
  uniform vec3 uOrigin;
  uniform vec3 uOut;
  uniform vec3 uAcross;
  uniform float uScale;
  uniform float uRise;
  uniform float uSpread;
  uniform float uRate;
  uniform float uSize;
  varying float vAlpha;
  void main() {
    float life = fract(uTime * uRate * (0.7 + 0.6 * fract(aSeed * 13.7)) + aSeed);
    float ang = aSeed * 431.7;
    float reach = (0.4 + life * uSpread) * (0.5 + fract(aSeed * 7.31));
    vec3 p = uOrigin
      + uAcross * sin(ang) * reach
      + uOut * (cos(ang) * reach * 0.7 + life * uSpread * 0.45)
      + vec3(0.0, life * uRise * (0.55 + 0.9 * fract(aSeed * 3.71)), 0.0);
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.6 + life * 1.6) * uScale / max(1.0, -mv.z);
    vAlpha = smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.5, 1.0, life));
  }
`;

const mistFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = vAlpha * uOpacity * (1.0 - smoothstep(0.15, 0.5, d));
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }
`;

/** The water's path from the spring to the pool: rows of (out along the bearing, height, half-width, metres come so far, how far through the fall). */
function waterPath(f: WaterfallInfo): Array<{ s: number; y: number; half: number; down: number; fall: number }> {
  const level = f.spring.level - 0.03;
  const tEnd = Math.sqrt((2 * (level - f.plunge.level)) / G);
  const top = f.runnel - 0.2;
  const bottom = f.width / 2 - 0.4;
  const rows: Array<{ s: number; y: number; half: number; down: number; fall: number }> = [];
  const from = f.spring.at + f.spring.r * 0.6;
  for (let k = 0; k < 5; k++) rows.push({ s: from + ((f.lip - from) * k) / 5, y: level, half: top * (0.75 + 0.05 * k), down: 0, fall: 0 });
  const steps = 64;
  for (let k = 0; k <= steps; k++) {
    // Closer together near the top, where it curves over the lip.
    const tau = tEnd * Math.pow(k / steps, 1.35);
    const spread = Math.min(1, tau / 1.9);
    rows.push({ s: f.lip + f.speed * tau, y: level - 0.5 * G * tau * tau, half: top + (bottom - top) * Math.sqrt(spread), down: 0, fall: tau / tEnd });
  }
  for (let k = 1; k < rows.length; k++) rows[k].down = rows[k - 1].down + Math.hypot(rows[k].s - rows[k - 1].s, rows[k].y - rows[k - 1].y);
  return rows;
}

function curtainGeometry(f: WaterfallInfo, back: number, narrow: number): THREE.BufferGeometry {
  const rows = waterPath(f);
  const across = 14;
  const pos: number[] = [];
  const uv: number[] = [];
  const water: number[] = [];
  const index: number[] = [];
  for (const r of rows) {
    for (let a = 0; a <= across; a++) {
      const k = (a / across) * 2 - 1;
      const t = k * r.half * narrow;
      const s = r.s - back * Math.min(1, r.fall * 8);
      pos.push(f.cx + f.ux * s + f.vx * t, r.y, f.cz + f.uz * s + f.vz * t);
      uv.push(a / across, r.fall);
      water.push(k, r.down);
    }
  }
  for (let j = 0; j < rows.length - 1; j++)
    for (let a = 0; a < across; a++) {
      const i0 = j * (across + 1) + a;
      const i1 = i0 + across + 1;
      index.push(i0, i1, i0 + 1, i0 + 1, i1, i1 + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aWater', new THREE.Float32BufferAttribute(water, 2));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

/** Where the water comes down into the plunge pool. */
export function splashPoint(f: WaterfallInfo): THREE.Vector3 {
  const level = f.spring.level - 0.03;
  const tEnd = Math.sqrt((2 * (level - f.plunge.level)) / G);
  const s = f.lip + f.speed * tEnd;
  return new THREE.Vector3(f.cx + f.ux * s, f.plunge.level, f.cz + f.uz * s);
}

export class FallsView {
  readonly group = new THREE.Group();
  private uniforms: Array<Record<string, THREE.IUniform>> = [];
  private mists: Array<Record<string, THREE.IUniform>> = [];

  constructor(falls: WaterfallInfo[]) {
    this.group.name = 'falls';
    for (const f of falls) this.build(f);
  }

  private build(f: WaterfallInfo): void {
    const out = new THREE.Vector3(f.ux, 0, f.uz);
    const across = new THREE.Vector3(f.vx, 0, f.vz);
    // The curtain, in two layers: the back one darker and a little narrower.
    for (const [layer, back, narrow, water, foam] of [
      [0, 0.55, 0.92, 0x5d8f98, 0xcfe3e6],
      [1, 0, 1, 0x8fc4cb, 0xf4fafb],
    ] as const) {
      const u: Record<string, THREE.IUniform> = {
        uTime: { value: 0 },
        uBright: { value: 1 },
        uLayer: { value: layer },
        uOut: { value: out },
        uWater: { value: new THREE.Color(water) },
        uFoam: { value: new THREE.Color(foam) },
        uGlow: { value: new THREE.Color(0xffa04a).multiplyScalar(layer ? 0.55 : 0.8) },
        uGlowY: { value: new THREE.Vector2(f.shelf.top, f.roof.top - 1.5) },
      };
      this.uniforms.push(u);
      const mat = new THREE.ShaderMaterial({
        uniforms: u,
        vertexShader: curtainVertex,
        fragmentShader: curtainFragment,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(curtainGeometry(f, back, narrow), mat);
      mesh.name = layer ? 'falls-curtain' : 'falls-curtain-back';
      mesh.renderOrder = 3 + layer;
      this.group.add(mesh);
    }
    // The two pools.
    const splash = splashPoint(f);
    const pool = (x: number, z: number, level: number, along: number, wide: number, churn: number, name: string) => {
      const u: Record<string, THREE.IUniform> = {
        uTime: { value: 0 },
        uBright: { value: 1 },
        uShallow: { value: new THREE.Color(0x4fa9a4) },
        uDeep: { value: new THREE.Color(0x1f5f6a) },
        uFoam: { value: new THREE.Color(0xf2f7f8) },
        uSky: { value: new THREE.Color(0xbcd6e4) },
        uCentre: { value: new THREE.Vector3(x, level, z) },
        uSize: { value: new THREE.Vector2(along, wide) },
        uOut: { value: out },
        uAcross: { value: across },
        uSplash: { value: splash },
        uChurn: { value: churn },
      };
      this.uniforms.push(u);
      const geo = new THREE.CircleGeometry(1, 40);
      geo.rotateX(-Math.PI / 2);
      geo.scale(along, 1, wide);
      geo.rotateY(Math.atan2(-f.uz, f.ux));
      const mat = new THREE.ShaderMaterial({ uniforms: u, vertexShader: poolVertex, fragmentShader: poolFragment, transparent: true, depthWrite: true });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, level, z);
      mesh.renderOrder = 2;
      mesh.name = name;
      this.group.add(mesh);
    };
    pool(f.spring.x, f.spring.z, f.spring.level, f.spring.r, f.spring.r, 0, 'falls-spring');
    pool(f.plunge.x, f.plunge.z, f.plunge.level + 0.02, f.plunge.along, f.plunge.across, 1, 'falls-plunge');
    // Mist over the pool, spray off the lip and where the curtain brushes the ledge's hood.
    const mist = (origin: THREE.Vector3, count: number, rise: number, spread: number, rate: number, size: number, opacity: number, name: string) => {
      const seeds = new Float32Array(count);
      for (let i = 0; i < count; i++) seeds[i] = (i * 0.618034) % 1;
      const geo = new THREE.BufferGeometry();
      // Positions are worked out in the shader; three only needs something to count.
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
      const u: Record<string, THREE.IUniform> = {
        uTime: { value: 0 },
        uOrigin: { value: origin },
        uOut: { value: out },
        uAcross: { value: across },
        uScale: { value: 600 },
        uRise: { value: rise },
        uSpread: { value: spread },
        uRate: { value: rate },
        uSize: { value: size },
        uColor: { value: new THREE.Color(0xf4f8fa) },
        uOpacity: { value: opacity },
      };
      this.mists.push(u);
      const mat = new THREE.ShaderMaterial({ uniforms: u, vertexShader: mistVertex, fragmentShader: mistFragment, transparent: true, depthWrite: false });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      points.renderOrder = 5;
      points.name = name;
      this.group.add(points);
    };
    mist(splash.clone().setY(f.plunge.level + 0.3), 120, 12, 6, 0.16, 3.6, 0.11, 'falls-mist');
    const lip = new THREE.Vector3(f.cx + f.ux * (f.lip + 0.6), f.spring.level - 1.2, f.cz + f.uz * (f.lip + 0.6));
    mist(lip, 30, 1.6, 1.8, 0.5, 1.4, 0.12, 'falls-spray');
  }

  update(time: number, viewHeight: number, fov: number): void {
    for (const u of this.uniforms) u.uTime.value = time;
    const scale = viewHeight / (2 * Math.tan((fov * Math.PI) / 180 / 2));
    for (const u of this.mists) {
      u.uTime.value = time;
      u.uScale.value = scale;
    }
  }

  /** Dims the water at night (k: 1 by day). */
  setBrightness(k: number): void {
    for (const u of this.uniforms) u.uBright.value = k;
    for (const u of this.mists) {
      u.uBase ??= { value: u.uOpacity.value };
      u.uOpacity.value = (u.uBase.value as number) * (0.35 + 0.65 * k);
    }
  }
}
