import { ABILITIES, JUMP, MOVEMENT_SKILLS, SLIDE, type AttackStep } from '../../tuning';
import type { DetailRig } from './rig';
import type { PoseFeedback, PoseInput } from '../../content/pose';
import { CLUB_SWINGS, SLASHES, STAFF_SWINGS, type SlashDef } from './swings';

// How a humanoid moves. Every playable race and humanoid NPC shares this - they differ in how
// they are built (src/content/creatures), not in how they walk. Poses only ever touch named
// joints and the feedback struct, never the scene, so the clip baker can run them offscreen to
// produce a creature's crowd animations from the very same code.

const TAU = Math.PI * 2;
export const STRIDE = 2.0; // metres per full run cycle

type Trail = NonNullable<PoseFeedback['trail']>['set'];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export function poseHumanoid(rig: DetailRig, p: PoseInput): PoseFeedback {
  const squash = rig.joint('squash');
  const body = rig.joint('body');
  const hips = rig.joint('hips');
  const torso = rig.joint('torso');
  const head = rig.joint('head');
  const legL = rig.joint('legL');
  const legR = rig.joint('legR');
  const armL = { yaw: rig.joint('armLyaw'), pitch: rig.joint('armLpitch') };
  const armR = { yaw: rig.joint('armRyaw'), pitch: rig.joint('armRpitch') };
  const wrist = rig.joint('wrist');
  const cape = rig.joint('cape');
  const out: PoseFeedback = { arrow: false, trail: null };
  const run = p.run;
  const phase = p.phase;
  const swing = Math.sin(phase);
  const breath = Math.sin(p.time * 2.2);

  function poseAir(p: PoseInput): void {
    const rising = p.rise;
    legL.rotation.x = -0.75;
    legR.rotation.x = 0.35;
    armL.yaw.rotation.y = 0.35;
    armL.pitch.rotation.x = -2.2 + rising * 0.3;
    armR.yaw.rotation.y = -0.3;
    armR.pitch.rotation.x = -1.2;
    wrist.rotation.x = -0.7;
    cape.rotation.x = 0.5 + Math.max(0, -rising) * 1.3;
    if (p.flipFrame >= 0) {
      // Double jump: a quick forward flip with legs tucked.
      const k = p.flipFrame / JUMP.flipFrames;
      body.rotation.x = (1 - (1 - k) * (1 - k)) * TAU;
      legL.rotation.x = -1.3;
      legR.rotation.x = -1.1;
      armL.pitch.rotation.x = -0.9;
      armR.pitch.rotation.x = -0.9;
    }
  }

  // Knocked down: flat on your back until you respawn.
  function poseDown(): void {
    body.position.y = 0.3;
    body.rotation.set(-1.45, 0, 0);
    legL.rotation.x = 0.15;
    legR.rotation.x = -0.1;
    armL.yaw.rotation.y = 1.1;
    armL.pitch.rotation.x = -1.2;
    armR.yaw.rotation.y = -1.1;
    armR.pitch.rotation.x = -1.2;
    wrist.rotation.x = -0.2;
    head.rotation.x = 0.2;
    cape.rotation.x = 1.4;
  }

  // Just been hit: reel back with arms flung up.
  function poseStunned(): void {
    torso.rotation.x = -0.35;
    head.rotation.x = -0.3;
    armL.yaw.rotation.y = 0.8;
    armL.pitch.rotation.x = -2.0;
    armR.yaw.rotation.y = -0.6;
    armR.pitch.rotation.x = -1.6;
    wrist.rotation.x = -0.5;
    legL.rotation.x = -0.3;
    legR.rotation.x = 0.25;
  }

  function poseSlide(p: PoseInput): void {
    const s = Math.min(clamp01(p.actionFrame / 3), clamp01((SLIDE.frames - p.actionFrame) / 4));
    body.position.y = lerp(0.78, 0.4, s);
    body.rotation.x = -1.15 * s;
    legL.rotation.x = 0;
    legR.rotation.x = 0.4 * s;
    head.rotation.x = 0.55 * s;
    armL.yaw.rotation.y = 0.45;
    armL.pitch.rotation.x = 0.9 * s;
    armR.pitch.rotation.x = lerp(-0.35, -1.5, s);
    wrist.rotation.x = -0.6;
    cape.rotation.x = 0.2 + 1.3 * s;
  }

  // Casting. Which pose to strike comes from the ability's castPose, so a new spell picks one
  // in the data instead of being named here.
  function poseCast(p: PoseInput): void {
    const bob = Math.sin(p.time * 9) * 0.06;
    head.rotation.x = -0.3;
    legL.rotation.x = -0.15;
    legR.rotation.x = 0.15;
    if (ABILITIES[p.castAbility]?.castPose === 'bothHands') {
      armL.yaw.rotation.y = 0.6;
      armL.pitch.rotation.x = -2.7 + bob;
      armR.yaw.rotation.y = -0.6;
      armR.pitch.rotation.x = -2.7 + bob;
      wrist.rotation.x = -0.3;
      torso.rotation.x = -0.12;
    } else {
      armR.yaw.rotation.y = -0.15;
      armR.pitch.rotation.x = -3.0 + bob;
      wrist.rotation.x = 0.1;
      armL.yaw.rotation.y = 0.25;
      armL.pitch.rotation.x = -1.6;
      torso.rotation.x = -0.15;
    }
  }

  // Movement skills. Which pose comes from the skill's own `pose`, so a new one picks an
  // existing shape in the data rather than being named here.
  function poseAction(p: PoseInput): void {
    const def = MOVEMENT_SKILLS[p.actionId]?.action;
    const total = def ? def.startup + def.active + def.recovery : 1;
    const k = Math.min(1, p.actionFrame / Math.max(1, total));
    if (def?.pose === 'slide') return poseSlide(p);
    if (def?.pose === 'block') {
      torso.rotation.x = -0.1;
      armL.yaw.rotation.y = 0.9;
      armL.pitch.rotation.x = -1.5;
      armR.yaw.rotation.y = -0.5;
      armR.pitch.rotation.x = -1.1;
      head.rotation.x = 0.15;
      squash.scale.set(1.04, 0.94, 1.04);
      return;
    }
    if (def?.pose === 'backstep') {
      const lean = Math.sin(k * Math.PI);
      torso.rotation.x = 0.35 * lean;
      armL.pitch.rotation.x = -0.9 * lean;
      armR.pitch.rotation.x = -0.9 * lean;
      legL.rotation.x = 0.5 * lean;
      legR.rotation.x = -0.3 * lean;
      return;
    }
    // Roll: tuck up and turn a full somersault over the active frames.
    const tuck = Math.sin(k * Math.PI);
    body.rotation.x = -k * Math.PI * 2;
    squash.scale.set(1 + 0.1 * tuck, 1 - 0.22 * tuck, 1 + 0.1 * tuck);
    legL.rotation.x = -1.4 * tuck;
    legR.rotation.x = -1.6 * tuck;
    armL.pitch.rotation.x = -2.2 * tuck;
    armR.pitch.rotation.x = -2.2 * tuck;
    head.rotation.x = 0.5 * tuck;
  }

  function poseAttack(p: PoseInput): void {
    const idx = Math.max(0, p.attackIndex);
    const step = p.step;
    if (!step) return;
    if (p.weapon === 3) return poseDraw(p, step);
    if (step.pose === 'spin') return poseSpin(p, step);
    const [set, defs]: [Trail, SlashDef[]] =
      p.weapon === 1 ? ['club', CLUB_SWINGS] : p.weapon === 2 ? ['staff', STAFF_SWINGS] : ['sword', SLASHES];
    poseSwing(p, step, defs[idx] ?? defs[0], set, idx, idx === p.comboLength - 1);
  }

  function poseSwing(p: PoseInput, step: AttackStep, def: SlashDef, set: Trail, index: number, finisher: boolean): void {
    const f = p.attackFrame;
    const S = step.startup;
    const A = step.active;
    const R = step.recovery;
    const restYaw = -0.15;
    const restPitch = -0.35;

    let yaw: number;
    let pitch: number;
    let wristAngle: number;
    if (f <= S) {
      const e = easeOut(clamp01(f / S));
      yaw = lerp(restYaw, def.a0, e);
      pitch = lerp(restPitch, def.p0, e);
      wristAngle = lerp(-1.0, 0, e);
    } else if (f <= S + A) {
      const e = easeOut(clamp01((f - S) / A));
      yaw = lerp(def.a0, def.a1, e);
      pitch = lerp(def.p0, def.p1, e);
      wristAngle = 0;
    } else {
      const e = easeInOut(clamp01(((f - S - A) / R - 0.3) / 0.7));
      yaw = lerp(def.a1, restYaw, e);
      pitch = lerp(def.p1, restPitch, e);
      wristAngle = lerp(0, -1.0, e);
    }
    armR.yaw.rotation.y = yaw;
    armR.pitch.rotation.x = pitch;
    wrist.rotation.x = wristAngle;

    // Body follows through: lean into the swing, plant the feet.
    const swingAmt = f <= S ? 0 : clamp01((f - S) / A);
    const settle = f > S + A ? 1 - clamp01((f - S - A) / R) : 1;
    torso.rotation.x = (finisher ? 0.35 : 0.22) * swingAmt * settle;
    hips.rotation.y = -yaw * 0.2;
    armL.yaw.rotation.y = 0.6;
    armL.pitch.rotation.x = -0.6;
    plantFeet(p);
    showTrail(set, index, f, S, A);
  }

  // Whirlwind: arm out to the side, the whole body spins once, the trail rings all the way round.
  function poseSpin(p: PoseInput, step: AttackStep): void {
    const f = p.attackFrame;
    const S = step.startup;
    const A = step.active;
    const spin = f <= S ? 0 : easeOut(clamp01((f - S) / A));
    body.rotation.y = -spin * TAU;
    const windUp = easeOut(clamp01(f / S));
    armR.yaw.rotation.y = lerp(-0.15, -1.4, windUp);
    armR.pitch.rotation.x = lerp(-0.35, -1.55, windUp);
    wrist.rotation.x = lerp(-1.0, 0, windUp);
    armL.yaw.rotation.y = 1.3;
    armL.pitch.rotation.x = -1.3;
    torso.rotation.x = 0.1;
    plantFeet(p);
    showTrail('spin', 0, f, S, A);
  }

  // Bow: raise it and draw while the shot lines up, release on the active frame.
  function poseDraw(p: PoseInput, step: AttackStep): void {
    const f = p.attackFrame;
    const S = step.startup;
    const draw = easeOut(clamp01(f / S));
    const relax = f > S + step.active ? easeInOut(clamp01((f - S - step.active) / step.recovery)) : 0;
    armL.yaw.rotation.y = lerp(0.2, 0, draw);
    armL.pitch.rotation.x = lerp(-0.35, -1.57, draw) * (1 - relax * 0.4);
    armR.yaw.rotation.y = lerp(-0.15, 0.25, draw) * (1 - relax);
    armR.pitch.rotation.x = lerp(-0.35, -1.45, draw) * (1 - relax) + -0.35 * relax;
    wrist.rotation.x = -1.0;
    torso.rotation.y = 0.25 * draw * (1 - relax);
    out.arrow = f <= S; // gone once it's been loosed
    plantFeet(p);
  }

  function plantFeet(p: PoseInput): void {
    if (p.grounded) {
      legL.rotation.x = -0.35;
      legR.rotation.x = 0.35;
    } else {
      legL.rotation.x = -0.9;
      legR.rotation.x = 0.2;
    }
  }

  // Trail: the bright head follows the weapon, the tail fades out after the swing.
  function showTrail(set: Trail, index: number, f: number, S: number, A: number): void {
    if (f <= S) return;
    const head = easeOut(clamp01((f - S) / A));
    const fade = clamp01((f - S - A) / 6);
    const tail = lerp(Math.max(0, head - 0.6), 1, fade);
    if (fade < 1) out.trail = { set, index, head, tail, alpha: 1 - fade * 0.6 };
  }

  // A trade pack's straps in both hands, leaning into the weight.
  function poseCarry(): void {
    torso.rotation.x += 0.16;
    head.rotation.x -= 0.1;
    armL.yaw.rotation.y = 0.55;
    armL.pitch.rotation.x = -0.75 + swing * 0.12 * run;
    armR.yaw.rotation.y = -0.55;
    armR.pitch.rotation.x = -0.75 - swing * 0.12 * run;
    wrist.rotation.x = -1.2;
    cape.rotation.x = 0.05;
  }

  // Swimming, gliding and the seats of every vehicle.
  function poseTravel(p: PoseInput): void {
    const t = p.time;
    const bank = p.bank;
    cape.rotation.x = 0.25;
    if (p.travel === 'swim') {
      // Front crawl, face down at the surface.
      const k = t * (3 + 3 * p.effort);
      body.position.y = 0.95;
      body.rotation.set(1.25, 0, Math.sin(k) * 0.18);
      head.rotation.x = -0.9;
      armL.yaw.rotation.y = 0.2;
      armR.yaw.rotation.y = -0.2;
      armL.pitch.rotation.x = -1.6 + Math.sin(k) * 1.5;
      armR.pitch.rotation.x = -1.6 - Math.sin(k) * 1.5;
      legL.rotation.x = Math.sin(k * 2.2) * 0.3 * (0.4 + p.effort);
      legR.rotation.x = -Math.sin(k * 2.2) * 0.3 * (0.4 + p.effort);
      cape.rotation.x = 1.3;
      return;
    }
    if (p.travel === 'glide') {
      // Hanging from the control bar, legs trailing, the body swinging into turns.
      body.position.y = 0.95;
      body.rotation.set(0.95, 0, -bank * 0.45);
      head.rotation.x = -0.75;
      armL.yaw.rotation.y = 0.35;
      armR.yaw.rotation.y = -0.35;
      armL.pitch.rotation.x = -2.75;
      armR.pitch.rotation.x = -2.75;
      wrist.rotation.x = -0.2;
      legL.rotation.x = 0.25 + Math.sin(t * 3.1) * 0.05;
      legR.rotation.x = 0.4 + Math.sin(t * 3.1 + 1) * 0.05;
      cape.rotation.x = 1.45 + Math.sin(t * 17) * 0.05;
      return;
    }
    // Seated: hips on the seat (the root), legs out front.
    body.position.y = 0.22;
    body.rotation.set(0, 0, 0);
    legL.rotation.set(-1.45, 0, 0);
    legR.rotation.set(-1.45, 0, 0);
    if (p.travel === 'ride') {
      // Astride: legs down either side, reins in hand, rising with the gait.
      body.position.y = 0.3 + Math.abs(Math.sin(t * (6 + 6 * p.effort))) * 0.05 * p.effort;
      torso.rotation.x = 0.12 + 0.12 * p.effort;
      legL.rotation.set(-0.35, 0, 0.5);
      legR.rotation.set(-0.35, 0, -0.5);
      armL.yaw.rotation.y = 0.35;
      armR.yaw.rotation.y = -0.35;
      armL.pitch.rotation.x = -0.95;
      armR.pitch.rotation.x = -0.95;
      body.rotation.z = -bank * 0.15;
      return;
    }
    if (p.travel === 'row') {
      const k = Math.sin(t * (2.2 + 2 * p.effort));
      torso.rotation.x = -0.2 + k * 0.35 * p.effort;
      armL.yaw.rotation.y = 0.55;
      armR.yaw.rotation.y = -0.55;
      armL.pitch.rotation.x = -1.35 - k * 0.5 * p.effort;
      armR.pitch.rotation.x = -1.35 - k * 0.5 * p.effort;
      return;
    }
    if (p.travel === 'helm') {
      // Standing at the tiller.
      body.position.y = 0.78;
      legL.rotation.set(-0.15, 0, 0.08);
      legR.rotation.set(0.15, 0, -0.08);
      torso.rotation.y = -bank * 0.2;
      armR.yaw.rotation.y = -0.3;
      armR.pitch.rotation.x = -0.9 - bank * 0.3;
      armL.yaw.rotation.y = 0.4;
      armL.pitch.rotation.x = -0.5;
      return;
    }
    if (p.travel === 'drive') {
      // Both hands on the wheel, turning it.
      torso.rotation.x = -0.08;
      torso.rotation.z = -bank * 0.06;
      armL.yaw.rotation.y = 0.45 + bank * 0.25;
      armR.yaw.rotation.y = -0.45 + bank * 0.25;
      armL.pitch.rotation.x = -1.25 + bank * 0.2;
      armR.pitch.rotation.x = -1.25 - bank * 0.2;
      return;
    }
    // A passenger: hands in the lap.
    armL.pitch.rotation.x = -0.6;
    armR.pitch.rotation.x = -0.6;
  }

  // Start from the idle / running pose.
  squash.scale.set(1, 1, 1);
  body.position.y = 0.78 + Math.abs(Math.cos(phase)) * 0.07 * run - 0.03 * run;
  body.rotation.set(0, 0, 0);
  hips.rotation.set(0, 0, 0);
  torso.rotation.set(0.16 * run, 0, 0);
  torso.position.y = -0.08 + breath * 0.008 * (1 - run);
  head.rotation.set(-0.08 * run, 0, 0);
  legL.rotation.set(swing * 0.85 * run, 0, 0);
  legR.rotation.set(-swing * 0.85 * run, 0, 0);
  armL.yaw.rotation.y = 0.12;
  armL.pitch.rotation.x = -swing * 0.9 * run + 0.05;
  armR.yaw.rotation.y = -0.15;
  armR.pitch.rotation.x = -0.35 + swing * 0.45 * run;
  wrist.rotation.x = -1.0;
  if (p.weapon === 2) wrist.rotation.x = -1.35; // staff held more upright
  if (p.weapon === 3) {
    // Bow held low in the left hand.
    armL.pitch.rotation.x = -0.35 - swing * 0.4 * run;
    armL.yaw.rotation.y = 0.2;
  }
  cape.rotation.x = 0.12 + 0.9 * run + Math.sin(phase * 2) * 0.08 * run + breath * 0.02;

  // Open-world travel replaces the on-foot pose wholesale; carrying only adjusts it.
  if (p.travel) {
    poseTravel(p);
    return out;
  }
  if (!p.grounded) poseAir(p);
  if (p.carry) poseCarry();
  if (p.attackIndex >= 0) poseAttack(p);
  if (p.castAbility >= 0) poseCast(p);
  if (p.actionId >= 0) poseAction(p);
  if (p.down) poseDown();
  else if (p.stunned) poseStunned();

    // Squash on landing, stretch on take-off.
    if (p.grounded && p.landFrame < 8) {
      const s = (1 - p.landFrame / 8) * (0.35 + 0.65 * p.landImpact);
      squash.scale.set(1 + 0.22 * s, 1 - 0.28 * s, 1 + 0.22 * s);
    } else if (!p.grounded && p.takeoffFrame < 6) {
      const s = 1 - p.takeoffFrame / 6;
      squash.scale.set(1 - 0.1 * s, 1 + 0.16 * s, 1 - 0.1 * s);
    }


  return out;
}
