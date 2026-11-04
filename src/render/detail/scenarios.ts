import { ABILITIES, COMBAT, JUMP, MOVE, MOVEMENT_SKILLS, comboShape, type AttackStep } from '../../tuning';
import type { PoseInput } from '../../content/pose';
import { lungeSpeed } from './humanoid';

// Little films of the hero, for the animation gallery (animations.html) and the tests that check
// the motion. Each one is what the rules would report frame by frame - running speed, which way
// you're going, a jump's rise and fall, which swing of a combo is on which frame - so the gallery
// plays the poses the way the game does, transitions and all, without a game running.

export interface Moment {
  input: Partial<PoseInput>;
  /** Ground speed, m/s, in the direction input.heading gives: how fast the floor slides by. */
  speed: number;
  /** Height of the feet above the ground, metres (jumps). */
  lift?: number;
  /** Which way the hero faces, radians (0 is the floor's +z, + turns left); the heading is from here. */
  facing?: number;
}

export interface Scenario {
  id: string;
  group: 'Moving' | 'Strafing' | 'In the air' | 'Fighting' | 'Hurt' | 'Travel';
  label: string;
  /** Loop length in sim frames (60 a second). */
  frames: number;
  weapon?: number;
  /** A model to show with it: what is ridden, flown or sat in. */
  prop?: 'glider' | 'horse' | 'cart' | 'roadster' | 'hauler' | 'rowboat' | 'sloop';
  at(frame: number): Moment;
}

const HZ = 60;
const TAU = Math.PI * 2;
const RUN = MOVE.runSpeed;
const WALK = MOVE.walkSpeed;
const DEG = Math.PI / 180;

/** A run of segments, each lasting `frames`, played back to back. */
interface Segment {
  frames: number;
  at(f: number, k: number): Moment;
}
function sequence(segments: Segment[]): Pick<Scenario, 'frames' | 'at'> {
  const total = segments.reduce((n, s) => n + s.frames, 0);
  return {
    frames: total,
    at(frame) {
      let f = ((frame % total) + total) % total;
      for (const s of segments) {
        if (f < s.frames) return s.at(f, s.frames > 1 ? f / (s.frames - 1) : 0);
        f -= s.frames;
      }
      return segments[segments.length - 1].at(0, 0);
    },
  };
}

const stand = (frames: number, extra: Partial<PoseInput> = {}): Segment => ({
  frames,
  at: () => ({ input: { ...extra }, speed: 0 }),
});

/** Standing still, facing `deg`. */
const standFacing = (frames: number, deg: number): Segment => ({
  frames,
  at: () => ({ input: {}, speed: 0, facing: deg * DEG }),
});

/**
 * Standing and turning on the spot from one facing to another, `rate` radians a second at its
 * fastest: what the camera swinging round does to you in a fight.
 */
function pivot(fromDeg: number, toDeg: number, rate = 4): Segment {
  const frames = Math.max(2, Math.round(((1.5 * Math.abs(toDeg - fromDeg) * DEG) / rate) * HZ));
  return {
    frames,
    at: (f) => {
      const k = f / (frames - 1);
      return { input: {}, speed: 0, facing: (fromDeg + (toDeg - fromDeg) * k * k * (3 - 2 * k)) * DEG };
    },
  };
}

/** Moving along the ground at a steady speed (in direction extra.heading, if given). */
const move = (frames: number, speed: number, extra: Partial<PoseInput> = {}): Segment => ({
  frames,
  at: () => ({ input: { run: speed / RUN, speed: speed / RUN, ...extra }, speed }),
});

/**
 * Putting the weapon away (`to` 1) or drawing it (`to` 0) at the close-up hero's pace
 * (character.ts: 0.6 s and 0.45 s), standing or moving at `speed` m/s.
 */
function stowing(from: number, to: number, speed = 0): Segment {
  const frames = Math.round((to > from ? 0.6 : 0.45) * HZ);
  return {
    frames,
    at: (f) => ({ input: { run: speed / RUN, speed: speed / RUN, stow: from + ((to - from) * f) / (frames - 1) }, speed }),
  };
}

/** Speeding up or slowing down at the rules' acceleration. */
const ramp = (from: number, to: number, accel: number, extra: Partial<PoseInput> = {}): Segment => {
  const frames = Math.max(1, Math.ceil((Math.abs(to - from) / accel) * HZ));
  return {
    frames,
    at: (f) => {
      const v = from + Math.sign(to - from) * Math.min(Math.abs(to - from), (accel * (f + 1)) / HZ);
      return { input: { run: v / RUN, speed: v / RUN, ...extra }, speed: v };
    },
  };
};

/** Share of run speed the rules allow moving at a heading while facing a fight. */
function stanceShare(heading: number): number {
  const ahead = Math.cos(heading);
  return ahead >= 0 ? MOVE.strafeSpeed + (1 - MOVE.strafeSpeed) * ahead : MOVE.strafeSpeed + (MOVE.backSpeed - MOVE.strafeSpeed) * -ahead;
}

/**
 * Walking a course of headings while facing ahead, as the rules move you: the velocity turns
 * toward each new direction at the ground acceleration, so the heading sweeps rather than jumps.
 */
function course(legs: Array<[headingDeg: number, frames: number]>, pace = RUN, extra: Partial<PoseInput> = {}): Segment {
  const out: Moment[] = [];
  let vx = 0;
  let vz = 0;
  for (const [deg, frames] of legs) {
    const h = deg * DEG;
    const share = deg === 999 ? 0 : stanceShare(h);
    const tx = deg === 999 ? 0 : Math.sin(h) * pace * share;
    const tz = deg === 999 ? 0 : Math.cos(h) * pace * share;
    for (let f = 0; f < frames; f++) {
      const ex = tx - vx;
      const ez = tz - vz;
      const err = Math.hypot(ex, ez);
      const max = ((tx === 0 && tz === 0 ? MOVE.groundDecel : MOVE.groundAccel) * 1) / HZ;
      if (err <= max) {
        vx = tx;
        vz = tz;
      } else {
        vx += (ex / err) * max;
        vz += (ez / err) * max;
      }
      const v = Math.hypot(vx, vz);
      out.push({ input: { run: v / RUN, speed: v / RUN, heading: v > 0.05 ? Math.atan2(vx, vz) : 0, ...extra }, speed: v });
    }
  }
  return { frames: out.length, at: (f) => out[f] };
}

/**
 * A jump with the rules' gravity, from take-off to a little after landing, going `heading` at
 * `speed` m/s. `second` adds a double jump on that frame, which turns the flight toward
 * `secondHeading` at the double jump's steer speed.
 */
function jump(speed: number, second = -1, settle = 24, heading = 0, secondHeading = heading): Segment {
  const frames: Moment[] = [];
  let y = 0;
  let vy = JUMP.velocity;
  let takeoff = 0;
  let flip = -1;
  let h = heading;
  let s = speed;
  for (let f = 0; f < 400; f++) {
    if (f === second) {
      vy = JUMP.doubleJumpVelocity;
      flip = 0;
      h = secondHeading;
      s = JUMP.doubleJumpSteer * RUN;
    }
    vy -= (vy > 0 ? JUMP.gravityUp : JUMP.gravityDown) / HZ;
    vy = Math.max(vy, -JUMP.maxFall);
    y += vy / HZ;
    if (y <= 0) break;
    frames.push({
      input: {
        grounded: false,
        run: 0,
        speed: s / RUN,
        heading: h,
        rise: Math.max(-1, Math.min(1, vy / JUMP.velocity)),
        takeoffFrame: takeoff++,
        flipFrame: flip >= 0 && flip < JUMP.flipFrames ? flip : -1,
      },
      speed: s,
      lift: y,
    });
    if (flip >= 0) flip++;
  }
  const impact = Math.min(1, -vy / 20);
  for (let f = 0; f < settle; f++) {
    frames.push({ input: { run: s / RUN, speed: s / RUN, heading: h, landFrame: f, landImpact: impact }, speed: s });
  }
  return { frames: frames.length, at: (f) => frames[f] };
}

/**
 * Struck, as the rules have it: the blow shoves you `pushDeg` (a heading, so 180 is a blow from the
 * front) at `knock` m/s and pops you off the ground, and the stun runs out as you come down and
 * slide to a stop.
 */
function knocked(pushDeg: number, knock = 3): Segment {
  const h = pushDeg * DEG;
  const frames: Moment[] = [];
  let y = 0;
  let vy = COMBAT.knockUp;
  let v = knock;
  let air = true;
  let land = 0;
  for (let f = 0; f < COMBAT.stunFrames; f++) {
    if (air) {
      vy -= (vy > 0 ? JUMP.gravityUp : JUMP.gravityDown) / HZ;
      y = Math.max(0, y + vy / HZ);
      v = Math.max(0, v - MOVE.airDrag / HZ);
      if (y === 0) air = false;
    } else {
      v = Math.max(0, v - MOVE.groundDecel / HZ);
      land++;
    }
    frames.push({
      input: {
        stunned: true,
        stunFrame: f,
        hit: h,
        heading: h,
        speed: v / RUN,
        run: air ? 0 : v / RUN,
        grounded: !air,
        rise: Math.max(-1, Math.min(1, vy / JUMP.velocity)),
        landFrame: air ? 99 : land,
        landImpact: 0.25,
      },
      speed: v,
      lift: y,
    });
  }
  return { frames: frames.length, at: (f) => frames[f] };
}

/** One swing of a combo. `chain` cuts it where the next swing would take over when mashing. */
function swing(weapon: number, index: number, chain: boolean, variants = 0): Segment {
  const combo = comboShape(weapon, variants);
  const step: AttackStep = combo[index];
  const total = step.startup + step.active + step.recovery;
  const frames = chain && index < combo.length - 1 ? step.startup + step.active + 2 : total;
  return {
    frames,
    at: (f) => ({
      input: { attackIndex: index, attackFrame: f, step, comboLength: combo.length, weapon },
      speed: lungeSpeed(step, f),
    }),
  };
}

function combo(weapon: number, variants = 0): Segment[] {
  return comboShape(weapon, variants).map((_, i) => swing(weapon, i, true, variants));
}

/** A movement skill (roll, backstep, guard, slide) by id, moving at its own speed. */
function action(id: string, runIn = 0, heading = 0): Segment {
  const index = MOVEMENT_SKILLS.findIndex((m) => m.id === id);
  const def = MOVEMENT_SKILLS[index].action;
  const total = def.startup + def.active + def.recovery;
  const dir = def.direction === 'backward' ? Math.PI : heading;
  return {
    frames: total,
    at: (f) => {
      const active = f >= def.startup && f < def.startup + def.active;
      const k = def.active > 1 ? (f - def.startup) / (def.active - 1) : 0;
      const top = def.endSpeed !== undefined ? def.speed + (def.endSpeed - def.speed) * Math.max(0, Math.min(1, k)) : def.speed;
      const v = active ? top : f < def.startup ? runIn : 0;
      return { input: { actionId: index, actionFrame: f, heading: dir, speed: v / RUN }, speed: v };
    },
  };
}

function cast(ability: number): Segment {
  const frames = ABILITIES[ability].castFrames;
  return { frames, at: (f) => ({ input: { castAbility: ability, castFrame: f, castFrames: frames }, speed: 0 }) };
}

const travel = (frames: number, mode: string, at: (t: number) => Partial<PoseInput>, speed = 0): Segment => ({
  frames,
  at: (f) => ({ input: { travel: mode, ...at(f / HZ) }, speed }),
});

const EIGHT = [0, 45, 90, 135, 180, -135, -90, -45];

export const SCENARIOS: Scenario[] = [
  // ---- Moving ----
  { id: 'idle', group: 'Moving', label: 'Idle', ...sequence([stand(360)]) },
  { id: 'idleAway', group: 'Moving', label: 'Idle, weapon put away', ...sequence([stand(360, { stow: 1 })]) },
  { id: 'walk', group: 'Moving', label: 'Walk', ...sequence([move(240, 1.4)]) },
  { id: 'jog', group: 'Moving', label: 'Jog (walk speed)', ...sequence([move(240, WALK)]) },
  { id: 'run', group: 'Moving', label: 'Run', ...sequence([move(240, RUN)]) },
  { id: 'runAway', group: 'Moving', label: 'Run, weapon put away', ...sequence([move(240, RUN, { stow: 1 })]) },
  { id: 'sprint', group: 'Moving', label: 'Sprint', ...sequence([move(240, MOVE.sprintSpeed)]) },
  {
    id: 'startStop',
    group: 'Moving',
    label: 'Start, run, stop',
    ...sequence([stand(50), ramp(0, RUN, MOVE.groundAccel), move(70, RUN), ramp(RUN, 0, MOVE.groundDecel), stand(50)]),
  },
  { id: 'crouch', group: 'Moving', label: 'Crouch', ...sequence([stand(40), { frames: 200, at: (f) => ({ input: { crouch: Math.min(1, f / MOVE.crouchEnterFrames) }, speed: 0 }) }]) },
  { id: 'sneak', group: 'Moving', label: 'Crouch walk', ...sequence([move(240, MOVE.crouchSpeed, { crouch: 1 })]) },
  { id: 'carry', group: 'Moving', label: 'Carrying a pack', ...sequence([stand(60, { carry: true }), ramp(0, RUN * 0.55, MOVE.groundAccel, { carry: true }), move(180, RUN * 0.55, { carry: true })]) },
  { id: 'turn', group: 'Moving', label: 'Running turns', ...sequence([move(90, RUN, { lean: 0.8 }), move(90, RUN, { lean: -0.8 })]) },
  {
    id: 'turnOnSpot',
    group: 'Moving',
    label: 'Turning on the spot',
    ...sequence([standFacing(30, 0), pivot(0, 90, 3), standFacing(45, 90), pivot(90, -90, 5), standFacing(45, -90), pivot(-90, 0, 3), standFacing(45, 0)]),
  },
  { id: 'bowRun', group: 'Moving', label: 'Run with a bow', weapon: 3, ...sequence([stand(60, { weapon: 3 }), move(180, RUN, { weapon: 3 })]) },
  { id: 'staffRun', group: 'Moving', label: 'Run with a staff', weapon: 2, ...sequence([stand(60, { weapon: 2 }), move(180, RUN, { weapon: 2 })]) },
  { id: 'clubRun', group: 'Moving', label: 'Run with a club', weapon: 1, ...sequence([stand(60, { weapon: 1 }), move(180, RUN, { weapon: 1 })]) },

  // ---- Strafing: facing a fight, moving every other way ----
  { id: 'strafeL', group: 'Strafing', label: 'Strafe left', ...sequence([move(240, RUN * MOVE.strafeSpeed, { heading: Math.PI / 2 })]) },
  { id: 'strafeR', group: 'Strafing', label: 'Strafe right', ...sequence([move(240, RUN * MOVE.strafeSpeed, { heading: -Math.PI / 2 })]) },
  { id: 'backpedal', group: 'Strafing', label: 'Back off', ...sequence([move(240, RUN * MOVE.backSpeed, { heading: Math.PI })]) },
  { id: 'backL', group: 'Strafing', label: 'Back off, diagonal', ...sequence([move(240, RUN * stanceShare(135 * DEG), { heading: 135 * DEG })]) },
  { id: 'aheadL', group: 'Strafing', label: 'Ahead, diagonal', ...sequence([move(240, RUN * stanceShare(45 * DEG), { heading: 45 * DEG })]) },
  { id: 'strafeWalk', group: 'Strafing', label: 'Side-step at walking pace', ...sequence([course([[90, 120], [-90, 120]], WALK * 0.7)]) },
  { id: 'eight', group: 'Strafing', label: 'All eight ways', ...sequence([course([...EIGHT.map((d) => [d, 55] as [number, number]), [999, 40]])]) },
  { id: 'dodge8', group: 'Strafing', label: 'Dodge, eight ways', ...sequence(EIGHT.flatMap((d) => [stand(16), action('dodgeRoll', 0, d * DEG)])) },
  { id: 'jump8', group: 'Strafing', label: 'Jump, four ways', ...sequence([0, 90, 180, -90].flatMap((d) => [move(20, RUN * stanceShare(d * DEG), { heading: d * DEG }), jump(RUN * stanceShare(d * DEG), -1, 20, d * DEG)])) },
  { id: 'flip8', group: 'Strafing', label: 'Double jump, four ways', ...sequence([0, 90, 180, -90].flatMap((d) => [stand(20), jump(0, 16, 24, 0, d * DEG)])) },

  // ---- In the air ----
  { id: 'jump', group: 'In the air', label: 'Standing jump', ...sequence([stand(30), jump(0), stand(20)]) },
  { id: 'runJump', group: 'In the air', label: 'Running jump', ...sequence([move(40, RUN), jump(RUN), move(30, RUN)]) },
  { id: 'doubleJump', group: 'In the air', label: 'Double jump (flip)', ...sequence([move(30, RUN), jump(RUN, 22), move(30, RUN)]) },

  // ---- Fighting ----
  { id: 'sword', group: 'Fighting', label: 'Sword combo', weapon: 0, ...sequence([stand(30), ...combo(0), stand(40)]) },
  { id: 'swordSlow', group: 'Fighting', label: 'Sword, each swing to the end', weapon: 0, ...sequence([stand(20), swing(0, 0, false), stand(12), swing(0, 1, false), stand(12), swing(0, 2, false), stand(30)]) },
  { id: 'whirlwind', group: 'Fighting', label: 'Whirlwind', weapon: 0, ...sequence([stand(30), ...combo(0, 1), stand(40)]) },
  { id: 'club', group: 'Fighting', label: 'Club combo', weapon: 1, ...sequence([stand(30, { weapon: 1 }), ...combo(1), stand(40, { weapon: 1 })]) },
  { id: 'staff', group: 'Fighting', label: 'Staff swing', weapon: 2, ...sequence([stand(30, { weapon: 2 }), swing(2, 0, false), stand(20, { weapon: 2 }), swing(2, 0, false), stand(30, { weapon: 2 })]) },
  { id: 'bow', group: 'Fighting', label: 'Bow shots', weapon: 3, ...sequence([stand(30, { weapon: 3 }), swing(3, 0, false), swing(3, 0, false), swing(3, 0, false), stand(40, { weapon: 3 })]) },
  { id: 'heal', group: 'Fighting', label: 'Cast: Healing Circle', weapon: 2, ...sequence([stand(30, { weapon: 2 }), cast(ABILITIES.findIndex((a) => a.id === 'heal')), stand(40, { weapon: 2 })]) },
  { id: 'meteor', group: 'Fighting', label: 'Cast: Meteor', weapon: 2, ...sequence([stand(30, { weapon: 2 }), cast(ABILITIES.findIndex((a) => a.id === 'meteor')), stand(40, { weapon: 2 })]) },
  { id: 'block', group: 'Fighting', label: 'Block', ...sequence([stand(30), action('block'), stand(40)]) },
  { id: 'sheathe', group: 'Fighting', label: 'Put away and draw', ...sequence([stand(30), stowing(0, 1), stand(40, { stow: 1 }), stowing(1, 0), stand(30)]) },
  {
    id: 'sheatheRun',
    group: 'Fighting',
    label: 'Put away and draw, running',
    ...sequence([move(40, RUN), stowing(0, 1, RUN), move(50, RUN, { stow: 1 }), stowing(1, 0, RUN), move(40, RUN)]),
  },
  { id: 'roll', group: 'Fighting', label: 'Dodge roll', ...sequence([move(30, RUN), action('dodgeRoll', RUN), move(40, RUN)]) },
  { id: 'backstep', group: 'Fighting', label: 'Backstep', ...sequence([stand(30), action('backstep'), stand(40)]) },
  { id: 'slide', group: 'Fighting', label: 'Slide', ...sequence([move(40, RUN), action('slide', RUN), move(40, RUN)]) },
  { id: 'airSlash', group: 'Fighting', label: 'Jump attack', weapon: 0, ...sequence([stand(20), jump(0, -1, 30), stand(10)]) },

  // ---- Hurt ----
  { id: 'hit', group: 'Hurt', label: 'Hit', ...sequence([stand(30), knocked(180), stand(40)]) },
  // From the front, from behind, from the right (shoving you left) and from the left.
  { id: 'hit4', group: 'Hurt', label: 'Hit from four sides', ...sequence([180, 0, 90, -90].flatMap((d) => [stand(30), knocked(d)]).concat([stand(30)])) },
  {
    id: 'down',
    group: 'Hurt',
    label: 'Knocked down',
    ...sequence([stand(30), { frames: 150, at: (f) => ({ input: { down: true, downFrame: f, heading: Math.PI }, speed: f < 10 ? 3 : 0 }) }, stand(30)]),
  },

  // ---- Travel ----
  { id: 'swim', group: 'Travel', label: 'Swim', ...sequence([travel(240, 'swim', () => ({ effort: 1 }), 4)]) },
  { id: 'tread', group: 'Travel', label: 'Tread water', ...sequence([travel(240, 'swim', () => ({ effort: 0 }))]) },
  { id: 'glide', group: 'Travel', label: 'Glide', prop: 'glider', ...sequence([travel(360, 'glide', (t) => ({ bank: Math.sin(t * 1.2) * 0.9, rise: -0.15 }), 12)]) },
  { id: 'ride', group: 'Travel', label: 'Ride', prop: 'horse', ...sequence([travel(240, 'ride', (t) => ({ effort: 0.5 + 0.5 * Math.sin(t * 0.8), bank: Math.sin(t * 0.6) * 0.5 }), 6)]) },
  { id: 'drive', group: 'Travel', label: 'Drive', prop: 'cart', ...sequence([travel(240, 'drive', (t) => ({ bank: Math.sin(t * 1.1), effort: 0.6 }), 6)]) },
  { id: 'driveRoadster', group: 'Travel', label: 'Drive the roadster', prop: 'roadster', ...sequence([travel(240, 'drive', (t) => ({ bank: Math.sin(t * 1.1), effort: 0.6 }), 9)]) },
  { id: 'driveHauler', group: 'Travel', label: 'Drive the hauler', prop: 'hauler', ...sequence([travel(240, 'drive', (t) => ({ bank: Math.sin(t * 1.1), effort: 0.6 }), 5)]) },
  { id: 'row', group: 'Travel', label: 'Row', prop: 'rowboat', ...sequence([travel(240, 'row', () => ({ effort: 1 }), 3)]) },
  { id: 'helm', group: 'Travel', label: 'At the helm', prop: 'sloop', ...sequence([travel(240, 'helm', (t) => ({ bank: Math.sin(t * 0.9) * 0.8, effort: 0.5 }), 5)]) },
  { id: 'sit', group: 'Travel', label: 'Passenger', prop: 'cart', ...sequence([travel(240, 'sit', () => ({ effort: 0.3 }), 6)]) },
];

/** The jump attack: an air swing started near the top of a jump. */
{
  const s = SCENARIOS.find((x) => x.id === 'airSlash')!;
  const base = s.at.bind(s);
  const step = comboShape(0, 0)[0];
  const swingFrames = step.startup + step.active + step.recovery;
  s.at = (frame) => {
    const m = base(frame);
    const f = (((frame % s.frames) + s.frames) % s.frames) - 20 - 18;
    if (m.input.grounded === false && f >= 0 && f < swingFrames) {
      return { ...m, input: { ...m.input, attackIndex: 0, attackFrame: f, step, comboLength: 3, weapon: 0 } };
    }
    return m;
  };
}

export const scenario = (id: string): Scenario => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`no scenario "${id}"; known: ${SCENARIOS.map((x) => x.id).join(', ')}`);
  return s;
};

void TAU;
