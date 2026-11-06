import type { Life } from './life';
import type { Sim } from '../sim';
import type { Actions, Mover } from '../types';
import type { Vehicle } from './state';
import { isBoat, isMount, isWheeled, rideable, type BoatDef, type MountDef, type RideableDef, type WheeledDef } from '../../content/vehicles';
import { itemDef } from '../../content/items';
import { SURFACE, type Heightfield } from '../terrain';
import { groundAt, pushOutOfBox } from '../zone/colliders';
import { toLocal, toWorld } from '../zone/generate';
import { angleDiff, len, turnToward } from '../math';
import { MOVE, STEP } from '../../content/tuning';
import { GROUND, STORM, SWIM } from '../../content/traversal';
import { stormAt } from './weather';
import { TAU } from '../../util/math';

// Carts, cars, boats and mounts. Wheeled things keep their own world velocity and only grip the
// road sideways, so a handbrake turn really slides; boats sail on whatever wind is blowing and run
// aground in the shallows; mounts move like you do, faster, and turn like an animal does.
const G = 9.81 * 1.6;

const wrap = (a: number) => (a > Math.PI ? a - TAU : a < -Math.PI ? a + TAU : a);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export const vehicleById = (life: Life, id: number): Vehicle | undefined => life.state.vehicles.find((v) => v.id === id);
/**
 * The vehicle of yours you are riding. Riding along in someone else's (`host` set), it's theirs, not
 * one of your island's, even when one of yours has the same number.
 */
export const ridden = (life: Life, sim: Sim): Vehicle | undefined =>
  sim.player.vehicle && !sim.player.host ? vehicleById(life, sim.player.vehicle) : undefined;

/**
 * A point given in the vehicle's own frame, out in the world: turned by its roll, then its pitch
 * (nose up is positive), then its heading, just as the vehicle is drawn (rotation order YXZ with
 * x = -pitch, y = heading, z = roll), so a seat stays where the model's seat is however it tilts.
 */
export function anchorWorld(v: Vehicle, a: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const cr = Math.cos(v.roll);
  const sr = Math.sin(v.roll);
  const cp = Math.cos(v.pitch);
  const sp = Math.sin(v.pitch);
  const x1 = a.x * cr - a.y * sr;
  const y1 = a.x * sr + a.y * cr;
  const y2 = y1 * cp + a.z * sp;
  const z2 = a.z * cp - y1 * sp;
  const [ox, oz] = toWorld(x1, z2, v.heading);
  return { x: v.x + ox, y: v.y + y2, z: v.z + oz };
}

// ---------- Summoning ----------

function clearAt(sim: Sim, x: number, z: number, r: number): boolean {
  let ok = true;
  sim.world.index?.eachObstacle(x, z, r + 1, (o) => {
    if (o.r > 0 && Math.hypot(o.x - x, o.z - z) < o.r + r) ok = false;
  });
  sim.world.index?.eachBox(x, z, r + 1, (b) => {
    if (b.top > -1e9 && pushOutOfBox(b, x, z, r)) ok = false;
  });
  return ok;
}

/** A place for a land vehicle near you: level, dry, unobstructed. */
function landSpot(sim: Sim, def: RideableDef): { x: number; z: number; heading: number } | null {
  const p = sim.player;
  const hf = sim.world.terrain!;
  for (const dist of [3.5, 5, 7, 9]) {
    for (let k = 0; k < 12; k++) {
      const a = p.facing + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 6);
      const x = p.pos.x + Math.sin(a) * (dist + def.radius);
      const z = p.pos.z + Math.cos(a) * (dist + def.radius);
      if (!hf.inside(x, z, 10)) continue;
      if (hf.water - hf.height(x, z) > 0.2) continue;
      if (hf.slope(x, z) > 0.5) continue;
      if (Math.abs(hf.height(x, z) - p.pos.y) > 3) continue;
      if (!clearAt(sim, x, z, def.radius)) continue;
      return { x, z, heading: p.facing };
    }
  }
  return null;
}

/** A place for a boat: the nearest water deep enough, pointing away from the shore. */
function waterSpot(sim: Sim, def: BoatDef): { x: number; z: number; heading: number } | null {
  const p = sim.player;
  const hf = sim.world.terrain!;
  const need = def.draft + 0.5;
  for (let dist = 3; dist <= 48; dist += 3) {
    let best: { x: number; z: number; heading: number } | null = null;
    let bestDepth = 0;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * TAU;
      const x = p.pos.x + Math.sin(a) * (dist + def.radius);
      const z = p.pos.z + Math.cos(a) * (dist + def.radius);
      if (!hf.inside(x, z, 20)) continue;
      const depth = hf.water - hf.height(x, z);
      if (depth < need) continue;
      // The whole hull must float: check bow and stern too.
      const g = hf.gradient(x, z);
      const heading = Math.atan2(-g.x, -g.z); // downhill = out to sea
      const bow = hf.water - hf.height(x + Math.sin(heading) * def.length * 0.5, z + Math.cos(heading) * def.length * 0.5);
      const stern = hf.water - hf.height(x - Math.sin(heading) * def.length * 0.5, z - Math.cos(heading) * def.length * 0.5);
      if (bow < def.draft || stern < def.draft) continue;
      if (!clearAt(sim, x, z, def.radius * 0.8)) continue;
      if (depth > bestDepth) {
        bestDepth = depth;
        best = { x, z, heading };
      }
    }
    if (best) return best;
  }
  return null;
}

function spawnVehicle(life: Life, def: RideableDef, at: { x: number; z: number; heading: number }, y: number): Vehicle {
  const v: Vehicle = {
    id: life.nextId(),
    def: def.id,
    x: at.x,
    y,
    z: at.z,
    heading: at.heading,
    vx: 0,
    vy: 0,
    vz: 0,
    speed: 0,
    steer: 0,
    throttle: 0,
    sail: 0,
    grounded: true,
    pitch: 0,
    roll: 0,
    hp: def.hp,
    cargo: new Array(def.cargo.length).fill(0),
    ridden: false,
    swimming: false,
  };
  life.state.vehicles.push(v);
  life.revision++;
  return v;
}

/** Calls the vehicle (or mount) a deed or whistle in your bag stands for. */
export function summon(life: Life, sim: Sim, item: string): Vehicle | null {
  const it = itemDef(item);
  const id = it.vehicle ?? it.mount;
  if (!id || life.count(item) < 1) return null;
  const def = rideable(id);
  const p = sim.player;
  if (p.mode !== 'normal' || !p.grounded) {
    life.toast('Stand on solid ground to summon', 'bad');
    return null;
  }
  const fixing = (life.state.repairs ?? {})[def.id] ?? 0;
  if (fixing > life.state.clock) {
    life.toast(`Your ${def.name.toLowerCase()} is still being repaired (${Math.ceil(fixing - life.state.clock)}s)`, 'bad');
    return null;
  }
  const existing = life.state.vehicles.find((v) => v.def === def.id);
  if (existing) {
    if (existing.cargo.some(Boolean)) {
      life.toast(`Your ${def.name} still has cargo aboard - go to it`, 'bad');
      return null;
    }
    recall(life, sim, existing.id, true);
  }
  const hf = sim.world.terrain!;
  const spot = isBoat(def) ? waterSpot(sim, def) : landSpot(sim, def);
  if (!spot) {
    life.toast(isBoat(def) ? 'No water deep enough nearby - go down to the shore' : 'No room here', 'bad');
    return null;
  }
  const y = isBoat(def) ? hf.water : groundAt(hf, sim.world.index, spot.x, spot.z, hf.height(spot.x, spot.z) + 1, 0.6);
  const v = spawnVehicle(life, def, spot, y);
  life.toast(`${def.icon} ${def.name} summoned`, 'good');
  life.notify({ type: 'summon', vehicle: def.id });
  return v;
}

export function recall(life: Life, sim: Sim, id: number, quiet = false): boolean {
  const v = vehicleById(life, id);
  if (!v) return false;
  if (v.ridden || sim.player.vehicle === id) {
    if (!quiet) life.toast('Get out first', 'bad');
    return false;
  }
  if (v.cargo.some(Boolean)) {
    if (!quiet) life.toast('Unload the cargo first', 'bad');
    return false;
  }
  life.state.vehicles = life.state.vehicles.filter((x) => x.id !== id);
  life.revision++;
  return true;
}

// ---------- Getting in and out ----------

/**
 * Why a pack on your back keeps you out of this one's seat, or null if it doesn't: only a pack
 * animal carries you with one. Carts and boats have a bed or a hold for it.
 */
export function packBlocks(def: RideableDef): string | null {
  if (isMount(def)) return def.canCarryPack ? null : `Your ${def.name.toLowerCase()} won't carry a trade pack - a donkey will`;
  return `Load your pack into the ${def.name.toLowerCase()} first - you can't ${isBoat(def) ? 'row or sail' : 'drive'} with it on your back`;
}

export function board(life: Life, sim: Sim, v: Vehicle): boolean {
  const def = rideable(v.def);
  const p = sim.player;
  const blocked = p.pack ? packBlocks(def) : null;
  if (blocked) {
    life.toast(blocked, 'bad');
    return false;
  }
  if (p.mode !== 'normal' && p.mode !== 'swim') return false;
  v.ridden = true;
  p.mode = 'ride';
  p.vehicle = v.id;
  p.seat = 0;
  p.vel.x = p.vel.y = p.vel.z = 0;
  p.grounded = true;
  p.jumpsUsed = 0;
  p.sprinting = false;
  p.crouching = false;
  p.jumpBuffer = 0;
  placeRider(sim, v);
  life.notify({ type: 'ride', vehicle: def.id });
  return true;
}

/** Where you would end up stepping out of a vehicle (dry land or a deck if any side has one). */
export function exitSpot(sim: Sim, v: Vehicle): { x: number; y: number; z: number; dry: boolean } {
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

export function dismount(life: Life, sim: Sim): boolean {
  const v = ridden(life, sim);
  const p = sim.player;
  if (!v) {
    if (p.mode === 'ride') p.mode = 'normal';
    p.vehicle = 0;
    p.host = 0;
    p.seat = 0;
    return false;
  }
  const def = rideable(v.def);
  const hf = sim.world.terrain!;
  // Step off on the left; failing that, any side with something to stand on.
  const side = def.width / 2 + 0.7;
  const tries: Array<[number, number]> = [
    [side, 0.3],
    [-side, 0.3],
    [0, def.length / 2 + 0.8],
    [0, -def.length / 2 - 0.8],
  ];
  let spot: { x: number; z: number; y: number; dry: boolean } | null = null;
  for (const [lx, lz] of tries) {
    const [ox, oz] = toWorld(lx, lz, v.heading);
    const x = v.x + ox;
    const z = v.z + oz;
    const y = groundAt(hf, sim.world.index, x, z, Math.max(v.y, hf.water) + 1.5, 2.2);
    const dry = y > hf.water - SWIM.depth + 0.2;
    if (dry && clearAt(sim, x, z, MOVE.playerRadius)) {
      spot = { x, z, y, dry };
      break;
    }
    if (!spot) spot = { x, z, y, dry };
  }
  v.ridden = false;
  // Nobody at the helm: the sail comes down and the oars stop.
  v.sail = 0;
  v.throttle = 0;
  p.vehicle = 0;
  p.mode = 'normal';
  p.pos.x = spot!.x;
  p.pos.z = spot!.z;
  p.pos.y = spot!.dry ? spot!.y : hf.water - SWIM.float;
  p.prevPos = { ...p.pos };
  p.grounded = spot!.dry;
  p.vel.x = p.vel.y = p.vel.z = 0;
  return true;
}

/** Seats the player in the vehicle (driver's seat). */
export function placeRider(sim: Sim, v: Vehicle): void {
  const def = rideable(v.def);
  const seat = def.seats[0];
  const w = anchorWorld(v, seat);
  const p = sim.player;
  p.pos.x = w.x;
  p.pos.y = w.y;
  p.pos.z = w.z;
  p.facing = v.heading;
  p.vel.x = v.vx;
  p.vel.y = v.vy;
  p.vel.z = v.vz;
  p.bank = v.steer;
}

/** The mount key: get on (calling it if it is far away or not out), or get off. */
export function mountCommand(life: Life, sim: Sim): void {
  const p = sim.player;
  const cur = ridden(life, sim);
  if (cur) {
    if (isMount(rideable(cur.def))) dismount(life, sim);
    return;
  }
  if (p.mode !== 'normal' || !p.grounded) return;
  const whistles = life.state.bag.map((s) => s.item).filter((i) => itemDef(i).cat === 'mount');
  if (!whistles.length) {
    life.toast('You have no mount yet - Sela at the stables sells them', 'bad');
    return;
  }
  // Carrying a pack, only a pack animal will do.
  const usable = whistles.filter((i) => !p.pack || (rideable(itemDef(i).mount!) as MountDef).canCarryPack);
  if (!usable.length) {
    life.toast("Your horse won't carry a trade pack - a donkey will", 'bad');
    return;
  }
  const pick = usable.sort((a, b) => (rideable(itemDef(b).mount!) as MountDef).runSpeed - (rideable(itemDef(a).mount!) as MountDef).runSpeed)[0];
  const def = rideable(itemDef(pick).mount!);
  let v = life.state.vehicles.find((x) => x.def === def.id);
  if (!v) v = spawnVehicle(life, def, { x: p.pos.x, z: p.pos.z, heading: p.facing }, p.pos.y);
  else if (Math.hypot(v.x - p.pos.x, v.z - p.pos.z) > 25) {
    // It comes when you whistle, cargo and all - never a second one.
    v.x = p.pos.x;
    v.z = p.pos.z;
    v.y = p.pos.y;
    v.vx = v.vy = v.vz = 0;
    v.speed = 0;
    v.heading = p.facing;
  }
  board(life, sim, v);
}

// ---------- Every step ----------

export function rideVehicle(life: Life, sim: Sim, a: Actions): void {
  const p = sim.player;
  // Riding along in someone else's: you sit where its seat goes, which whoever runs the channel
  // works out once its owner has driven it this step (crates/server/src/play/mod.rs).
  if (p.host) return;
  const v = ridden(life, sim);
  if (!v) {
    p.mode = 'normal';
    p.vehicle = 0;
    return;
  }
  const def = rideable(v.def);
  const input = { throttle: a.stickY, steer: -a.stickX, handbrake: a.jumpHeld, boost: a.sprintHeld };
  if (isWheeled(def)) stepWheeled(sim, v, def, input);
  else if (isBoat(def)) stepBoat(life, sim, v, def, input);
  else stepMount(sim, v, def, a, !!p.pack);
  // The step can end the ride (a boat breaking up under you): then there is no seat to sit in.
  if (p.vehicle !== v.id || !life.state.vehicles.includes(v)) return;
  placeRider(sim, v);
}

export function stepVehicles(life: Life, sim: Sim, _a: Actions): void {
  const none = { throttle: 0, steer: 0, handbrake: true, boost: false };
  for (const v of life.state.vehicles) {
    if (v.ridden) continue;
    const def = rideable(v.def);
    if (isBoat(def)) v.sail = 0; // an empty boat drifts to a stop (saves from before this rule too)
    if (isWheeled(def)) stepWheeled(sim, v, def, none);
    else if (isBoat(def)) stepBoat(life, sim, v, def, { ...none, handbrake: false });
    else stepMountIdle(sim, v, def);
  }
  // You bump into vehicles you are not riding, like anything else solid: yours, and online
  // everyone else's in the channel (ridden or not).
  const p = sim.player;
  if (p.mode !== 'ride' && p.mode !== 'glide') {
    for (const v of life.state.vehicles) {
      if (v.ridden) continue;
      const def = rideable(v.def);
      for (const c of circles(v, def)) bump(p.pos, c, v.y, def.height);
    }
    for (const m of sim.world.movers ?? []) bump(p.pos, m, m.y, m.height);
  }
}

/** Pushes you out of one of a vehicle's circles, if you are in it and at its height. */
function bump(pos: { x: number; y: number; z: number }, c: { x: number; z: number; r: number }, y: number, height: number): void {
  const dx = pos.x - c.x;
  const dz = pos.z - c.z;
  const min = c.r + MOVE.playerRadius;
  const d2 = dx * dx + dz * dz;
  if (d2 >= min * min) return;
  // Only if you are at its height (not standing on a deck above a boat, say).
  if (Math.abs(pos.y - y) > Math.max(2.2, height)) return;
  const d = Math.sqrt(d2) || 1e-4;
  pos.x = c.x + (dx / d) * min;
  pos.z = c.z + (dz / d) * min;
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

/** Pushes a vehicle out of trees, rocks and walls; returns the hardest impact speed. */
function collide(sim: Sim, v: Vehicle, def: RideableDef, solidDecks: boolean): number {
  const idx = sim.world.index;
  if (!idx) return 0;
  let impact = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (const c of circles(v, def)) {
      const push = (nx: number, nz: number, depth: number) => {
        v.x += nx * depth;
        v.z += nz * depth;
        const vn = v.vx * nx + v.vz * nz;
        if (vn < 0) {
          impact = Math.max(impact, -vn);
          v.vx -= vn * nx * 1.25;
          v.vz -= vn * nz * 1.25;
        }
      };
      idx.eachObstacle(c.x, c.z, c.r + 2, (o) => {
        if (o.r <= 0) return;
        const dx = c.x - o.x;
        const dz = c.z - o.z;
        const min = c.r + o.r;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) return;
        const d = Math.sqrt(d2) || 1e-4;
        push(dx / d, dz / d, min - d);
      });
      idx.eachBox(c.x, c.z, c.r + 1, (b) => {
        if (v.y >= b.top - 0.1) return;
        const pp = pushOutOfBox(b, c.x, c.z, c.r);
        if (!pp) return;
        const l = Math.hypot(pp.x, pp.z) || 1e-4;
        push(pp.x / l, pp.z / l, l);
      });
      if (solidDecks) {
        idx.eachDeck(c.x, c.z, c.r + 1, (b) => {
          const pp = pushOutOfBox(b, c.x, c.z, c.r);
          if (!pp) return;
          const l = Math.hypot(pp.x, pp.z) || 1e-4;
          push(pp.x / l, pp.z / l, l);
        });
      }
    }
  }
  const lim = sim.world.radius - 4;
  const r = len(v.x, v.z);
  if (r > lim) {
    v.x *= lim / r;
    v.z *= lim / r;
  }
  return impact;
}

/** Visual tilt from the ground under the wheels or hooves. */
function settleTilt(hf: Heightfield, v: Vehicle, def: RideableDef, dt: number): void {
  const fx = Math.sin(v.heading);
  const fz = Math.cos(v.heading);
  const hl = def.length * 0.4;
  const hw = def.width * 0.45;
  const front = hf.height(v.x + fx * hl, v.z + fz * hl);
  const back = hf.height(v.x - fx * hl, v.z - fz * hl);
  const left = hf.height(v.x + fz * hw, v.z - fx * hw);
  const right = hf.height(v.x - fz * hw, v.z + fx * hw);
  const pitch = v.grounded ? Math.atan2(front - back, hl * 2) : v.pitch;
  const roll = v.grounded ? Math.atan2(left - right, hw * 2) : v.roll;
  const k = 1 - Math.exp(-10 * dt);
  v.pitch += (clamp(pitch, -0.6, 0.6) - v.pitch) * k;
  v.roll += (clamp(roll, -0.5, 0.5) - v.roll) * k;
}

interface DriveInput {
  throttle: number;
  steer: number;
  handbrake: boolean;
  boost: boolean;
}

function stepWheeled(sim: Sim, v: Vehicle, d: WheeledDef, inp: DriveInput): void {
  const dt = STEP;
  const hf = sim.world.terrain!;
  v.throttle += (inp.throttle - v.throttle) * Math.min(1, 9 * dt);
  v.steer += (inp.steer - v.steer) * Math.min(1, 7 * dt);
  const fx = Math.sin(v.heading);
  const fz = Math.cos(v.heading);
  const rx = -fz;
  const rz = fx;
  let vf = v.vx * fx + v.vz * fz;
  let vs = v.vx * rx + v.vz * rz;
  const surf = hf.surfaceAt(v.x, v.z);
  const paved = surf === SURFACE.road || surf === SURFACE.plaza;
  const boosting = inp.boost && d.boostSpeed > 0 && v.throttle > 0.3;
  const cap = (boosting ? d.boostSpeed : d.maxSpeed) * (paved ? 1 : d.offroad) * (surf === SURFACE.sand ? 0.8 : 1);
  if (v.grounded) {
    const t = v.throttle;
    if (t > 0.05) {
      if (vf < -0.3) vf += d.brake * t * dt;
      else if (vf < cap) vf = Math.min(cap, vf + d.accel * (boosting ? 1.5 : 1) * t * dt);
    } else if (t < -0.05) {
      if (vf > 0.3) vf -= d.brake * -t * dt;
      else if (vf > -d.reverseSpeed) vf = Math.max(-d.reverseSpeed, vf + d.accel * 0.7 * t * dt);
    }
    const res = d.rolling + d.drag * Math.abs(vf);
    vf -= Math.sign(vf) * Math.min(Math.abs(vf), res * dt);
    if (Math.abs(vf) > cap) vf -= Math.sign(vf) * Math.min(Math.abs(vf) - cap, (Math.abs(vf) - cap) * 1.8 * dt + 0.4 * dt);
    const g = hf.gradient(v.x, v.z);
    vf -= 9.81 * (g.x * fx + g.z * fz) * dt * 0.9;
    if (inp.handbrake) vf -= Math.sign(vf) * Math.min(Math.abs(vf), d.brake * 0.45 * dt);
    const sf = clamp(Math.abs(vf) / 3, 0, 1) * (1 - 0.4 * clamp(Math.abs(vf) / Math.max(1, d.maxSpeed), 0, 1));
    const yaw = v.steer * d.turnRate * sf * (vf >= 0 ? 1 : -1) * (inp.handbrake ? 1.35 : 1);
    const grip = (inp.handbrake ? d.driftGrip : d.grip) * (paved ? 1 : 0.75);
    vs *= Math.exp(-grip * dt);
    v.vx = fx * vf + rx * vs;
    v.vz = fz * vf + rz * vs;
    v.heading = wrap(v.heading + yaw * dt);
  }
  v.speed = vf;
  moveOnLand(sim, v, d, d.climb, 0.8);
}

/** Moves a land vehicle or mount: walls of rock and water stop it, the ground carries it. */
function moveOnLand(sim: Sim, v: Vehicle, def: RideableDef, climb: number, maxWade: number): void {
  const dt = STEP;
  const hf = sim.world.terrain!;
  const idx = sim.world.index;
  const nx = v.x + v.vx * dt;
  const nz = v.z + v.vz * dt;
  const run = Math.hypot(nx - v.x, nz - v.z);
  let blocked = false;
  if (run > 1e-6) {
    const wet = hf.water - hf.height(nx, nz);
    const ground = groundAt(hf, idx, nx, nz, v.y + 0.6, 0.6);
    const rise = ground - v.y;
    if (wet > maxWade && !v.swimming) blocked = true;
    else if (v.grounded && rise > 0.6) blocked = true;
    else if (v.grounded && rise > 0.02 && ground <= hf.height(nx, nz) + 0.01 && hf.slope(nx, nz) > climb) blocked = true;
  }
  if (blocked) {
    // Lose the speed into the obstacle, keep sliding along it.
    const g = hf.gradient(nx, nz);
    const gl = Math.hypot(g.x, g.z);
    if (gl > 1e-4) {
      const ux = g.x / gl;
      const uz = g.z / gl;
      const into = v.vx * ux + v.vz * uz;
      if (into > 0) {
        v.vx -= ux * into;
        v.vz -= uz * into;
      }
    } else {
      v.vx *= -0.2;
      v.vz *= -0.2;
    }
  } else {
    v.x = nx;
    v.z = nz;
  }
  collide(sim, v, def, false);
  const ground = groundAt(hf, idx, v.x, v.z, v.y + 0.6, 0.6);
  if (v.grounded) {
    const drop = v.y - ground;
    const speed = Math.hypot(v.vx, v.vz);
    if (drop > 0.3 + speed * dt * 1.0) {
      v.grounded = false;
      v.vy = Math.min(0, v.vy);
    } else {
      v.vy = (ground - v.y) / dt;
      v.y = ground;
    }
  } else {
    v.vy -= G * dt;
    v.y += v.vy * dt;
    if (v.y <= ground) {
      if (v.vy < -12) v.hp = Math.max(1, v.hp - (-v.vy - 12) * 20);
      v.y = ground;
      v.vy = 0;
      v.grounded = true;
    }
  }
  settleTilt(hf, v, def, dt);
}

function stepBoat(life: Life, sim: Sim, v: Vehicle, d: BoatDef, inp: DriveInput): void {
  const dt = STEP;
  const hf = sim.world.terrain!;
  const w = life.state.weather;
  let target: number;
  let rel = 0;
  if (d.sail) {
    v.sail = clamp(v.sail + inp.throttle * 0.55 * dt, 0, 1);
    rel = angleDiff(w.windDir, v.heading);
    const eff = sailEfficiency(rel);
    target = v.sail * d.maxSpeed * eff * (0.6 + 0.4 * w.windSpeed);
    v.throttle = v.sail;
  } else {
    v.throttle += (inp.throttle - v.throttle) * Math.min(1, 5 * dt);
    target = v.throttle >= 0 ? v.throttle * d.maxSpeed : v.throttle * d.reverseSpeed;
  }
  v.steer += (inp.steer - v.steer) * Math.min(1, 5 * dt);
  const fx = Math.sin(v.heading);
  const fz = Math.cos(v.heading);
  const rx = -fz;
  const rz = fx;
  let vf = v.vx * fx + v.vz * fz;
  let vs = v.vx * rx + v.vz * rz;
  if (vf < target) vf = Math.min(target, vf + d.accel * dt);
  else vf = Math.max(target, vf - (d.brake + d.drag * Math.abs(vf)) * dt);
  const flow = clamp(Math.abs(vf) / (0.4 * d.maxSpeed), 0, 1);
  const turn = d.turnAtRest + (d.turnRate - d.turnAtRest) * flow;
  v.heading = wrap(v.heading + v.steer * turn * dt * (vf < -0.2 ? -1 : 1));
  vs *= Math.exp(-d.grip * dt);
  v.vx = fx * vf + rx * vs;
  v.vz = fz * vf + rz * vs;
  v.speed = vf;

  // Shallows: the keel catches and the boat stops dead (a little bounce back).
  const nx = v.x + v.vx * dt;
  const nz = v.z + v.vz * dt;
  const bowX = nx + fx * d.length * 0.45 * Math.sign(vf || 1);
  const bowZ = nz + fz * d.length * 0.45 * Math.sign(vf || 1);
  const shallow = Math.min(hf.water - hf.height(nx, nz), hf.water - hf.height(bowX, bowZ));
  if (shallow < d.draft) {
    if (Math.abs(vf) > 3 && life.state.clock % 1 < dt) life.toast('Running aground!', 'bad');
    v.vx *= -0.15;
    v.vz *= -0.15;
    v.speed = 0;
  } else {
    v.x = nx;
    v.z = nz;
  }
  collide(sim, v, d, true);
  v.y = hf.water;
  v.vy = 0;
  v.grounded = false;

  // Rough water out at sea in the rain: the swell shoves you about and works the hull loose.
  const storm = stormAt(life, hf.water - hf.height(v.x, v.z));
  if (storm > 0) {
    const shove = (life.rand() - 0.5) * STORM.buffet * storm * dt * 10;
    v.vx += -fz * shove;
    v.vz += fx * shove;
    v.roll += (life.rand() - 0.5) * 0.06 * storm;
    const rate = STORM.hullDamage.find(([len]) => d.length <= len)?.[1] ?? 2.5;
    v.hp -= rate * storm * dt;
    if (v.ridden && !v.stormWarned) {
      v.stormWarned = true;
      life.toast(`🌊 The sea is rough - your ${d.name.toLowerCase()}'s hull is taking a beating! Make for shallower water.`, 'bad');
    }
    if (v.hp <= 0) breakUp(life, sim, v);
  } else v.stormWarned = false;
  // Heel with the wind in the sail and into the turn; the renderer adds the swell.
  const heel = (d.sail ? Math.sin(rel) * 0.12 * v.sail : 0) - v.steer * flow * 0.08;
  v.roll += (heel - v.roll) * (1 - Math.exp(-3 * dt));
  v.pitch += (-clamp(vf / Math.max(1, d.maxSpeed), -1, 1) * 0.04 - v.pitch) * (1 - Math.exp(-3 * dt));
}

/** A boat lost to the storm: its cargo floats where it went down, and it is out for repairs. */
function breakUp(life: Life, sim: Sim, v: Vehicle): void {
  const def = rideable(v.def);
  const hf = sim.world.terrain!;
  v.cargo.forEach((id, i) => {
    if (!id) return;
    const pk = life.state.packs.find((p) => p.id === id);
    if (!pk) return;
    const a = (i / Math.max(1, v.cargo.length)) * Math.PI * 2 + life.rand();
    pk.at = 'ground';
    pk.vehicle = 0;
    pk.x = v.x + Math.cos(a) * (1.5 + life.rand() * 2.5);
    pk.z = v.z + Math.sin(a) * (1.5 + life.rand() * 2.5);
    pk.y = hf.water - 0.15;
    pk.rot = a;
  });
  if (v.ridden) dismount(life, sim);
  life.state.vehicles = life.state.vehicles.filter((x) => x.id !== v.id);
  (life.state.repairs ??= {})[def.id] = life.state.clock + STORM.repairSeconds;
  life.revision++;
  const floating = v.cargo.filter(Boolean).length;
  life.toast(
    `💥 Your ${def.name.toLowerCase()} broke up in the swell!${floating ? ` ${floating} pack${floating > 1 ? 's are' : ' is'} floating where she went down.` : ''}`,
    'bad',
  );
}

/** How much of the wind a sail can use at this angle off it (0 = wind straight behind). */
export function sailEfficiency(rel: number): number {
  return 0.25 + 0.75 * Math.pow(0.5 + 0.5 * Math.cos(rel), 0.6);
}

function stepMount(sim: Sim, v: Vehicle, d: MountDef, a: Actions, carrying: boolean): void {
  const dt = STEP;
  const hf = sim.world.terrain!;
  const mag = Math.min(1, len(a.moveX, a.moveZ));
  const gallop = a.sprintHeld && !carrying;
  let top = mag < 0.05 ? 0 : mag < MOVE.runThreshold ? d.walkSpeed * (mag / MOVE.runThreshold) : gallop ? d.gallopSpeed : d.runSpeed;
  if (carrying) top = Math.min(top, d.packSpeed || d.walkSpeed);
  const depth = hf.water - hf.height(v.x, v.z);
  v.swimming = depth > 1.5;
  if (v.swimming) top *= 0.45;
  if (mag > 0.05) v.heading = turnToward(v.heading, Math.atan2(a.moveX, a.moveZ), d.turnRate * dt);
  // Animals turn their whole body: speed builds along the heading, not the stick.
  const align = mag > 0.05 ? Math.max(0.25, Math.cos(angleDiff(v.heading, Math.atan2(a.moveX, a.moveZ)))) : 1;
  const want = top * align;
  if (v.speed < want) v.speed = Math.min(want, v.speed + d.accel * dt);
  else v.speed = Math.max(want, v.speed - d.accel * 1.4 * dt);
  v.vx = Math.sin(v.heading) * v.speed;
  v.vz = Math.cos(v.heading) * v.speed;
  v.steer = clamp(angleDiff(v.heading, Math.atan2(a.moveX || 1e-6, a.moveZ)) * (mag > 0.05 ? 1 : 0), -1, 1);
  if (a.jumpPressed && v.grounded && !v.swimming) {
    v.vy = d.jump;
    v.grounded = false;
  }
  if (v.swimming) {
    v.y = hf.water - 1.0;
    v.vy = 0;
    v.grounded = true;
    const nx = v.x + v.vx * dt;
    const nz = v.z + v.vz * dt;
    if (groundAt(hf, sim.world.index, nx, nz, v.y + 1, 1) <= hf.water + 0.6) {
      v.x = nx;
      v.z = nz;
    }
    collide(sim, v, d, true);
    if (hf.water - hf.height(v.x, v.z) <= 1.5) v.y = Math.max(v.y, hf.height(v.x, v.z));
    return;
  }
  moveOnLand(sim, v, d, GROUND.maxSlope * 0.95, 99);
}

function stepMountIdle(sim: Sim, v: Vehicle, d: MountDef): void {
  v.speed = 0;
  v.vx = 0;
  v.vz = 0;
  if (!v.swimming) moveOnLand(sim, v, d, GROUND.maxSlope, 99);
}

/**
 * For the interaction prompt: is (x, z) nearer a seat or a cargo slot, and which? With a pack in
 * your arms the cargo bed wins ties - you came over to load it.
 */
export function nearestAnchor(v: Vehicle, x: number, z: number, carrying = false): { kind: 'seat' | 'cargo'; index: number; dist: number } {
  const def = rideable(v.def);
  const [lx, lz] = toLocal(x - v.x, z - v.z, v.heading);
  let best = { kind: 'seat' as 'seat' | 'cargo', index: 0, dist: Infinity };
  def.seats.slice(0, 1).forEach((s, i) => {
    const dd = Math.hypot(lx - s.x, lz - s.z);
    if (dd < best.dist) best = { kind: 'seat', index: i, dist: dd };
  });
  def.cargo.forEach((c, i) => {
    const dd = Math.hypot(lx - c.x, lz - c.z) - (carrying ? 0.6 : 0);
    if (dd < best.dist) best = { kind: 'cargo', index: i, dist: dd };
  });
  return best;
}

/** Distance from (x, z) to the vehicle's hull, roughly. */
export function distanceTo(v: Vehicle, x: number, z: number): number {
  const def = rideable(v.def);
  const [lx, lz] = toLocal(x - v.x, z - v.z, v.heading);
  const ox = Math.max(0, Math.abs(lx) - def.width / 2);
  const oz = Math.max(0, Math.abs(lz) - def.length / 2);
  return Math.hypot(ox, oz);
}
