import type { BoxCollider } from './types';

// Turning between a structure's own frame (its +Z is its front) and the world's.

/** World offset into a structure's own frame (its +Z is its front). */
export function toLocal(dx: number, dz: number, rot: number): [number, number] {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return [dx * c - dz * s, dx * s + dz * c];
}

/** A structure-local point back out into the world. */
export function toWorld(lx: number, lz: number, rot: number): [number, number] {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return [lx * c + lz * s, -lx * s + lz * c];
}

/** A solid rectangle at (x, z), `hw` by `hd` either way, turned `rot`, up to `top`. */
export function rect(x: number, z: number, hw: number, hd: number, rot: number, top: number): BoxCollider {
  return { x, z, hw, hd, rot, cos: Math.cos(rot), sin: Math.sin(rot), top };
}
