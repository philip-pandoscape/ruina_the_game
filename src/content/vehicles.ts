import data from '../../shared/vehicles.json' with { type: 'json' };

// Everything you can ride, as content. The rules (src/sim/life/vehicles.ts) and the 3D models
// (src/render/models/*) both read these definitions, so a seat moved in shared/vehicles.json moves
// where you sit *and* where the bench is drawn.
//
// Local frame: the vehicle faces +Z, +Y is up, and its right-hand side is -X.

export interface Anchor {
  x: number;
  y: number;
  z: number;
}

/** How the rider's body is posed in a seat. */
export type SeatPose = 'drive' | 'sit' | 'row' | 'helm' | 'ride';

export interface Seat extends Anchor {
  pose: SeatPose;
}

export interface Wheel {
  x: number;
  z: number;
  r: number;
  steer: boolean;
}

interface Common {
  id: string;
  name: string;
  icon: string;
  desc: string;
  length: number;
  width: number;
  height: number;
  /** Collision radius used against obstacles and other vehicles. */
  radius: number;
  hp: number;
  seats: Seat[];
  /** Trade-pack slots. */
  cargo: Anchor[];
}

export interface WheeledDef extends Common {
  class: 'wheeled';
  maxSpeed: number;
  reverseSpeed: number;
  /** Top-speed multiplier off the road. */
  offroad: number;
  accel: number;
  brake: number;
  /** Air drag per m/s, and a flat rolling resistance (m/s²). */
  drag: number;
  rolling: number;
  /** Yaw rate at full lock once moving (rad/s). */
  turnRate: number;
  /** How quickly sideways sliding dies away, normally and with the handbrake on. */
  grip: number;
  driftGrip: number;
  /** Steepest slope (rise over run) it can drive up. */
  climb: number;
  /** Top speed while boosting; 0 for none. */
  boostSpeed: number;
  wheels: Wheel[];
}

export interface BoatDef extends Common {
  class: 'boat';
  /** How deep the hull sits; it runs aground in water shallower than this. */
  draft: number;
  maxSpeed: number;
  reverseSpeed: number;
  accel: number;
  brake: number;
  drag: number;
  rolling: number;
  turnRate: number;
  /** Turning still possible when stopped (rad/s): oars can spin a rowboat, a cog barely moves. */
  turnAtRest: number;
  grip: number;
  /** 1 when the wind drives it (sail trim is the throttle), 0 when it is rowed. */
  sail: number;
  mast?: { x: number; z: number; height: number };
  oars?: Anchor[];
}

export interface MountDef extends Common {
  class: 'mount';
  walkSpeed: number;
  runSpeed: number;
  gallopSpeed: number;
  /** Top speed with a trade pack aboard; 0 when it will not carry one. */
  packSpeed: number;
  accel: number;
  turnRate: number;
  jump: number;
  canCarryPack: boolean;
}

export type VehicleDef = WheeledDef | BoatDef;
export type RideableDef = VehicleDef | MountDef;

export interface GliderDef {
  id: string;
  name: string;
  icon: string;
  desc: string;
  span: number;
  /** Airspeed with the stick neutral, pushed forward (dive) and pulled back (flare). */
  cruiseSpeed: number;
  diveSpeed: number;
  flareSpeed: number;
  /** Sink rates (m/s, positive is down) at those three attitudes. */
  sink: number;
  diveSink: number;
  flareSink: number;
  /** Below this airspeed it stalls and drops. */
  stallSpeed: number;
  turnRate: number;
  /** How quickly airspeed eases toward the attitude's target (per second). */
  speedEase: number;
  /** Fraction of shed airspeed turned back into climb when you flare out of a dive. */
  zoomLift: number;
  /** You cannot open it lower than this above the ground. */
  minHeight: number;
  /** F in flight: a burst of speed and lift, then a cooldown. */
  gust?: { speed: number; lift: number; cooldownSeconds: number };
}

export const VEHICLES = data.vehicles as unknown as VehicleDef[];
export const MOUNTS = data.mounts as unknown as MountDef[];
export const GLIDERS = data.gliders as unknown as GliderDef[];

const RIDEABLE = new Map<string, RideableDef>([...VEHICLES, ...MOUNTS].map((d) => [d.id, d]));
const GLIDER = new Map(GLIDERS.map((g) => [g.id, g]));

export function rideable(id: string): RideableDef {
  const d = RIDEABLE.get(id);
  if (!d) throw new Error(`unknown vehicle "${id}"; known: ${[...RIDEABLE.keys()].join(', ')}`);
  return d;
}

export function glider(id: string): GliderDef {
  const g = GLIDER.get(id);
  if (!g) throw new Error(`unknown glider "${id}"; known: ${[...GLIDER.keys()].join(', ')}`);
  return g;
}

export const isBoat = (d: RideableDef): d is BoatDef => d.class === 'boat';
export const isWheeled = (d: RideableDef): d is WheeledDef => d.class === 'wheeled';
export const isMount = (d: RideableDef): d is MountDef => d.class === 'mount';
