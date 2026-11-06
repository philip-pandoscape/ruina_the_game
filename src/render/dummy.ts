import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { isAlive, type Actor } from '../engine/creatures';
import { DUMMY } from '../content/tuning';
import { part, toon } from './toon';

// A straw training dummy on a post. It wobbles, flashes white when hit, and pops back after breaking.
export class TrainingDummy {
  readonly root = new THREE.Group();
  private pivot = new THREE.Group();
  private parts = new THREE.Group();
  private flashMats: THREE.MeshToonMaterial[];

  constructor(x: number, z: number) {
    const wood = toon(0x8d5a3b);
    const straw = toon(0xe2c158);
    const rope = toon(0xa1887f);
    const red = toon(0xd63031);
    const white = toon(0xf5f0e6);
    this.flashMats = [straw, rope, red, white];

    this.root.position.set(x, 0, z);
    part(this.root, new THREE.CylinderGeometry(0.45, 0.5, 0.12, 12), wood, 0, 0.06, 0);
    this.pivot.position.y = 0.12;
    this.root.add(this.pivot);
    this.parts.rotation.y = Math.PI; // faces the player's spawn
    this.pivot.add(this.parts);

    const p = this.parts;
    part(p, new THREE.CylinderGeometry(0.07, 0.08, 1.0, 8), wood, 0, 0.5, 0);
    part(p, new RoundedBoxGeometry(0.52, 0.72, 0.38, 3, 0.14), straw, 0, 0.98, 0);
    part(p, new RoundedBoxGeometry(0.55, 0.06, 0.41, 2, 0.03), rope, 0, 0.74, 0);
    part(p, new RoundedBoxGeometry(0.55, 0.06, 0.41, 2, 0.03), rope, 0, 1.24, 0);
    part(p, new THREE.IcosahedronGeometry(0.21, 1), straw, 0, 1.55, 0);
    const arm = new THREE.CylinderGeometry(0.04, 0.04, 1.1, 6);
    arm.rotateZ(Math.PI / 2);
    part(p, arm, wood, 0, 1.18, 0);
    for (const sx of [0.58, -0.58]) part(p, new THREE.IcosahedronGeometry(0.1, 0), straw, sx, 1.18, 0);
    // Target painted on the chest.
    const disc = (r: number) => {
      const g = new THREE.CylinderGeometry(r, r, 0.02, 24);
      g.rotateX(Math.PI / 2);
      return g;
    };
    part(p, disc(0.16), red, 0, 1.02, 0.19, { castShadow: false });
    part(p, disc(0.11), white, 0, 1.02, 0.2, { castShadow: false });
    part(p, disc(0.05), red, 0, 1.02, 0.21, { castShadow: false });
  }

  /** As the rules have it here: leaning the way it was hit, white as a blow lands, broken a moment. */
  update(d: Actor): void {
    this.pose(d.leanX, d.leanZ, Math.max(0, 1 - d.flashFrame / 8), isAlive(d) ? -1 : d.deadFrame);
  }

  /**
   * As the server has it (online, where the browser only draws what it says): how white it is (0..1)
   * and how many frames since it broke (-1 standing). The server doesn't say which way it leans.
   */
  fromNetwork(glow: number, deadFrame: number): void {
    this.pose(0, 0, glow, deadFrame);
  }

  private pose(leanX: number, leanZ: number, flash: number, deadFrame: number): void {
    // Lean toward the direction it was hit.
    this.pivot.rotation.set(leanZ, 0, -leanX);

    for (const m of this.flashMats) m.emissive.setScalar(flash * 0.65);
    const squish = 1 - 0.1 * flash;
    this.parts.scale.set(1 + 0.06 * flash, squish, 1 + 0.06 * flash);

    if (deadFrame >= 0) {
      // Broken: gone for a moment, then springs back up.
      const back = Math.max(0, (deadFrame - (DUMMY.resetFrames - 12)) / 12);
      const s = back * back * (3 - 2 * back);
      this.parts.scale.set(s, s, s);
    }
  }
}
