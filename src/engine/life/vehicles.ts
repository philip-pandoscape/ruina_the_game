import type { Mover } from '../shapes';
import type { Vehicle } from './land';
import { rideable, type RideableDef } from '../../content/vehicles';
import { groundAt, pushOutOfBox } from '../world/colliders';
import { toWorld } from '../world/frames';
import { MOVE } from '../../content/tuning';
import { SWIM } from '../../content/traversal';
import type { IslandRead } from './life';
import type { SimRead } from '../shapes';

// Vehicles as the page reads them: which one you ride, where you'd step out, what of one is solid to
// others, how a sail takes the wind. The engine drives them (crates/engine/src/life/vehicles.rs).

export const vehicleById = (life: IslandRead, id: number): Vehicle | undefined => life.land.vehicles.find((v) => v.id === id);
/**
 * The vehicle of yours you are riding. Riding along in someone else's (`host` set), it's theirs, not
 * one of your island's, even when one of yours has the same number.
 */
export const ridden = (life: IslandRead, sim: SimRead): Vehicle | undefined =>
  sim.player.vehicle && !sim.player.host ? vehicleById(life, sim.player.vehicle) : undefined;

function clearAt(sim: SimRead, x: number, z: number, r: number): boolean {
  let ok = true;
  sim.world.index?.eachObstacle(x, z, r + 1, (o) => {
    if (o.r > 0 && Math.hypot(o.x - x, o.z - z) < o.r + r) ok = false;
  });
  sim.world.index?.eachBox(x, z, r + 1, (b) => {
    if (b.top > -1e9 && pushOutOfBox(b, x, z, r)) ok = false;
  });
  return ok;
}

/** Where you would end up stepping out of a vehicle (dry land or a deck if any side has one). */
export function exitSpot(sim: SimRead, v: Vehicle): { x: number; y: number; z: number; dry: boolean } {
  const def = rideable(v.def);
  const hf = sim.world.terrain!;
  const side = def.width / 2 + 0.7;
  const tries: Array<[number, number]> = [
    [side, 0.3],
    [-side, 0.3],
    [0, def.length / 2 + 0.8],
    [0, -def.length / 2 - 0.8],
  ];
  let spot: { x: number; y: number; z: number; dry: boolean } | null = null;
  for (const [lx, lz] of tries) {
    const [ox, oz] = toWorld(lx, lz, v.heading);
    const x = v.x + ox;
    const z = v.z + oz;
    const y = groundAt(hf, sim.world.index, x, z, Math.max(v.y, hf.water) + 1.5, 2.2);
    const dry = y > hf.water - SWIM.depth + 0.2;
    if (dry && clearAt(sim, x, z, MOVE.playerRadius)) return { x, y, z, dry };
    if (!spot) spot = { x, y: dry ? y : hf.water - SWIM.float, z, dry };
  }
  return spot!;
}

/** A vehicle as something solid to everyone but its owner (World.movers): its circles, where it is now. */
export function vehicleBodies(v: Vehicle): Mover[] {
  const def = rideable(v.def);
  return circles(v, def).map((c) => ({ ...c, y: v.y, height: def.height }));
}

/** A long vehicle is two circles (front and back), a short one is one. */
function circles(v: Vehicle, def: RideableDef): Array<{ x: number; z: number; r: number }> {
  if (def.length < def.width * 1.6) return [{ x: v.x, z: v.z, r: def.radius }];
  const r = def.width / 2 + 0.1;
  const off = def.length / 2 - r;
  const fx = Math.sin(v.heading);
  const fz = Math.cos(v.heading);
  return [
    { x: v.x + fx * off, z: v.z + fz * off, r },
    { x: v.x - fx * off, z: v.z - fz * off, r },
    { x: v.x, z: v.z, r },
  ];
}

/** How much of the wind a sail can use at this angle off it (0 = wind straight behind). */
export function sailEfficiency(rel: number): number {
  return 0.25 + 0.75 * Math.pow(0.5 + 0.5 * Math.cos(rel), 0.6);
}
