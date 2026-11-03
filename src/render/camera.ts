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
  private trauma = 0;
  private shakeTime = 0;

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

  reset(yaw: number): void {
    this.yaw = yaw;
    this.pitch = CAMERA.startPitch;
    this.distance = CAMERA.distance;
    this.placed = false;
    this.trauma = 0;
    this.shakeTime = 0;
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

    const flat = this.distance * Math.cos(this.pitch);
    const cam = this.camera;
    cam.position.set(
      this.focus.x - Math.sin(this.yaw) * flat,
      Math.max(0.4, this.focus.y + this.distance * Math.sin(this.pitch)),
      this.focus.z - Math.cos(this.yaw) * flat,
    );
    cam.lookAt(this.focus);

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
