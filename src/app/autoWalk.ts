import type { Actions, World } from '../sim/types';
import type { Sim } from '../sim/sim';
import type { Life } from '../sim/life/life';
import { RoadNetwork, routeNearest, routePoint, routeTight, type Route } from '../sim/zone/roads';
import { ridden } from '../sim/life/vehicles';
import { isBoat, isMount, isWheeled, rideable, type WheeledDef } from '../content/vehicles';
import { angleDiff } from '../sim/math';

// Walking for you: auto-run (straight on the way the camera looks, the mouse still steering) and
// travel by road (along a route to a spot marked on the map). Both only make the controls the rules
// read every step, the way the keyboard would, so they work the same online, where the server moves
// you from those same controls. Your own movement takes over at once. No page in here: the map, the
// readout and the toasts are the UI's (src/ui/life/travelUI.ts).

export type WalkMode = 'off' | 'run' | 'travel';

/** Where you have asked to go, and what the map calls it. */
export interface Marker {
  x: number;
  z: number;
  label: string;
}

/** Why travel by road can't set off from here. */
export type Refusal = 'offRoad' | 'noWay' | 'swim' | 'glide' | 'boat' | 'down' | 'here' | 'along';

/** What happened on the way, for the UI to say. */
export type WalkEvent =
  | { t: 'arrived'; label: string }
  | { t: 'roadEnds'; label: string; left: number }
  | { t: 'stuck' }
  | { t: 'lost' }
  | { t: 'water' }
  | { t: 'refused'; why: Refusal };

/** Within this far of the end of the route, you have arrived. */
const ARRIVE = 0.8;
/** Further than this from the route, you have left it. */
const LOST = 14;
/** Rules steps without getting a metre further before travel gives up (2.5 seconds). */
const STUCK_STEPS = 150;
/** How far ahead along the route you aim: on foot, a rider, and across a square or off the road. */
const LOOK_FOOT = 3.5;
const LOOK_TIGHT = 1.8;
/** A push of the stick or a key this far is you moving yourself. */
const OWN_MOVE = 0.2;
/** How fast a cart goes across a square, off the road, or while turning to the way on (m/s). */
const WHEELS_TIGHT = 4;

interface Body {
  x: number;
  z: number;
  heading: number;
  speed: number;
  kind: 'foot' | 'mount' | 'wheeled' | 'boat';
  def: WheeledDef | null;
}

export class AutoWalk {
  mode: WalkMode = 'off';
  /** Where you asked to go. Kept when you take over, so the key sets off again; gone once you are there. */
  marker: Marker | null = null;
  /** The way there while travelling. */
  route: Route | null = null;
  /** How far along the route you have come, in metres. */
  progress = 0;
  /** Bumped on every change the UI shows, so it redraws only then. */
  revision = 0;
  /** Set by the UI: told what happened on the way. */
  onEvent: (e: WalkEvent) => void = () => {};
  private net: RoadNetwork | null = null;
  /** What you were riding when it started (0 on foot): getting on or off anything ends it. */
  private vehicle = 0;
  private anchor = { x: 0, z: 0, steps: 0 };

  constructor(private d: { sim: Sim; world: World; life: Life | null }) {}

  /** The island's roads, joined up the first time they are wanted. */
  get roads(): RoadNetwork {
    return (this.net ??= new RoadNetwork(this.d.world));
  }

  private body(): Body {
    const p = this.d.sim.player;
    const v = this.d.life && p.mode === 'ride' ? ridden(this.d.life, this.d.sim) : undefined;
    if (v) {
      const def = rideable(v.def);
      const kind = isBoat(def) ? 'boat' : isMount(def) ? 'mount' : 'wheeled';
      return { x: v.x, z: v.z, heading: v.heading, speed: v.speed, kind, def: isWheeled(def) ? def : null };
    }
    return { x: p.pos.x, z: p.pos.z, heading: p.facing, speed: Math.hypot(p.vel.x, p.vel.z), kind: 'foot', def: null };
  }

  /** Why travel by road can't set off from where you are, or null when it can. */
  refusal(): Refusal | null {
    const p = this.d.sim.player;
    if (p.downFrame >= 0) return 'down';
    if (p.mode === 'ride' && p.host) return 'along';
    if (p.mode === 'swim') return 'swim';
    if (p.mode === 'glide') return 'glide';
    const b = this.body();
    if (b.kind === 'boat') return 'boat';
    return this.roads.onRoad(b.x, b.z) ? null : 'offRoad';
  }

  /** The auto-walk key: stop if walking for you; else along the roads to your marker when you are on one; else straight on. */
  toggle(): void {
    if (this.mode !== 'off') return this.stop();
    if (this.marker && this.refusal() === null && this.travel()) return;
    // Riding along in someone else's vehicle, they drive.
    if (this.refusal() === 'along') return this.onEvent({ t: 'refused', why: 'along' });
    this.run();
  }

  /** Auto-run: straight on the way the camera looks. */
  run(): void {
    this.mode = 'run';
    this.route = null;
    this.vehicle = this.d.sim.player.vehicle;
    this.revision++;
  }

  /** Marks somewhere to go (the map). */
  mark(x: number, z: number, label: string): void {
    this.marker = { x, z, label };
    if (this.mode === 'travel') this.stop();
    this.revision++;
  }

  /** Forgets the marker, and stops if on the way to it. */
  clearMarker(): void {
    if (this.mode === 'travel') this.stop();
    this.marker = null;
    this.revision++;
  }

  /** Sets off along the roads to the marker. False, after saying why, when that can't happen from here. */
  travel(): boolean {
    const m = this.marker;
    if (!m) return false;
    const why = this.refusal();
    if (why) {
      this.onEvent({ t: 'refused', why });
      return false;
    }
    const b = this.body();
    const plan = this.roads.plan(b.x, b.z, m.x, m.z);
    if (!plan.ok) {
      this.onEvent({ t: 'refused', why: plan.why });
      return false;
    }
    if (plan.route.length < ARRIVE * 2) {
      // Already as near as the roads go.
      this.onEvent(plan.route.short < 3 ? { t: 'refused', why: 'here' } : { t: 'roadEnds', label: m.label, left: plan.route.short });
      return false;
    }
    this.route = plan.route;
    this.progress = 0;
    this.mode = 'travel';
    this.vehicle = this.d.sim.player.vehicle;
    this.anchor = { x: b.x, z: b.z, steps: 0 };
    this.revision++;
    return true;
  }

  /** Stops walking for you (the marker stays). */
  stop(): void {
    if (this.mode === 'off') return;
    this.mode = 'off';
    this.route = null;
    this.progress = 0;
    this.revision++;
  }

  /** Metres left to go along the route (0 when not travelling). */
  get left(): number {
    return this.route ? Math.max(0, this.route.length - this.progress) : 0;
  }

  /**
   * The controls for one rules step: your own (`own`), with auto-run or the route's steering in
   * place of the movement. `camYaw` is where the camera looks, which auto-run follows.
   */
  steer(own: Actions, camYaw: number): Actions {
    if (this.mode === 'off') return own;
    const p = this.d.sim.player;
    // Knocked down, or on or off a mount or vehicle: whatever you were doing has stopped.
    if (p.downFrame >= 0 || p.vehicle !== this.vehicle) {
      this.stop();
      return own;
    }
    return this.mode === 'run' ? this.runStep(own, camYaw) : this.travelStep(own);
  }

  private runStep(own: Actions, yaw: number): Actions {
    // Forward or back yourself (W, S, the stick pushed either way) takes over; A and D still
    // strafe (or steer a cart or a boat), jumping and sprinting work as ever.
    if (Math.abs(own.stickY) > 0.5) {
      this.stop();
      return own;
    }
    const sx = Math.max(-1, Math.min(1, own.stickX));
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    // Forward plus the strafe, turned into the world the way the keyboard does it (src/input/input.ts).
    const mx = fx - fz * sx;
    const mz = fz + fx * sx;
    const l = Math.hypot(mx, mz) || 1;
    return { ...own, moveX: mx / l, moveZ: mz / l, stickX: sx, stickY: 1 };
  }

  private travelStep(own: Actions): Actions {
    if (Math.hypot(own.moveX, own.moveZ) > OWN_MOVE || Math.abs(own.stickX) > OWN_MOVE || Math.abs(own.stickY) > OWN_MOVE) {
      this.stop();
      return own;
    }
    const p = this.d.sim.player;
    if (p.mode === 'swim' || p.mode === 'glide') {
      this.stop();
      if (p.mode === 'swim') this.onEvent({ t: 'water' });
      return own;
    }
    const r = this.route!;
    const b = this.body();
    const near = routeNearest(r, b.x, b.z, this.progress - 2, this.progress + 25);
    if (near.dist > LOST) {
      this.stop();
      this.onEvent({ t: 'lost' });
      return own;
    }
    this.progress = Math.max(this.progress, near.at);
    const left = r.length - this.progress;
    if (left <= ARRIVE + (b.kind === 'foot' ? 0 : 1.2) && near.dist < 2.5) {
      const m = this.marker;
      this.stop();
      if (r.short < 3) {
        this.marker = null;
        this.onEvent({ t: 'arrived', label: m?.label ?? '' });
      } else this.onEvent({ t: 'roadEnds', label: m?.label ?? '', left: r.short });
      return own;
    }
    // Not getting anywhere (a cart left on the road, a wall): give up rather than run on the spot.
    // A swing or a cast in the way doesn't count.
    if (Math.hypot(b.x - this.anchor.x, b.z - this.anchor.z) > 1) this.anchor = { x: b.x, z: b.z, steps: 0 };
    else if (p.mode === 'normal' || p.mode === 'ride') this.anchor.steps++;
    if (this.anchor.steps > STUCK_STEPS) {
      this.stop();
      this.onEvent({ t: 'stuck' });
      return own;
    }
    // Aim a little way ahead along the route: corners come out smooth and you stay on the road.
    // Closer across a square or off the road, where things stand near the way.
    const rider = b.kind !== 'foot';
    const tight = routeTight(r, this.progress) || routeTight(r, this.progress + (rider ? 6 : 2));
    const look = tight ? LOOK_TIGHT + (rider ? 1 : 0) : rider ? Math.max(4, Math.min(12, Math.abs(b.speed) * 0.7)) : LOOK_FOOT;
    const [tx, tz] = routePoint(r, Math.min(r.length, this.progress + look));
    const l = Math.hypot(tx - b.x, tz - b.z) || 1;
    const [dx, dz] = this.around(b, (tx - b.x) / l, (tz - b.z) / l);
    if (b.kind === 'wheeled' && b.def) return this.drive(own, b, b.def, dx, dz, r);
    // Running on foot stops within half a metre; a mount needs a few, so it walks the last of the
    // way, and across squares, where its turns are wide.
    const mag = rider && (tight || left < 7) ? 0.5 : 1;
    return { ...own, moveX: dx * mag, moveZ: dz * mag, stickX: 0, stickY: mag };
  }

  /**
   * A lamp, a post or one of the townsfolk right on the way ahead (where two roads run side by
   * side, one's lamps can stand on the other): aim past its side rather than into it. The route
   * itself already goes round everything across squares and off the road.
   */
  private around(b: Body, dx: number, dz: number): [number, number] {
    const room = b.kind === 'foot' ? 0.75 : b.kind === 'mount' ? 1.1 : 1.6;
    let best: { ahead: number; side: number; need: number; ox: number; oz: number } | null = null;
    const consider = (cx: number, cz: number, r: number) => {
      const ox = cx - b.x;
      const oz = cz - b.z;
      const ahead = ox * dx + oz * dz;
      if (ahead <= 0 || ahead > 4) return;
      const side = oz * dx - ox * dz; // along (-dz, dx)
      const need = r + room;
      if (Math.abs(side) >= need || (best && best.ahead <= ahead)) return;
      best = { ahead, side, need, ox, oz };
    };
    this.d.world.index?.eachObstacle(b.x + dx * 2, b.z + dz * 2, 4, (o) => {
      if (o.r > 0 && o.r < 1.5) consider(o.x, o.z, o.r);
    });
    for (const n of this.d.world.zone?.recipe.npcs ?? []) consider(n.x, n.z, 0.4);
    const o = best as { ahead: number; side: number; need: number; ox: number; oz: number } | null;
    if (!o) return [dx, dz];
    // Past it on the side you are already on.
    const s = o.side > 0 ? -1 : 1;
    const tx = o.ox - dz * o.need * s;
    const tz = o.oz + dx * o.need * s;
    const l = Math.hypot(tx, tz) || 1;
    return [tx / l, tz / l];
  }

  /** A cart or a roadster: steer for the aim point, and slow in time for the bends, squares and the end ahead. */
  private drive(own: Actions, b: Body, def: WheeledDef, dx: number, dz: number, r: Route): Actions {
    const err = angleDiff(b.heading, Math.atan2(dx, dz)); // positive: the way on is to the left
    const steer = Math.max(-1, Math.min(1, err * 2.2));
    // Far off the heading (just setting off, say): slowly until it is turned.
    const want = Math.min(this.speedLimit(r, def), Math.abs(err) > 0.8 ? WHEELS_TIGHT : Infinity);
    const throttle = b.speed < want - 0.4 ? 1 : b.speed > want + 0.8 ? -1 : 0.15;
    return { ...own, moveX: dx, moveZ: dz, stickX: -steer, stickY: throttle };
  }

  /**
   * The fastest a cart can go now and still slow down, braking gently, to what every stretch within
   * reach ahead allows: a bend only as fast as the wheels can turn round it, a square or the walk
   * off the road at a crawl, the end of the route at a stop.
   */
  private speedLimit(r: Route, def: WheeledDef): number {
    const brake = def.brake * 0.5;
    // The wheels turn less as the speed builds (vehicles.ts stepWheeled): count on 60% of the rate.
    const turn = def.turnRate * 0.6;
    let limit = def.maxSpeed;
    const reach = (def.maxSpeed * def.maxSpeed) / (2 * brake) + 4;
    for (let d = 0; d <= reach; d += 2) {
      const s = this.progress + d;
      if (s >= r.length) {
        limit = Math.min(limit, Math.sqrt(2 * brake * Math.max(0, r.length - this.progress - 1.5)));
        break;
      }
      // How sharply the way bends over the 6 m around here.
      const [ax, az] = routePoint(r, s - 3);
      const [bx, bz] = routePoint(r, s);
      const [cx, cz] = routePoint(r, s + 3);
      const bend = Math.abs(angleDiff(Math.atan2(bx - ax, bz - az), Math.atan2(cx - bx, cz - bz)));
      let there = bend > 1e-3 ? (turn * 3) / bend : def.maxSpeed;
      if (routeTight(r, s)) there = Math.min(there, WHEELS_TIGHT);
      limit = Math.min(limit, Math.sqrt(there * there + 2 * brake * d));
    }
    return Math.max(WHEELS_TIGHT * 0.5, limit);
  }
}
