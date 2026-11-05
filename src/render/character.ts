import * as THREE from 'three';
import type { PlayerState } from '../sim/types';
import { angleDiff } from '../sim/math';
import { ABILITIES, COMBAT, comboShape, JUMP, MOVE, MOVEMENT_SKILLS, NO_ABILITY, STEP } from '../tuning';
import { DetailRig } from './detail/rig';
import { Body, SIDES, type Side } from './detail/body';
import { Inertia } from './detail/blend';
import { directional, dutyFactor, strideLength } from './detail/gait';
import { HERO_BOW, HERO_RIG, HERO_TEAM_COLOURS, HERO_TRAIL_EDGES, HERO_WEAPONS } from '../content/creatures/hero';
import { SlashArc } from './vfx';
import { poseHumanoid, settle, strokeRate } from './detail/humanoid';
import { swingFor } from './detail/swings';
import { pose, type PoseFeedback, type PoseInput } from '../content/pose';
import type { Holds } from './models/vehicles';
import { stowedFor, stowedTurn } from './detail/stow';

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Which way a horizontal direction goes relative to a facing: 0 ahead, + to the left. */
function headingOf(x: number, z: number, facing: number): number {
  const ahead = x * Math.sin(facing) + z * Math.cos(facing);
  const left = x * Math.cos(facing) - z * Math.sin(facing);
  return Math.atan2(left, ahead);
}

// Turning the rules' idea of a character into the neutral input the poses take. This is the
// only place PlayerState and the poses meet, which is what lets the clip baker drive the same
// motion from a time value instead. `alpha` is how far the drawn moment is from the last sim step
// to the newest: frame counters are whole steps, so they are drawn part way too, and the
// animation is as smooth as the motion on a fast screen.
export function inputFromPlayer(p: PlayerState, frame: number, seat = '', alpha = 1): PoseInput {
  const hs = Math.hypot(p.vel.x, p.vel.z);
  const combo = comboShape(p.weapon, p.comboVariants);
  const attacking = p.mode === 'attack';
  const acting = p.mode === 'action';
  const casting = p.mode === 'cast' && p.castAbility !== NO_ABILITY;
  const idx = attacking ? Math.min(p.attackIndex, combo.length - 1) : -1;
  const back = 1 - alpha;
  const sub = (n: number) => Math.max(0, n - back);
  return pose({
    run: p.mode === 'normal' && p.grounded ? hs / MOVE.runSpeed : 0,
    speed: hs / MOVE.runSpeed,
    heading: acting ? headingOf(p.actionDirX, p.actionDirZ, p.facing) : hs > 0.05 ? headingOf(p.vel.x, p.vel.z, p.facing) : 0,
    crouch: clamp(p.crouchFrame / MOVE.crouchEnterFrames, 0, 1),
    time: (frame - back) / 60,
    grounded: p.grounded,
    rise: clamp(p.vel.y / JUMP.velocity, -1, 1),
    weapon: p.weapon,
    attackIndex: idx,
    attackFrame: attacking ? sub(p.attackFrame) : 0,
    step: idx >= 0 ? combo[idx] : null,
    comboLength: combo.length,
    actionId: acting ? p.actionId : -1,
    actionFrame: acting ? sub(p.actionFrame) : 0,
    castAbility: casting ? p.castAbility : -1,
    castFrame: casting ? sub(p.castFrame) : 0,
    castFrames: casting ? Math.max(1, ABILITIES[p.castAbility]?.castFrames ?? 1) : 1,
    down: p.downFrame >= 0,
    downFrame: p.downFrame >= 0 ? sub(p.downFrame) : 0,
    stunned: p.stun > 0,
    stunFrame: p.stun > 0 ? Math.max(0, COMBAT.stunFrames - p.stun - back) : 0,
    // A hit shoves you away from whoever struck: the knock is the way you're sliding. (The close-up
    // hero keeps the first one, as the slide dies away before the flinch does.)
    hit: p.stun > 0 && hs > 0.05 ? headingOf(p.vel.x, p.vel.z, p.facing) : Math.PI,
    landFrame: sub(p.landFrame),
    landImpact: p.landImpact,
    takeoffFrame: sub(p.takeoffFrame),
    flipFrame: p.flipFrame >= 0 ? sub(p.flipFrame) : -1,
    travel: p.mode === 'swim' ? 'swim' : p.mode === 'glide' ? 'glide' : p.mode === 'ride' ? seat || 'sit' : '',
    bank: p.bank,
    carry: p.pack !== 0 && p.mode !== 'ride',
    effort: Math.min(1, hs / 6),
  });
}

function angleLerp(a: number, b: number, t: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

/** What the body is doing, coarsely: a change here is a transition worth smoothing over. */
function stateKey(p: PoseInput): string {
  if (p.travel) return `travel:${p.travel}`;
  if (p.down) return 'down';
  if (p.actionId >= 0) return `action:${p.actionId}`;
  // Coming down mid-swing is worth easing over too: the legs reach for the ground.
  if (p.attackIndex >= 0) return `attack:${p.attackIndex}${p.grounded ? '' : ':air'}`;
  if (p.castAbility >= 0) return `cast:${p.castAbility}`;
  return `${p.grounded ? 'ground' : 'air'}${p.flipFrame >= 0 ? ':flip' : ''}${p.carry ? ':carry' : ''}${p.stunned ? ':hit' : ''}:${p.weapon}`;
}

/** Seconds to ease from one state into the next: quick into anything you pressed, gentler out. */
function transition(from: string, to: string): number {
  if (!from || from === 'down') return 0; // first frame, or respawned somewhere else
  if (to === 'down') return 0.06;
  if (to.startsWith('travel') || from.startsWith('travel')) return 0.22;
  if (to.startsWith('attack')) return 0.05;
  if (to.startsWith('action')) return 0.04;
  if (to.startsWith('cast')) return 0.08;
  if (from.startsWith('attack') || from.startsWith('action') || from.startsWith('cast')) return 0.14;
  if (to.includes(':hit')) return 0.03;
  if (from.startsWith('air') && to.startsWith('ground')) return 0.05;
  if (from.startsWith('ground') && to.startsWith('air')) return 0.08;
  return 0.12;
}

// ---------- weapon trails, traced from the swings themselves ----------

type Edges = Array<readonly [THREE.Vector3, THREE.Vector3]>;
const traced = new Map<string, Edges | null>();
let tracer: DetailRig | null = null;

const swingKey = (p: PoseInput): string =>
  `${p.weapon}:${p.attackIndex}:${p.comboLength}:${p.step?.startup}:${p.step?.active}:${p.step?.recovery}:${p.step?.pose ?? ''}:${p.airSwing ? 'air' : ''}`;

/**
 * Where the weapon's edge goes through a swing's strike: the pose run offscreen at evenly spaced
 * moments, the blade's base and tip read off the hand. The trail can't help but follow the blade.
 */
export function traceSwing(p: PoseInput): Edges | null {
  const key = swingKey(p);
  if (traced.has(key)) return traced.get(key)!;
  const step = p.step!;
  const edge = HERO_TRAIL_EDGES[HERO_WEAPONS[p.weapon] ?? ''];
  let edges: Edges | null = null;
  if (edge) {
    tracer ??= new DetailRig(HERO_RIG);
    const hand = tracer.joint('handR');
    const n = Math.max(24, step.active * 6);
    edges = [];
    for (let i = 0; i <= n; i++) {
      const f = step.startup + (step.active * i) / n;
      // A jump attack is traced in the air, as it is mostly swung.
      poseHumanoid(tracer, pose({ weapon: p.weapon, attackIndex: p.attackIndex, attackFrame: f, step, comboLength: p.comboLength, airSwing: p.airSwing, grounded: !p.airSwing }));
      tracer.root.updateMatrixWorld(true);
      edges.push([new THREE.Vector3(...edge.inner).applyMatrix4(hand.matrixWorld), new THREE.Vector3(...edge.outer).applyMatrix4(hand.matrixWorld)]);
    }
  }
  traced.set(key, edges);
  return edges;
}

const _m = new THREE.Matrix4();
const _mInv = new THREE.Matrix4();
const _mWorld = new THREE.Matrix4();
const _q = new THREE.Quaternion();
/** The furthest a planted foot is held from where the pose puts it before it drags along, metres. */
const HOLD_MAX = 0.3;
/** How far a held foot can be from where it belongs, standing, before it steps over; and how long that step takes. */
const SETTLE_AT = 0.1;
const SETTLE_STEP = 0.16;
/**
 * Turning, a planted foot keeps pointing the way it was put down: past TWIST_AT (radians) from
 * where the body would have it, standing, it steps round; past TWIST_MAX it gives and swivels.
 */
const TWIST_AT = 0.55;
const TWIST_MAX = 1.0;
/**
 * Drawing the weapon and putting it away (seconds), and how long after a fight it stays out: yours
 * (main.ts says when you're in one), and other players' (judged by what they were doing).
 */
const DRAW_TIME = 0.45;
const SHEATHE_TIME = 0.6;
const LINGER = 2.5;
const OTHERS_LINGER = 4;

/**
 * Stepping up onto a deck or a ledge is one step of the rules (up to 0.65 m in a sixtieth of a
 * second); drawn as it is, the body pops up. A rise in one step of at least STEP_UP_POP (more than
 * the steepest slope you can sprint up gives) is eased over instead, this fast (per second).
 */
const STEP_UP_POP = 0.2;
const STEP_UP_EASE = 14;

/** How quickly a change of effort (PoseInput.effort) comes through: the time constant, seconds. */
const EFFORT_EASE = 0.35;

/** A foot held where it was planted. */
interface FootHold {
  /** Where the point it pivots on is held in the world, while planted. */
  last: THREE.Vector3 | null;
  /** Whether that point is the ball of the foot (else the heel). */
  ball: boolean;
  /** How far the shown foot is moved from the pose's, world x and z. */
  fix: THREE.Vector3;
  /** How far the shown foot is turned from the pose's, radians about the vertical (+ to the left). */
  yaw: number;
  /** 0..1 through a settling step, 0 when not stepping; and the offset and turn it started from. */
  stepping: number;
  from: THREE.Vector3;
  yawFrom: number;
}
const footHold = (): FootHold => ({ last: null, ball: false, fix: new THREE.Vector3(), yaw: 0, stepping: 0, from: new THREE.Vector3(), yawFrom: 0 });

/** How badly a held foot wants to step back under you, out of place and turned: 1 is the point it does. */
const strain = (h: FootHold): number => Math.hypot(Math.hypot(h.fix.x, h.fix.z) / SETTLE_AT, h.yaw / TWIST_AT);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const UP_Z = new THREE.Vector3(0, 0, 1);
const DOWN_Z = new THREE.Vector3(0, 0, -1);
const DOWN_Y = new THREE.Vector3(0, -1, 0);

// The player character, built from simple shapes and animated in code. Carries whichever weapon
// the build has equipped: sword, club, staff or bow.
export class Hero {
  readonly root = new THREE.Group();
  // The body comes from content (src/content/creatures/hero.ts); the motion lives in
  // detail/humanoid.ts, shared by every humanoid race, and is a pure function of its input. What
  // only the close-up body does - the stride clock, easing between states, trails, the bowstring -
  // lives here.
  private rig: DetailRig;
  private body: Body;
  private torso: THREE.Group;
  private nockedArrow: THREE.Group;
  private strings: THREE.Mesh[];
  private weaponShown = -1;
  private trails = new Map<string, SlashArc>();
  private inertia: Inertia;
  /** The stride clock: one turn per stride, advanced by the distance actually run. */
  private phase = 0;
  /** Travelling, the stroke clock: wound on at the pace of the stroke (strokeRate in humanoid.ts). */
  private stroke = 0;
  /** The effort as drawn (PoseInput.effort, eased: see drive); NaN until the first pose. */
  private effort = NaN;
  private lastDistance = NaN;
  private lastTime = NaN;
  private lastFacing = NaN;
  private turnLean = 0;
  /** 0..1 eased into the stride (see PoseInput.stride). */
  private stride = 0;
  private wasGrounded = true;
  private lastKey = '';
  /** Which way the hit that stunned you shoved you, kept from the moment it landed (NaN: not hit). */
  private hitFrom = NaN;
  /**
   * The swing being drawn (combo step and frame) and whether it began in the air: a jump attack
   * plays through to its end, landing or not (PoseInput.airSwing).
   */
  private swingIndex = -1;
  private swingFrame = 0;
  private swingAir = false;
  /**
   * A hit's pause, drawn: sixtieths of a second of it still to hold, how far behind the rules the
   * swing is drawn because of it, and which swing it was for.
   */
  private pauseLeft = 0;
  private pauseLag = 0;
  private pauseSwing = -1;
  private lastStunFrame = Infinity;
  /**
   * Where the weapon's model hangs: null in the hand, '' put away on foot, otherwise put away for
   * that way of travelling (stow.ts).
   */
  private stowedAs: string | null = null;
  /** 0 the weapon in hand .. 1 put away (PoseInput.stow), and when you last fought (seconds). */
  private stow = 0;
  private lastFight = -Infinity;
  /** How far below the rules' height the body is drawn, easing out after a step up; and what was drawn last, when. */
  private stepLift = 0;
  private stepFrame = -1;
  private shownY = NaN;
  private shownAt = NaN;
  /**
   * Whether you are in a fight, set by whoever knows (main.ts, for the player: an enemy marked or a
   * swing just made); left undefined, the hero judges by what the rules have it doing. In a fight
   * the weapon comes out; a few seconds after, it goes away.
   */
  armed: boolean | undefined = undefined;
  /** Feet held where they were planted (see holdFeet), and the facing they were last held at. */
  private holds: Record<Side, FootHold> = { L: footHold(), R: footHold() };
  private holdFacing = NaN;
  /** How to sit while riding (the vehicle's seat pose), set by whoever draws the vehicle. */
  seatPose = '';
  /**
   * What the hands hold and the feet rest on in that seat, as the vehicle model moves them (its
   * wheel's rim, its oars' handles), set by whoever draws the vehicle; null for none.
   */
  seatHolds: Holds | null = null;
  /** Where a pack on your back hangs from. */
  get torsoJoint(): THREE.Object3D {
    return this.torso;
  }

  constructor() {
    this.rig = new DetailRig(HERO_RIG);
    this.root.add(this.rig.root);
    this.body = Body.of(this.rig);
    this.torso = this.rig.joint('torso');
    this.nockedArrow = this.rig.attachment('arrow');
    this.strings = this.rig.built.filter((b) => b.mat === 'string').map((b) => b.mesh);
    this.inertia = new Inertia(this.body);
    this.setWeapon(0);
  }

  // Team colours: blue tunic with a red cape, or red tunic with a dark cape.
  setTeam(team: number): void {
    const c = HERO_TEAM_COLOURS[team === 1 ? 1 : 0];
    this.rig.recolour('tunic', c.tunic);
    this.rig.recolour('cape', c.cape);
  }

  // 0 sword, 1 club, 2 staff, 3 bow.
  setWeapon(weapon: number): void {
    this.weaponShown = weapon;
    this.rig.showAttachment(HERO_WEAPONS[weapon] ?? null);
  }

  /** Where the vehicle's holds are this frame, in the body's model space, for the seated poses. */
  private reachForHolds(input: PoseInput, h: Holds): void {
    this.root.updateWorldMatrix(true, false);
    this.rig.root.updateMatrix();
    const toModel = _mInv.multiplyMatrices(this.root.matrixWorld, this.rig.root.matrix).invert();
    const at = (o: THREE.Object3D) => {
      o.updateWorldMatrix(true, false);
      return o.getWorldPosition(_v).applyMatrix4(toModel);
    };
    if (h.hands) {
      const l = at(h.hands[0]);
      const grips = [l.x, l.y, l.z];
      const r = at(h.hands[1]);
      grips.push(r.x, r.y, r.z);
      input.grips = grips;
    }
    if (Array.isArray(h.feet)) {
      const l = at(h.feet[0]);
      const rest = [l.x, l.y, l.z];
      const r = at(h.feet[1]);
      rest.push(r.x, r.y, r.z);
      input.footrest = rest;
    } else if (h.feet) {
      const f = at(h.feet);
      input.footrest = [f.x, f.y, f.z];
    }
  }

  /** Hangs the weapons where they are put away (null: in the hand; '' on foot, or a way of travelling). */
  private place(as: string | null): void {
    this.stowedAs = as;
    const table = as === null ? null : stowedFor(as);
    for (const name of HERO_WEAPONS) {
      const g = this.rig.attachment(name);
      const s = table?.[name];
      if (s) {
        (s.parent === 'hips' ? this.rig.joint('hips') : this.torso).add(g);
        g.position.set(...s.at);
        stowedTurn(s, g.quaternion);
      } else {
        this.rig.joint(HERO_RIG.attachments?.[name]?.joint ?? 'handR').add(g);
        g.position.set(0, 0, 0);
        g.quaternion.identity();
      }
    }
  }

  /** Whether the weapon is in a hand right now, rather than put away. */
  get weaponInHand(): boolean {
    return this.stowedAs === null;
  }

  /** The body itself, for benches and tests that measure it. */
  get detail(): DetailRig {
    return this.rig;
  }

  /**
   * A swing of yours connected: hold it where it is for `frames` (sixtieths of a second), then let
   * it catch up, as the rules' own hit pause does in the training yard. Online the rules can't stop
   * for it - the server decides where you are - so only the drawing does.
   */
  hitPause(frames: number, swing: number): void {
    if (frames <= 0) return;
    if (swing !== this.pauseSwing) this.pauseLag = 0;
    this.pauseSwing = swing;
    this.pauseLeft = Math.max(this.pauseLeft, frames);
  }

  /** Draws the swing a little behind the rules while a hit's pause holds it and it catches up. */
  private holdForHit(input: PoseInput): void {
    if (input.attackIndex < 0 || input.attackIndex !== this.pauseSwing) {
      this.pauseLeft = this.pauseLag = 0;
      this.pauseSwing = -1;
      return;
    }
    const dt = Number.isFinite(this.lastTime) ? clamp((input.time - this.lastTime) * 60, 0, 6) : 0;
    if (this.pauseLeft > 0) {
      const hold = Math.min(this.pauseLeft, dt);
      this.pauseLeft -= hold;
      this.pauseLag += hold;
    } else {
      // Half as fast again until it's caught up.
      this.pauseLag = Math.max(0, this.pauseLag - dt * 0.5);
    }
    input.attackFrame = Math.max(0, input.attackFrame - this.pauseLag);
  }

  // Poses the character from the game state. alpha blends between the last two sim steps.
  update(p: PlayerState, alpha: number, frame: number): void {
    this.root.position.set(lerp(p.prevPos.x, p.pos.x, alpha), this.easeStepUp(p, alpha, frame), lerp(p.prevPos.z, p.pos.z, alpha));
    this.root.rotation.y = angleLerp(p.prevFacing, p.facing, alpha);
    // How far you have run, drawn part way between steps like everything else.
    const running = p.mode === 'normal' && p.grounded;
    const back = running ? Math.hypot(p.vel.x, p.vel.z) * STEP * (1 - alpha) : 0;
    const input = inputFromPlayer(p, frame, this.seatPose, alpha);
    this.holdForHit(input);
    input.stow = this.drawOrSheathe(p, input);
    this.drive(input, p.runPhase - back);
  }

  /** Where to draw the body's height: the rules', but carried up over a step instead of popping. */
  private easeStepUp(p: PlayerState, alpha: number, frame: number): number {
    const y = lerp(p.prevPos.y, p.pos.y, alpha);
    const now = (frame - (1 - alpha)) / 60;
    const dt = Number.isFinite(this.shownAt) ? clamp(now - this.shownAt, 0, 0.1) : 0;
    const rise = p.pos.y - p.prevPos.y;
    if (frame !== this.stepFrame && p.grounded && rise >= STEP_UP_POP && rise < 1 && Number.isFinite(this.shownY)) {
      this.stepFrame = frame;
      this.stepLift = Math.min(0, this.shownY - y); // carry on from where it was drawn
    } else {
      this.stepLift *= Math.exp(-dt * STEP_UP_EASE);
    }
    // Only ever below where it stands, and gone once it's too small to see (or you've left the ground).
    if (this.stepLift > -1e-3 || !p.grounded) this.stepLift = 0;
    this.shownAt = now;
    this.shownY = y + this.stepLift;
    return this.shownY;
  }

  /**
   * The weapon comes out for a fight and goes away after one: drawn over DRAW_TIME when a fight
   * starts, put away over SHEATHE_TIME once it has been over a while, and in the hand at once
   * whenever you swing, shoot, cast or guard (the swing's own wind-up covers the draw). A pack on
   * your back keeps it in hand, over the shoulder; travelling puts it away whatever.
   */
  private drawOrSheathe(p: PlayerState, input: PoseInput): number {
    const now = input.time;
    const step = Number.isFinite(this.lastTime) ? Math.min(0.1, Math.max(0, now - this.lastTime)) : 0;
    const guarding = p.mode === 'action' && MOVEMENT_SKILLS[p.actionId]?.action.pose === 'block';
    const striking = p.mode === 'attack' || (p.mode === 'cast' && p.castAbility !== NO_ABILITY) || guarding;
    const fighting = striking || p.stun > 0 || this.armed === true;
    if (fighting) this.lastFight = now;
    const linger = this.armed === undefined ? OTHERS_LINGER : LINGER;
    if (striking || input.carry) this.stow = 0;
    else if (fighting || now - this.lastFight < linger) this.stow = Math.max(0, this.stow - step / DRAW_TIME);
    else this.stow = Math.min(1, this.stow + step / SHEATHE_TIME);
    return this.stow;
  }

  /**
   * Poses the body from a pose description. `distance` is metres run so far (it drives the stride
   * clock); `dt` is the time since the last call, worked out from the pose's own clock if not given.
   */
  drive(input: PoseInput, distance: number, dt?: number): PoseFeedback {
    let step = dt ?? (Number.isFinite(this.lastTime) ? input.time - this.lastTime : 0);
    const jumped = step < 0 || step > 0.5;
    if (jumped) step = 0;
    this.lastTime = input.time;

    // The stride clock turns once per stride, and strides shorten as you slow and when backing off.
    const moved = Number.isFinite(this.lastDistance) ? distance - this.lastDistance : 0;
    this.lastDistance = distance;
    // The clock starts where the body is: landing, on the heel of the leg that reached down for the
    // ground (the left, which leads every leap); setting off from standing, with the back foot's step.
    if (input.grounded && !this.wasGrounded) {
      const v = input.speed * MOVE.runSpeed;
      if (Math.cos(input.heading) < -0.3 && v > 0.5) this.phase = -dutyFactor(v, input.crouch, 1) * TAU; // backing away: toes first
      else this.phase = Math.sin(input.heading) * input.speed < -0.15 ? Math.PI : 0;
    }
    else if (this.stride < 0.02 && input.run > 0.01) this.phase = 0.06 * TAU;
    this.wasGrounded = input.grounded;
    if (moved > 0 && moved < 3) {
      const v = input.run * MOVE.runSpeed;
      this.phase = (this.phase + (moved / strideLength(v, input.crouch, input.carry, directional(input.heading).back)) * TAU) % (TAU * 64);
    }
    // How hard the stroke goes eases in and out over a moment, as the stride does: setting off from
    // treading water the body tips forward into the crawl rather than flopping flat, and a pace read
    // from someone else's updates doesn't flicker.
    if (Number.isNaN(this.effort) || jumped) this.effort = input.effort;
    else this.effort += (input.effort - this.effort) * (1 - Math.exp(-step / EFFORT_EASE));
    input.effort = this.effort;
    // Travelling, the stroke clock stands in for it (swimming, riding, rowing), wound on at the
    // stroke's pace: speeding up or slowing down quickens or eases the stroke, never jumps it.
    if (input.travel) this.stroke = (this.stroke + step * strokeRate(input)) % (TAU * 64);
    input.phase = input.travel ? this.stroke : this.phase;

    // Into and out of the stride over a few frames: a foot that was planted stays planted (and
    // held) while the other one swings in or sets down.
    const toward = input.grounded && input.actionId < 0 && input.attackIndex < 0 ? clamp((input.run * MOVE.runSpeed) / 0.8, 0, 1) : 0;
    const want = toward * toward * (3 - 2 * toward);
    if (jumped) this.stride = want;
    else this.stride += (want - this.stride) * (1 - Math.exp(-step / (want > this.stride ? 0.05 : 0.1)));
    input.stride = this.stride;

    // Leaning into turns: how fast the facing swings round, at speed.
    const facing = this.root.rotation.y;
    if (Number.isFinite(this.lastFacing) && step > 0) {
      const want = clamp((angleDiff(this.lastFacing, facing) / step) * input.run * 0.06, -1, 1);
      this.turnLean += (want - this.turnLean) * (1 - Math.exp(-step * 10));
    }
    this.lastFacing = facing;
    input.lean += this.turnLean;

    // A hit's shove is clearest the moment it lands; the flinch keeps that direction while the
    // slide dies away under it (a fresh hit mid-flinch starts the count again).
    if (!input.stunned) this.hitFrom = NaN;
    else if (Number.isNaN(this.hitFrom) || input.stunFrame < this.lastStunFrame) this.hitFrom = input.hit;
    this.lastStunFrame = input.stunned ? input.stunFrame : Infinity;
    if (input.stunned) input.hit = this.hitFrom;

    // A swing that starts in the air is the jump attack, all the way through.
    if (input.attackIndex >= 0) {
      if (input.attackIndex !== this.swingIndex || input.attackFrame < this.swingFrame) this.swingAir = input.airSwing || !input.grounded;
      input.airSwing = this.swingAir;
    }
    this.swingIndex = input.attackIndex;
    this.swingFrame = input.attackFrame;

    if (input.weapon !== this.weaponShown) this.setWeapon(input.weapon);
    // Where the weapon hangs: travelling, put away for it (stow.ts); on foot, in the hand until the
    // hand putting it away lets go of it, halfway through (and back in it halfway through drawing).
    // A pack on the back keeps it in hand, over the shoulder.
    const as = input.carry ? null : input.travel ? input.travel : input.stow >= 0.5 ? '' : null;
    if (as !== this.stowedAs) this.place(as);
    if (input.travel && this.seatHolds) this.reachForHolds(input, this.seatHolds);
    const fb = poseHumanoid(this.rig, input);

    // Ease over a change of state rather than snapping into the new pose.
    const key = stateKey(input);
    let blend = 0;
    if (key !== this.lastKey) {
      blend = jumped ? 0 : transition(this.lastKey, key);
      this.lastKey = key;
    }
    if (jumped) this.inertia.reset();
    this.inertia.step(step, blend);
    if (this.inertia.blending) settle(this.rig, input);
    this.holdFeet(input, fb, step, jumped);

    this.feedback(input, fb);
    return fb;
  }

  /**
   * Planted feet stay where they are on the ground. The poses keep them there moving in a straight
   * line; this catches the rest - turning, changing direction, starting and stopping, easing between
   * states - by cancelling whatever motion the pose gives a planted foot, and lets the correction go
   * once the foot lifts.
   */
  private holdFeet(input: PoseInput, fb: PoseFeedback, step: number, jumped: boolean): void {
    const b = this.body;
    // Model space to world: the hero's place in the world, then the rig's root and the squash. Just
    // that chain, not every mesh under it (the renderer does those).
    this.root.updateWorldMatrix(true, false);
    this.rig.root.updateMatrix();
    b.squash.updateMatrix();
    const toWorld = _mWorld.multiplyMatrices(this.root.matrixWorld, this.rig.root.matrix).multiply(b.squash.matrix);
    _mInv.copy(toWorld).invert();
    // How far the body has turned since last time. The poses don't know about that, so their feet
    // turn with it; a planted foot shouldn't.
    const facing = this.root.rotation.y;
    const turned = jumped || !Number.isFinite(this.holdFacing) ? 0 : angleDiff(this.holdFacing, facing);
    this.holdFacing = facing;
    // Standing about (or creeping), a foot held well away from where it belongs, or turned well
    // away from it, steps back under you - one foot at a time - rather than sliding or swivelling.
    const settling = input.run < 0.15;
    SIDES.forEach((s, i) => {
      const h = this.holds[s];
      if (jumped) {
        h.last = null;
        h.fix.set(0, 0, 0);
        h.yaw = 0;
        h.stepping = 0;
      }
      const foot = b.leg[s].end;
      let lift = 0;
      if (h.stepping > 0) {
        // A settling step: up, across to where the pose has the foot (turning to point its way), and down.
        h.stepping = Math.min(1, h.stepping + step / SETTLE_STEP);
        // Up first, then across, then down: it never drags along the ground.
        const k = h.stepping;
        const across = Math.min(1, Math.max(0, (k - 0.2) / 0.65));
        const left = 1 - across * across * (3 - 2 * across);
        h.fix.copy(h.from).multiplyScalar(left);
        h.yaw = h.yawFrom * left;
        lift = 0.07 * Math.sin(Math.PI * k);
        if (k >= 1) {
          h.stepping = 0;
          h.fix.set(0, 0, 0);
          h.yaw = 0;
          h.last = null;
        }
      } else {
        // The point the foot pivots on: its heel while the toes are up, the ball of the foot otherwise.
        const toesUp = _v.set(0, 0, 1).applyQuaternion(b.quaternionOf(foot, _q)).y > 0.03;
        const pivot = b.toModel(foot, _v2.set(0, -b.ankleHeight, toesUp ? b.heel : b.ball), _v2).applyMatrix4(toWorld);
        if (fb.plant[i] > 0.5) {
          // Planted, the foot keeps pointing the way it was put down while the body turns over it,
          // and its pivot stays on the spot in the world (h.last) however the pose moves it.
          if (h.last) h.yaw = clamp(h.yaw - turned, -TWIST_MAX, TWIST_MAX);
          const ankle = b.positionOf(foot, _v3).applyMatrix4(toWorld);
          const c = Math.cos(h.yaw);
          const sn = Math.sin(h.yaw);
          const rx = pivot.x - ankle.x;
          const rz = pivot.z - ankle.z;
          const tx = rx * c + rz * sn;
          const tz = -rx * sn + rz * c;
          if (!h.last || h.ball !== !toesUp) {
            // Just put down, or rolling from heel to ball: hold the pivot where it is shown now.
            (h.last ??= new THREE.Vector3()).set(ankle.x + h.fix.x + tx, 0, ankle.z + h.fix.z + tz);
            h.ball = !toesUp;
          }
          h.fix.x = h.last.x - ankle.x - tx;
          h.fix.z = h.last.z - ankle.z - tz;
          const far = Math.hypot(h.fix.x, h.fix.z);
          // One foot at a time, the one most out of place (on a tie, as turning, the first to look).
          const other = this.holds[s === 'L' ? 'R' : 'L'];
          const worse = s === 'L' ? strain(h) >= strain(other) : strain(h) > strain(other);
          if (settling && !h.stepping && !other.stepping && strain(h) > 1 && worse) {
            h.stepping = 1e-6;
            h.from.copy(h.fix);
            h.yawFrom = h.yaw;
          } else if (far > HOLD_MAX) {
            // Held too far from where the pose wants it, the foot gives and drags along.
            h.fix.multiplyScalar(HOLD_MAX / far);
            h.last.set(ankle.x + h.fix.x + tx, 0, ankle.z + h.fix.z + tz);
          }
        } else {
          h.last = null;
          const fade = Math.exp(-step * 20);
          h.fix.multiplyScalar(fade);
          h.yaw *= fade;
        }
      }
      if (h.fix.x * h.fix.x + h.fix.z * h.fix.z > 1e-8 || Math.abs(h.yaw) > 1e-5 || lift > 0) {
        const ankle = b.positionOf(foot, _v3).applyMatrix4(toWorld);
        ankle.x += h.fix.x;
        ankle.y += lift;
        ankle.z += h.fix.z;
        b.reachFoot(s, ankle.applyMatrix4(_mInv), h.yaw);
      }
    });
  }

  // Feedback the poses cannot do themselves, because it is not a joint.
  private feedback(input: PoseInput, fb: PoseFeedback): void {
    for (const arc of this.trails.values()) arc.hide();
    if (fb.trail && input.step) {
      const key = swingKey(input);
      let arc = this.trails.get(key);
      if (!arc) {
        const edges = traceSwing(input);
        if (edges) {
          const def = swingFor(input.weapon, input.attackIndex, input.step.pose, input.airSwing);
          arc = new SlashArc(def, edges);
          this.root.add(arc.mesh);
          this.trails.set(key, arc);
        }
      }
      arc?.set(fb.trail.head, fb.trail.tail, fb.trail.alpha);
    }
    this.nockedArrow.visible = fb.arrow;
    if (input.weapon === 3) this.bowstring(fb);
  }

  /** The string follows the drawing hand back, and the nocked arrow lies along it to the grip. */
  private bowstring(fb: PoseFeedback): void {
    const nock = _v.set(...HERO_BOW.nock);
    if (fb.draw > 0) {
      const toBow = this.body.matrixOf(this.body.arm.L.end, _m).invert();
      const hand = this.body.positionOf(this.body.arm.R.end, _v2).applyMatrix4(toBow);
      if (hand.length() > HERO_BOW.maxDraw) hand.setLength(HERO_BOW.maxDraw);
      nock.lerp(hand, fb.draw);
    }
    const half = HERO_BOW.tips[0][2];
    HERO_BOW.tips.forEach((tip, i) => {
      const mesh = this.strings[i];
      if (!mesh) return;
      const run = _v3.set(tip[0], tip[1], tip[2]).sub(nock);
      const len = run.length();
      mesh.position.copy(nock);
      mesh.quaternion.setFromUnitVectors(i === 0 ? UP_Z : DOWN_Z, run.normalize());
      mesh.scale.set(1, 1, len / half);
    });
    if (fb.arrow) {
      // Nock end on the string, shaft resting on the grip (the hand's origin).
      const along = _v3.copy(nock).negate().normalize();
      this.nockedArrow.quaternion.setFromUnitVectors(DOWN_Y, along);
      this.nockedArrow.position.copy(nock).sub(_v2.set(0, HERO_BOW.arrowNock, 0).applyQuaternion(this.nockedArrow.quaternion));
    }
  }
}
