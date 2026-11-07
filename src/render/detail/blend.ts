import * as THREE from 'three';
import type { Body } from './body';

// Smooths a change of state - a swing starting, a landing, climbing onto a horse - without
// slowing the new motion down. When the state changes, the difference between what was on screen
// and what the new pose wants is kept as an offset, and the offset fades out over a few frames
// while the new pose plays underneath at full speed (what games call inertialization). The poses
// themselves stay a pure function of their input; only the close-up renderer holds this state.

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _id = new THREE.Quaternion();

export class Inertia {
  private shown: Float32Array;
  private offset: Float32Array;
  private has = false;
  private t = 0;
  private duration = 0;

  constructor(private readonly body: Body) {
    this.shown = new Float32Array(body.jointCount * 10);
    this.offset = new Float32Array(body.jointCount * 10);
  }

  /** Forget what was shown (a teleport, a respawn): the next pose appears as it is. */
  reset(): void {
    this.has = false;
    this.duration = 0;
  }

  /**
   * Call once per frame after the rig has been posed. `blend` > 0 starts a transition of that many
   * seconds from whatever was last on screen; `dt` is the time since the last frame.
   */
  step(dt: number, blend: number): void {
    const b = this.body;
    const target = b.save(b.buf(4));
    if (blend > 0 && this.has) {
      for (let i = 0; i < b.jointCount; i++) {
        const o = i * 10;
        this.offset[o] = this.shown[o] - target[o];
        this.offset[o + 1] = this.shown[o + 1] - target[o + 1];
        this.offset[o + 2] = this.shown[o + 2] - target[o + 2];
        // The turn that takes the new pose to the old one.
        _q.set(this.shown[o + 3], this.shown[o + 4], this.shown[o + 5], this.shown[o + 6]);
        _q2.set(target[o + 3], target[o + 4], target[o + 5], target[o + 6]).invert();
        _q.multiply(_q2);
        this.offset[o + 3] = _q.x;
        this.offset[o + 4] = _q.y;
        this.offset[o + 5] = _q.z;
        this.offset[o + 6] = _q.w;
        for (let j = 7; j < 10; j++) this.offset[o + j] = this.shown[o + j] / Math.max(1e-4, target[o + j]);
      }
      this.t = 0;
      this.duration = blend;
    }
    if (this.has && this.t < this.duration) {
      // Fades smoothly: holds the old pose's position for an instant, then lets go.
      const k = Math.min(1, this.t / this.duration);
      const w = 1 - k * k * (3 - 2 * k);
      const out = b.buf(5);
      for (let i = 0; i < b.jointCount; i++) {
        const o = i * 10;
        out[o] = target[o] + this.offset[o] * w;
        out[o + 1] = target[o + 1] + this.offset[o + 1] * w;
        out[o + 2] = target[o + 2] + this.offset[o + 2] * w;
        _q.set(this.offset[o + 3], this.offset[o + 4], this.offset[o + 5], this.offset[o + 6]);
        _q2.slerpQuaternions(_id, _q, w);
        _q.set(target[o + 3], target[o + 4], target[o + 5], target[o + 6]);
        _q2.multiply(_q);
        out[o + 3] = _q2.x;
        out[o + 4] = _q2.y;
        out[o + 5] = _q2.z;
        out[o + 6] = _q2.w;
        for (let j = 7; j < 10; j++) out[o + j] = target[o + j] * (1 + (this.offset[o + j] - 1) * w);
      }
      b.mix(out, out, 1);
      this.t += dt;
    }
    b.save(this.shown);
    this.has = true;
  }

  /** Whether a transition is still fading out. */
  get blending(): boolean {
    return this.has && this.t < this.duration;
  }
}
