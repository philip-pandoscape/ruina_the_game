import type { ActorSpawnPoint } from './types';

/**
 * A war-band of `count` of a kind standing in a ring round (x, z), facing out, as spawn points
 * that share `band`.
 */
export function bandAround(kind: string, count: number, x: number, z: number, band: number, seed = 0x9b1d): ActorSpawnPoint[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2;
    const r = count > 1 ? 1.2 + 0.4 * (i % 2) : 0;
    return { kind, x: x + Math.sin(angle) * r, z: z + Math.cos(angle) * r, facing: angle, seed: (seed + Math.imul(i + 1, 0x9e3779b1)) >>> 0, band };
  });
}
