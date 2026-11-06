import * as THREE from 'three';
import { bindWorlds } from './pose';
import { MAT, type Joint, type ProxyBox, type Quat, type Vec3 } from './types';

// Hand-authoring a species. Imported rigs go through fit.ts; anything without a motion library -
// a slime, a construct, a boss with three heads - is written here instead, and comes out in the
// same format, through the same renderer.

export interface BoxOptions {
  mat?: number;
  color?: number;
  /** Euler rotation in the joint's own space, radians. */
  tilt?: Vec3;
}

export class RigBuilder {
  private joints: Joint[] = [];
  private pending: Array<{ joint: number; pos: Vec3; size: Vec3; opts: BoxOptions }> = [];

  /** Adds a joint under `parent` (-1 for the root) at an offset from it, in metres. */
  joint(name: string, parent: number, pos: Vec3, rot: Quat = [0, 0, 0, 1]): number {
    if (parent >= this.joints.length) throw new Error(`joint ${name}: parent ${parent} not added yet`);
    this.joints.push({ name, parent, pos, rot });
    return this.joints.length - 1;
  }

  /** Hangs a box off a joint, positioned in that joint's own space. */
  box(joint: number, pos: Vec3, size: Vec3, opts: BoxOptions = {}): this {
    this.pending.push({ joint, pos, size, opts });
    return this;
  }

  build(): { joints: Joint[]; proxy: ProxyBox[]; height: number } {
    const worlds = bindWorlds(this.joints);
    const t = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const bounds = new THREE.Box3();
    const proxy = this.pending.map(({ joint, pos, size, opts }) => {
      const local = new THREE.Matrix4().compose(
        new THREE.Vector3(...pos),
        opts.tilt ? new THREE.Quaternion().setFromEuler(new THREE.Euler(...opts.tilt)) : new THREE.Quaternion(),
        new THREE.Vector3(1, 1, 1),
      );
      new THREE.Matrix4().multiplyMatrices(worlds[joint], local).decompose(t, q, s);
      bounds.expandByPoint(new THREE.Vector3(t.x, t.y + size[1] / 2, t.z));
      bounds.expandByPoint(new THREE.Vector3(t.x, t.y - size[1] / 2, t.z));
      return {
        joint,
        pos: [t.x, t.y, t.z] as Vec3,
        rot: [q.x, q.y, q.z, q.w] as Quat,
        size,
        mat: opts.mat ?? MAT.fixed,
        color: opts.color ?? 0xffffff,
      };
    });
    return { joints: this.joints, proxy, height: bounds.max.y - Math.min(0, bounds.min.y) };
  }
}

/** A joint's bind rotation nudged about an axis - the usual shape of an authored pose track. */
export const swing = (rest: Quat, axis: Vec3, radians: number): Quat => {
  const q = new THREE.Quaternion(...rest).multiply(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), radians),
  );
  return [q.x, q.y, q.z, q.w];
};
