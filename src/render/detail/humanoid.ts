import * as THREE from 'three';
import { ABILITIES, JUMP, MOVE, MOVEMENT_SKILLS, comboShape, weaponId, type AttackStep } from '../../content/tuning';
import type { DetailRig } from './rig';
import type { PoseFeedback, PoseInput } from '../../content/pose';
import { Body, SIDES, bump, clamp, clamp01, easeIn, easeInOut, easeOut, lerp, smooth, span, type Side } from './body';
import { directional, dutyFactor, planFoot, runGait, sprintGait, type FootPlan, type GaitShape } from './gait';
import { cycleTurn, motionOf, type Motion, type Move } from './mocap';
import { READY, swingFor, type SwingDef, type SwingKey } from './swings';
import { playPlanted, poseFromClip, strikeTime } from './retarget';
import { gliderGrip } from '../models/gliders';
import { DRAWING_HAND, stowedFor } from './stow';
import { HERO_BOW } from '../creatures/heroBody';
import { TAU } from '../../util/math';

// How a humanoid moves. Every playable race and humanoid NPC shares this - they differ in how
// they are built (src/content/creatures), not in how they walk. Poses only ever touch named
// joints and the feedback struct, never the scene, and depend on nothing but their input, so the
// clip baker can run them offscreen to produce a creature's crowd animations from the same code.
//
// Limbs are posed two ways (src/render/detail/body.ts): by angle, for swinging arms and tucked
// legs, and by where the hand or foot should be, for planted feet, hands on a wheel or a bowstring.
// Planted feet travel back under the body at exactly the ground speed, so they never skate.
const HZ = 60;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _f = new THREE.Vector3();
const _g = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _plan: Record<Side, FootPlan> = {
  L: { ankle: new THREE.Vector3(), pitch: 0, planted: 0, stance: 0 },
  R: { ankle: new THREE.Vector3(), pitch: 0, planted: 0, stance: 0 },
};

/** A foot to stand on: ankle x and z, how high it is lifted, toes down (+), toes left (+). */
interface Foot {
  x: number;
  z: number;
  lift: number;
  pitch: number;
  yaw: number;
}
const foot = (): Foot => ({ x: 0, z: 0, lift: 0, pitch: 0, yaw: 0 });
const _feet: Record<Side, Foot> = { L: foot(), R: foot() };
const ALL = { L: 1, R: 1 };
/** How planted each foot ended up in the pose being built (see PoseFeedback.plant). */
const _planted: Record<Side, number> = { L: 0, R: 0 };
/** The furthest a stance lets the body sink to keep planted feet under it. */
const MAX_SINK = 0.16;

/** Smooth, deterministic wandering in -1..1. */
function noise(t: number): number {
  return Math.sin(t) * 0.55 + Math.sin(t * 2.31 + 1.7) * 0.3 + Math.sin(t * 4.13 + 0.4) * 0.15;
}

/** A direction at azimuth az (0 ahead, + left) and elevation el (+ up). */
function dir(az: number, el: number, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(el);
  return out.set(Math.sin(az) * c, Math.sin(el), Math.cos(az) * c);
}

/** A point in the torso's frame, in model space. */
const torsoPoint = (b: Body, x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 => b.toModel(b.torso, out.set(x, y, z), out);
/** A direction in the torso's frame, in model space. */
const torsoDir = (b: Body, v: THREE.Vector3): THREE.Vector3 => v.applyQuaternion(b.quaternionOf(b.torso, _q));

const k = (s: Side): number => (s === 'L' ? 1 : -1);

// ---------- standing on the ground ----------

/**
 * Stands on two feet: lets the body down just far enough that the planted feet can reach (`hold`
 * says how much each one counts), then reaches for them.
 */
function plant(b: Body, feet: Record<Side, Foot>, kneeOut = 0.12, hold: Record<Side, number> = ALL): void {
  let drop = 0;
  const sinkMax = (MAX_SINK * (b.leg.L.l1 + b.leg.L.l2)) / 0.54;
  for (const s of SIDES) {
    const f = feet[s];
    // A planted foot left further away than the leg can reach, even with the body sunk as far as
    // a stance allows, drags along after it - the back foot of a long lunge.
    if (hold[s] > 0) {
      const hip = b.hipOf(s, _b);
      const reach = (b.leg[s].l1 + b.leg[s].l2) * 0.99;
      const rise = hip.y - sinkMax - (f.lift + b.ankleHeight);
      const flat = Math.sqrt(Math.max(0, reach * reach - rise * rise));
      const dx = f.x - hip.x;
      const dz = f.z - hip.z;
      const far = Math.hypot(dx, dz);
      if (far > flat && far > 1e-6) {
        f.x = hip.x + (dx / far) * flat;
        f.z = hip.z + (dz / far) * flat;
      }
    }
    b.ankleOver(f.x, f.lift, f.z, _a);
    drop = Math.max(drop, b.dropToReach(s, _a) * hold[s]);
  }
  b.body.position.y -= Math.min(sinkMax, drop);
  for (const s of SIDES) {
    const f = feet[s];
    b.footTo(s, b.ankleOver(f.x, f.lift, f.z, _a), f.pitch, f.yaw, kneeOut);
    _planted[s] = f.lift < 0.01 ? hold[s] : 0;
  }
}

/**
 * Keeps a tumbling or sprawled body out of the floor (y = 0 in model space: the ground, or in the
 * air the point the rules call your feet). Finds the lowest point of every part of the body - each
 * rounded box and ball, exactly - and lifts the whole body by however far it went under.
 */
function keepOffFloor(b: Body, floor = 0): void {
  const low = lowestPoint(b);
  if (low < floor) b.body.position.y += floor - low;
}

const _mm = new THREE.Matrix4();

/** The lowest point of the body's own parts (not what it carries), model space. */
function lowestPoint(b: Body): number {
  let low = Infinity;
  let joint = '';
  let e: number[] = _mm.elements;
  for (const part of b.rig.def.parts) {
    if (part.joint !== joint) {
      joint = part.joint;
      e = b.matrixOf(b.rig.joint(joint), _mm).elements;
    }
    const [px, py, pz] = part.pos ?? [0, 0, 0];
    const cy = e[1] * px + e[5] * py + e[9] * pz + e[13];
    const sh = part.shape;
    if (sh.kind === 'box') {
      const r = Math.min(sh.r ?? 0.05, sh.w / 2, sh.h / 2, sh.d / 2);
      low = Math.min(low, cy - (Math.abs(e[1]) * (sh.w / 2 - r) + Math.abs(e[5]) * (sh.h / 2 - r) + Math.abs(e[9]) * (sh.d / 2 - r)) - r);
    } else if (sh.kind === 'sphere') {
      low = Math.min(low, cy - sh.r);
    }
  }
  return low;
}

/** The lowest point of the parts hung on one joint (a boot, say), model space. */
function lowestOn(b: Body, joint: THREE.Object3D): number {
  let low = Infinity;
  const e = b.matrixOf(joint, _mm).elements;
  for (const part of b.rig.def.parts) {
    if (b.rig.joint(part.joint) !== joint || part.shape.kind !== 'box') continue;
    const sh = part.shape;
    const [px, py, pz] = part.pos ?? [0, 0, 0];
    const cy = e[1] * px + e[5] * py + e[9] * pz + e[13];
    const r = Math.min(sh.r ?? 0.05, sh.w / 2, sh.h / 2, sh.d / 2);
    low = Math.min(low, cy - (Math.abs(e[1]) * (sh.w / 2 - r) + Math.abs(e[5]) * (sh.h / 2 - r) + Math.abs(e[9]) * (sh.d / 2 - r)) - r);
  }
  return low;
}

/**
 * Tidies a pose that something has eased between two others (the close-up renderer's
 * transitions): feet lifted back out of the floor, the weapon kept up. Poses straight from
 * poseHumanoid never need it.
 */
export function settle(rig: DetailRig, p: PoseInput): void {
  if (p.travel) return;
  const b = Body.of(rig);
  for (const s of SIDES) {
    const low = lowestOn(b, b.leg[s].end);
    if (low < -0.002) b.liftLeg(s, -low);
  }
  if (!p.grounded || p.down || p.actionId >= 0) keepOffFloor(b);
  keepBladeUp(b, p.weapon, p.attackIndex >= 0 ? -0.1 : 0.02);
}

/**
 * How far a held weapon reaches past the hand, metres (its tip, down the hand's -Y), by the weapon's
 * id. The poses know each weapon by its id (weaponId: a PoseInput has its place in WEAPONS), as each
 * is held, swung and put away in a way of its own.
 */
const REACH: Record<string, number> = { sword: 1.1, club: 0.65 };
const _tip = new THREE.Vector3();

/**
 * A weapon held at rest stays out of the floor: if its tip would go under `floor`, the wrist tips
 * it up just enough. Swings allow a little bite into the ground (a smash); held weapons none.
 */
function keepBladeUp(b: Body, weapon: number, floor: number): void {
  const reach = REACH[weaponId(weapon)] ?? 0;
  if (!reach) return;
  const hand = b.positionOf(b.arm.R.end, _b);
  const along = b.toModel(b.arm.R.end, _tip.set(0, -1, 0), _tip).sub(hand);
  const tipY = hand.y + along.y * reach;
  if (tipY >= floor) return;
  // Raise the blade's elevation until the tip clears.
  const flat = Math.hypot(along.x, along.z) || 1;
  const el = Math.asin(clamp((floor - hand.y) / reach, -1, 1));
  _tip.set((along.x / flat) * Math.cos(el), Math.sin(el), (along.z / flat) * Math.cos(el));
  b.aimHand('R', _tip);
}

/** The cape hangs from the shoulders: `lift` is how far it streams back from straight down. */
function cape(b: Body, lift: number, curl: number, sway = 0): void {
  const back = Math.max(0.05, lift - b.pitchOf(b.torso));
  b.cape.rotation.set(back, 0, sway);
  b.capeTail.rotation.set(Math.max(-0.1, curl), 0, sway * 0.5);
}

/** Standing stance: ankle x, z and how far the toes turn out. */
const STANCE: Record<Side, readonly [number, number, number]> = { L: [0.15, 0.07, 0.24], R: [-0.15, -0.06, -0.32] };

interface Gait {
  moving: number;
  run: number;
  sprint: number;
  cycle: number;
}
const STILL: Gait = { moving: 0, run: 0, sprint: 0, cycle: 0 };
/** In the air, a weapon is carried as at a run, mid-stride. */
const LEAPING: Gait = { moving: 1, run: 1, sprint: 0, cycle: 0.25 };

/**
 * Standing, walking, running, sprinting, creeping: the whole body from the speed and stride
 * phase. `sink` lowers it (landing); the legs bend to keep the feet where they are.
 */
function locomotion(b: Body, p: PoseInput, sink = 0): Gait {
  const v = Math.max(0, p.run) * MOVE.runSpeed;
  const c = clamp01(p.crouch);
  const moving = p.stride >= 0 ? clamp01(p.stride) : smooth(v / 0.8);
  const still = 1 - moving;
  const stride = b.stride;
  const run = runGait(v, stride);
  const sprint = sprintGait(v);
  const carry = p.carry ? 1 : 0;
  const cycle = p.phase / TAU;
  const d = dutyFactor(v, c, directional(p.heading).back, stride);
  // A made body's captured walk and run (mocap.ts), and how much longer its legs are than the box
  // hero's, which the body's rise and fall and its crouch are measured against.
  const motion = stride.made ? motionOf(b.rig.def) : undefined;
  const legs = (b.leg.L.l1 + b.leg.L.l2) / 0.54;
  const t = p.time;
  const breath = Math.sin(t * 2.2);

  // Where the feet go: the gait's plan laid along the way the body is travelling (ahead, to the
  // side, or played backwards to back away), eased into a standing stance as the body comes to rest.
  const dirs = directional(p.heading);
  const back = dirs.back;
  const ahead = Math.cos(p.heading);
  const side = Math.sin(p.heading);
  // Hips turn toward the way you go once you're moving properly; creeping sideways is a side-step.
  const twist = smooth((v - 0.8) / 2.2) * (1 - 0.6 * c);
  const pelvis = lerp(dirs.pelvisAhead, dirs.pelvisBehind, back) * twist * moving;
  // A made body's planted foot centres a little behind its hips, as a person's does.
  const centre = stride.made ? -0.04 - 0.06 * run : 0.015 * run;
  const shape: GaitShape = {
    speed: v,
    crouch: c,
    carry: p.carry,
    back: 0,
    centre,
    width: 0,
    ankleHeight: b.ankleHeight,
    heel: b.heel,
    ball: b.ball,
    stride,
    low: stride.made ? 0.6 * Math.abs(Math.sin(p.heading)) : 0,
  };
  const width = stride.made ? lerp(lerp(0.1, 0.06, run) - 0.01 * sprint, 0.16, c) : lerp(lerp(0.115, 0.085, run) - 0.012 * sprint, 0.17, c);
  const hold = { L: 1, R: 1 };
  const onGround = { L: 1, R: 1 };
  const along = { L: 0, R: 0 };
  for (const s of SIDES) {
    const st = STANCE[s];
    const f = _feet[s];
    let x = 0;
    let y = 0;
    let z = 0;
    let pitch = 0;
    let planted = 0;
    let down = 0;
    for (const [w, gaitBack, dirAt, u] of [
      [1 - back, 0, dirs.ahead, cycle + (s === 'L' ? 0 : 0.5)],
      [back, 1, dirs.behind, -(cycle + (s === 'L' ? 0 : 0.5))],
    ] as const) {
      if (w <= 0) continue;
      shape.back = gaitBack;
      const plan = planFoot(shape, u, _plan[s]);
      const lx = k(s) * width;
      const lz = plan.ankle.z;
      const cs = Math.cos(dirAt);
      const sn = Math.sin(dirAt);
      x += w * (lx * cs + lz * sn);
      z += w * (-lx * sn + lz * cs);
      y += w * plan.ankle.y;
      pitch += w * plan.pitch;
      planted += w * plan.planted;
      down += w * (plan.stance >= 0 ? 1 : 0);
      along[s] += w * lz;
    }
    f.x = lerp(st[0] * (1 + 0.15 * c), x, moving);
    f.z = lerp(st[1], z, moving);
    // Setting off, a foot lifts into its step before it travels, rather than sliding out.
    f.lift = (y - b.ankleHeight) * Math.min(1, moving * 2.5);
    f.pitch = pitch * moving;
    // Toes along the stride, so a foot rolling heel to toe rolls along the line it travels.
    const toes = lerp(dirs.ahead, dirs.behind, back);
    f.yaw = lerp(st[2] * (1 + 0.3 * c), toes * twist + k(s) * lerp(0.12, 0.04, run), moving);
    hold[s] = lerp(1, smooth(planted * 1.5), moving);
    onGround[s] = lerp(1, down, moving);
  }

  // The body: a little lower at speed, bobbing (up over the planted foot walking, down onto it
  // running), swaying over the standing leg, shifting its weight when still.
  const idle = noise(t * 0.45);
  const bob = legs * moving * lerp(0.012, -0.032 - 0.012 * sprint, run) * Math.cos(TAU * 2 * (cycle - d / 2));
  b.body.position.set(
    legs * moving * lerp(0.022, 0.008, run) * Math.cos(TAU * (cycle - d / 2)) + still * 0.013 * idle,
    b.standY - 0.012 * still - legs * (c * 0.25 + 0.03 * run) - 0.02 * carry - sink + bob,
    0,
  );
  // Leaning into turns, and toward the side you're strafing to.
  b.body.rotation.set(0, 0, -p.lean * 0.3 * moving * (0.35 + 0.65 * run) - side * 0.12 * moving * run - still * 0.012 * idle);

  // The pelvis turns toward the way you go and swings with the striding legs; the shoulders keep
  // facing ahead and turn against the swing.
  const hipYaw = (motion ? 0 : -0.3) * (along.L - along.R) * moving;
  b.hips.rotation.set((0.05 * run + 0.04 * carry) * Math.max(0, ahead) + 0.16 * c, pelvis + hipYaw, 0);
  // A made body's pelvis swings and tips as the captured one does, on top of turning to go.
  const phase = back > 0.5 ? -p.phase : p.phase;
  if (motion) b.hips.quaternion.multiply(captured(motion, 'hips', phase, run, moving, _mq));
  // Lean into a run, sit back a little backing away, upright strafing.
  const runLean = moving * lerp(0.07, 0.17, run) + 0.2 * sprint;
  const lean = 0.04 + runLean * Math.max(0, ahead) - 0.3 * runLean * Math.max(0, -ahead) + 0.3 * c + 0.18 * carry + sink * 1.3;
  b.torso.rotation.set(lean - 0.02 * breath * still, -0.6 * hipYaw, 0.3 * p.lean * moving * run);
  b.torso.position.y += 0.005 * breath * still;
  b.shoulder.L.position.y += 0.004 * breath * still;
  b.shoulder.R.position.y += 0.004 * breath * still;

  // The head keeps the eyes level and forward, and looks about when standing.
  b.neck.rotation.set(-lean * 0.6 + still * 0.05 * noise(t * 0.31 + 1.3), 0.55 * hipYaw + still * 0.24 * noise(t * 0.23 + 3.1), 0);
  if (motion) {
    // On the move a made body's chest, neck and head go as captured, still leaning into a crouch,
    // a load or a turn as the box hero does.
    _mq2.setFromEuler(_me.set(0.3 * c + 0.18 * carry + sink * 1.3, 0, 0.3 * p.lean * moving * run));
    b.torso.quaternion.slerp(_mq2.multiply(captured(motion, 'torso', phase, run, 1, _mq)), moving);
    b.neck.quaternion.slerp(captured(motion, 'neck', phase, run, 1, _mq), moving);
    b.head.quaternion.slerp(captured(motion, 'head', phase, run, 1, _mq), moving);
  }

  plant(b, _feet, 0.1 + 0.25 * c, hold);
  // A foot is planted the whole time it's down, heel strike to toe-off (it pivots on its heel and
  // then the ball, both of which stay put), so whoever keeps feet still can hold it all that time.
  for (const s of SIDES) _planted[s] = onGround[s] > 0.5 ? 1 : 0;

  // Arms swing against the legs, elbows folding as the pace rises; less when strafing.
  const amp = (moving * lerp(0.3, 0.62, run) + 0.3 * sprint) * (1 - 0.35 * Math.abs(side));
  const elbow = lerp(0.22, lerp(0.35, 1.3, run) + 0.25 * sprint, moving) + 0.5 * c;
  if (motion) {
    // A made body's arms hang easy standing and swing as the captured walk and run swing them.
    for (const s of SIDES) {
      b.setArmOut(s, 0.1 + 0.08 * c, 0.015 * breath * still - 0.25 * c, 0, -(0.18 + 0.5 * c));
      for (const j of ARM_JOINTS[s]) b.rig.joint(j).quaternion.slerp(captured(motion, j, phase, run, 1, _mq), moving * (1 - 0.3 * Math.abs(side)));
    }
  }
  for (const s of motion ? [] : SIDES) {
    const fwd = Math.cos(TAU * (s === 'R' ? cycle : cycle + 0.5));
    b.setArmOut(
      s,
      0.11 + 0.05 * run - 0.04 * fwd * run + 0.1 * c,
      -amp * fwd + 0.1 * run * moving - 0.35 * c + 0.015 * breath * still - sink * 0.8,
      -0.25 * run * moving,
      -(elbow + 0.3 * run * moving * Math.max(0, fwd)),
    );
  }

  // The cape streams out behind with speed and flutters with the stride. The wind comes from the
  // way you go: going ahead it lifts the cape out behind; strafing it swings the cape out to the
  // other side, half lifted; backing away it presses the cape to your back, the hem flapping
  // against your legs.
  const flutter = Math.sin(TAU * 2 * cycle) * moving;
  const behind = Math.max(0, ahead);
  const across = Math.abs(side) * (1 - behind);
  const pressed = Math.max(0, -ahead) * moving * run;
  const wind = behind + 0.45 * across;
  const speedLift = moving * lerp(0.22, 0.95, run) + 0.3 * sprint;
  cape(
    b,
    0.06 + speedLift * wind + 0.03 * Math.sin(t * 1.3) * still + 0.08 * flutter * (wind + 0.4 * pressed),
    0.08 + (0.35 * moving * run + 0.12 * Math.sin(TAU * 2 * cycle - 1.3) * moving) * (wind + 0.5 * pressed) - 0.16 * pressed + 0.03 * Math.sin(t * 1.7) * still,
    0.15 * p.lean * moving - 0.5 * side * speedLift * (1 - behind),
  );
  return { moving, run, sprint, cycle };
}

const _mq = new THREE.Quaternion();
const _mq2 = new THREE.Quaternion();
const _mq3 = new THREE.Quaternion();
const _me = new THREE.Euler();
const ARM_JOINTS: Record<Side, readonly string[]> = { L: ['armL', 'elbowL', 'handL'], R: ['armR', 'elbowR', 'handR'] };

/** A joint's turn in a made body's captured walk blended into its run, from rest by `weight`. */
function captured(m: Motion, joint: string, phase: number, run: number, weight: number, out: THREE.Quaternion): THREE.Quaternion {
  cycleTurn(m.walk, joint, phase, out);
  out.slerp(cycleTurn(m.run, joint, phase, _mq3), run);
  return weight >= 1 ? out : out.slerp(_mq3.identity(), 1 - weight);
}

// ---------- what the hands carry ----------

const _up = new THREE.Vector3(0, 1, 0);
const _drawDir = new THREE.Vector3();
const _hilt = new THREE.Vector3();
const _stowFace = new THREE.Vector3();
const _qHeld = new THREE.Quaternion();
const _qMid = new THREE.Quaternion();
const _qStow = new THREE.Quaternion();
const _qTurn = new THREE.Quaternion();

/**
 * The weapon held at rest or on the move, or put away, or on its way between (p.stow): the hand
 * that draws it reaches to where it's stowed (stow.ts) and is there at halfway, where the weapon
 * changes over from the hand to its place, lying exactly as the held one does then; the blade swings
 * up over the top between held and stowed so it never sweeps the ground. Put away, the arms hang
 * and swing free. Runs after locomotion has swung the arms.
 */
function holdWeapon(b: Body, p: PoseInput, g: Gait): void {
  const u = clamp01(p.stow);
  if (u <= 0) return holdArmed(b, p, g);
  const name = weaponId(p.weapon) || 'sword';
  const st = stowedFor(b.rig.def)[name];
  const s = DRAWING_HAND[name] ?? 'R';
  const free = b.save(b.buf(6));
  holdArmed(b, p, g);
  const heldDir = bladeDir(b, _drawDir, s);
  b.quaternionOf(b.arm[s].end, _qHeld);
  const held = b.save(b.buf(7));
  // The arms: as held, giving way to hanging free once the weapon has been let go.
  b.mix(held, free, smooth((u - 0.5) / 0.4));
  if (!st) return;
  // The hand at the hilt for a moment either side of halfway, so the change-over can't show.
  const reach = 1 - smooth((Math.abs(u - 0.5) - 0.06) / 0.36);
  if (reach > 0) {
    const hand = b.positionOf(b.arm[s].end, _e);
    torsoPoint(b, st.at[0], st.at[1], st.at[2], _hilt);
    b.handTo(s, _f.lerpVectors(hand, _hilt, reach), torsoDir(b, _pole.set(k(s) * 0.8, -0.4, -0.45)));
  }
  if (u >= 0.5) return;
  // Still in the hand: the whole hand turning, evenly over the half-move, from how it held the
  // weapon, by way of the blade straight up, to exactly how the weapon lies put away.
  const stowed = torsoDir(b, _g.set(st.along[0], st.along[1], st.along[2])).normalize();
  b.frameHand(s, stowed, torsoDir(b, _stowFace.set(st.face[0], st.face[1], st.face[2])));
  b.quaternionOf(b.arm[s].end, _qStow);
  _qMid.setFromUnitVectors(heldDir, _up).multiply(_qHeld);
  // Shared out by how far each leg of the turn goes, so it turns at an even pace (a staff held
  // upright is nearly at the top already).
  const q = smooth(u / 0.44);
  const first = _qHeld.angleTo(_qMid);
  const split = first / Math.max(1e-6, first + _qMid.angleTo(_qStow));
  if (q < split) _qTurn.slerpQuaternions(_qHeld, _qMid, q / split);
  else _qTurn.slerpQuaternions(_qMid, _qStow, (q - split) / Math.max(1e-6, 1 - split));
  b.orient(b.arm[s].end, _qTurn);
}

/** The weapon held at rest or on the move. Runs after locomotion has swung the arms. */
function holdArmed(b: Body, p: PoseInput, g: Gait): void {
  const move = g.moving;
  const t = p.time;
  const w = weaponId(p.weapon);
  if (w === 'sword' && b.stride.made) {
    // A made body holds a sword as a person does, the blade square to the forearm across the fist:
    // hanging at the side, point down and a little forward, at rest; on the move the arm swinging
    // half as far as the free one and the blade trailing back and down past the leg; up in front on
    // guard while strafing or backing off.
    const swing = Math.cos(TAU * g.cycle);
    const ahead = Math.max(0, Math.cos(p.heading));
    const at = move * smooth((ahead - 0.5) / 0.4);
    const guard = move * (1 - smooth((ahead - 0.5) / 0.4));
    const pace = 0.6 + 0.4 * g.run;
    b.setArmOut(
      'R',
      lerp(0.14 + 0.04 * move, 0.05, guard),
      lerp(lerp(-0.1, -0.08 - 0.32 * swing * pace, at), -0.5, guard),
      0,
      -lerp(lerp(0.28, 0.45 + 0.3 * g.run, at), 1.25, guard),
    );
    // Swung round the outside (the hero's right), never across the legs. On guard, a low one: the
    // hand at the waist in front, the point up and forward toward the middle.
    const az = lerp(lerp(-0.12, -(Math.PI - 0.3), at), 0.32, guard);
    const el = lerp(lerp(-0.85, -0.62, at), 0.62, guard) + 0.02 * Math.sin(t * 2.2);
    b.aimHand('R', torsoDir(b, dir(az, el, _a)));
  } else if (w === 'sword') {
    // Sword: low and forward at rest; running ahead, carried ready - elbow bent, hand at the waist,
    // the blade up and forward, bobbing with the stride; held up in front on guard while strafing
    // or backing off.
    const swing = Math.cos(TAU * g.cycle);
    const ahead = Math.max(0, Math.cos(p.heading));
    const at = move * g.run * smooth((ahead - 0.5) / 0.4);
    const guard = move * (1 - smooth((ahead - 0.5) / 0.4));
    b.setArmOut('R', 0.2 + 0.06 * move, lerp(lerp(-0.28, -0.5 - 0.12 * swing, at), -0.75, guard), 0, -lerp(lerp(0.5, 1.25, at), 0.95, guard));
    const az = lerp(lerp(0.38, -0.3, at), 0.3, guard);
    const el = lerp(lerp(-0.45, 0.62 + 0.05 * swing, at), 0.25, guard) + 0.02 * Math.sin(t * 2.2);
    b.aimHand('R', torsoDir(b, dir(az, el, _a)));
  } else if (w === 'club') {
    // Club: carried on the shoulder.
    b.handTo('R', torsoPoint(b, -0.23, 0.35 + 0.01 * Math.sin(TAU * 2 * g.cycle) * move, 0.2, _a), torsoDir(b, _pole.set(-0.5, -0.8, 0.1)));
    b.aimHand('R', torsoDir(b, dir(-2.75, 0.55, _b)));
  } else if (w === 'staff') {
    // Staff: planted upright at the side when still, slanted forward like a lance at a run.
    b.handTo('R', torsoPoint(b, lerp(-0.36, -0.33, move), lerp(0.1, 0.2, move), lerp(0.1, 0.22, move), _a), torsoDir(b, _pole.set(-0.6, -0.3, -0.7)));
    b.aimHand('R', torsoDir(b, dir(lerp(0.04, 0.18, move), lerp(1.36, 0.6, move * g.run), _b)));
  } else if (w === 'bow') {
    // Bow: held low in the left hand, upright, the arm swinging less.
    const swing = Math.cos(TAU * (g.cycle + 0.5));
    b.setArmOut('L', 0.16, lerp(-0.25, -0.35 * swing * move - 0.1, move), 0, -0.55);
    b.frameHand('L', torsoDir(b, _a.set(0.1, -0.45, 1)), torsoDir(b, _b.set(-0.1, 1, 0.25)));
  }
  keepBladeUp(b, p.weapon, 0.06);
}

// ---------- in the air ----------

/**
 * A jump, shaped by which way it's going relative to where you face: a running leap (lead knee
 * driven up, trailing leg stretched back), a hop backwards (knees up in front, sitting back into
 * it), a leap to the side (legs swung toward it, body tipped in), or straight up (both knees drawn
 * up) - and any blend of them. Reaching down for the ground on the way down.
 */
function air(b: Body, p: PoseInput): void {
  const up = clamp01(p.rise);
  const down = clamp01(-p.rise);
  const t = p.time;
  const top = 1 - Math.abs(p.rise);
  const go = clamp01(p.speed * 1.4);
  const fwd = Math.max(0, Math.cos(p.heading)) * go;
  const bwd = Math.max(0, -Math.cos(p.heading)) * go;
  const lat = Math.sin(p.heading) * go; // + to the left
  const sideW = Math.abs(lat);
  const lead: Side = lat >= 0 ? 'L' : 'R';
  b.body.position.set(0, b.standY + 0.02, 0);
  b.body.rotation.set(0, 0, -lat * 0.22 * (1 - 0.5 * down));
  b.torso.rotation.set(0.05 + 0.14 * fwd * up + 0.12 * down * fwd - 0.06 * down - 0.22 * bwd, 0, 0);
  b.neck.rotation.set(-0.08 + 0.15 * down - 0.1 * fwd + 0.12 * bwd, 0, lat * 0.15);
  for (const s of SIDES) {
    // Straight up: both knees drawn up.
    let pitch = s === 'L' ? -1.1 : -0.75;
    let knee = s === 'L' ? 1.75 : 1.7;
    let out = 0.07;
    // Running leap: the left knee leads, the right leg trails.
    pitch = lerp(pitch, s === 'L' ? -1.25 : 0.45, fwd);
    knee = lerp(knee, s === 'L' ? 1.45 : 1.25, fwd);
    // Hopping back: both legs up in front.
    pitch = lerp(pitch, s === 'L' ? -1.25 : -1.0, bwd);
    knee = lerp(knee, s === 'L' ? 1.35 : 1.2, bwd);
    // To the side: the near leg swung out toward it, the far one trailing under.
    pitch = lerp(pitch, s === lead ? -0.9 : -0.35, sideW);
    knee = lerp(knee, s === lead ? 1.45 : 1.0, sideW);
    out = lerp(out, s === lead ? 0.55 : -0.12, sideW);
    // Coming down: reach for the ground.
    pitch = lerp(pitch, s === 'L' ? -0.45 : 0.05, down);
    knee = lerp(knee, s === 'L' ? 0.5 : 0.35, down) + (s === 'L' ? 0.25 : 0.15) * top;
    out = lerp(out, 0.08, down);
    b.setLegOut(s, pitch, out, knee, lerp(s === 'L' ? 0.45 : 0.7, s === 'L' ? 0.35 : 0.45, down));
  }
  // Arms thrown up on take-off, out for balance falling, pumping against the legs leaping,
  // reaching ahead hopping back, flung out toward the side.
  for (const s of SIDES) {
    const pump = s === 'R' ? 1 : -1; // right arm forward with the left knee
    let pitch = lerp(-2.0, -1.2 * pump - 0.3, fwd);
    pitch = lerp(pitch, -1.35, bwd);
    pitch = lerp(pitch, s === lead ? -1.6 : -1.1, sideW);
    pitch = lerp(pitch, -1.25 + 0.15 * Math.sin(t * 9 + pump), down);
    const out = lerp(lerp(0.3, 0.75, sideW), 0.95, down);
    b.setArmOut(s, out, pitch, 0, -lerp(0.45, 0.7, down));
  }
  cape(b, lerp(0.3, 1.7, down) + 0.25 * fwd + 0.05 * Math.sin(t * 14), lerp(0.1, 0.6, down), lat * 0.3);

  if (p.flipFrame >= 0) flip(b, p);
  keepOffFloor(b);
}

/** The axis a body turns over to tumble along a heading: forward flips, back flips, side flips. */
function tumbleAxis(heading: number, moving: boolean, out: THREE.Vector3): THREE.Vector3 {
  if (!moving) return out.set(1, 0, 0);
  return out.set(Math.cos(heading), 0, -Math.sin(heading));
}

/**
 * Double jump: tuck tight and turn a full somersault about the middle of the ball, tumbling the
 * way the jump goes - a front flip, a back flip, a side flip or anything between.
 */
function flip(b: Body, p: PoseInput): void {
  const kf = clamp01(p.flipFrame / JUMP.flipFrames);
  const tuck = smooth(kf / 0.18) * (1 - smooth((kf - 0.72) / 0.28));
  // Gathers, whips round through the middle, and opens out again to land.
  const angle = TAU * smooth(kf);
  const open = b.save(b.buf(0));
  b.body.position.set(0, b.standY - 0.1, -0.02);
  b.body.rotation.set(0.25, 0, 0);
  b.torso.rotation.set(0.75, 0, 0);
  b.neck.rotation.set(0.55, 0, 0);
  for (const s of SIDES) {
    b.setLegOut(s, -2.2, 0.1, 2.35, 0.6);
    b.setArmOut(s, 0.3, -1.05, -0.4, -1.55);
  }
  cape(b, 0.4, 0.2);
  tumbleAxis(p.heading, p.speed > 0.15, _axis);
  b.aimHand('R', alongAxis(_axis, _g));
  b.mix(open, b.save(b.buf(1)), tuck);
  spinAbout(b, angle, _e.set(0, b.standY - 0.05, 0.05), tumbleAxis(p.heading, p.speed > 0.15, _axis));
}

/** A held blade tucked along a tumble's axis, out to the weapon side, so the turn can't sweep it into anything. */
function alongAxis(axis: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  out.copy(axis).negate();
  if (out.x > 0.01 || (Math.abs(out.x) <= 0.01 && out.z < 0)) out.negate();
  return out;
}

/** Turns the whole body about a pivot in model space (rolls, flips, somersaults). */
function spinAbout(b: Body, angle: number, pivot: THREE.Vector3, axis: THREE.Vector3 = _axis.set(1, 0, 0)): void {
  _q.setFromAxisAngle(axis, angle);
  b.body.quaternion.premultiply(_q);
  b.body.position.sub(pivot).applyQuaternion(_q).add(pivot);
}

// ---------- swings ----------

/** Place on a swing's timeline (0 start, 1 end of startup, 2 end of active, 3 end of recovery). */
function timeline(step: AttackStep, f: number): number {
  const S = Math.max(1, step.startup);
  const A = Math.max(1, step.active);
  const R = Math.max(1, step.recovery);
  if (f <= S) return f / S;
  if (f <= S + A) return 1 + (f - S) / A;
  return Math.min(3, 2 + (f - S - A) / R);
}

/** The frame a timeline place falls on. */
function frameAt(step: AttackStep, at: number): number {
  if (at <= 1) return at * step.startup;
  if (at <= 2) return step.startup + (at - 1) * step.active;
  return step.startup + step.active + (at - 2) * step.recovery;
}

/** Speed the lunge gives you on frame f of a swing, as the rules set it (crates/engine/src/player.rs). */
export function lungeSpeed(step: AttackStep, f: number): number {
  if (f <= step.startup) return step.lunge * 0.5;
  if (f <= step.startup + step.active) return step.lunge;
  return Math.max(0, step.lunge - ((f - step.startup - step.active) * MOVE.groundDecel) / HZ);
}

/** Metres the lunge has carried the body by frame f, so planted feet can stay where they are. */
function lunged(step: AttackStep, f: number): number {
  let d = 0;
  const n = Math.floor(f);
  for (let i = 1; i <= n; i++) d += lungeSpeed(step, i) / HZ;
  return d + ((f - n) * lungeSpeed(step, n + 1)) / HZ;
}

interface Sampled {
  arm: [number, number, number];
  aim: [number, number];
  torso: [number, number, number];
  hips: number;
  drop: number;
  off: [number, number, number];
  grip: number;
}
const REST_OFF: readonly [number, number, number] = [0.15, 0.1, -0.35];
const _sampled: Sampled = { arm: [0, 0, 0], aim: [0, 0], torso: [0, 0, 0], hips: 0, drop: 0, off: [0, 0, 0], grip: 0 };

/** Every channel of a swing at a timeline place: a smooth curve through the keys. */
function sample(keys: SwingKey[], t: number, out: Sampled): Sampled {
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1].at) i++;
  const k0 = keys[i];
  const k1 = keys[i + 1];
  const kp = keys[i - 1];
  const kn = keys[i + 2];
  const h = Math.max(1e-6, k1.at - k0.at);
  const s = clamp01((t - k0.at) / h);
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  // Hermite segments with Catmull-Rom tangents: the motion carries through each key.
  const curve = (pick: (x: SwingKey) => number): number => {
    const p0 = pick(k0);
    const p1 = pick(k1);
    const m0 = kp ? (p1 - pick(kp)) / (k1.at - kp.at) : 0;
    const m1 = kn ? (pick(kn) - p0) / (kn.at - k0.at) : 0;
    return h00 * p0 + h10 * h * m0 + h01 * p1 + h11 * h * m1;
  };
  for (let j = 0; j < 3; j++) {
    out.arm[j] = curve((x) => x.arm[j]);
    out.torso[j] = curve((x) => x.torso[j]);
    out.off[j] = curve((x) => (x.off ?? REST_OFF)[j]);
  }
  out.aim[0] = curve((x) => x.aim[0]);
  out.aim[1] = curve((x) => x.aim[1]);
  out.hips = curve((x) => x.hips ?? 0);
  out.drop = curve((x) => x.drop ?? 0);
  out.grip = clamp01(curve((x) => x.grip ?? 0));
  return out;
}

type Stance = Record<Side, readonly [number, number]>;
const stanceCache = new Map<string, Stance>();

/** Where the feet are when swing `index` of a combo begins: where the swing before left them. */
function startStance(weapon: number, index: number, pose: string | undefined, reach = 1): Stance {
  if (index <= 0) return reach === 1 ? READY : { L: [READY.L[0], READY.L[1] * reach], R: [READY.R[0], READY.R[1] * reach] };
  const key = `${weapon}:${index}:${pose ?? ''}:${reach}`;
  const hit = stanceCache.get(key);
  if (hit) return hit;
  const combo = comboShape(weapon, 0);
  const prev = combo[index - 1];
  const chain = prev.startup + prev.active + 2;
  const feet = footwork(swingFor(weapon, index - 1, prev.pose), prev, startStance(weapon, index - 1, prev.pose, reach), chain, true, reach);
  const out: Stance = { L: [feet.L.x, feet.L.z], R: [feet.R.x, feet.R.z] };
  stanceCache.set(key, out);
  return out;
}

/**
 * The feet through a swing: planted where they are, stepping where the swing says. A planted
 * foot stays put on the ground while the lunge carries the body forward over it.
 */
function footwork(def: SwingDef, step: AttackStep, start: Stance, f: number, grounded: boolean, reach = 1): Record<Side, Foot> {
  const travelled = grounded ? lunged(step, f) : 0;
  for (const s of SIDES) {
    // Ground positions are measured in the frame the body had when the swing began.
    let x = start[s][0];
    let z = start[s][1];
    let lift = 0;
    let pitch = 0;
    for (const st of def.steps ?? []) {
      if (st.foot !== s) continue;
      const f0 = frameAt(step, st.lift);
      const f1 = frameAt(step, st.land);
      if (f <= f0) break;
      const tx = st.to[0];
      // Steps are measured for the box hero's legs; longer ones step out further.
      const tz = st.to[1] * reach + (grounded ? lunged(step, f1) : 0);
      if (f >= f1) {
        x = tx;
        z = tz;
        continue;
      }
      // Across a little ahead of down: the foot arrives over its spot, then sets down on it.
      const k0 = (f - f0) / Math.max(1e-6, f1 - f0);
      const q = easeInOut(Math.min(1, k0 * 1.2));
      x = lerp(x, tx, q);
      z = lerp(z, tz, q);
      lift = (st.height ?? 0.06) * reach * bump(k0);
      pitch = 0.35 * bump(q) - 0.15 * smooth((q - 0.6) / 0.4);
      break;
    }
    const ft = _feet[s];
    ft.x = x;
    ft.z = z - travelled;
    ft.lift = lift;
    ft.pitch = pitch;
  }
  // The front foot points at the target, the back one turns out.
  const leftAhead = _feet.L.z >= _feet.R.z;
  _feet.L.yaw = leftAhead ? 0.12 : 0.45;
  _feet.R.yaw = leftAhead ? -0.45 : -0.12;
  return _feet;
}

/** Where the right arm points, as a hand position IK can reach for, plus a natural elbow. */
function reachArm(b: Body, az: number, el: number, straight: number): void {
  const a = b.arm.R;
  const reach = (a.l1 + a.l2) * straight;
  const shoulder = b.rest(b.shoulder.R);
  dir(az, el, _b);
  // Raising the arm lifts the shoulder a touch; reaching across pulls it forward.
  b.shoulder.R.position.set(shoulder.x + 0.03 * clamp01(_b.x), shoulder.y + 0.04 * clamp01(_b.y), shoulder.z + 0.03 * clamp01(_b.z));
  torsoPoint(b, shoulder.x + _b.x * reach, shoulder.y + _b.y * reach, shoulder.z + _b.z * reach, _a);
  torsoDir(b, _pole.set(-0.55, -0.65, -0.45).addScaledVector(_b, -0.3));
  b.handTo('R', _a, _pole);
}

function attack(b: Body, p: PoseInput, out: PoseFeedback): void {
  const step = p.step!;
  if (weaponId(p.weapon) === 'bow') return bowShot(b, p, step, out);
  const move = p.airSwing || step.pose ? undefined : moveFor(b, p.weapon, Math.max(0, p.attackIndex));
  if (move) return clipAttack(b, p, step, move, out);
  const def = swingFor(p.weapon, Math.max(0, p.attackIndex), step.pose, p.airSwing);
  // A jump attack: begun in the air, it never stepped through a lunge.
  const jump = def !== swingFor(p.weapon, Math.max(0, p.attackIndex), step.pose);
  const f = p.attackFrame;
  const t = timeline(step, f);
  const s = sample(def.keys, t, _sampled);

  // Body: sink into the swing; spin and hop for Whirlwind.
  const spinK = def.spin ? easeOut(span(t, 1.02, 1.85)) : 0;
  const hop = def.hop ? def.hop * bump(span(t, 1.0, 2.05)) : 0;
  // Sinks and steps are measured for the box hero's legs; longer ones go further.
  const legs = (b.leg.L.l1 + b.leg.L.l2) / 0.54;
  b.body.position.set(0, b.standY - s.drop * legs + hop, 0);
  const spin = (def.spin ?? 0) * TAU * spinK;
  b.body.rotation.set(0, spin, 0);
  b.hips.rotation.set(0.04 + s.drop * 0.6, s.hips, 0);
  b.torso.rotation.set(s.torso[0], s.torso[1], s.torso[2]);
  b.neck.rotation.set(-s.torso[0] * 0.6, -s.torso[1] * 0.55, -s.torso[2] * 0.5);

  // Feet: footwork on the ground (turning with a spin), or tucked up in the air. A jump attack that
  // comes down before it's done lands square, feet under you, and finishes there.
  if (p.grounded) {
    const feet = jump
      ? footwork(def, step, startStance(p.weapon, 0, step.pose, legs), f, false, legs)
      : footwork(def, step, startStance(p.weapon, p.attackIndex, step.pose, legs), f, true, legs);
    if (spin) {
      const c = Math.cos(spin);
      const sn = Math.sin(spin);
      for (const side of SIDES) {
        const ft = feet[side];
        const x = ft.x;
        ft.x = x * c + ft.z * sn;
        ft.z = -x * sn + ft.z * c;
        ft.yaw += spin;
        ft.lift += hop * 1.1;
      }
    }
    plant(b, feet, 0.18);
  } else {
    airLegs(b, p);
  }

  // The weapon arm reaches where it points, then the wrist turns the weapon.
  reachArm(b, s.arm[0], s.arm[1], s.arm[2]);
  b.aimHand('R', torsoDir(b, dir(s.aim[0], s.aim[1], _c)));

  // The other arm: balancing, or with its hand on the grip.
  b.setArmOut('L', s.off[0], s.off[1], 0, s.off[2]);
  if (s.grip > 0.001) {
    const free = b.positionOf(b.arm.L.end, _d);
    const grip = b.toModel(b.arm.R.end, _b.set(0, def.grip ?? 0.13, 0), _b);
    _c.lerpVectors(free, grip, smooth(s.grip));
    b.handTo('L', _c, torsoDir(b, _pole.set(0.6, -0.6, -0.3)));
  }

  keepBladeUp(b, p.weapon, -0.1);
  cape(b, 0.25 + 0.45 * Math.abs(s.torso[1]) + 2.4 * spinK * (1 - spinK), 0.15 + 0.2 * span(t, 1, 2), -s.torso[1] * 0.25);
  trail(out, p.weapon, Math.max(0, p.attackIndex), def.spin ? 'spin' : null, f, step);
}

// ---------- combo hits from animation libraries' clips (moves.ts, retarget.ts) ----------

/** A made body's clip for a combo hit, if its weapon plays one. */
function moveFor(b: Body, weapon: number, index: number): Move | undefined {
  return b.stride.made ? motionOf(b.rig.def)?.moves?.get(`${weaponId(weapon)}:${index}`) : undefined;
}

/**
 * A combo hit played from a clip: posed as the clip has it (retargeted bone for bone, retarget.ts),
 * the clip's strike landing on the rules' first active frame (strikeTime). The feet it plants are
 * held where they stand on the ground (character.ts), the rules' lunge carrying the body on over them.
 */
function clipAttack(b: Body, p: PoseInput, step: AttackStep, move: Move, out: PoseFeedback): void {
  const f = p.attackFrame;
  const s = strikeTime(move.strike, step.startup, step.active, f);
  poseFromClip(b, move.clip, s);
  if (p.grounded) SIDES.forEach((side, i) => (_planted[side] = playPlanted(move.clip, i, s) ? 1 : 0));
  else airLegs(b, p);
  keepBladeUp(b, p.weapon, -0.1);
  trail(out, p.weapon, Math.max(0, p.attackIndex), null, f, step);
}

function trail(out: PoseFeedback, weapon: number, index: number, spin: 'spin' | null, f: number, step: AttackStep): void {
  const S = step.startup;
  const A = step.active;
  if (f <= S) return;
  const head = clamp01((f - S) / A);
  const fade = clamp01((f - S - A) / 7);
  if (fade >= 1) return;
  const set = spin ?? weaponId(weapon);
  out.trail = { set, index, head, tail: lerp(Math.max(0, head - 0.6), 1, fade), alpha: 1 - fade * 0.6 };
}

/**
 * Legs in the air while the arms do something else (air attacks, air casts), reaching down for the
 * ground as you fall - but no further than your feet go, so they meet the floor as you land rather
 * than through it. Only the legs move for that, so the swing above stays where it was traced.
 */
function airLegs(b: Body, p: PoseInput): void {
  const down = clamp01(-p.rise);
  b.setLegOut('L', lerp(-1.0, -0.5, down), 0.06, lerp(1.5, 0.6, down), 0.45);
  b.setLegOut('R', lerp(0.25, 0.0, down), 0.08, lerp(1.2, 0.45, down), 0.6);
  for (const s of SIDES) {
    const low = lowestOn(b, b.leg[s].end);
    if (low < 0) b.liftLeg(s, -low);
  }
}

// ---------- the bow ----------

function bowShot(b: Body, p: PoseInput, step: AttackStep, out: PoseFeedback): void {
  const f = p.attackFrame;
  const S = step.startup;
  const A = step.active;
  const R = step.recovery;
  const raise = easeOut(span(f, 0, S * 0.55));
  const pull = easeInOut(span(f, S * 0.3, S));
  const loosed = f > S;
  const after = easeOut(span(f, S, S + 3));
  const relax = easeInOut(span(f, S + A + 2, S + A + R));
  const on = raise * (1 - relax);

  // Side-on to the target: hips and shoulders turned right, the head turned back to look along
  // the arrow, feet set wide across the line.
  b.body.position.set(0, b.standY - 0.04 * on, 0);
  b.hips.rotation.set(0.04, -0.8 * on, 0);
  b.torso.rotation.set(0.03, -1.42 * on, 0.05 * on);
  b.neck.rotation.set(0.04 * on, 1.38 * on, -0.05 * on);
  const feet = _feet;
  feet.L.x = lerp(STANCE.L[0], 0.07, on);
  feet.L.z = lerp(STANCE.L[1], 0.2, on);
  feet.L.yaw = lerp(STANCE.L[2], -0.35, on);
  feet.R.x = lerp(STANCE.R[0], -0.17, on);
  feet.R.z = lerp(STANCE.R[1], -0.17, on);
  feet.R.yaw = lerp(STANCE.R[2], -1.3, on);
  for (const s of SIDES) feet[s].lift = feet[s].pitch = 0;
  plant(b, feet, 0.15);

  // Hands at rest first, to raise them from.
  b.setArmOut('L', 0.16, -0.25, 0, -0.55);
  b.setArmOut('R', 0.12, -0.1, 0, -0.3);
  const restL = b.positionOf(b.arm.L.end, _e);
  const restR = b.positionOf(b.arm.R.end, _f);
  // Bow arm out straight along the line of the shot; the bow stands upright, canted a touch. The
  // line runs at the chin and in front of the chest, not along the shoulders: the bow reaches a
  // little across and the draw hand anchors under the jaw, so the arrow never passes through the
  // body (the head reaches 0.23 in front of the neck, the chest 0.15).
  const aim = _d.set(0, 0.04, 1).normalize();
  const front = torsoDir(b, _front.set(0, 0, 1)).multiplyScalar(0.26 * on);
  const grip = b
    .positionOf(b.shoulder.L, _g)
    .addScaledVector(aim, 0.42)
    .add(_pole.set(-0.03, 0.03 + 0.06 * on, 0))
    .add(front);
  b.handTo('L', _a.lerpVectors(grip, restL, 1 - on), _pole.set(0.6, -0.5, -0.2));
  b.frameHand('L', _a.copy(aim).lerp(_b.set(0.1, -0.45, 1).normalize(), 1 - on), _c.set(-0.15, 1, 0));
  // Draw hand: to the string, back to the chin, and away on the release.
  const nock = b.toModel(b.arm.L.end, _a.set(...(b.rig.def.bow ?? HERO_BOW).nock), _a);
  const anchor = _b
    .copy(grip)
    .addScaledVector(aim, -0.66)
    .add(_pole.set(0, 0.02, 0));
  const hand = _c.lerpVectors(nock, anchor, pull);
  if (loosed)
    hand
      .copy(anchor)
      .addScaledVector(aim, -0.13 * after)
      .add(_pole.set(-0.08 * after, 0.04 * after, 0));
  hand.lerp(restR, Math.max(1 - on * smooth(f / (S * 0.35)), relax));
  b.handTo('R', hand, _pole.set(-0.35, 0.25, -1));
  b.aimHand('R', aim);

  out.arrow = !loosed;
  out.draw = loosed ? 0 : pull * on;
  cape(b, 0.12, 0.1, 0.05 * on);
}

// ---------- casting ----------

function cast(b: Body, p: PoseInput): void {
  const kc = p.castFrames > 1 ? clamp01(p.castFrame / p.castFrames) : (p.time * 0.6) % 1;
  const t = p.time;
  if (ABILITIES[p.castAbility]?.castPose === 'bothHands') {
    // Gather the hands at the chest, then lift them wide to the sky.
    const gather = easeOut(span(kc, 0, 0.3));
    const rise = easeInOut(span(kc, 0.25, 0.7));
    const pulse = 0.04 * Math.sin(t * 9) * span(kc, 0.6, 1);
    b.body.position.set(0, b.standY - 0.05 * gather * (1 - rise) + 0.02 * rise, 0);
    b.torso.rotation.set(0.16 * gather * (1 - rise) - 0.14 * rise, 0, 0);
    b.neck.rotation.set(0.22 * gather * (1 - rise) - 0.38 * rise, 0, 0);
    standWide(b, 0.15);
    for (const s of SIDES) {
      b.setArmOut(s, 0.62 + pulse, -2.55 - pulse, 0.2, -0.28);
      const sky = b.positionOf(b.arm[s].end, _e);
      const chest = torsoPoint(b, k(s) * 0.07, 0.3, 0.27, _b);
      const at = torsoPoint(b, k(s) * 0.34, 0.02, 0.06, _c)
        .lerp(chest, gather)
        .lerp(sky, rise);
      b.handTo(s, at, torsoDir(b, _pole.set(k(s) * 0.7, -0.6, -0.4)));
    }
    cape(b, 0.25 + 0.5 * rise + 0.05 * Math.sin(t * 7), 0.15 + 0.3 * rise);
    return;
  }
  // Raise the weapon high, point at the target with the other hand, channel, then bring it down.
  const raise = easeOut(span(kc, 0, 0.2));
  const channel = span(kc, 0.2, 0.8);
  const release = easeOut(span(kc, 0.8, 0.95));
  const swirl = channel > 0 && release < 1 ? 1 : 0;
  b.body.position.set(0, b.standY - 0.05 * raise - 0.08 * release, 0);
  b.hips.rotation.set(0.04, -0.15 * raise, 0);
  b.torso.rotation.set(-0.1 * raise * (1 - release) + 0.15 * release, -0.15 * raise * (1 - release), 0);
  b.neck.rotation.set(0.08 * raise - 0.2 * release, 0.12 * raise, 0);
  standWide(b, 0.18);
  const az = -0.15 + 0.22 * Math.sin(t * 8.5) * swirl;
  const el = 1.3 + 0.1 * Math.cos(t * 8.5) * swirl;
  reachArm(b, lerp(lerp(0.15, az, raise), 0.1, release), lerp(lerp(-1.0, el, raise), -0.05, release), lerp(0.86, 0.95, raise));
  b.aimHand('R', torsoDir(b, dir(lerp(0.1, 0.05, release), lerp(lerp(-0.4, 1.45, raise), -0.05, release), _c)));
  b.setArmOut('L', lerp(0.15, 0.1, raise), lerp(0.1, -1.45, raise * (1 - release)) + 0.3 * release, 0, lerp(-0.35, -0.1, raise));
  cape(b, 0.2 + 0.7 * raise * (1 - release) + 0.18 * Math.sin(t * 6) * swirl, 0.15 + 0.4 * channel);
}

/** Feet set apart, planted. */
function standWide(b: Body, wide: number): void {
  _feet.L.x = wide;
  _feet.L.z = 0.11;
  _feet.L.yaw = 0.2;
  _feet.R.x = -wide;
  _feet.R.z = -0.1;
  _feet.R.yaw = -0.45;
  for (const s of SIDES) _feet[s].lift = _feet[s].pitch = 0;
  plant(b, _feet, 0.15);
}

// ---------- movement skills ----------

function action(b: Body, p: PoseInput): void {
  const def = MOVEMENT_SKILLS[p.actionId]?.action;
  if (!def) return;
  const total = def.startup + def.active + def.recovery;
  if (def.pose === 'slide') return slide(b, p, total);
  if (def.pose === 'block') return block(b, p, def.startup, def.active, def.recovery);
  if (def.pose === 'backstep') return backstep(b, p, def.startup, def.active, def.recovery);
  roll(b, p, total);
}

/** Dodge roll: dive, tuck into a ball and turn over once, come up into a crouch and stand. */
function roll(b: Body, p: PoseInput, total: number): void {
  const f = p.actionFrame * (24 / Math.max(1, total));
  const tuck = smooth(span(f, 0.3, 4.2)) * (1 - smooth(span(f, 15.5, 20.5)));
  const turn = TAU * easeInOut(span(f, 1.2, 17.5));
  const crouch = bump(span(f, 0, 6)) * 0.4 + bump(span(f, 15, 24)) * 0.7;
  locomotion(b, { ...p, run: 0, crouch: Math.min(1, crouch) });
  holdWeapon(b, p, STILL);
  const stand = b.save(b.buf(0));
  b.reset();
  b.body.position.set(0, 0.46, -0.05);
  b.body.rotation.set(0.2, 0, 0);
  b.torso.rotation.set(1.05, 0, 0);
  b.neck.rotation.set(0.7, 0, 0);
  for (const s of SIDES) {
    b.setLegOut(s, -2.3, 0.1, 2.4, 0.65);
    b.setArmOut(s, 0.28, -1.0, -0.4, -1.65);
  }
  cape(b, 0.25, 0.3);
  tumbleAxis(p.heading, true, _axis);
  b.aimHand('R', alongAxis(_axis, _g));
  b.mix(stand, b.save(b.buf(1)), tuck);
  // Rolls the way the dodge goes: forward, back, to either side, or between, over the ground.
  spinAbout(b, turn, _e.set(0, 0.46, 0), tumbleAxis(p.heading, true, _axis));
  keepOffFloor(b);
  for (const s of SIDES) _planted[s] *= 1 - smooth(tuck * 3);
}

/** Backstep: a quick hop back, leaning in against it, landing soft. */
function backstep(b: Body, p: PoseInput, S: number, A: number, R: number): void {
  const f = p.actionFrame;
  const push = bump(span(f, 0, S + 2));
  const hop = bump(span(f, S, S + A));
  const land = bump(span(f, S + A - 1, S + A + 6));
  const settle = 1 - smooth(span(f, S + A + 4, S + A + R));
  b.body.position.set(0, b.standY - 0.06 * push - 0.12 * land + 0.08 * hop, 0);
  b.torso.rotation.set(0.12 + 0.2 * hop * settle + 0.1 * land, 0, 0);
  b.neck.rotation.set(-0.15 * hop, 0, 0);
  b.hips.rotation.set(0.1 * hop, 0, 0);
  _feet.L.x = 0.15;
  _feet.L.z = 0.08 + 0.12 * hop;
  _feet.L.lift = 0.1 * hop;
  _feet.L.pitch = 0.5 * hop;
  _feet.L.yaw = 0.2;
  _feet.R.x = -0.16;
  _feet.R.z = -0.08 - 0.12 * hop;
  _feet.R.lift = 0.14 * hop;
  _feet.R.pitch = 0.3 * hop;
  _feet.R.yaw = -0.35;
  plant(b, _feet, 0.15, { L: 1 - hop, R: 1 - hop });
  for (const s of SIDES) b.setArmOut(s, 0.3 + 0.15 * hop, -0.9 * hop * settle - 0.2, -0.2, -0.9 - 0.3 * hop);
  holdWeapon(b, p, STILL);
  cape(b, 0.1 - 0.05 * hop + 0.4 * land, 0.1);
}

/** Guard: feet wide, knees bent, weapon across the body with the other hand braced behind it. */
function block(b: Body, p: PoseInput, S: number, A: number, R: number): void {
  const f = p.actionFrame;
  const up = f <= S ? easeOut(f / Math.max(1, S)) : f <= S + A ? 1 : 1 - easeInOut((f - S - A) / Math.max(1, R));
  const tense = 0.006 * Math.sin(p.time * 23) * up;
  locomotion(b, { ...p, run: 0 });
  holdWeapon(b, p, STILL);
  const rest = b.save(b.buf(0));
  b.reset();
  b.body.position.set(0, b.standY - 0.13, 0);
  b.hips.rotation.set(0.12, -0.25, 0);
  b.torso.rotation.set(0.14 + tense, -0.22, 0);
  b.neck.rotation.set(0.05, 0.22, 0);
  _feet.L.x = 0.17;
  _feet.L.z = 0.14;
  _feet.L.yaw = 0.12;
  _feet.R.x = -0.18;
  _feet.R.z = -0.15;
  _feet.R.yaw = -0.6;
  for (const s of SIDES) _feet[s].lift = _feet[s].pitch = 0;
  plant(b, _feet, 0.2);
  const w = weaponId(p.weapon);
  if (w === 'bow') {
    // Bow up in front like a shield.
    b.handTo('L', torsoPoint(b, 0.08, 0.5, 0.36, _a), torsoDir(b, _pole.set(0.7, -0.6, 0)));
    b.frameHand('L', torsoDir(b, _a.set(0, 0.1, 1)), torsoDir(b, _b.set(0.2, 1, 0)));
    b.setArmOut('R', 0.2, -1.2, 0, -1.7);
  } else {
    // Weapon held across, high; the left palm on the flat of it.
    const staff = w === 'staff';
    b.handTo('R', torsoPoint(b, -0.2, staff ? 0.38 : 0.44, 0.3, _a), torsoDir(b, _pole.set(-0.7, -0.6, -0.1)));
    b.aimHand('R', torsoDir(b, dir(staff ? 1.5 : 1.15, staff ? 0.12 : 0.6, _b)));
    const brace = b.toModel(b.arm.R.end, _c.set(0, staff ? -0.42 : -0.38, 0.04), _c);
    b.handTo('L', brace, torsoDir(b, _pole.set(0.7, -0.6, -0.2)));
  }
  cape(b, 0.18, 0.12);
  b.mix(rest, b.save(b.buf(1)), up);
  b.squash.scale.set(1 + 0.015 * up, 1 - 0.02 * up, 1 + 0.015 * up);
}

/** Slide: drop low, lead leg out along the ground, the other folded under, a hand trailing. */
function slide(b: Body, p: PoseInput, total: number): void {
  const f = p.actionFrame;
  const into = easeOut(span(f, 0, 4));
  const outOf = smooth(span(f, total - 6, total));
  const sl = into * (1 - outOf);
  const t = p.time;
  locomotion(b, { ...p, run: 0, crouch: 0.4 * outOf });
  holdWeapon(b, p, STILL);
  const rest = b.save(b.buf(0));
  b.reset();
  b.body.position.set(0, 0.36, 0);
  b.body.rotation.set(-0.72, 0, -0.08);
  b.torso.rotation.set(0.22 + 0.02 * Math.sin(t * 41), 0.1, -0.06);
  b.neck.rotation.set(0.5, -0.1, 0);
  b.setLegOut('L', -1.0, 0.06, 0.15, -0.3);
  b.setLegOut('R', 0.3, 0.12, 2.1, 0.5);
  b.setArmOut('L', 0.55, 0.65, 0, -0.25);
  b.setArmOut('R', 0.45, -1.2, 0, -0.75);
  b.aimHand('R', torsoDir(b, dir(0.3, 0.55, _a)));
  cape(b, 1.5 + 0.05 * Math.sin(t * 30), 0.3);
  b.mix(rest, b.save(b.buf(1)), sl);
  for (const s of SIDES) _planted[s] *= 1 - smooth(sl * 3);
  keepOffFloor(b);
  keepBladeUp(b, p.weapon, 0.04);
}

// ---------- hurt ----------

// Arms in a flinch (out, pitch, twist, elbow, as setArmOut takes them): up to guard against a blow
// from the front, flung back by one from behind, and from the side the arm nearest the blow tucks
// in while the other flies out.
const FLINCH_FRONT = [0.6, -1.45, 0.1, -0.7] as const;
const FLINCH_BEHIND = [0.75, 0.65, 0.25, -0.3] as const;
const FLINCH_NEAR = [0.25, -1.15, 0.3, -1.7] as const;
const FLINCH_FAR = [1.3, -0.35, 0, -0.25] as const;

/**
 * A hit: the blow throws the upper body the way it shoves you (the rules knock you away from whoever
 * struck), back from the front, forward from behind, over and twisting away from a blow to the side;
 * then the body gathers itself again. The legs are whatever the shove leaves them doing: stumbling
 * the way you slide.
 */
function hurt(b: Body, p: PoseInput): void {
  const f = p.stunFrame;
  const a = f < 3 ? easeOut(f / 3) : Math.exp(-(f - 3) / 4.2) * (1 + 0.12 * Math.sin((f - 3) * 0.9));
  const h = p.hit;
  const fore = Math.max(0, Math.cos(h)); // shoved forward: hit from behind
  const aft = Math.max(0, -Math.cos(h)); // shoved back: hit from the front
  const side = Math.sin(h); // + shoved to the left: hit from the right
  const pose = b.save(b.buf(2));
  const held = REACH[weaponId(p.weapon)] && p.stow < 0.5 ? bladeDir(b, _held) : null;
  b.torso.rotation.x += 0.45 * fore - 0.5 * aft;
  b.torso.rotation.y += 0.35 * side;
  b.torso.rotation.z -= 0.4 * side;
  b.neck.rotation.x -= 0.35 * fore + 0.4 * aft;
  b.neck.rotation.z += 0.25 * side;
  b.body.position.x += 0.05 * Math.sin(h);
  b.body.position.z += 0.05 * Math.cos(h);
  const across = Math.abs(side);
  const total = aft + fore + across;
  for (const s of SIDES) {
    const flank = k(s) * side > 0 ? FLINCH_FAR : FLINCH_NEAR;
    const arm = (i: number) => (aft * FLINCH_FRONT[i] + fore * FLINCH_BEHIND[i] + across * flank[i]) / total;
    b.setArmOut(s, arm(0), arm(1) + 0.2 * k(s) * aft, arm(2), arm(3));
  }
  // The weapon goes with the arm but out of harm's way (and out of the ground): forward when
  // guarding, trailing back and up when flung back, out and up when the arm flies out.
  if (held) {
    const guard = _b.set(0.15, 0.1, 1).normalize();
    _aim.copy(guard).multiplyScalar(aft);
    _aim.addScaledVector(_e.set(-0.4, 0.45, -1).normalize(), fore);
    _aim.addScaledVector(k('R') * side > 0 ? _e.set(-1, 0.45, 0.25).normalize() : guard, across);
    torsoDir(b, _aim.normalize());
  }
  // The cape flies up off the back, and swings away from a blow to the side.
  cape(b, 0.2 + 0.6 * a * (0.5 + 0.5 * fore), 0.3 * a, -0.4 * side * a);
  b.mix(pose, b.save(b.buf(3)), clamp01(a));
  // Easing back, the blade swings the short way round between the two, not through the floor.
  if (held) b.aimHand('R', slerpDir(held, _aim, clamp01(a), _aim));
  b.squash.scale.set(1 + 0.04 * a, 1 - 0.05 * a, 1 + 0.04 * a);
}

const _held = new THREE.Vector3();
const _front = new THREE.Vector3();
const _aim = new THREE.Vector3();

/** Which way the weapon in a hand (the right, unless told) points, in model space. */
function bladeDir(b: Body, out: THREE.Vector3, s: Side = 'R'): THREE.Vector3 {
  const hand = b.positionOf(b.arm[s].end, _b);
  return b
    .toModel(b.arm[s].end, out.set(0, -1, 0), out)
    .sub(hand)
    .normalize();
}

/** Part way round the great circle from one direction to another (they're unit vectors). */
function slerpDir(from: THREE.Vector3, to: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  const dot = clamp(from.dot(to), -1, 1);
  const theta = Math.acos(dot);
  if (theta < 1e-3) return out.copy(to);
  const s = Math.sin(theta);
  if (s < 1e-3) return out.copy(t < 0.5 ? from : to); // opposite ways: no circle to prefer
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return out.set(from.x * wa + to.x * wb, from.y * wa + to.y * wb, from.z * wa + to.z * wb).normalize();
}

/** Knocked down: thrown off the feet onto the back, a bounce, then lying still. */
function down(b: Body, p: PoseInput): void {
  const f = p.downFrame;
  const t = p.time;
  const fall = easeIn(span(f, 0, 10));
  const bounce = f > 10 ? Math.exp(-(f - 10) / 3.5) * Math.abs(Math.sin((f - 10) * 0.5)) : 0;
  const thrown = bump(span(f, 0, 12));
  locomotion(b, { ...p, run: 0 });
  const stand = b.save(b.buf(0));
  b.reset();
  b.body.position.set(0, lerp(b.standY + 0.1, 0.15, fall) + 0.05 * bounce, -0.08 * fall);
  b.body.rotation.set(lerp(-0.5, -1.52, fall) + 0.08 * bounce, 0, 0.05 * fall);
  b.torso.rotation.set(-0.15 * thrown + 0.015 * Math.sin(t * 1.7) * span(f, 20, 40), 0.05, 0);
  b.neck.rotation.set(lerp(-0.3, 0.3, fall), lerp(0, 0.35, fall), lerp(0, 0.25, fall));
  b.setArmOut('L', lerp(0.6, 1.25, fall), lerp(-2.1, -0.5, fall), 0.3, lerp(-0.4, -0.5, fall));
  b.setArmOut('R', lerp(0.5, 1.0, fall), lerp(-1.9, -0.3, fall), 0.2, lerp(-0.5, -0.85, fall));
  b.setLegOut('L', lerp(-0.6, -0.55, fall), 0.12, lerp(0.7, 0.95, fall), 0.35);
  b.setLegOut('R', lerp(-0.2, -0.1, fall), 0.2, lerp(0.4, 0.2, fall), 0.5);
  // The weapon drops flat to the ground beside the hand.
  b.aimHand('R', _a.set(-1, -0.15 * fall, lerp(0.6, 0.25, fall)).normalize());
  cape(b, lerp(1.2, 1.6, fall), 0.2);
  b.mix(stand, b.save(b.buf(1)), smooth(span(f, 0, 3)));
  keepOffFloor(b);
}

// ---------- travel ----------

/**
 * How fast the stroke clock (PoseInput.phase, travelling) turns, radians a second: swimming, one
 * turn is a stroke of each arm; riding, the rise and fall of two of the mount's strides; rowing, one
 * stroke of the oars. The close-up hero (src/render/character.ts) winds the clock on by this each
 * frame, so a change of pace speeds the stroke up or slows it down instead of jumping it along.
 */
export function strokeRate(p: PoseInput): number {
  const e = clamp01(p.effort);
  if (p.travel === 'swim') return 2.6 + 2.4 * e;
  if (p.travel === 'ride') return 6 + 6 * e;
  if (p.travel === 'row') return TAU * (0.35 + 0.6 * e);
  return 0;
}

/**
 * Swimming, gliding, riding or seated in a vehicle. The weapon isn't drawn while travelling (the
 * close-up hero sees to that), so the hands are free for the stroke, the bar, the reins, the wheel
 * or the oars.
 */
function travel(b: Body, p: PoseInput): void {
  const t = p.time;
  if (p.travel === 'swim') return swim(b, p);
  if (p.travel === 'glide') return glide(b, p);
  if (p.travel === 'ride') return ride(b, p);
  if (p.travel === 'helm') return helmsman(b, p);
  // Seated: well forward on the seat (the origin), so the thighs reach out over its front edge.
  b.body.position.set(0, 0.22, 0.08);
  b.hips.rotation.set(-0.12, 0, 0);
  if (p.travel === 'row') return row(b, p);
  if (p.travel === 'drive') {
    // Both hands on the wheel, turning it, the shoulders turning a little with it.
    b.torso.rotation.set(0.12, -p.bank * 0.14, -p.bank * 0.06);
    b.neck.rotation.set(-0.1, p.bank * 0.15, 0);
    seatedLegs(b, p, 0.04);
    const turn = clamp(p.bank, -1, 1) * 1.2;
    for (const s of SIDES) {
      if (p.grips) {
        // The wheel's own rim, as it turns (vehicles.ts steeringWheel).
        const i = s === 'L' ? 0 : 3;
        _a.set(p.grips[i], p.grips[i + 1], p.grips[i + 2]);
      } else {
        // No vehicle to ask: a wheel ~0.3 up and 0.41 ahead of the seat, tipped back.
        const a = Math.PI / 2 - k(s) * 1.05 - turn;
        _a.set(Math.cos(a) * 0.17, Math.sin(a) * 0.17, 0)
          .applyAxisAngle(_b.set(1, 0, 0), -0.85)
          .add(_c.set(0, 0.3, 0.41));
      }
      b.handTo(s, _a, torsoDir(b, _pole.set(k(s) * 0.8, -0.7, -0.3)));
    }
    cape(b, 0.1, 0.05);
    return;
  }
  // A passenger: sitting back, hands on the knees.
  const sway = 0.03 * Math.sin(t * 2.1) * (0.3 + p.effort);
  b.torso.rotation.set(-0.04 + sway, 0, sway * 0.5);
  b.neck.rotation.set(0.05, 0.25 * noise(t * 0.2), 0);
  seatedLegs(b, p, 0.02);
  for (const s of SIDES) {
    const knee = b.positionOf(b.leg[s].mid, _a).add(_b.set(0, 0.09, 0.02));
    b.handTo(s, knee, torsoDir(b, _pole.set(k(s) * 0.7, -0.3, -0.6)));
  }
  cape(b, 0.08, 0.05);
}

function swim(b: Body, p: PoseInput): void {
  const e = clamp01(p.effort);
  const t = p.time;
  // Treading water: upright, legs beating, hands sculling.
  b.body.position.set(0, 0.62 + 0.03 * Math.sin(t * 2.3), 0);
  b.body.rotation.set(0.12, 0, 0);
  b.torso.rotation.set(0.06, 0, 0);
  b.neck.rotation.set(-0.12, 0.2 * noise(t * 0.3), 0);
  const scull = Math.sin(t * 4.2);
  for (const s of SIDES) {
    b.setArmOut(s, 0.7 + 0.3 * scull, -1.05, -0.35 * scull, -0.85);
    const ph = t * 4.6 + (s === 'L' ? 0 : Math.PI);
    b.setLegOut(s, -0.85 + 0.25 * Math.sin(ph), 0.3, 1.35 + 0.35 * Math.cos(ph), 0.35, 0.3 * Math.sin(ph));
  }
  cape(b, 1.2, 0.2);
  const tread = b.save(b.buf(0));
  b.reset();
  // Front crawl: flat on the water, rolling with each stroke, turning the face up to breathe. The
  // stroke clock turns once for a stroke of each arm (strokeRate).
  const kk = p.phase;
  b.body.position.set(0, 1.02, 0);
  b.body.rotation.set(1.36, 0.36 * Math.sin(kk), 0);
  const breathe = Math.pow(Math.max(0, Math.sin(kk * 0.5)), 4);
  b.neck.rotation.set(-0.45, -1.0 * breathe, 0);
  for (const s of SIDES) {
    const u = ((((kk + (s === 'L' ? 0 : Math.PI)) / TAU) % 1) + 1) % 1;
    if (u < 0.55) {
      // The pull, under the water: reach far forward, then sweep back to the hip, elbow high.
      const q = u / 0.55;
      b.setArmOut(s, 0.12, lerp(-3.0, -0.25, easeInOut(q)), 0, -0.25 - 1.0 * bump(q));
    } else {
      // The recovery, over it: elbow up and out, the hand swinging forward close to the body.
      const q = (u - 0.55) / 0.45;
      b.setArmOut(s, 0.12 + 0.65 * bump(q), lerp(-0.25, -3.0, smooth(q)), 0.7 * bump(q), -0.25 - 0.95 * bump(q));
    }
    const ph = kk * 3 + (s === 'L' ? 0 : Math.PI);
    b.setLegOut(s, 0.05 + 0.22 * Math.sin(ph), 0.04, 0.25 + 0.3 * Math.max(0, -Math.sin(ph)), 0.9);
  }
  cape(b, 1.4 + 0.05 * Math.sin(kk * 2), 0.05);
  b.mix(tread, b.save(b.buf(1)), smooth((e - 0.05) / 0.45));
}

/** Hanging from the control bar: hands on its grips wherever the wing tilts it. */
function glide(b: Body, p: PoseInput): void {
  const t = p.time;
  // The wing's own tilt, as src/render/open/life.ts animates it.
  const bank = clamp(p.bank * 0.6, -0.9, 0.9);
  const pitch = clamp((p.rise * JUMP.velocity) / 12, -0.35, 0.3);
  // Hanging just behind the bar, which is out in front of the chin (gliders.ts), arms reaching to it,
  // and swinging with it as the wing tilts: the pilot hangs from the wing.
  const bar = gliderGrip(0, bank, pitch, _b);
  const rest = gliderGrip(0, 0, 0, _c);
  b.body.position.set(p.bank * 0.07 + (bar.x - rest.x) * 0.85, 1.4 + (bar.y - rest.y) * 0.85, bar.z - 0.47);
  b.body.rotation.set(0.42, 0, -bank * 0.45);
  b.torso.rotation.set(0.05, 0, 0);
  b.neck.rotation.set(-0.42, 0, bank * 0.2);
  for (const s of SIDES) {
    const ph = t * 3.1 + (s === 'L' ? 0 : 1);
    b.setLegOut(s, 0.22 + 0.05 * Math.sin(ph), 0.03, 0.35 + 0.08 * Math.sin(ph + 0.6), 0.65);
    b.handTo(s, gliderGrip(k(s), bank, pitch, _a), torsoDir(b, _pole.set(k(s) * 0.9, -0.2, -0.5)));
  }
  cape(b, 1.55 + 0.05 * Math.sin(t * 17), 0.3 + 0.08 * Math.sin(t * 13));
}

/** Astride: legs round the barrel, feet in the stirrups, reins in hand, rising to the trot. */
function ride(b: Body, p: PoseInput): void {
  const e = clamp01(p.effort);
  // Rising and sitting twice a turn of the stroke clock (strokeRate).
  const stride = p.phase;
  const post = Math.abs(Math.sin(stride)) * 0.035 * e;
  // Down in the saddle, the hips' joints just above the seat, rising a little to the trot.
  b.body.position.set(0, 0.22 + post, -0.03);
  b.body.rotation.set(0, 0, -p.bank * 0.12);
  b.hips.rotation.set(-0.12, 0, 0);
  b.torso.rotation.set(0.1 + 0.22 * e + 0.03 * Math.sin(stride * 2) * e, 0, p.bank * 0.05);
  b.neck.rotation.set(-0.1 - 0.2 * e, 0, 0);
  // Legs round the barrel: the thighs out over its top, the knees out past its sides and the shins
  // back in against them, the balls of the feet on the stirrup irons (the mount's own, as it moves,
  // when it gave them; mounts.ts saddle()), heels down. The irons hang short, so the knees bend.
  for (const s of SIDES) {
    const i = s === 'L' ? 0 : 3;
    const ankle =
      p.footrest && p.footrest.length >= 6
        ? _f.set(p.footrest[i], p.footrest[i + 1] + b.ankleHeight, p.footrest[i + 2] - 0.08)
        : _f.set(k(s) * 0.31, -0.34, -0.02);
    b.footTo(s, ankle, -0.25, k(s) * 0.12, 1.25);
  }
  for (const s of SIDES) {
    const pump = 0.03 * Math.sin(stride * 2) * e;
    b.handTo(s, _a.set(k(s) * 0.11, 0.5 + pump, 0.42 + pump), torsoDir(b, _pole.set(k(s) * 0.7, -0.7, -0.3)));
  }
  cape(b, 0.2 + 0.85 * e + 0.08 * Math.sin(stride * 2) * e, 0.1 + 0.3 * e);
}

/**
 * Sitting: thighs out along the seat and over its front edge, knees bent, the shins down to where
 * the vehicle has its footrest if the feet reach it with the knees still bent (`reach`, metres from
 * the hip; a rower braces with the legs nearly straight), otherwise hanging just past the edge.
 */
function seatedLegs(b: Body, p: PoseInput, spread: number, reach = 0.5): void {
  for (const s of SIDES) {
    const hip = b.positionOf(b.leg[s].root, _e);
    const ankle = _f.set(hip.x + k(s) * spread, hip.y - 0.31, hip.z + 0.33);
    if (p.footrest) {
      const rest = _g.set(p.footrest[0] + k(s) * (0.11 + spread), p.footrest[1] + b.ankleHeight, p.footrest[2]);
      const far = hip.distanceTo(rest);
      if (far <= reach) ankle.copy(rest);
      // A little out of reach: lean the feet toward it rather than leave them hanging short.
      else if (far <= reach + 0.12) ankle.lerp(rest, 1 - (far - reach) / 0.12);
    }
    b.footTo(s, ankle, -0.2, k(s) * 0.12, 0.08);
  }
}

/** Where a hand is to go, seated: the vehicle's grip for it (p.grips) if it gave one, else `fallback`. */
function gripFor(p: PoseInput, s: Side, fallback: THREE.Vector3): THREE.Vector3 {
  if (!p.grips) return fallback;
  const i = s === 'L' ? 0 : 3;
  return fallback.set(p.grips[i], p.grips[i + 1], p.grips[i + 2]);
}

/**
 * Rowing: the hands on the oars' handles wherever the boat's stroke has them, the body swinging
 * with them - leaning in to the catch, back at the finish - and the legs braced against the floor.
 */
function row(b: Body, p: PoseInput): void {
  const e = clamp01(p.effort);
  // How far forward the handles are: from the boat's own oars when it gave them, otherwise a stroke
  // on the stroke clock (strokeRate), as vehicles.ts oars() pulls them.
  const ph = (((p.phase / TAU) % 1) + 1) % 1;
  const drive = ph < 0.55 ? easeInOut(ph / 0.55) : 1 - smooth((ph - 0.55) / 0.45);
  // Leaning in as far as the further handle needs: turning, the inside oar takes a shorter stroke,
  // and leaning only as far as the two handles' middle would leave the outside hand short of its own.
  const reachOut = p.grips ? clamp01((Math.max(p.grips[2], p.grips[5]) - 0.22) / 0.42) : 1 - drive * e;
  b.torso.rotation.set(lerp(-0.2, 0.42, reachOut), 0, 0);
  b.neck.rotation.set(lerp(0.12, -0.3, reachOut), 0, 0);
  seatedLegs(b, p, 0.06, 0.53);
  for (const s of SIDES) {
    const z = lerp(0.48, 0.08, drive * e) + 0.05;
    const y = 0.38 + 0.05 * Math.sin(TAU * ph) * e;
    b.handTo(s, gripFor(p, s, _a.set(k(s) * 0.12, y, z)), torsoDir(b, _pole.set(k(s) * 0.6, -0.5, -0.7)));
  }
  cape(b, 0.12 + 0.1 * (1 - reachOut), 0.05);
}

/** At the ship's wheel: sitting to it, both hands on the rim, swaying with the swell. */
function helmsman(b: Body, p: PoseInput): void {
  const t = p.time;
  b.body.position.set(0, 0.22, 0.1);
  b.hips.rotation.set(-0.1, 0, 0);
  b.torso.rotation.set(0.36 + 0.03 * Math.sin(t * 1.3), clamp(p.bank, -1, 1) * 0.14, 0.03 * Math.sin(t * 0.9));
  b.neck.rotation.set(-0.3, 0.1 * noise(t * 0.25), 0);
  seatedLegs(b, p, 0.05);
  // A ship's wheel 0.42 up and 0.55 ahead of the seat, radius 0.32 (vehicles.ts helm()): its own
  // rim if the boat gave it, else where it would be. Steering left turns its top left.
  const turn = clamp(p.bank, -1, 1) * 1.1;
  for (const s of SIDES) {
    const a = Math.PI / 2 - k(s) * 0.9 - turn;
    const at = gripFor(p, s, _a.set(Math.cos(a) * 0.3, 0.42 + Math.sin(a) * 0.3, 0.5));
    b.handTo(s, at, torsoDir(b, _pole.set(k(s) * 0.8, -0.6, -0.3)));
  }
  cape(b, 0.15, 0.05);
}

// ---------- carrying ----------

/**
 * A trade pack's straps in both hands, leaning into the weight. The weapon isn't drawn with a pack
 * on but for a strike (the close-up hero sees to that), so there's nothing else to hold.
 */
function carry(b: Body): void {
  for (const s of SIDES) {
    b.handTo(s, torsoPoint(b, k(s) * 0.12, 0.34, 0.18, _a), torsoDir(b, _pole.set(k(s) * 0.8, -0.6, -0.1)));
  }
  b.neck.rotation.x -= 0.12;
}

// ---------- the whole pose ----------

/** Eyes: a blink every few seconds. */
function blink(b: Body, t: number): void {
  const period = 3.7;
  const local = (t + 0.4 * Math.sin(Math.floor(t / period) * 12.9898)) % period;
  b.eyes.scale.y = local < 0.13 ? lerp(1, 0.12, bump(local / 0.13)) : 1;
}

export function poseHumanoid(rig: DetailRig, p: PoseInput): PoseFeedback {
  const b = Body.of(rig);
  b.reset();
  _planted.L = _planted.R = 0;
  const out: PoseFeedback = { arrow: false, draw: 0, trail: null, plant: [0, 0] };

  if (p.travel) {
    travel(b, p);
  } else if (p.down) {
    down(b, p);
  } else {
    if (p.actionId >= 0) {
      action(b, p);
    } else if (p.attackIndex >= 0 && p.step) {
      attack(b, p, out);
    } else if (p.castAbility >= 0) {
      cast(b, p);
      if (!p.grounded) airLegs(b, p);
    } else if (!p.grounded) {
      // Knocked off your feet, you don't leap: arms out for balance and legs reaching for the
      // ground, as when falling, whichever way the knock is taking you.
      air(b, p.stunned ? { ...p, rise: Math.min(p.rise, -0.5) } : p);
      if (p.carry) carry(b);
      // A made body carries its weapon through a leap as it does running, not held out ahead.
      else if (b.stride.made && !p.stunned) holdWeapon(b, p, LEAPING);
    } else {
      // Landing: the knees take it, deeper the harder you came down.
      let sink = 0;
      if (p.landFrame < 14) {
        const lf = p.landFrame;
        sink = (0.05 + 0.17 * p.landImpact) * (lf < 2.5 ? easeOut(lf / 2.5) : 1 - easeInOut((lf - 2.5) / 11.5));
      }
      const g = locomotion(b, p, sink);
      if (p.carry) carry(b);
      else holdWeapon(b, p, g);
    }
    if (p.stunned) hurt(b, p);

    // A touch of stretch leaving the ground and squash meeting it (the box hero's; a made body
    // is a person, and doesn't squash).
    if (b.stride.made) {
      // no squash
    } else if (p.grounded && p.landFrame < 8 && p.actionId < 0) {
      const s = (1 - p.landFrame / 8) * (0.3 + 0.7 * p.landImpact);
      b.squash.scale.multiply(_a.set(1 + 0.05 * s, 1 - 0.07 * s, 1 + 0.05 * s));
    } else if (!p.grounded && p.takeoffFrame < 6 && p.actionId < 0) {
      const s = 1 - p.takeoffFrame / 6;
      b.squash.scale.multiply(_a.set(1 - 0.04 * s, 1 + 0.07 * s, 1 - 0.04 * s));
    }
  }
  blink(b, p.time);
  // Seated, swimming, flying, tumbling or flat on your back, nothing is planted.
  const grounded = !p.travel && !p.down && (p.grounded || p.actionId >= 0);
  out.plant = grounded ? [_planted.L, _planted.R] : [0, 0];
  return out;
}
