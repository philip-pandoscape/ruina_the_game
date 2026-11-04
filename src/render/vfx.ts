import * as THREE from 'three';
import { makeRng, range } from '../rng';
import type { GameEvent } from '../sim/types';
import { MOVEMENT_SKILLS } from '../tuning';
import { toon } from './toon';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ---------- Slash trail ----------

export interface SlashDef {
  a0: number;
  a1: number;
  p0: number;
  p1: number;
  color: number;
  core: number;
}

// Direction of an arm with yaw a and pitch p (see SLASHES in character.ts).
function armDir(a: number, p: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(-Math.sin(p) * Math.sin(a), -Math.cos(p), -Math.sin(p) * Math.cos(a));
}

// A glowing ribbon along the sword's swing path. Head and tail (0..1 along the swing) animate it.
export class SlashArc {
  readonly mesh: THREE.Mesh;
  private uniforms: Record<string, THREE.IUniform>;

  constructor(def: SlashDef, rIn: number, rOut: number, segments = 32) {
    const positions: number[] = [];
    const ts: number[] = [];
    const rs: number[] = [];
    const indices: number[] = [];
    const v = new THREE.Vector3();
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      armDir(lerp(def.a0, def.a1, t), lerp(def.p0, def.p1, t), v);
      positions.push(v.x * rIn, v.y * rIn, v.z * rIn, v.x * rOut, v.y * rOut, v.z * rOut);
      ts.push(t, t);
      rs.push(0, 1);
      if (i < segments) {
        const k = i * 2;
        indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('aT', new THREE.Float32BufferAttribute(ts, 1));
    geo.setAttribute('aR', new THREE.Float32BufferAttribute(rs, 1));
    geo.setIndex(indices);

    this.uniforms = {
      uHead: { value: 0 },
      uTail: { value: 0 },
      uOpacity: { value: 1 },
      uColor: { value: new THREE.Color(def.color) },
      uCore: { value: new THREE.Color(def.core) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute float aT;
        attribute float aR;
        varying float vT;
        varying float vR;
        void main() {
          vT = aT;
          vR = aR;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uHead;
        uniform float uTail;
        uniform float uOpacity;
        uniform vec3 uColor;
        uniform vec3 uCore;
        varying float vT;
        varying float vR;
        void main() {
          if (vT > uHead || vT < uTail) discard;
          float k = (vT - uTail) / max(uHead - uTail, 0.0001);
          float edge = smoothstep(0.0, 0.45, vR) * (1.0 - smoothstep(0.9, 1.0, vR));
          float a = pow(k, 1.6) * edge * uOpacity;
          vec3 col = mix(uColor, uCore, smoothstep(0.55, 1.0, vR) * k);
          gl_FragColor = vec4(col, a);
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  set(head: number, tail: number, opacity: number): void {
    this.mesh.visible = true;
    this.uniforms.uHead.value = head;
    this.uniforms.uTail.value = tail;
    this.uniforms.uOpacity.value = opacity;
  }

  hide(): void {
    this.mesh.visible = false;
  }
}

// ---------- Particles ----------

interface Particle {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  life: number;
  size: number;
  gravity: number;
  drag: number;
}

// A fixed pool of particles drawn as one instanced mesh. Fades by shrinking, so it stays opaque.
class ParticlePool {
  readonly mesh: THREE.InstancedMesh;
  private items: Particle[] = [];
  private next = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private static UP = new THREE.Vector3(0, 1, 0);

  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, max: number, private stretch: boolean) {
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    for (let i = 0; i < max; i++) {
      this.items.push({ alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), age: 0, life: 1, size: 1, gravity: 0, drag: 0 });
      this.mesh.setColorAt(i, new THREE.Color(0xffffff));
    }
    this.sync();
  }

  spawn(pos: THREE.Vector3, vel: THREE.Vector3, life: number, size: number, gravity: number, drag: number, color?: THREE.Color): void {
    const i = this.next;
    this.next = (this.next + 1) % this.items.length;
    const p = this.items[i];
    p.alive = true;
    p.pos.copy(pos);
    p.vel.copy(vel);
    p.age = 0;
    p.life = life;
    p.size = size;
    p.gravity = gravity;
    p.drag = drag;
    this.mesh.setColorAt(i, color ?? new THREE.Color(0xffffff));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear(): void {
    for (const p of this.items) p.alive = false;
    this.sync();
  }

  step(dt: number): void {
    for (const p of this.items) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false;
        continue;
      }
      p.vel.y -= p.gravity * dt;
      p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < 0.02) {
        p.pos.y = 0.02;
        p.vel.y = Math.abs(p.vel.y) * 0.3;
      }
    }
    this.sync();
  }

  get activeCount(): number {
    return this.items.filter((p) => p.alive).length;
  }

  private sync(): void {
    this.items.forEach((p, i) => {
      if (!p.alive) {
        this.m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.m);
        return;
      }
      const k = p.age / p.life;
      if (this.stretch) {
        // Sparks: stretched along their velocity, shrinking over their life.
        const speed = p.vel.length();
        this.dir.copy(p.vel).normalize();
        if (speed < 0.001) this.dir.set(0, 1, 0);
        this.q.setFromUnitVectors(ParticlePool.UP, this.dir);
        const w = p.size * (1 - k);
        this.s.set(w, w * (1.5 + speed * 0.25), w);
      } else {
        // Dust: puffs up fast, then shrinks away.
        this.q.identity();
        const grow = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8;
        const w = p.size * Math.max(0, grow);
        this.s.set(w, w, w);
      }
      this.m.compose(p.pos, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------- Rings ----------

class RingPool {
  private rings: Array<{ mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; life: number; size: number }> = [];
  private next = 0;

  constructor(scene: THREE.Scene, count: number) {
    const geo = new THREE.RingGeometry(0.8, 1, 40);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 5;
      scene.add(mesh);
      this.rings.push({ mesh, mat, age: 0, life: 1, size: 1 });
    }
  }

  spawn(pos: THREE.Vector3, size: number, life: number, color: number): void {
    const r = this.rings[this.next];
    this.next = (this.next + 1) % this.rings.length;
    r.mesh.position.copy(pos);
    r.mat.color.set(color);
    r.age = 0;
    r.life = life;
    r.size = size;
    r.mesh.visible = true;
  }

  clear(): void {
    for (const r of this.rings) r.mesh.visible = false;
  }

  step(dt: number): void {
    for (const r of this.rings) {
      if (!r.mesh.visible) continue;
      r.age += dt;
      const k = r.age / r.life;
      if (k >= 1) {
        r.mesh.visible = false;
        continue;
      }
      r.mesh.scale.setScalar(r.size * (0.3 + 0.7 * (1 - Math.pow(1 - k, 3))));
      r.mat.opacity = 0.85 * (1 - k);
    }
  }
}

// ---------- Flashes ----------

// Bright additive balls that swell and fade: the core of an explosion.
class FlashPool {
  private items: Array<{ mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; life: number; size: number }> = [];
  private next = 0;

  constructor(scene: THREE.Scene, count: number) {
    const geo = new THREE.IcosahedronGeometry(1, 2);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffb347,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 8;
      scene.add(mesh);
      this.items.push({ mesh, mat, age: 0, life: 1, size: 1 });
    }
  }

  spawn(pos: THREE.Vector3, size: number, life: number, color: number): void {
    const f = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    f.mesh.position.copy(pos);
    f.mat.color.set(color);
    f.age = 0;
    f.life = life;
    f.size = size;
    f.mesh.visible = true;
  }

  clear(): void {
    for (const f of this.items) f.mesh.visible = false;
  }

  step(dt: number): void {
    for (const f of this.items) {
      if (!f.mesh.visible) continue;
      f.age += dt;
      const k = f.age / f.life;
      if (k >= 1) {
        f.mesh.visible = false;
        continue;
      }
      f.mesh.scale.setScalar(f.size * (0.35 + 0.65 * (1 - Math.pow(1 - k, 2))));
      f.mat.opacity = 0.9 * (1 - k) * (1 - k);
    }
  }
}

// ---------- Effects driven by game events ----------

const DUST = new THREE.Color(0xefe4d0);
const STRAW = new THREE.Color(0xe2c158);
const SMOKE = new THREE.Color(0x4a4440);
const FIRE = [new THREE.Color(0xffd166), new THREE.Color(0xff9f1c), new THREE.Color(0xff5a14)];
const HEAL = [new THREE.Color(0x7dffb0), new THREE.Color(0xd8ffe6), new THREE.Color(0x3ddc84)];

export class Vfx {
  private dust: ParticlePool;
  private sparks: ParticlePool;
  private rings: RingPool;
  private flashes: FlashPool;
  private trailTick = 0;
  private rng = makeRng(99);
  private v = new THREE.Vector3();
  private w = new THREE.Vector3();
  /** Ground height in an open world, so effects that hug the ground sit on hills too. */
  ground: ((x: number, z: number) => number) | null = null;

  private gy(x: number, z: number): number {
    return this.ground ? this.ground(x, z) : 0;
  }

  constructor(scene: THREE.Scene) {
    this.dust = new ParticlePool(new THREE.IcosahedronGeometry(0.5, 0), toon(0xffffff), 260, false);
    this.sparks = new ParticlePool(new THREE.OctahedronGeometry(0.5, 0), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), 420, true);
    scene.add(this.dust.mesh, this.sparks.mesh);
    this.rings = new RingPool(scene, 14);
    this.flashes = new FlashPool(scene, 6);
  }

  reset(): void {
    this.rng = makeRng(99);
    this.dust.clear();
    this.sparks.clear();
    this.rings.clear();
    this.flashes.clear();
  }

  get particleCount(): number {
    return this.dust.activeCount + this.sparks.activeCount;
  }

  private puff(x: number, y: number, z: number, count: number, speed: number, size: number, color = DUST): void {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + this.rng() * 0.5;
      const s = speed * range(this.rng, 0.6, 1.2);
      this.v.set(x + Math.cos(a) * 0.2, y + 0.08, z + Math.sin(a) * 0.2);
      this.w.set(Math.cos(a) * s, range(this.rng, 0.4, 1.4), Math.sin(a) * s);
      this.dust.spawn(this.v, this.w, range(this.rng, 0.35, 0.6), size * range(this.rng, 0.7, 1.2), -1.5, 4, color);
    }
  }

  private burst(x: number, y: number, z: number, dirX: number, dirZ: number, count: number, speed: number, color: THREE.Color): void {
    for (let i = 0; i < count; i++) {
      const spread = range(this.rng, -1.1, 1.1);
      const c = Math.cos(spread);
      const s = Math.sin(spread);
      const dx = dirX * c - dirZ * s;
      const dz = dirX * s + dirZ * c;
      const sp = speed * range(this.rng, 0.5, 1.2);
      this.v.set(x, y, z);
      this.w.set(dx * sp, range(this.rng, -1, 4), dz * sp);
      this.sparks.spawn(this.v, this.w, range(this.rng, 0.18, 0.32), range(this.rng, 0.06, 0.1), 14, 3, color);
    }
  }

  onEvent(e: GameEvent): void {
    switch (e.type) {
      case 'jump':
        this.puff(e.x, e.y, e.z, 5, 1.6, 0.22);
        break;
      case 'doubleJump':
        this.rings.spawn(this.v.set(e.x, e.y + 0.1, e.z), 1.0, 0.3, 0xffffff);
        break;
      case 'land':
        this.puff(e.x, e.y, e.z, 6 + Math.round(e.impact * 6), 2 + e.impact * 2.5, 0.22 + e.impact * 0.12);
        break;
      case 'action': {
        // Kick up dust for a movement skill that actually carries you along the ground; a guard
        // stands still and shouldn't.
        const def = MOVEMENT_SKILLS[e.id]?.action;
        if (def && def.speed > 0) this.puff(e.x, this.gy(e.x, e.z), e.z, 6, 2.2, 0.26);
        break;
      }
      case 'hit': {
        const big = e.index === 2;
        const color = big ? new THREE.Color(0xffd166) : new THREE.Color(0xfff6c8);
        this.burst(e.x, e.y, e.z, e.dirX, e.dirZ, big ? 22 : 12, big ? 9 : 6.5, color);
        this.puff(e.x, e.y - 0.3, e.z, big ? 6 : 3, 1.4, 0.16, STRAW);
        this.rings.spawn(this.v.set(e.x, this.gy(e.x, e.z) + 0.03, e.z), big ? 1.8 : 1.0, big ? 0.35 : 0.22, big ? 0xffd166 : 0xffffff);
        break;
      }
      case 'actorDie':
        // Straw for a dummy; anything else bursts in its own colour once content says so.
        if (e.kind !== 'dummy') {
          this.puff(e.x, Math.max(0.2, e.y), e.z, 10, 2.2, 0.26);
          break;
        }
        this.puff(e.x, 0.6, e.z, 16, 3.5, 0.3, STRAW);
        this.burst(e.x, 1.1, e.z, 1, 0, 14, 7, STRAW);
        this.burst(e.x, 1.1, e.z, -1, 0, 14, 7, STRAW);
        break;
      case 'shoot':
        // Bow release: a little snap of light off the string.
        this.burst(e.x, e.y, e.z, e.dirX, e.dirZ, 5, 5, new THREE.Color(0xfff6c8));
        break;
      case 'arrowHit':
        this.burst(e.x, e.y, e.z, 1, 0, 6, 5, new THREE.Color(0xfff6c8));
        this.burst(e.x, e.y, e.z, -1, 0, 6, 5, new THREE.Color(0xffd166));
        this.rings.spawn(this.v.set(e.x, Math.max(0.03, e.y - 1.2), e.z), 0.9, 0.2, 0xffffff);
        break;
      case 'heal':
        this.healBloom(e.x, e.z, e.radius);
        break;
      case 'explosion':
        this.explosion(e.x, e.z, e.radius);
        break;
      default:
        break;
    }
  }

  // Healing Circle: a green ring sweeps out and sparkles drift up across the whole area.
  private healBloom(x: number, z: number, radius: number): void {
    const g = this.gy(x, z);
    this.rings.spawn(this.v.set(x, g + 0.05, z), radius, 0.7, 0x4dff9a);
    this.rings.spawn(this.v.set(x, g + 0.06, z), radius * 0.55, 0.45, 0xd8ffe6);
    for (let i = 0; i < 40; i++) {
      const a = this.rng() * Math.PI * 2;
      const r = Math.sqrt(this.rng()) * radius;
      this.v.set(x + Math.cos(a) * r, g + range(this.rng, 0.1, 1.2), z + Math.sin(a) * r);
      this.w.set(0, range(this.rng, 1.5, 3.2), 0);
      this.sparks.spawn(this.v, this.w, range(this.rng, 0.6, 1.1), range(this.rng, 0.06, 0.11), -1.5, 1.5, HEAL[i % HEAL.length]);
    }
  }

  // Meteor impact: a flash, a fireball of sparks, smoke and shockwave rings.
  private explosion(x: number, z: number, radius: number): void {
    const g = this.gy(x, z);
    this.flashes.spawn(this.v.set(x, g + 0.8, z), radius * 0.9, 0.35, 0xffb347);
    this.rings.spawn(this.v.set(x, g + 0.05, z), radius * 1.15, 0.5, 0xff7a1a);
    this.rings.spawn(this.v.set(x, g + 0.06, z), radius * 0.7, 0.28, 0xfff1c1);
    for (let i = 0; i < 46; i++) {
      const a = this.rng() * Math.PI * 2;
      const s = range(this.rng, 5, 13);
      this.v.set(x + Math.cos(a) * 0.4, g + range(this.rng, 0.2, 1.0), z + Math.sin(a) * 0.4);
      this.w.set(Math.cos(a) * s, range(this.rng, 2, 9), Math.sin(a) * s);
      this.sparks.spawn(this.v, this.w, range(this.rng, 0.3, 0.6), range(this.rng, 0.08, 0.15), 14, 2, FIRE[i % FIRE.length]);
    }
    this.puff(x, g + 0.2, z, 14, radius * 1.1, 0.5, SMOKE);
    this.puff(x, g + 0.1, z, 10, radius * 1.6, 0.35, DUST);
  }

  // Embers and smoke streaming off a falling meteor. Called every drawn frame.
  fireTrail(x: number, y: number, z: number): void {
    this.trailTick++;
    for (let i = 0; i < 2; i++) {
      this.v.set(x + range(this.rng, -0.3, 0.3), y + range(this.rng, -0.3, 0.3), z + range(this.rng, -0.3, 0.3));
      this.w.set(range(this.rng, -1.2, 1.2), range(this.rng, 1, 3), range(this.rng, -1.2, 1.2));
      this.sparks.spawn(this.v, this.w, range(this.rng, 0.2, 0.4), range(this.rng, 0.1, 0.18), 0, 2, FIRE[(this.trailTick + i) % FIRE.length]);
    }
    if (this.trailTick % 3 === 0) {
      this.v.set(x, y + 0.3, z);
      this.w.set(range(this.rng, -0.5, 0.5), range(this.rng, 0.5, 1.5), range(this.rng, -0.5, 0.5));
      this.dust.spawn(this.v, this.w, range(this.rng, 0.4, 0.7), range(this.rng, 0.35, 0.55), -1, 1, SMOKE);
    }
  }


  // A small dust kick every few frames while sliding.
  slideDust(x: number, z: number, dirX: number, dirZ: number): void {
    this.v.set(x - dirX * 0.3 + range(this.rng, -0.15, 0.15), this.gy(x, z) + 0.06, z - dirZ * 0.3 + range(this.rng, -0.15, 0.15));
    this.w.set(-dirX * 1.5 + range(this.rng, -0.6, 0.6), range(this.rng, 0.5, 1.3), -dirZ * 1.5 + range(this.rng, -0.6, 0.6));
    this.dust.spawn(this.v, this.w, range(this.rng, 0.3, 0.45), range(this.rng, 0.16, 0.26), -1, 3, DUST);
  }

  /** Open-world happenings: a harvest, a felled tree, a building stage, a sale, a splash. */
  lifeEffect(kind: string, x: number, y: number, z: number): void {
    const LEAF = new THREE.Color(0x6abf4b);
    const WOOD = new THREE.Color(0xc8995f);
    const STONE = new THREE.Color(0xbcb6aa);
    const GOLD = new THREE.Color(0xffd166);
    const WATER = new THREE.Color(0xe8fbff);
    switch (kind) {
      case 'harvest':
        this.burst(x, y + 0.5, z, 1, 0, 8, 3, LEAF);
        this.burst(x, y + 0.5, z, -1, 0, 8, 3, STRAW);
        this.puff(x, y, z, 5, 1.2, 0.2, DUST);
        break;
      case 'timber':
        this.burst(x, y + 0.8, z, 1, 0, 10, 4, WOOD);
        this.burst(x, y + 0.8, z, -1, 0, 10, 4, WOOD);
        break;
      case 'stone':
      case 'ore':
        this.burst(x, y + 0.8, z, 1, 0, 10, 4, STONE);
        this.puff(x, y + 0.2, z, 8, 2, 0.3, DUST);
        break;
      case 'herbs':
        this.burst(x, y + 0.4, z, 0, 1, 10, 2.5, LEAF);
        break;
      case 'build':
        this.rings.spawn(this.v.set(x, y + 0.08, z), 7, 0.6, 0xffd166);
        this.puff(x, y + 0.2, z, 22, 5, 0.6, DUST);
        for (let i = 0; i < 30; i++) {
          this.v.set(x + range(this.rng, -4, 4), y + range(this.rng, 0.5, 4), z + range(this.rng, -4, 4));
          this.w.set(0, range(this.rng, 1, 3), 0);
          this.sparks.spawn(this.v, this.w, range(this.rng, 0.5, 1), range(this.rng, 0.06, 0.12), -1, 1, GOLD);
        }
        break;
      case 'coins':
        for (let i = 0; i < 26; i++) {
          const a = this.rng() * Math.PI * 2;
          this.v.set(x, y + 1.4, z);
          this.w.set(Math.cos(a) * range(this.rng, 1, 3), range(this.rng, 3, 6), Math.sin(a) * range(this.rng, 1, 3));
          this.sparks.spawn(this.v, this.w, range(this.rng, 0.5, 0.9), range(this.rng, 0.08, 0.14), 9, 1, GOLD);
        }
        this.rings.spawn(this.v.set(x, y + 0.05, z), 1.6, 0.4, 0xffd166);
        break;
      case 'splash':
        this.rings.spawn(this.v.set(x, y + 0.04, z), 2.2, 0.6, 0xffffff);
        for (let i = 0; i < 24; i++) {
          const a = this.rng() * Math.PI * 2;
          this.v.set(x, y + 0.1, z);
          this.w.set(Math.cos(a) * range(this.rng, 1, 3), range(this.rng, 3, 6.5), Math.sin(a) * range(this.rng, 1, 3));
          this.sparks.spawn(this.v, this.w, range(this.rng, 0.4, 0.7), range(this.rng, 0.07, 0.12), 14, 1, WATER);
        }
        break;
      case 'thunder':
        this.flashes.spawn(this.v.set(x, y + 1.5, z), 3, 0.3, 0xfff6a0);
        this.burst(x, y + 1, z, 1, 0, 16, 6, GOLD);
        this.burst(x, y + 1, z, -1, 0, 16, 6, GOLD);
        break;
      case 'glide':
        this.rings.spawn(this.v.set(x, y + 2.4, z), 2.6, 0.35, 0xffffff);
        break;
      case 'wake':
        this.v.set(x + range(this.rng, -0.4, 0.4), y + 0.05, z + range(this.rng, -0.4, 0.4));
        this.w.set(range(this.rng, -1, 1), range(this.rng, 0.6, 1.6), range(this.rng, -1, 1));
        this.sparks.spawn(this.v, this.w, range(this.rng, 0.3, 0.5), range(this.rng, 0.06, 0.1), 9, 2, WATER);
        break;
      case 'wheels':
        this.v.set(x + range(this.rng, -0.3, 0.3), y + 0.08, z + range(this.rng, -0.3, 0.3));
        this.w.set(range(this.rng, -0.8, 0.8), range(this.rng, 0.4, 1.2), range(this.rng, -0.8, 0.8));
        this.dust.spawn(this.v, this.w, range(this.rng, 0.35, 0.55), range(this.rng, 0.18, 0.3), -1, 3, DUST);
        break;
    }
  }

  step(dt: number): void {
    this.dust.step(dt);
    this.sparks.step(dt);
    this.rings.step(dt);
    this.flashes.step(dt);
  }
}
