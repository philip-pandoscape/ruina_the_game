import * as THREE from 'three';
import { CAMERA } from '../tuning';

// Over-the-shoulder camera that orbits the player and shakes on big hits.
export class FollowCamera {
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0; // 0 looks toward +Z
  pitch = CAMERA.startPitch;
  distance = CAMERA.distance;
  private focus = new THREE.Vector3();
  private placed = false;
  private aim = 0; // 0..1: how far into the raised ground-targeting view
  private aimWanted = 0;
  private lead = new THREE.Vector3(); // where the circle is, to lean the view toward it
  private hasLead = false;
  private look = new THREE.Vector3(); // focus, leaned toward the circle; never written back
  private trauma = 0;
  private shakeTime = 0;
  /** Lowest the eye may go at a point (terrain and sea in an open world); null on flat ground. */
  groundAt: ((x: number, z: number) => number) | null = null;
  /**
   * How far along the line from the player to the camera it can go before something solid is in
   * the way, 0..1 (buildings in an open world); null when nothing ever blocks it.
   */
  blocker: ((fx: number, fy: number, fz: number, cx: number, cy: number, cz: number) => number) | null = null;
  /**
   * A hood of rock over the player (the goblins' ledge behind the falls): how high the eye may go
   * under it, and whether a point is still under it. Null in the open. There the ground's height is
   * no floor to lift the eye to - the ground behind is the cliff above the hood - so the eye stays
   * under the hood instead, pulled in short of any rock between it and the player.
   */
  ceiling: ((x: number, y: number, z: number) => { eye: number; under: (x: number, z: number) => boolean } | null) | null = null;
  /** The bare ground's height (no padding), for the pull-in under a hood. */
  terrainAt: ((x: number, z: number) => number) | null = null;
  private reach = 1; // eased: snaps in when blocked, drifts back out when clear

  constructor(aspect: number, far = 320, private maxDistance = 14) {
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, aspect, 0.1, far);
  }

  rotate(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = Math.max(CAMERA.pitchMin, Math.min(CAMERA.pitchMax, this.pitch + dPitch));
  }

  // dZoom is logarithmic: +0.1 moves the camera about 10% further away.
  zoom(dZoom: number): void {
    this.distance = Math.max(3, Math.min(this.maxDistance, this.distance * Math.exp(dZoom)));
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  // Placing a ground-aimed cast: lift the view and lean it toward the circle. Call this every
  // frame while aiming, then stopAiming() once the cast goes off or is cancelled.
  aimAt(x: number, z: number): void {
    this.aimWanted = 1;
    this.lead.set(x, 0, z);
    this.hasLead = true;
  }

  stopAiming(): void {
    this.aimWanted = 0;
  }

  get aiming(): number {
    return this.aim;
  }

  reset(yaw: number): void {
    this.yaw = yaw;
    this.pitch = CAMERA.startPitch;
    this.distance = CAMERA.distance;
    this.placed = false;
    this.trauma = 0;
    this.shakeTime = 0;
    this.aim = 0;
    this.aimWanted = 0;
    this.hasLead = false;
  }

  // Follows the target smoothly. Vertical follow is looser so jumps don't jerk the view.
  update(target: THREE.Vector3, dt: number): void {
    const gx = target.x;
    const gy = target.y + CAMERA.targetHeight;
    const gz = target.z;
    if (!this.placed) {
      this.focus.set(gx, gy, gz);
      this.placed = true;
    } else {
      const kxz = 1 - Math.exp(-CAMERA.followXZ * dt);
      const ky = 1 - Math.exp(-CAMERA.followY * dt);
      this.focus.x += (gx - this.focus.x) * kxz;
      this.focus.y += (gy - this.focus.y) * ky;
      this.focus.z += (gz - this.focus.z) * kxz;
    }

    // Ease in and out of the targeting view rather than snapping to it.
    this.aim += (this.aimWanted - this.aim) * (1 - Math.exp(-CAMERA.aimEase * dt));
    if (this.aim < 0.001) {
      this.aim = 0;
      this.hasLead = false;
    }
    // The player's own pitch and zoom are left alone; only what's used this frame is blended.
    const pitch = this.pitch + (CAMERA.aimPitch - this.pitch) * this.aim;
    const distance = this.distance * (1 + (CAMERA.aimZoom - 1) * this.aim);
    // Leaning must not write back into the smoothed follow position, or it would drift toward
    // the circle and stay there.
    const look = this.look.copy(this.focus);
    if (this.aim > 0 && this.hasLead) {
      const k = CAMERA.aimLead * this.aim;
      look.x += (this.lead.x - look.x) * k;
      look.z += (this.lead.z - look.z) * k;
    }

    const flat = distance * Math.cos(pitch);
    const cam = this.camera;
    const cx = look.x - Math.sin(this.yaw) * flat;
    const cz = look.z - Math.cos(this.yaw) * flat;
    const floor = this.groundAt ? this.groundAt(cx, cz) : 0.4;
    const hood = this.ceiling?.(look.x, look.y, look.z) ?? null;
    if (hood && this.terrainAt) {
      const cy = Math.min(look.y + distance * Math.sin(pitch), hood.eye);
      let t = 1;
      for (let k = 1; k <= 32; k++) {
        const u = k / 32;
        const x = look.x + (cx - look.x) * u;
        const z = look.z + (cz - look.z) * u;
        if (!hood.under(x, z) || this.terrainAt(x, z) + 0.35 > look.y + (cy - look.y) * u) {
          t = Math.max(0.08, (k - 1.5) / 32);
          break;
        }
      }
      cam.position.set(look.x + (cx - look.x) * t, look.y + (cy - look.y) * t, look.z + (cz - look.z) * t);
    } else cam.position.set(cx, Math.max(floor, look.y + distance * Math.sin(pitch)), cz);
    if (this.blocker) {
      const free = this.blocker(look.x, look.y, look.z, cam.position.x, cam.position.y, cam.position.z);
      this.reach = free < this.reach ? free : this.reach + (free - this.reach) * (1 - Math.exp(-4 * dt));
      if (this.reach < 0.999) cam.position.lerpVectors(look, cam.position, this.reach);
    }
    cam.lookAt(look);

    this.shakeTime += dt;
    this.trauma = Math.max(0, this.trauma - 2.2 * dt);
    const amp = this.trauma * this.trauma;
    if (amp > 0) {
      const t = this.shakeTime;
      cam.translateX(amp * 0.22 * (Math.sin(t * 47.3) + 0.5 * Math.sin(t * 31.7)));
      cam.translateY(amp * 0.18 * (Math.sin(t * 53.1 + 1.7) + 0.5 * Math.sin(t * 29.3)));
      cam.rotateZ(amp * 0.03 * Math.sin(t * 41.9 + 0.4));
    }
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
