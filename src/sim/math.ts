import { TAU, DEG } from '../util/math';
// Small shared maths the rules lean on. Angles are radians; the sim never uses degrees except
// where a tuning value is written in them.


// Shortest signed angle from a to b.
// Plain square root instead of Math.hypot, so Rust (server/src/player.rs) gets identical results.
export const len = (x: number, z: number) => Math.sqrt(x * x + z * z);

export function angleDiff(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function turnToward(current: number, target: number, maxStep: number): number {
  const d = angleDiff(current, target);
  const next = current + Math.max(-maxStep, Math.min(maxStep, d));
  return Math.atan2(Math.sin(next), Math.cos(next));
}

export { TAU, DEG };
