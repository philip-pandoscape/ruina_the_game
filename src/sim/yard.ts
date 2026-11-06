import { makeRng, range } from '../util/rng';
import { SLIME, WORLD } from '../content/tuning';
import type { ActorSpawnPoint, Obstacle, World } from './types';

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

// Builds the same layout every time for a given seed. The renderer and the rules both read it.
export function makeWorld(seed = WORLD.seed): World {
  const rng = makeRng(seed);
  const obstacles: Obstacle[] = [];
  const dummy = { x: 0, z: 3.2 };
  const spawn = { x: 0, z: -1, facing: 0 };

  const fits = (x: number, z: number, r: number, clearance: number) => {
    for (const o of obstacles) {
      if (Math.hypot(o.x - x, o.z - z) < o.r + r + clearance) return false;
    }
    return true;
  };

  // Training-yard props close to the dummy.
  const props: Array<[Obstacle['kind'], number, number, number]> = [
    ['hay', 4.2, 4.6, 0.3],
    ['hay', 5.4, 3.4, 1.4],
    ['crate', -4.6, 4.0, 0.2],
    ['crate', -5.3, 5.0, 0.9],
    ['crate', -4.1, 5.5, 0.5],
    ['hay', -6.0, -2.5, 2.1],
  ];
  for (const [kind, x, z, rot] of props) {
    obstacles.push({ kind, x, z, r: kind === 'hay' ? 0.62 : 0.5, scale: 1, rot });
  }

  // A ring of trees around the clearing.
  let tries = 0;
  let trees = 0;
  while (trees < 48 && tries < 3000) {
    tries++;
    const angle = rng() * Math.PI * 2;
    const dist = range(rng, 12, WORLD.radius + 6);
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    const scale = range(rng, 0.8, 1.35);
    const r = 0.45 * scale;
    if (!fits(x, z, r, 1.6)) continue;
    obstacles.push({ kind: 'tree', x, z, r, scale, rot: rng() * Math.PI * 2 });
    trees++;
  }

  // Rocks scattered everywhere except right by the spawn and the dummy.
  tries = 0;
  let rocks = 0;
  while (rocks < 26 && tries < 3000) {
    tries++;
    const angle = rng() * Math.PI * 2;
    const dist = range(rng, 6.5, WORLD.radius + 4);
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    const scale = range(rng, 0.45, 1.1);
    const r = 0.55 * scale;
    if (Math.hypot(x - spawn.x, z - spawn.z) < 4 || Math.hypot(x - dummy.x, z - dummy.z) < 4) continue;
    if (!fits(x, z, r, 0.8)) continue;
    obstacles.push({ kind: 'rock', x, z, r, scale, rot: rng() * Math.PI * 2 });
    rocks++;
  }

  // Who is standing here when you arrive. Adding a monster to the yard is a line in this list.
  const spawns: ActorSpawnPoint[] = [{ kind: 'dummy', x: dummy.x, z: dummy.z }];
  for (let i = 0; i < SLIME.count; i++) {
    const angle = (i / SLIME.count) * Math.PI * 2 + 0.4;
    const r = 5 + (i % 3);
    spawns.push({ kind: 'slime', x: Math.sin(angle) * r, z: 4 + Math.cos(angle) * r, seed: (seed ^ 0x51e0) + i * 0x9e3779b1 });
  }
  return { seed, radius: WORLD.radius, obstacles, dummy, spawn, teamSpawns: [spawn, spawn], spawns };
}
