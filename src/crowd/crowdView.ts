import * as THREE from 'three';
import { SpeciesCrowd } from '../species/crowd';
import { FIGHTER_ATTACK_FRAMES, FIGHTER_RUN_FRAMES } from '../species/builtin/fighter';
import { getSpecies } from '../species/registry';
import { clipRows } from '../species/types';
import { ATTACK_TIME, CROWD_SPEED } from './crowdSim';
import { TAU } from '../util/math';

// Draws thousands of fighters in three draw calls. The fighter is an ordinary species now, so
// the posing lives in src/species rather than here; what is left is the battle's own bookkeeping
// - who has fallen, who is mid-swing, who we have not heard about yet - and the ground shadows.

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

export class CrowdView {
  readonly group = new THREE.Group();
  readonly trianglesPerFighter: number;
  updateMs = 0; // smoothed CPU cost of writing per-fighter data each frame
  private crowd: SpeciesCrowd;
  private root: Float32Array;
  private pose: Float32Array;
  private phase: Float32Array;
  private localSwing: Float32Array;
  private lastSwing: Uint16Array;
  private downSince: Float32Array; // when each fighter fell (-1 while standing)
  private spawnedAt: Float32Array; // when each fighter last (re)appeared
  private time = 0;
  private rows: { idle: number; run: number; attack: number; down: number };

  constructor(private n: number) {
    this.phase = new Float32Array(n);
    this.localSwing = new Float32Array(n).fill(-1);
    this.lastSwing = new Uint16Array(n);
    this.downSince = new Float32Array(n).fill(-1);
    this.spawnedAt = new Float32Array(n).fill(-100);

    const species = getSpecies('fighter');
    this.crowd = new SpeciesCrowd(species, n);
    this.crowd.setCount(n);
    this.group.add(this.crowd.group);
    this.trianglesPerFighter = this.crowd.trianglesPerInstance;
    this.root = this.crowd.root;
    this.pose = this.crowd.pose;
    const [idle, run, attack, down] = clipRows(species);
    this.rows = { idle, run, attack, down };

    // Soft round shadows under every fighter, faded out by distance like the fog. These ride on
    // the crowd's own position attribute, so they follow it for free.
    const blobGeo = new THREE.InstancedBufferGeometry();
    const circle = new THREE.CircleGeometry(0.42, 10).rotateX(-Math.PI / 2);
    blobGeo.index = circle.index;
    for (const [name, attr] of Object.entries(circle.attributes)) blobGeo.setAttribute(name, attr);
    blobGeo.instanceCount = n;
    blobGeo.setAttribute('aRoot', this.crowd.rootAttribute);
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
    const { root, pose, phase, localSwing, lastSwing, downSince, spawnedAt, time, rows } = this;
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

      // Pick the two pose rows to read and how far between them to sit.
      let a: number;
      let b: number;
      let mix: number;
      if (swing < -1.5) {
        a = b = rows.down;
        mix = 0;
      } else if (swing >= 0) {
        const t = swing * (FIGHTER_ATTACK_FRAMES - 1);
        const f = Math.floor(t);
        a = rows.attack + f;
        b = rows.attack + Math.min(f + 1, FIGHTER_ATTACK_FRAMES - 1);
        mix = t - f;
      } else {
        // The run cycle at full stride, blended back toward the standing pose by how fast this
        // fighter is actually moving.
        let p = (phase[i] / TAU) % 1;
        if (p < 0) p += 1;
        a = rows.run + (Math.floor(p * FIGHTER_RUN_FRAMES) % FIGHTER_RUN_FRAMES);
        b = rows.idle;
        mix = 1 - Math.min(1, speed / CROWD_SPEED);
      }
      pose[k] = a;
      pose[k + 1] = b;
      pose[k + 2] = mix;
      pose[k + 3] = team[i];
    }
    this.crowd.flush();
    const ms = performance.now() - t0;
    this.updateMs = this.updateMs === 0 ? ms : this.updateMs * 0.95 + ms * 0.05;
  }
}
