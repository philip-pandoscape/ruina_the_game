import type * as THREE from 'three';
import { Hero } from '../../../render/character';
import { pose, type PoseFeedback, type PoseInput } from '../../../content/pose';
import { DEFAULT_BUILD } from '../../../content/tuning';
import { GLIDERS, MOUNTS, VEHICLES } from '../../../content/vehicles';
import { buildGlider, buildMount, buildVehicle } from '../../../render/models';
import type { Holds } from '../../../render/models/vehicles';
import type { Moment, Scenario } from '../../../render/detail/scenarios';

// The hero playing one of its films (src/render/detail/scenarios.ts: what the rules report frame by
// frame) through the game's own Hero (src/render/character.ts), a frame at a time at 60 fps, moving
// over the ground as it does in the game, riding, flying or sitting in whatever the film has it in.
// The library's hero takes keep every frame of one (subjects/hero.ts); the measurements play them
// through (bench/hero.ts). Nothing here reads the page, so it runs in Node too, on the box hero.

export const STEP = 1 / 60;

/** What the hero rides, flies or sits in. */
export interface Prop {
  root: THREE.Object3D;
  animate(dt: number, m: Moment, input: PoseInput): void;
  water?: number;
  /** What the first seat's hands hold and feet rest on, and which seat pose that is. */
  holds?: Holds;
  driver?: string;
}

function makeProp(kind: Scenario['prop'], hero: Hero): Prop | null {
  if (!kind) return null;
  if (kind === 'glider') {
    const g = buildGlider(GLIDERS[0]);
    hero.root.add(g.root);
    return {
      root: g.root,
      animate: (dt, m, input) => g.animate(dt, { bank: input.bank * 0.6, pitch: Math.max(-0.35, Math.min(0.3, (input.rise * 9.2) / 12)), speed: m.speed }),
    };
  }
  if (kind === 'horse') {
    const def = MOUNTS.find((x) => x.id === 'horse')!;
    const h = buildMount(def);
    hero.root.add(h.root);
    return { root: h.root, animate: (dt, m) => h.animate(dt, { speed: m.speed, grounded: true }), holds: h.holds, driver: 'ride' };
  }
  const id = kind === 'cart' ? 'farmCart' : kind;
  const def = VEHICLES.find((x) => x.id === id)!;
  const v = buildVehicle(def);
  let t = 0;
  hero.root.add(v.root);
  const boat = def.class === 'boat';
  return {
    root: v.root,
    water: boat ? 0 : undefined,
    holds: v.holds,
    driver: def.seats[0].pose,
    animate: (dt, m, input) => {
      t += dt;
      v.animate(dt, { speed: m.speed, steer: m.controls?.steer ?? input.bank, throttle: m.controls?.throttle ?? input.effort, sail: 0.8, boom: 0.3, time: t });
    },
  };
}

/**
 * Puts a ridden thing so the seat the hero uses sits on the hero's origin, as the game does, and
 * returns how high that seat is: the hero is lifted by it so the vehicle stands on the floor.
 */
function seatProp(prop: Prop, kind: Scenario['prop'], input: PoseInput): number {
  if (!kind || kind === 'glider') return 0;
  const def = kind === 'horse' ? MOUNTS.find((x) => x.id === 'horse')! : VEHICLES.find((x) => x.id === (kind === 'cart' ? 'farmCart' : kind))!;
  const seat = def.seats.find((s) => s.pose === input.travel) ?? def.seats[0];
  prop.root.position.set(-seat.x, -seat.y, -seat.z);
  return seat.y;
}

/** One hero playing one film from its first frame. */
export class Film {
  readonly hero = new Hero();
  readonly prop: Prop | null;
  /** The next frame to play. */
  frame = 0;
  distance = 0;
  /** How far the hero has travelled over the floor, metres (x left, z ahead). */
  travelled: [number, number] = [0, 0];
  /** Which way the hero faces over the floor, radians. */
  facing = 0;
  last: Moment | null = null;
  input: PoseInput = pose();
  fb: PoseFeedback | null = null;

  constructor(
    readonly s: Scenario,
    /** The weapon in hand (by its place in WEAPONS) where the film has none of its own: the one a hero starts with, unless told. */
    readonly weapon: number = DEFAULT_BUILD.weapon,
  ) {
    this.prop = makeProp(s.prop, this.hero);
  }

  step(): void {
    const m = this.s.at(this.frame);
    const input = pose({ time: (this.s.start ?? 0) + this.frame * STEP, ...m.input, weapon: this.s.weapon ?? this.weapon });
    if (input.run > 0) this.distance += Math.abs(m.speed) * STEP;
    this.facing = m.facing ?? 0;
    const h = this.facing + (m.input.heading ?? 0);
    this.travelled[0] += m.speed * Math.sin(h) * STEP;
    this.travelled[1] += m.speed * Math.cos(h) * STEP;
    // The hero really moves over the floor, as in the game, so a planted foot stays put on it.
    const seat = this.prop ? seatProp(this.prop, this.s.prop, input) : 0;
    this.hero.root.position.set(this.travelled[0], (m.lift ?? 0) + seat, this.travelled[1]);
    this.hero.root.rotation.y = this.facing;
    // The vehicle moves first (its wheel turns, its oars sweep), then the hero takes hold of it.
    this.prop?.animate(STEP, m, input);
    this.hero.seatHolds = this.prop?.holds && input.travel === this.prop.driver ? this.prop.holds : null;
    this.fb = this.hero.drive(input, this.distance, STEP);
    this.last = m;
    this.input = input;
    this.frame++;
  }

  /** Plays from the start up to (and including) a frame, so transitions come out as in play. */
  seek(frame: number): void {
    while (this.frame <= frame) this.step();
  }

  dispose(): void {
    this.hero.root.removeFromParent();
  }
}
