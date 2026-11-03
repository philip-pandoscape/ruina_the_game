import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { PlayerState } from '../sim/types';
import { CAST, comboFor, JUMP, MOVE, PERK, SLIDE, type AttackStep } from '../tuning';
import { part, toon } from './toon';
import { SlashArc, type SlashDef } from './vfx';

const TAU = Math.PI * 2;
const STRIDE = 2.0; // metres per full run cycle

// Arm swing for each combo hit: yaw a (0 = straight ahead, + = to the left), pitch p
// (-π/2 = arm horizontal, -π = straight up). The slash trail follows the same path.
// Swings are diagonal so their trails read well from a camera behind the player.
export const SLASHES: SlashDef[] = [
  { a0: -1.6, a1: 1.2, p0: -2.0, p1: -1.15, color: 0x6fd3ff, core: 0xffffff }, // high right → low left
  { a0: 1.2, a1: -1.5, p0: -1.2, p1: -2.0, color: 0x6fd3ff, core: 0xffffff }, // rising backhand
  { a0: -0.9, a1: 0.5, p0: -3.2, p1: -0.75, color: 0xffb627, core: 0xfff4d6 }, // overhead finisher
];
const CLUB_SWINGS: SlashDef[] = [
  { a0: -1.4, a1: 1.1, p0: -1.9, p1: -1.2, color: 0xffa94d, core: 0xfff1d6 }, // wide swing
  { a0: -0.3, a1: 0.2, p0: -3.3, p1: -0.6, color: 0xff8c42, core: 0xfff1d6 }, // overhead smash
];
const STAFF_SWINGS: SlashDef[] = [{ a0: -0.5, a1: 0.35, p0: -1.75, p1: -1.4, color: 0xb48cff, core: 0xffffff }];
// Whirlwind: the arm stays out to the side while the whole body turns a full circle.
const SPIN: SlashDef = { a0: -1.4, a1: -1.4 - TAU, p0: -1.55, p1: -1.55, color: 0xffb627, core: 0xfff4d6 };

const rbox = (w: number, h: number, d: number, r = 0.05) => new RoundedBoxGeometry(w, h, d, 2, r);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function angleLerp(a: number, b: number, t: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

interface Arm {
  yaw: THREE.Group;
  pitch: THREE.Group;
}

// The player character, built from simple shapes and animated in code. Carries whichever weapon
// the build has equipped: sword, club, staff or bow.
export class Hero {
  readonly root = new THREE.Group();
  private squash = new THREE.Group();
  private body = new THREE.Group();
  private hips = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private armL: Arm;
  private armR: Arm;
  private wrist = new THREE.Group(); // right hand: sword, club or staff
  private leftHand = new THREE.Group(); // left hand: bow
  private cape = new THREE.Group();
  private weapons: THREE.Group[] = [];
  private nockedArrow: THREE.Group;
  private weaponShown = -1;
  private trails: Record<string, SlashArc[]>;
  private spinTrail: SlashArc;
  private tunicMat!: THREE.MeshToonMaterial;
  private capeMat!: THREE.MeshToonMaterial;

  constructor() {
    const skin = toon(0xf1c27d);
    const tunic = (this.tunicMat = toon(0x3a6ea5));
    const leather = toon(0x6b4226);
    const pants = toon(0x2f3e46);
    const boots = toon(0x4a3426);
    const hair = toon(0x5b3a29);
    const dark = toon(0x1d2733);
    const gold = toon(0xe0b84a);
    const steel = toon(0xdfe6ee, { emissive: 0x334455 });
    const red = (this.capeMat = toon(0xc0392b));
    const wood = toon(0x8a5a33);
    const darkWood = toon(0x5c3a1e);

    this.root.add(this.squash);
    this.squash.add(this.body);
    this.body.position.y = 0.78;

    // Hips and legs
    this.hips.position.y = -0.14;
    this.body.add(this.hips);
    part(this.hips, rbox(0.4, 0.16, 0.26), pants);
    for (const [leg, x] of [[this.legL, 0.12], [this.legR, -0.12]] as const) {
      leg.position.set(x, -0.02, 0);
      this.hips.add(leg);
      part(leg, rbox(0.15, 0.5, 0.17), pants, 0, -0.25, 0);
      part(leg, rbox(0.19, 0.13, 0.27, 0.04), boots, 0, -0.555, 0.04);
    }

    // Torso, belt, head
    this.torso.position.y = -0.08;
    this.body.add(this.torso);
    part(this.torso, rbox(0.46, 0.44, 0.3, 0.08), tunic, 0, 0.23, 0);
    part(this.torso, rbox(0.48, 0.07, 0.32, 0.03), leather, 0, 0.04, 0, { outline: 0.015 });
    part(this.torso, rbox(0.09, 0.08, 0.04, 0.02), gold, 0, 0.04, 0.165, { outline: false });

    this.head.position.y = 0.7;
    this.torso.add(this.head);
    part(this.head, rbox(0.5, 0.46, 0.46, 0.12), skin);
    part(this.head, rbox(0.55, 0.17, 0.5, 0.07), hair, 0, 0.2, -0.01);
    part(this.head, rbox(0.55, 0.36, 0.15, 0.06), hair, 0, 0.05, -0.19);
    for (const x of [0.11, -0.11]) {
      part(this.head, rbox(0.07, 0.11, 0.02, 0.01), dark, x, 0.0, 0.235, { outline: false, castShadow: false });
    }

    // Cape hangs from the shoulders and flaps with movement.
    this.cape.position.set(0, 0.42, -0.16);
    this.torso.add(this.cape);
    part(this.cape, rbox(0.42, 0.5, 0.04, 0.02), red, 0, -0.25, 0, { outline: 0.015 });

    // Arms: shoulder → yaw → pitch, so swings are easy to describe.
    const makeArm = (x: number): Arm => {
      const shoulder = new THREE.Group();
      shoulder.position.set(x, 0.4, 0);
      this.torso.add(shoulder);
      const yaw = new THREE.Group();
      const pitch = new THREE.Group();
      shoulder.add(yaw);
      yaw.add(pitch);
      part(pitch, rbox(0.14, 0.42, 0.15, 0.05), tunic, 0, -0.21, 0);
      part(pitch, new THREE.SphereGeometry(0.075, 12, 8), skin, 0, -0.45, 0, { outline: 0.015 });
      return { yaw, pitch };
    };
    this.armL = makeArm(0.31);
    this.armR = makeArm(-0.31);
    this.wrist.position.y = -0.45;
    this.armR.pitch.add(this.wrist);
    this.leftHand.position.y = -0.45;
    this.armL.pitch.add(this.leftHand);

    // Weapons. In the right hand, "forward" along the weapon is -Y (continuing the arm).
    const sword = new THREE.Group();
    part(sword, new THREE.CylinderGeometry(0.028, 0.028, 0.18, 8), leather, 0, 0, 0, { outline: 0.012 });
    part(sword, new THREE.SphereGeometry(0.04, 8, 6), gold, 0, 0.1, 0, { outline: 0.012 });
    part(sword, rbox(0.26, 0.05, 0.07, 0.02), gold, 0, -0.1, 0, { outline: 0.012 });
    part(sword, rbox(0.075, 0.86, 0.025, 0.012), steel, 0, -0.55, 0, { outline: 0.012 });
    const tip = new THREE.ConeGeometry(0.053, 0.12, 4);
    tip.rotateZ(Math.PI);
    tip.rotateY(Math.PI / 4);
    tip.scale(1, 1, 0.33);
    part(sword, tip, steel, 0, -1.04, 0, { outline: 0.012 });

    const club = new THREE.Group();
    part(club, new THREE.CylinderGeometry(0.03, 0.035, 0.34, 8), darkWood, 0, -0.06, 0, { outline: 0.012 });
    part(club, new THREE.CylinderGeometry(0.1, 0.065, 0.42, 9), wood, 0, -0.42, 0, { outline: 0.015 });
    for (const [x, y, z] of [[0.09, -0.5, 0.03], [-0.07, -0.42, 0.07], [0.02, -0.58, -0.09], [-0.05, -0.33, -0.08]]) {
      part(club, new THREE.IcosahedronGeometry(0.035, 0), gold, x, y, z, { outline: false });
    }

    const staff = new THREE.Group();
    part(staff, new THREE.CylinderGeometry(0.026, 0.03, 1.6, 7), darkWood, 0, -0.3, 0, { outline: 0.012 });
    part(staff, new THREE.TorusGeometry(0.09, 0.02, 6, 14), gold, 0, -1.12, 0, { outline: false });
    const orbMat = new THREE.MeshBasicMaterial({ color: 0xffa040, toneMapped: false });
    part(staff, new THREE.IcosahedronGeometry(0.085, 1), orbMat, 0, -1.2, 0, { outline: 0.012, castShadow: false });

    // The bow sits in the left hand. With the arm raised forward, it stands upright with the
    // grip at the hand, bulging forward, and the string behind it.
    const bow = new THREE.Group();
    const bowArc = new THREE.TorusGeometry(0.55, 0.026, 6, 18, (TAU / 360) * 120);
    bowArc.rotateZ(-(5 * Math.PI) / 6);
    bowArc.rotateY(Math.PI / 2);
    bowArc.translate(0, 0.55, 0);
    part(bow, bowArc, wood, 0, 0, 0, { outline: 0.012 });
    const string = new THREE.CylinderGeometry(0.006, 0.006, 0.95, 4);
    string.rotateX(Math.PI / 2);
    part(bow, string, toon(0xeeeeee), 0, 0.275, 0, { outline: false, castShadow: false });
    this.nockedArrow = new THREE.Group();
    const shaft = new THREE.CylinderGeometry(0.012, 0.012, 0.8, 5);
    part(this.nockedArrow, shaft, toon(0xd9c39a), 0, -0.1, 0, { outline: false, castShadow: false });
    part(this.nockedArrow, new THREE.ConeGeometry(0.03, 0.08, 4).rotateZ(Math.PI), steel, 0, -0.52, 0, { outline: false });
    bow.add(this.nockedArrow);

    this.wrist.add(sword, club, staff);
    this.leftHand.add(bow);
    this.weapons = [sword, club, staff, bow];

    // Slash trails sit at the right shoulder so they share the arm's swing path.
    const trailsFor = (defs: SlashDef[], inner: number, outer: number) =>
      defs.map((def) => {
        const arc = new SlashArc(def, inner, outer);
        arc.mesh.position.set(-0.31, 0.4, 0);
        this.torso.add(arc.mesh);
        return arc;
      });
    this.trails = {
      sword: trailsFor(SLASHES, 0.55, 1.58),
      club: trailsFor(CLUB_SWINGS, 0.4, 1.15),
      staff: trailsFor(STAFF_SWINGS, 0.5, 1.6),
    };
    // The Whirlwind trail stays still while the body spins inside it.
    this.spinTrail = new SlashArc(SPIN, 0.6, 1.95);
    this.spinTrail.mesh.position.set(0, 1.1, 0);
    this.root.add(this.spinTrail.mesh);
    this.setWeapon(0);
  }

  // Team colours: blue tunic with a red cape, or red tunic with a dark cape.
  setTeam(team: number): void {
    this.tunicMat.color.set(team === 1 ? 0xb33a3a : 0x3a6ea5);
    this.capeMat.color.set(team === 1 ? 0x3a3f4f : 0xc0392b);
  }

  // 0 sword, 1 club, 2 staff, 3 bow.
  setWeapon(weapon: number): void {
    this.weaponShown = weapon;
    this.weapons.forEach((w, i) => (w.visible = i === weapon));
  }

  // Poses the character from the game state. alpha blends between the last two sim steps.
  update(p: PlayerState, alpha: number, frame: number): void {
    if (p.weapon !== this.weaponShown) this.setWeapon(p.weapon);
    this.root.position.set(
      lerp(p.prevPos.x, p.pos.x, alpha),
      lerp(p.prevPos.y, p.pos.y, alpha),
      lerp(p.prevPos.z, p.pos.z, alpha),
    );
    this.root.rotation.y = angleLerp(p.prevFacing, p.facing, alpha);

    const hs = Math.hypot(p.vel.x, p.vel.z);
    const run = p.mode === 'normal' && p.grounded ? clamp01(hs / MOVE.runSpeed) : 0;
    const phase = (p.runPhase / STRIDE) * TAU;
    const swing = Math.sin(phase);
    const breath = Math.sin((frame / 60) * 2.2);

    // Start from the idle / running pose.
    this.squash.scale.set(1, 1, 1);
    this.body.position.y = 0.78 + Math.abs(Math.cos(phase)) * 0.07 * run - 0.03 * run;
    this.body.rotation.set(0, 0, 0);
    this.hips.rotation.set(0, 0, 0);
    this.torso.rotation.set(0.16 * run, 0, 0);
    this.torso.position.y = -0.08 + breath * 0.008 * (1 - run);
    this.head.rotation.set(-0.08 * run, 0, 0);
    this.legL.rotation.set(swing * 0.85 * run, 0, 0);
    this.legR.rotation.set(-swing * 0.85 * run, 0, 0);
    this.armL.yaw.rotation.y = 0.12;
    this.armL.pitch.rotation.x = -swing * 0.9 * run + 0.05;
    this.armR.yaw.rotation.y = -0.15;
    this.armR.pitch.rotation.x = -0.35 + swing * 0.45 * run;
    this.wrist.rotation.x = -1.0;
    if (p.weapon === 2) this.wrist.rotation.x = -1.35; // staff held more upright
    if (p.weapon === 3) {
      // Bow held low in the left hand.
      this.armL.pitch.rotation.x = -0.35 - swing * 0.4 * run;
      this.armL.yaw.rotation.y = 0.2;
    }
    this.nockedArrow.visible = false;
    this.cape.rotation.x = 0.12 + 0.9 * run + Math.sin(phase * 2) * 0.08 * run + breath * 0.02;
    for (const list of Object.values(this.trails)) for (const arc of list) arc.hide();
    this.spinTrail.hide();

    if (p.mode === 'normal' && !p.grounded) this.poseAir(p);
    if (p.mode === 'slide') this.poseSlide(p);
    if (p.mode === 'attack') this.poseAttack(p);
    if (p.mode === 'cast') this.poseCast(p, frame);
    if (p.downFrame >= 0) this.poseDown();
    else if (p.stun > 0) this.poseStunned();

    // Squash on landing, stretch on take-off.
    if (p.grounded && p.landFrame < 8) {
      const s = (1 - p.landFrame / 8) * (0.35 + 0.65 * p.landImpact);
      this.squash.scale.set(1 + 0.22 * s, 1 - 0.28 * s, 1 + 0.22 * s);
    } else if (!p.grounded && p.takeoffFrame < 6) {
      const s = 1 - p.takeoffFrame / 6;
      this.squash.scale.set(1 - 0.1 * s, 1 + 0.16 * s, 1 - 0.1 * s);
    }
  }

  private poseAir(p: PlayerState): void {
    const rising = Math.max(-1, Math.min(1, p.vel.y / JUMP.velocity));
    this.legL.rotation.x = -0.75;
    this.legR.rotation.x = 0.35;
    this.armL.yaw.rotation.y = 0.35;
    this.armL.pitch.rotation.x = -2.2 + rising * 0.3;
    this.armR.yaw.rotation.y = -0.3;
    this.armR.pitch.rotation.x = -1.2;
    this.wrist.rotation.x = -0.7;
    this.cape.rotation.x = 0.5 + Math.max(0, -rising) * 1.3;
    if (p.flipFrame >= 0) {
      // Double jump: a quick forward flip with legs tucked.
      const k = p.flipFrame / JUMP.flipFrames;
      this.body.rotation.x = (1 - (1 - k) * (1 - k)) * TAU;
      this.legL.rotation.x = -1.3;
      this.legR.rotation.x = -1.1;
      this.armL.pitch.rotation.x = -0.9;
      this.armR.pitch.rotation.x = -0.9;
    }
  }

  // Knocked down: flat on your back until you respawn.
  private poseDown(): void {
    this.body.position.y = 0.3;
    this.body.rotation.set(-1.45, 0, 0);
    this.legL.rotation.x = 0.15;
    this.legR.rotation.x = -0.1;
    this.armL.yaw.rotation.y = 1.1;
    this.armL.pitch.rotation.x = -1.2;
    this.armR.yaw.rotation.y = -1.1;
    this.armR.pitch.rotation.x = -1.2;
    this.wrist.rotation.x = -0.2;
    this.head.rotation.x = 0.2;
    this.cape.rotation.x = 1.4;
  }

  // Just been hit: reel back with arms flung up.
  private poseStunned(): void {
    this.torso.rotation.x = -0.35;
    this.head.rotation.x = -0.3;
    this.armL.yaw.rotation.y = 0.8;
    this.armL.pitch.rotation.x = -2.0;
    this.armR.yaw.rotation.y = -0.6;
    this.armR.pitch.rotation.x = -1.6;
    this.wrist.rotation.x = -0.5;
    this.legL.rotation.x = -0.3;
    this.legR.rotation.x = 0.25;
  }

  private poseSlide(p: PlayerState): void {
    const s = Math.min(clamp01(p.slideFrame / 3), clamp01((SLIDE.frames - p.slideFrame) / 4));
    this.body.position.y = lerp(0.78, 0.4, s);
    this.body.rotation.x = -1.15 * s;
    this.legL.rotation.x = 0;
    this.legR.rotation.x = 0.4 * s;
    this.head.rotation.x = 0.55 * s;
    this.armL.yaw.rotation.y = 0.45;
    this.armL.pitch.rotation.x = 0.9 * s;
    this.armR.pitch.rotation.x = lerp(-0.35, -1.5, s);
    this.wrist.rotation.x = -0.6;
    this.cape.rotation.x = 0.2 + 1.3 * s;
  }

  // Casting: Healing Circle raises both hands; Meteor lifts the staff high and points at the target.
  private poseCast(p: PlayerState, frame: number): void {
    const bob = Math.sin((frame / 60) * 9) * 0.06;
    this.head.rotation.x = -0.3;
    this.legL.rotation.x = -0.15;
    this.legR.rotation.x = 0.15;
    if (p.castKind === CAST.heal) {
      this.armL.yaw.rotation.y = 0.6;
      this.armL.pitch.rotation.x = -2.7 + bob;
      this.armR.yaw.rotation.y = -0.6;
      this.armR.pitch.rotation.x = -2.7 + bob;
      this.wrist.rotation.x = -0.3;
      this.torso.rotation.x = -0.12;
    } else {
      this.armR.yaw.rotation.y = -0.15;
      this.armR.pitch.rotation.x = -3.0 + bob;
      this.wrist.rotation.x = 0.1;
      this.armL.yaw.rotation.y = 0.25;
      this.armL.pitch.rotation.x = -1.6;
      this.torso.rotation.x = -0.15;
    }
  }

  private poseAttack(p: PlayerState): void {
    const combo = comboFor(p.weapon, p.perks);
    const idx = Math.min(p.attackIndex, combo.length - 1);
    const step = combo[idx];
    if (p.weapon === 3) return this.poseDraw(p, step);
    if (p.weapon === 0 && idx === 2 && p.perks & PERK.whirlwind) return this.poseSpin(p, step);
    const [defs, trails] =
      p.weapon === 1 ? [CLUB_SWINGS, this.trails.club] : p.weapon === 2 ? [STAFF_SWINGS, this.trails.staff] : [SLASHES, this.trails.sword];
    this.poseSwing(p, step, defs[idx] ?? defs[0], trails[idx] ?? trails[0], idx === combo.length - 1);
  }

  private poseSwing(p: PlayerState, step: AttackStep, def: SlashDef, trail: SlashArc, finisher: boolean): void {
    const f = p.attackFrame;
    const S = step.startup;
    const A = step.active;
    const R = step.recovery;
    const restYaw = -0.15;
    const restPitch = -0.35;

    let yaw: number;
    let pitch: number;
    let wrist: number;
    if (f <= S) {
      const e = easeOut(clamp01(f / S));
      yaw = lerp(restYaw, def.a0, e);
      pitch = lerp(restPitch, def.p0, e);
      wrist = lerp(-1.0, 0, e);
    } else if (f <= S + A) {
      const e = easeOut(clamp01((f - S) / A));
      yaw = lerp(def.a0, def.a1, e);
      pitch = lerp(def.p0, def.p1, e);
      wrist = 0;
    } else {
      const e = easeInOut(clamp01(((f - S - A) / R - 0.3) / 0.7));
      yaw = lerp(def.a1, restYaw, e);
      pitch = lerp(def.p1, restPitch, e);
      wrist = lerp(0, -1.0, e);
    }
    this.armR.yaw.rotation.y = yaw;
    this.armR.pitch.rotation.x = pitch;
    this.wrist.rotation.x = wrist;

    // Body follows through: lean into the swing, plant the feet.
    const swingAmt = f <= S ? 0 : clamp01((f - S) / A);
    const settle = f > S + A ? 1 - clamp01((f - S - A) / R) : 1;
    this.torso.rotation.x = (finisher ? 0.35 : 0.22) * swingAmt * settle;
    this.hips.rotation.y = -yaw * 0.2;
    this.armL.yaw.rotation.y = 0.6;
    this.armL.pitch.rotation.x = -0.6;
    this.plantFeet(p);
    this.showTrail(trail, f, S, A);
  }

  // Whirlwind: arm out to the side, the whole body spins once, the trail rings all the way round.
  private poseSpin(p: PlayerState, step: AttackStep): void {
    const f = p.attackFrame;
    const S = step.startup;
    const A = step.active;
    const spin = f <= S ? 0 : easeOut(clamp01((f - S) / A));
    this.body.rotation.y = -spin * TAU;
    const windUp = easeOut(clamp01(f / S));
    this.armR.yaw.rotation.y = lerp(-0.15, -1.4, windUp);
    this.armR.pitch.rotation.x = lerp(-0.35, -1.55, windUp);
    this.wrist.rotation.x = lerp(-1.0, 0, windUp);
    this.armL.yaw.rotation.y = 1.3;
    this.armL.pitch.rotation.x = -1.3;
    this.torso.rotation.x = 0.1;
    this.plantFeet(p);
    this.showTrail(this.spinTrail, f, S, A);
  }

  // Bow: raise it and draw while the shot lines up, release on the active frame.
  private poseDraw(p: PlayerState, step: AttackStep): void {
    const f = p.attackFrame;
    const S = step.startup;
    const draw = easeOut(clamp01(f / S));
    const relax = f > S + step.active ? easeInOut(clamp01((f - S - step.active) / step.recovery)) : 0;
    this.armL.yaw.rotation.y = lerp(0.2, 0, draw);
    this.armL.pitch.rotation.x = lerp(-0.35, -1.57, draw) * (1 - relax * 0.4);
    this.armR.yaw.rotation.y = lerp(-0.15, 0.25, draw) * (1 - relax);
    this.armR.pitch.rotation.x = lerp(-0.35, -1.45, draw) * (1 - relax) + -0.35 * relax;
    this.wrist.rotation.x = -1.0;
    this.torso.rotation.y = 0.25 * draw * (1 - relax);
    this.nockedArrow.visible = f <= S; // gone once it's been loosed
    this.plantFeet(p);
  }

  private plantFeet(p: PlayerState): void {
    if (p.grounded) {
      this.legL.rotation.x = -0.35;
      this.legR.rotation.x = 0.35;
    } else {
      this.legL.rotation.x = -0.9;
      this.legR.rotation.x = 0.2;
    }
  }

  // Trail: the bright head follows the weapon, the tail fades out after the swing.
  private showTrail(trail: SlashArc, f: number, S: number, A: number): void {
    if (f <= S) return;
    const head = easeOut(clamp01((f - S) / A));
    const fade = clamp01((f - S - A) / 6);
    const tail = lerp(Math.max(0, head - 0.6), 1, fade);
    if (fade < 1) trail.set(head, tail, 1 - fade * 0.6);
  }
}
