import * as THREE from 'three';
import type { PlayerState } from '../sim/types';
import { comboShape, JUMP, MOVE, NO_ABILITY } from '../tuning';
import { DetailRig } from './detail/rig';
import { HERO_RIG, HERO_TEAM_COLOURS, HERO_WEAPONS } from '../content/creatures/hero';
import { SlashArc } from './vfx';
import { poseHumanoid, STRIDE } from './detail/humanoid';
import { pose, type PoseInput } from '../content/pose';
import { CLUB_SWINGS, SLASHES, SPIN, STAFF_SWINGS, type SlashDef } from './detail/swings';

const TAU = Math.PI * 2;

// Turning the rules' idea of a character into the neutral input the poses take. This is the
// only place PlayerState and the poses meet, which is what lets the clip baker drive the same
// motion from a time value instead.
export function inputFromPlayer(p: PlayerState, frame: number, seat = ''): PoseInput {
  const hs = Math.hypot(p.vel.x, p.vel.z);
  const combo = comboShape(p.weapon, p.comboVariants);
  const attacking = p.mode === 'attack';
  const idx = attacking ? Math.min(p.attackIndex, combo.length - 1) : -1;
  return pose({
    run: p.mode === 'normal' && p.grounded ? Math.max(0, Math.min(1, hs / MOVE.runSpeed)) : 0,
    phase: (p.runPhase / STRIDE) * Math.PI * 2,
    time: frame / 60,
    grounded: p.grounded,
    rise: Math.max(-1, Math.min(1, p.vel.y / JUMP.velocity)),
    weapon: p.weapon,
    attackIndex: idx,
    attackFrame: p.attackFrame,
    step: idx >= 0 ? combo[idx] : null,
    comboLength: combo.length,
    actionId: p.mode === 'action' ? p.actionId : -1,
    actionFrame: p.actionFrame,
    castAbility: p.mode === 'cast' && p.castAbility !== NO_ABILITY ? p.castAbility : -1,
    down: p.downFrame >= 0,
    stunned: p.stun > 0,
    landFrame: p.landFrame,
    landImpact: p.landImpact,
    takeoffFrame: p.takeoffFrame,
    flipFrame: p.flipFrame,
    travel: p.mode === 'swim' ? 'swim' : p.mode === 'glide' ? 'glide' : p.mode === 'ride' ? seat || 'sit' : '',
    bank: p.bank,
    carry: p.pack !== 0 && p.mode !== 'ride',
    effort: Math.min(1, hs / 6),
  });
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function angleLerp(a: number, b: number, t: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

// The player character, built from simple shapes and animated in code. Carries whichever weapon
// the build has equipped: sword, club, staff or bow.
export class Hero {
  readonly root = new THREE.Group();
  // The body comes from content (src/content/creatures/hero.ts); these are handles into it, so
  // the motion lives in detail/humanoid.ts, shared by every humanoid race.
  private rig: DetailRig;
  /** Trails hang off the shoulder, so the Hero keeps a handle on the torso. */
  private torso: THREE.Group;
  private nockedArrow: THREE.Group;
  private weaponShown = -1;
  /** How to sit while riding (the vehicle's seat pose), set by whoever draws the vehicle. */
  seatPose = '';
  /** Where a pack on your back hangs from. */
  get torsoJoint(): THREE.Object3D {
    return this.torso;
  }
  private trails: Record<string, SlashArc[]>;
  private spinTrail: SlashArc;

  constructor() {
    this.rig = new DetailRig(HERO_RIG);
    this.root.add(this.rig.root);
    const j = (name: string) => this.rig.joint(name);
    this.torso = j('torso');
    this.nockedArrow = this.rig.attachment('arrow');

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
    const c = HERO_TEAM_COLOURS[team === 1 ? 1 : 0];
    this.rig.recolour('tunic', c.tunic);
    this.rig.recolour('cape', c.cape);
  }

  // 0 sword, 1 club, 2 staff, 3 bow.
  setWeapon(weapon: number): void {
    this.weaponShown = weapon;
    this.rig.showAttachment(HERO_WEAPONS[weapon] ?? null);
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

    const fb = poseHumanoid(this.rig, inputFromPlayer(p, frame, this.seatPose));

    // Feedback the poses cannot do themselves, because it is not a joint.
    this.nockedArrow.visible = fb.arrow;
    for (const list of Object.values(this.trails)) for (const arc of list) arc.hide();
    this.spinTrail.hide();
    if (fb.trail) {
      const arc = fb.trail.set === 'spin' ? this.spinTrail : (this.trails[fb.trail.set]?.[fb.trail.index] ?? this.trails[fb.trail.set]?.[0]);
      arc?.set(fb.trail.head, fb.trail.tail, fb.trail.alpha);
    }
  }
}
