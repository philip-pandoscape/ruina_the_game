// Small maths every part of the game uses, once. Angles are radians.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

/** `v` kept between `lo` and `hi`. */
export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** From `a` to `b` by `t` (0 is `a`, 1 is `b`). */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
