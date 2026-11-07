// Small maths the page shares with the rules' read helpers. Angles are radians, except where a
// tuning value is written in degrees.
import { TAU, DEG } from '../util/math';

// Shortest signed angle from a to b.
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export { TAU, DEG };
