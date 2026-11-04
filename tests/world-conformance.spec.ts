import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { makeRng } from '../src/rng';
import { Sim } from '../src/sim/sim';
import { NO_ACTIONS, type Actions, type Mode } from '../src/sim/types';
import { makeZoneWorld } from '../src/sim/zone/world';
import { groundAt, pushOutOfBox } from '../src/sim/zone/colliders';
import { gust } from '../src/sim/player/traverse';
import { GLIDE, GROUND, SWIM } from '../src/content/traversal';
import { CARRY } from '../src/content/trade';
import { glider as gliderDef } from '../src/content/vehicles';
import { JUMP, MOVE, STEP } from '../src/tuning';

// Emberholm's rules, browser against server: the browser predicts your own moves with
// src/sim/player/traverse.ts (hills, cliffs, decks, wading, swimming, gliders, trade packs) and the
// server decides with server/src/open (step_player). If they disagree, your character would
// visibly jump back. This runs the same inputs through both, on the real island, and checks they
// stay in the same place frame by frame. Each script also checks that it really does what it says
// (that the swim really swims), so a change to the island can't quietly empty one out.

const WORLDCHECK = `server/target/release/worldcheck${process.platform === 'win32' ? '.exe' : ''}`;
/** Modes by number, as server/src/player.rs Mode numbers them. */
const MODES: Record<Mode, number> = { normal: 0, attack: 1, cast: 2, action: 3, swim: 4, glide: 5, ride: 6 };

// One recorded frame, in the order both sides write it (see server/src/bin/worldcheck.rs).
const F = {
  x: 0, y: 1, z: 2, vx: 3, vy: 4, vz: 5, facing: 6, airspeed: 7, bank: 8, landImpact: 9, runPhase: 10, hp: 11,
  mode: 12, grounded: 13, jumpsUsed: 14, jumpCutDone: 15, coyote: 16, jumpBuffer: 17, flipFrame: 18, landFrame: 19,
  takeoffFrame: 20, sprinting: 21, crouching: 22, crouchFrame: 23, modeFrame: 24, gustFrames: 25, actionId: 26,
  actionFrame: 27, attackIndex: 28, attackFrame: 29, stun: 30, downFrame: 31,
} as const;
const FRAME_LEN = 32;
// Continuous values, compared with a tolerance.
const NEAR = [F.x, F.y, F.z, F.vx, F.vy, F.vz, F.facing, F.airspeed, F.bank, F.landImpact, F.runPhase, F.hp];
// Modes, flags and frame counters, which must match exactly.
const EXACT = Object.values(F).filter((k) => !NEAR.includes(k as (typeof NEAR)[number]));
// How far apart the two may drift. Both do the same arithmetic in the same order; what is left is
// the last bit of sin, cos, atan2, exp and hypot, which JavaScript and Rust round their own ways.
const TOLERANCE = 1e-6;

interface Script {
  spawn: { x: number; z: number; facing: number };
  glider: string;
  pack: number;
  steps: Actions[];
  /** Frames on which the glider's gust is used (the F key, a command in the life systems). */
  gusts: number[];
}

type Frame = number[];
const world = () => makeZoneWorld();

/** Writing a script: hold some input for a number of frames, or press jump for one. */
function writer(spawn: Script['spawn'], opts: { glider?: string; pack?: number } = {}) {
  const s: Script = { spawn, glider: opts.glider ?? '', pack: opts.pack ?? 0, steps: [], gusts: [] };
  const hold = (n: number, a: Partial<Actions> = {}) => {
    for (let i = 0; i < n; i++) s.steps.push({ ...NO_ACTIONS, ...a });
  };
  const jump = (a: Partial<Actions> = {}) => {
    const at = s.steps.length;
    hold(1, { ...a, jumpPressed: true, jumpHeld: true });
    return at;
  };
  /** The frame the next input lands on. */
  const now = () => s.steps.length;
  return { s, hold, jump, now };
}

/** Someone playing: a direction held for a while, then another, with presses mixed in. */
function wander(hold: (n: number, a: Partial<Actions>) => void, seed: number, frames: number): void {
  const rng = makeRng(seed);
  for (let n = 0; n < frames; ) {
    const len = 10 + Math.floor(rng() * 50);
    const ang = rng() * Math.PI * 2;
    const mag = rng() < 0.1 ? 0 : 0.3 + rng() * 0.7;
    const sprint = rng() < 0.35;
    const crouch = rng() < 0.1;
    const held = rng() < 0.7;
    for (let i = 0; i < len && n < frames; i++, n++) {
      hold(1, {
        moveX: Math.sin(ang) * mag,
        moveZ: Math.cos(ang) * mag,
        jumpPressed: rng() < 0.04,
        jumpHeld: held,
        attackPressed: rng() < 0.01,
        slidePressed: rng() < 0.01,
        sprintHeld: sprint,
        crouchHeld: crouch,
      });
    }
  }
}

const mode = (f: Frame) => f[F.mode];
const speed = (f: Frame) => Math.hypot(f[F.vx], f[F.vz]);
/** How far you moved over the ground between two frames, per second. */
const pace = (a: Frame, b: Frame) => Math.hypot(b[F.x] - a[F.x], b[F.z] - a[F.z]) / STEP;
const anyFrame = (frames: Frame[], from: number, to: number, fn: (f: Frame, i: number) => boolean) => {
  for (let i = Math.max(0, from); i < Math.min(frames.length, to); i++) if (fn(frames[i], i)) return i;
  return -1;
};
/** The first frame (from `from`) where the mode changes from `a` to `b`, or -1. */
const change = (frames: Frame[], a: Mode, b: Mode, from = 1) =>
  anyFrame(frames, from, frames.length, (f, i) => i > 0 && mode(frames[i - 1]) === MODES[a] && mode(f) === MODES[b]);

/** A jump pressed in the water at `press` hauled you out (it is buffered, so within a few frames). */
function hauledOut(frames: Frame[], press: number): number {
  const out = change(frames, 'swim', 'normal', press);
  expect(out, 'hauled out of the water').toBeGreaterThanOrEqual(press);
  expect(out - press).toBeLessThan(JUMP.bufferFrames);
  expect(frames[out][F.grounded]).toBe(0);
  expect(frames[out][F.vy], 'up and out').toBeGreaterThan(0);
  return out;
}

interface Case {
  script: Script;
  /** Checks, on the TypeScript run, that the script does what it says. */
  verify: (frames: Frame[]) => void;
}

const CASES: Record<string, () => Case> = {
  // Down the long slope east of the updraft and back up it, sprinting, then crouching and walking.
  'running over hills': () => {
    const { s, hold } = writer({ x: 84, z: 184, facing: Math.PI * 0.75 });
    hold(240, { moveX: 0.8, moveZ: -0.6 });
    hold(240, { moveX: -0.8, moveZ: 0.6, sprintHeld: true });
    hold(120, { moveX: 0.3, moveZ: -0.5, crouchHeld: true });
    hold(120, { moveX: 0.25, moveZ: -0.25 });
    return {
      script: s,
      verify: (fr) => {
        const hf = world().terrain!;
        expect(fr.every((f) => f[F.grounded] === 1), 'on your feet the whole way').toBe(true);
        const ys = fr.map((f) => f[F.y]);
        expect(Math.max(...ys) - Math.min(...ys), 'down and back up the hill').toBeGreaterThan(10);
        expect(Math.max(...fr.map((f) => hf.slope(f[F.x], f[F.z]))), 'on a real slope').toBeGreaterThan(0.5);
        expect(fr.slice(250, 480).every((f) => f[F.sprinting] === 1), 'sprinting uphill').toBe(true);
        expect(pace(fr[400], fr[401]), 'at sprint speed, measured over the ground').toBeGreaterThan(MOVE.sprintSpeed * 0.75);
        expect(fr.slice(490, 600).every((f) => f[F.crouching] === 1), 'crouching').toBe(true);
      },
    };
  },

  // Windspire's east face: run into it, push along it both ways (sliding off where it is too steep
  // to stand), jump at it, and run back down off it.
  'walking into a cliff and along it': () => {
    const { s, hold, jump } = writer({ x: 120, z: 228, facing: -Math.PI / 2 });
    hold(150, { moveX: -1 });
    hold(150, { moveX: -0.9, moveZ: 0.44 });
    hold(150, { moveX: -0.9, moveZ: -0.44 });
    jump({ moveX: -1 });
    hold(60, { moveX: -1, jumpHeld: true });
    hold(60, { moveX: 1 });
    return {
      script: s,
      verify: (fr) => {
        const hf = world().terrain!;
        expect(fr[149][F.vx], 'stopped by the cliff while still pushing into it').toBe(0);
        expect(Math.abs(fr[149][F.x] - fr[130][F.x]), 'and not moving').toBeLessThan(0.2);
        expect(hf.slope(fr[149][F.x] - 0.5, fr[149][F.z]), 'it is steeper than you can walk').toBeGreaterThan(GROUND.maxSlope);
        expect(anyFrame(fr, 150, 300, (f) => f[F.vx] === 0 && f[F.vz] > 0.3), 'sliding north along it').toBeGreaterThan(0);
        // Off your feet without jumping: slid off ground too steep to stand on, or ran off an edge.
        const offFeet = anyFrame(fr, 1, fr.length, (f, i) => fr[i - 1][F.grounded] === 1 && f[F.grounded] === 0 && f[F.takeoffFrame] > 0);
        expect(offFeet, 'slid off the steep part').toBeGreaterThan(0);
      },
    };
  },

  // The east pier at Lanternwick Docks: onto it from the quay, off its end into the sea, swim out
  // and back, haul out at its end, double jump up onto it, step off its side into the shallows,
  // wade ashore and climb the bank to the quay.
  'decks, piers, swimming and climbing out': () => {
    const { s, hold, jump, now } = writer({ x: 17, z: -328, facing: Math.PI });
    hold(260, { moveZ: -1 });
    hold(40, { moveZ: -0.3 });
    hold(120, { moveZ: 1 });
    const climb = jump({ moveZ: 1 });
    hold(15, { moveZ: 1, jumpHeld: true });
    jump({ moveZ: 1 });
    hold(25, { moveZ: 1, jumpHeld: true });
    hold(25, { moveZ: 1 });
    const side = now();
    hold(60, { moveX: 1 });
    hold(200, { moveX: 0.5, moveZ: 0.86 });
    return {
      script: s,
      verify: (fr) => {
        const w = world();
        const hf = w.terrain!;
        const onDeck = (f: Frame) => f[F.grounded] === 1 && Math.abs(f[F.y] - 1.4) < 1e-9 && hf.height(f[F.x], f[F.z]) < 1.3;
        expect(anyFrame(fr, 0, 180, onDeck), 'walking the pier above the water').toBeGreaterThan(0);
        expect(change(fr, 'normal', 'swim'), 'off its end and swimming').toBeGreaterThan(0);
        const out = hauledOut(fr, climb);
        expect(fr[out][F.jumpsUsed]).toBe(1);
        expect(anyFrame(fr, out, side, onDeck), 'and up onto it').toBeGreaterThan(0);
        const off = anyFrame(fr, side, fr.length, (f) => f[F.grounded] === 0);
        expect(off, 'stepped off its side').toBeGreaterThan(0);
        expect(fr[off][F.y]).toBeCloseTo(1.4, 6);
        const wading = anyFrame(fr, off, fr.length, (f, i) => f[F.grounded] === 1 && hf.water - f[F.y] > GROUND.wadeDepth && fr[i - 1][F.grounded] === 1);
        expect(wading, 'wading').toBeGreaterThan(0);
        expect(pace(fr[wading - 1], fr[wading]), 'slowly').toBeCloseTo(MOVE.runSpeed * GROUND.wadeSpeed, 1);
        expect(fr[fr.length - 1][F.y], 'up on the quay at the end').toBeGreaterThan(1.4);
      },
    };
  },

  // Sunscale Strand: run into the sea (wading, then swimming), swim hard, try to jump in open
  // water, drift, swim back and walk out up the beach.
  'wading and swimming off the beach': () => {
    const { s, hold, jump } = writer({ x: -228, z: -300, facing: -Math.PI / 2 });
    hold(200, { moveX: -1 });
    hold(200, { moveX: -1, sprintHeld: true });
    hold(120, { moveX: -0.7, moveZ: 0.7, sprintHeld: true });
    const openWater = jump({ moveZ: 1 });
    hold(60, { moveZ: 1 });
    hold(30, {});
    hold(400, { moveX: 1 });
    jump({ moveX: 1 });
    hold(40, { moveX: 1, jumpHeld: true });
    return {
      script: s,
      verify: (fr) => {
        const hf = world().terrain!;
        const swim = change(fr, 'normal', 'swim');
        expect(swim, 'swimming').toBeGreaterThan(0);
        expect(anyFrame(fr, 0, swim, (f) => f[F.grounded] === 1 && hf.water - f[F.y] > GROUND.wadeDepth), 'wading in first').toBeGreaterThan(0);
        expect(anyFrame(fr, swim, fr.length, (f) => mode(f) === MODES.swim && f[F.sprinting] === 1), 'swimming hard').toBeGreaterThan(0);
        expect(mode(fr[openWater + 1]), 'no jumping out of open water').toBe(MODES.swim);
        const ashore = change(fr, 'swim', 'normal');
        expect(ashore, 'walked out').toBeGreaterThan(swim);
        expect(fr[ashore][F.grounded]).toBe(1);
        expect(fr[fr.length - 1][F.y], 'back up the beach').toBeGreaterThan(1);
      },
    };
  },

  // A double jump on the hillside, steered; a short hop; a slide and a jump out of it; the combo;
  // an attack in the air; another slide.
  'jumps, double jumps, slides and swings on a slope': () => {
    const { s, hold, jump } = writer({ x: 100, z: 172, facing: -Math.PI / 2 });
    hold(30, { moveX: -0.8, moveZ: 0.6 });
    jump({ moveX: -0.8, moveZ: 0.6 });
    hold(18, { moveX: -0.8, moveZ: 0.6, jumpHeld: true });
    const double = jump({ moveX: 0.6, moveZ: 0.8 });
    hold(50, { moveX: 0.6, moveZ: 0.8, jumpHeld: true });
    const hop = jump({ moveX: 0.8, moveZ: -0.6 });
    hold(4, { moveX: 0.8, moveZ: -0.6, jumpHeld: true });
    hold(40, { moveX: 0.8, moveZ: -0.6 });
    hold(1, { moveX: 0.8, moveZ: -0.6, slidePressed: true });
    hold(12, { moveX: 0.8, moveZ: -0.6 });
    jump({ moveX: 0.8, moveZ: -0.6 });
    hold(60, { moveX: 0.8, moveZ: -0.6, jumpHeld: true });
    hold(1, { attackPressed: true });
    hold(8, {});
    hold(1, { attackPressed: true });
    hold(10, {});
    hold(1, { attackPressed: true });
    hold(50, {});
    jump({ moveX: -1 });
    hold(10, { moveX: -1, jumpHeld: true });
    hold(1, { moveX: -1, attackPressed: true, jumpHeld: true });
    hold(60, { moveX: -1 });
    hold(1, { slidePressed: true, moveZ: 1 });
    hold(40, { moveZ: 1 });
    return {
      script: s,
      verify: (fr) => {
        expect(fr[double][F.jumpsUsed], 'double jump').toBe(2);
        expect(fr[double][F.vx] * 0.8 - fr[double][F.vz] * 0.6, 'turned to the new direction').toBeCloseTo(0, 6);
        expect(fr[hop + 5][F.jumpCutDone], 'short hop').toBe(1);
        expect(fr.some((f) => mode(f) === MODES.action), 'slide').toBe(true);
        expect(fr.some((f) => mode(f) === MODES.attack && f[F.attackIndex] === 2), 'the whole combo').toBe(true);
        expect(fr.some((f) => mode(f) === MODES.attack && f[F.grounded] === 0), 'a swing in the air').toBe(true);
      },
    };
  },

  // Off Windspire's edge: jump, double jump, open the glider (a jump with both spent), ignore a
  // fold pressed too soon, ride the updraft round, gust (and be refused a second), dive, flare,
  // fold and fall, double jump and open it again.
  'gliding: open, updraft, gust, dive, flare, fold': () => {
    const { s, hold, jump, now } = writer({ x: 50, z: 232, facing: Math.PI / 2 }, { glider: 'wayfarer' });
    hold(150, { moveX: 1 });
    jump({ moveX: 1 });
    hold(20, { moveX: 1, jumpHeld: true });
    jump({ moveX: 1 });
    hold(10, { moveX: 1, jumpHeld: true });
    const open = jump({ moveX: 1 });
    hold(4, { moveX: 1 });
    const tooSoon = jump({ moveX: 1 });
    hold(45, { moveX: 1 });
    hold(220, { moveZ: -1 });
    const circle = now();
    for (let i = 0; i < 300; i++) {
      const a = Math.PI + 0.6 + i * (1.5 / 60);
      hold(1, { moveX: Math.sin(a), moveZ: Math.cos(a), crouchHeld: i > 100 && i < 220 });
    }
    const gustAt = now();
    s.gusts.push(gustAt, gustAt + 20);
    hold(60, { moveX: 0.7, moveZ: -0.7 });
    const dive = now();
    hold(120, { moveX: 0.7, moveZ: -0.7, sprintHeld: true });
    hold(90, { moveX: 0.7, moveZ: -0.7, crouchHeld: true });
    const fold = jump({ moveX: 0.7, moveZ: -0.7 });
    hold(40, { moveX: 0.7, moveZ: -0.7 });
    jump({ moveX: 0.7, moveZ: -0.7 });
    hold(15, { moveX: 0.7, moveZ: -0.7, jumpHeld: true });
    const reopen = jump({ moveX: 0.7, moveZ: -0.7 });
    hold(90, { moveX: -0.7, moveZ: -0.7 });
    return {
      script: s,
      verify: (fr) => {
        const g = gliderDef('wayfarer');
        expect([mode(fr[open - 1]), fr[open - 1][F.jumpsUsed], mode(fr[open])], 'opened with both jumps spent').toEqual([MODES.normal, 2, MODES.glide]);
        expect(mode(fr[tooSoon]), 'a fold pressed while it opens is ignored').toBe(MODES.glide);
        const lift = anyFrame(fr, circle, gustAt, (f) => mode(f) === MODES.glide && f[F.vy] > 3);
        expect(lift, 'climbing in the updraft').toBeGreaterThan(0);
        expect(fr[gustAt][F.gustFrames], 'gust').toBe(Math.round(g.gust!.cooldownSeconds / STEP) - 1);
        expect(fr[gustAt + 20][F.gustFrames], 'and no second one while it recharges').toBe(fr[gustAt][F.gustFrames] - 20);
        expect(fr[dive + 119][F.airspeed], 'diving').toBeGreaterThan(g.cruiseSpeed + 5);
        expect(fr[fold - 1][F.vy], 'a flare turns speed into height').toBeGreaterThan(0);
        expect([mode(fr[fold]), fr[fold][F.grounded], fr[fold][F.jumpsUsed]], 'folded in mid-air').toEqual([MODES.normal, 0, 1]);
        expect(mode(fr[reopen]), 'and opened again').toBe(MODES.glide);
      },
    };
  },

  // In Lanternwick: jump and double jump, too low to open the glider, then high enough; glide into
  // a house, along its wall and past it, and land.
  'gliding into a house and landing': () => {
    const { s, hold, jump } = writer({ x: -6, z: -264, facing: -Math.PI / 2 }, { glider: 'swiftwing' });
    hold(20, { moveX: -1 });
    jump({ moveX: -1 });
    hold(20, { moveX: -1, jumpHeld: true });
    jump({ moveX: -1 });
    hold(1, { moveX: -1, jumpHeld: true });
    const tooLow = jump({ moveX: -1 });
    hold(12, { moveX: -1, jumpHeld: true });
    const open = jump({ moveX: -1 });
    hold(30, { moveX: -1 });
    hold(120, { moveX: -0.8, moveZ: 0.6 });
    return {
      script: s,
      verify: (fr) => {
        const wall = -30 + 4.5 + MOVE.playerRadius; // the house at (-30, -264), its east face
        expect(fr.slice(tooLow, open).every((f) => mode(f) === MODES.normal && f[F.jumpsUsed] === 2), 'too low to open').toBe(true);
        expect(mode(fr[open]), 'then high enough').toBe(MODES.glide);
        const hit = anyFrame(fr, open, fr.length, (f) => mode(f) === MODES.glide && f[F.vx] === 0 && Math.abs(f[F.x] - wall) < 1e-6);
        expect(hit, 'flew into the wall and along it').toBeGreaterThan(0);
        const land = change(fr, 'glide', 'normal', hit);
        expect(land, 'landed').toBeGreaterThan(hit);
        expect(fr[land][F.grounded]).toBe(1);
        expect(speed(fr[land]) / fr[land - 1][F.airspeed], 'keeping some of its speed').toBeCloseTo(GLIDE.landKeep, 1);
      },
    };
  },

  // Off Windspire, out and round, and back nose first into its face: the glider crashes (no way
  // round in either direction), you slide down the face, double jump and open it again.
  'gliding into a cliff': () => {
    const { s, hold, jump } = writer({ x: 50, z: 232, facing: Math.PI / 2 }, { glider: 'wayfarer' });
    hold(150, { moveX: 1 });
    jump({ moveX: 1 });
    hold(20, { moveX: 1, jumpHeld: true });
    jump({ moveX: 1 });
    hold(10, { moveX: 1, jumpHeld: true });
    jump({ moveX: 1 });
    hold(110, { moveX: 1 });
    hold(60, { moveZ: -1 });
    const a = Math.atan2(-1, 1);
    hold(200, { moveX: Math.sin(a), moveZ: Math.cos(a) });
    hold(5, {});
    const double = jump({});
    hold(15, { jumpHeld: true });
    const reopen = jump({ moveX: 1 });
    hold(90, { moveX: 1 });
    return {
      script: s,
      verify: (fr) => {
        const crash = change(fr, 'glide', 'normal');
        expect(crash, 'crashed').toBeGreaterThan(0);
        expect([fr[crash][F.grounded], fr[crash][F.vx], fr[crash][F.vz], fr[crash][F.jumpsUsed]], 'stopped dead in the air').toEqual([0, 0, 0, 1]);
        expect(fr[double][F.jumpsUsed], 'double jump after').toBe(2);
        expect(mode(fr[reopen]), 'and open again').toBe(MODES.glide);
      },
    };
  },

  // Off the end of the east pier: a late jump (coyote time), a double jump, the glider, out over
  // the sea and down into it.
  'gliding out to sea': () => {
    const { s, hold, jump } = writer({ x: 17, z: -344, facing: Math.PI }, { glider: 'wayfarer' });
    hold(51, { moveZ: -1 });
    const late = jump({ moveZ: -1 });
    hold(20, { moveZ: -1, jumpHeld: true });
    jump({ moveZ: -1 });
    hold(12, { moveZ: -1, jumpHeld: true });
    const open = jump({ moveZ: -1 });
    hold(240, { moveZ: -1, sprintHeld: true });
    hold(60, { moveZ: -1 });
    return {
      script: s,
      verify: (fr) => {
        expect(fr[late - 1][F.grounded], 'off the end of the pier').toBe(0);
        expect([fr[late][F.jumpsUsed], fr[late][F.vy]], 'and still a full jump').toEqual([1, JUMP.velocity - JUMP.gravityUp * STEP]);
        expect(mode(fr[open]), 'glider').toBe(MODES.glide);
        const splash = change(fr, 'glide', 'swim');
        expect(splash, 'down into the sea, swimming').toBeGreaterThan(open);
        expect(fr[splash][F.airspeed]).toBeGreaterThan(gliderDef('wayfarer').cruiseSpeed);
      },
    };
  },

  // From the south edge of Lanternwick, glide down onto the roof of the building by the docks
  // (its top is ground too), walk across it and off its far edge to the quay below.
  'landing on a roof': () => {
    const { s, hold, jump } = writer({ x: 34, z: -301, facing: Math.PI }, { glider: 'wayfarer' });
    hold(10, { moveZ: -1 });
    jump({ moveZ: -1 });
    hold(20, { moveZ: -1, jumpHeld: true });
    jump({ moveZ: -1 });
    hold(19, { moveZ: -1, jumpHeld: true });
    jump({ moveZ: -1 });
    hold(150, { moveZ: -1 });
    hold(60, { moveX: 1 });
    return {
      script: s,
      verify: (fr) => {
        const w = world();
        const hf = w.terrain!;
        const roof = w.index!.boxes.find((b) => b.x === 34 && b.z === -318)!.top;
        const land = change(fr, 'glide', 'normal');
        expect(fr[land][F.grounded], 'landed').toBe(1);
        expect(fr[land][F.y], 'on the roof').toBeCloseTo(roof, 6);
        expect(hf.height(fr[land][F.x], fr[land][F.z]), 'well above the ground').toBeLessThan(roof - 5);
        const off = anyFrame(fr, land, fr.length, (f) => f[F.grounded] === 0);
        expect(fr[off][F.y], 'walked off its edge').toBeCloseTo(roof, 6);
        expect(fr[fr.length - 1][F.y], 'down to the quay').toBeLessThan(2);
      },
    };
  },

  // As far out to sea as anyone can go: the edge of the world holds you in.
  'swimming to the edge of the world': () => {
    const { s, hold } = writer({ x: 3, z: -752, facing: Math.PI });
    hold(300, { moveX: 0.3, moveZ: -1, sprintHeld: true });
    hold(100, { moveX: 1 });
    return {
      script: s,
      verify: (fr) => {
        const r = world().radius;
        expect(fr.every((f) => mode(f) === MODES.swim), 'swimming all the way').toBe(true);
        const far = Math.max(...fr.map((f) => Math.hypot(f[F.x], f[F.z])));
        expect(far, 'to the edge').toBeGreaterThan(r - 1e-6);
        expect(far, 'and no further').toBeLessThan(r + 1e-9);
      },
    };
  },

  // Lanternwick's buildings: into a house, along its wall into the lamp post at its corner, round
  // the well, into a bench and along a stall, between the posts and into the next house, along
  // its wall and round its corner.
  'walking into buildings': () => {
    const { s, hold } = writer({ x: 0, z: -264, facing: -Math.PI / 2 });
    hold(240, { moveX: -1 });
    hold(90, { moveX: -0.6, moveZ: 0.8 });
    hold(60, { moveX: -1 });
    hold(240, { moveX: 0.92, moveZ: 0.38 });
    hold(120, { moveX: 0.6, moveZ: -0.8 });
    hold(20, { moveZ: -1 });
    hold(220, { moveX: 1, sprintHeld: true });
    hold(90, { moveX: 0.6, moveZ: -0.8 });
    return {
      script: s,
      verify: (fr) => {
        const w = world();
        const inside = fr.findIndex((f) => w.index!.boxes.some((b) => f[F.y] < b.top - 0.05 && pushOutOfBox(b, f[F.x], f[F.z], MOVE.playerRadius - 1e-6)));
        expect(inside, 'never inside a wall').toBe(-1);
        expect(fr[220][F.vx], 'stopped by the first house').toBe(0);
        expect(anyFrame(fr, 240, 330, (f) => f[F.vx] === 0 && f[F.vz] > 1), 'along its wall').toBeGreaterThan(0);
        expect(Math.hypot(fr[389][F.x] - fr[340][F.x], fr[389][F.z] - fr[340][F.z]), 'pinned between the wall and the lamp post').toBeLessThan(1e-3);
        const well = Math.min(...fr.map((f) => Math.hypot(f[F.x], f[F.z] + 250)));
        expect(well, 'brushed the well').toBeLessThan(1 + MOVE.playerRadius + 0.01);
        expect(anyFrame(fr, 790, 1000, (f) => speed(f) < 0.05 && f[F.sprinting] === 1), 'sprinted into the second house').toBeGreaterThan(0);
      },
    };
  },

  // A trade pack on your back, at the docks: no sprinting, a low jump and no double jump, so no
  // glider either; a slower swim, and hauling out without the jump to get up onto the pier.
  'carrying a trade pack': () => {
    const { s, hold, jump } = writer({ x: 17, z: -328, facing: Math.PI }, { glider: 'wayfarer', pack: 1 });
    hold(60, { moveZ: -1, sprintHeld: true });
    const hop = jump({ moveZ: -1 });
    hold(15, { moveZ: -1, jumpHeld: true });
    const second = jump({ moveZ: -1 });
    hold(10, { moveZ: -1, jumpHeld: true });
    jump({ moveZ: -1 });
    hold(200, { moveZ: -1 });
    hold(100, { moveZ: -1, sprintHeld: true });
    hold(197, { moveZ: 1 });
    const climb = jump({ moveZ: 1 });
    hold(15, { moveZ: 1, jumpHeld: true });
    jump({ moveZ: 1 });
    hold(60, { moveZ: 1, jumpHeld: true });
    hold(100, { moveZ: 1, crouchHeld: true });
    return {
      script: s,
      verify: (fr) => {
        expect(fr.every((f) => f[F.jumpsUsed] < 2 && mode(f) !== MODES.glide), 'never a second jump, so never a glider').toBe(true);
        expect(fr.slice(0, 60).every((f) => f[F.sprinting] === 0), 'no sprinting').toBe(true);
        expect(pace(fr[40], fr[41]), 'slower').toBeCloseTo(MOVE.runSpeed * CARRY.speedFactor, 6);
        expect(fr[hop][F.vy], 'a low jump').toBeCloseTo(JUMP.velocity * CARRY.jumpFactor - JUMP.gravityUp * STEP, 9);
        expect(fr[second][F.jumpsUsed], 'and no second one').toBe(1);
        const swims = fr.filter((f) => mode(f) === MODES.swim);
        expect(swims.length, 'swimming').toBeGreaterThan(100);
        expect(Math.max(...swims.map(speed)), 'slowly').toBeCloseTo(SWIM.sprintSpeed * CARRY.swimFactor, 6);
        hauledOut(fr, climb);
      },
    };
  },

  // Random play on the shore, in and out of the sea, with a glider.
  'random play on the shore': () => {
    const { s, hold } = writer({ x: -282, z: -300, facing: -Math.PI / 2 }, { glider: 'wayfarer' });
    wander(hold, 7, 1800);
    return {
      script: s,
      verify: (fr) => {
        const seen = new Set(fr.map(mode));
        for (const m of ['normal', 'swim', 'action', 'attack'] as Mode[]) expect(seen.has(MODES[m]), `some ${m}`).toBe(true);
      },
    };
  },

  // Random play at the foot of Windspire's cliffs, with the faster glider.
  'random play on the hills': () => {
    const { s, hold } = writer({ x: 104, z: 226, facing: 0 }, { glider: 'swiftwing' });
    wander(hold, 11, 1800);
    return {
      script: s,
      verify: (fr) => {
        const seen = new Set(fr.map(mode));
        for (const m of ['normal', 'action', 'attack'] as Mode[]) expect(seen.has(MODES[m]), `some ${m}`).toBe(true);
      },
    };
  },
};

/** The TypeScript (what the browser predicts), started the way api.reset() in src/main.ts does. */
function runTs(s: Script): { start: number[]; frames: Frame[] } {
  const w = world();
  const hf = w.terrain!;
  const sim = new Sim(w, { training: false });
  sim.life = null;
  sim.reset(s.spawn);
  const p = sim.player;
  // Stand on the ground there, not inside it.
  p.pos.y = groundAt(hf, w.index, p.pos.x, p.pos.z, hf.height(p.pos.x, p.pos.z) + 1.2, 1.2);
  p.prevPos = { ...p.pos };
  p.glider = s.glider;
  p.pack = s.pack;
  const start = [p.pos.x, p.pos.y, p.pos.z];
  const frames = s.steps.map((a, i) => {
    if (s.gusts.includes(i)) gust(sim);
    sim.step(a);
    const f = [
      p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z, p.facing, p.airspeed, p.bank, p.landImpact, p.runPhase, p.hp,
      MODES[p.mode], p.grounded ? 1 : 0, p.jumpsUsed, p.jumpCutDone ? 1 : 0, p.coyote, p.jumpBuffer, p.flipFrame, p.landFrame,
      p.takeoffFrame, p.sprinting ? 1 : 0, p.crouching ? 1 : 0, p.crouchFrame, p.modeFrame, p.gustFrames, p.actionId,
      p.actionFrame, p.attackIndex, p.attackFrame, p.stun, p.downFrame,
    ];
    return f;
  });
  return { start, frames };
}

for (const [name, make] of Object.entries(CASES)) {
  test(`TypeScript and Rust agree in Emberholm frame by frame: ${name}`, () => {
    const { script, verify } = make();
    const ts = runTs(script);
    expect(ts.frames[0].length).toBe(FRAME_LEN);
    verify(ts.frames);

    test.skip(!existsSync(WORLDCHECK), 'build it first: cargo build --release --manifest-path server/Cargo.toml --bin worldcheck');
    const rust = JSON.parse(execFileSync(WORLDCHECK, { input: JSON.stringify(script), maxBuffer: 64 * 1024 * 1024 }).toString()) as {
      start: number[];
      frames: Frame[];
    };
    expect(rust.start, 'stood on the same ground at the start').toEqual(ts.start);
    expect(rust.frames.length).toBe(ts.frames.length);
    expect(rust.frames[0].length, 'the two sides record the same columns').toBe(FRAME_LEN);
    // serde_json writes NaN as null, which arithmetic would quietly read as 0.
    expect(rust.frames.every((f) => f.every((v) => typeof v === 'number')), 'every value a number').toBe(true);

    let worst = 0;
    let worstFrame = 0;
    let worstColumn = '';
    let mismatches = 0;
    ts.frames.forEach((f, i) => {
      const r = rust.frames[i];
      for (const k of NEAR) {
        const d = Math.abs(f[k] - r[k]);
        // NaN never passes: a difference that is not a number is the worst of all.
        if (!(d <= worst)) {
          worst = Number.isNaN(d) ? Infinity : d;
          worstFrame = i;
          worstColumn = Object.entries(F).find(([, v]) => v === k)![0];
        }
      }
      if (EXACT.some((k) => f[k] !== r[k])) {
        if (mismatches === 0) {
          const names = Object.entries(F).filter(([, k]) => EXACT.includes(k) && f[k] !== r[k]).map(([n]) => n);
          console.log(`${name}: first mismatch at frame ${i} in ${names.join(', ')}:\n  ts=${f.join()}\n  rust=${r.join()}`);
        }
        mismatches++;
      }
    });
    const largest = worst > 0 ? `${worst.toExponential(2)} (${worstColumn}, frame ${worstFrame})` : 'none, identical';
    console.log(`${name}: ${ts.frames.length} frames | largest difference ${largest} | state mismatches ${mismatches}`);
    expect(mismatches).toBe(0);
    expect(worst).toBeLessThan(TOLERANCE);
  });
}
