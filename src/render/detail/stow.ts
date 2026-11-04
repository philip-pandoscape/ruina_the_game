import * as THREE from 'three';
import type { Side } from './body';

// Where the hero's weapon goes when it isn't in hand: on foot out of a fight, and travelling. The
// close-up hero (src/render/character.ts) hangs the weapon's model there; the poses
// (humanoid.ts) reach a hand to it to draw and to sheathe, so the weapon in the hand is exactly
// where the one put away was at the moment it changes over.

type Vec3 = readonly [number, number, number];

/**
 * A weapon put away: where its grip goes, the way it points from there (the hand's -y, the way the
 * blade runs from the hilt) and the way its flat faces (the hand's z), in the torso's frame (the
 * hips' for `parent: 'hips'`).
 */
export interface Stowed {
  at: Vec3;
  along: Vec3;
  face: Vec3;
  parent?: 'hips';
}

/** The staff over the right shoulder, the bow up by the left: long things across the back. */
const ACROSS_BACK: Record<string, Stowed> = {
  staff: { at: [-0.33, 0.53, -0.24], along: [0.82, -0.57, 0], face: [0, 0, -1] },
  bow: { at: [0.1, 0.38, -0.25], along: [-0.6, -0.8, 0], face: [0.8, -0.6, 0] },
};

/**
 * On foot: the sword and the club hang at the right hip, the hilt forward of the swinging arm and
 * the blade back and down past the leg, clear of the cape (a cape hides a back like nothing else,
 * and the hero's arms are too short to draw across the body from the left).
 */
const ON_FOOT: Record<string, Stowed> = {
  sword: { at: [-0.25, 0.0, 0.1], along: [-0.1, -0.5, -0.86], face: [-1, 0, 0] },
  club: { at: [-0.25, 0.02, 0.1], along: [-0.1, -0.7, -0.7], face: [-1, 0, 0] },
  ...ACROSS_BACK,
};

/** Lying out flat (swimming, gliding): the sword and club along the body toward the feet. */
const FLAT: Record<string, Stowed> = {
  sword: { at: [0.26, 0.1, 0.03], along: [0.06, -0.97, -0.2], face: [1, 0, 0] },
  club: { at: [-0.26, 0.1, 0.03], along: [-0.06, -0.97, -0.2], face: [-1, 0, 0] },
  ...ACROSS_BACK,
};

/** On a horse: down the flank, cavalry fashion, behind the leg. */
const SADDLE: Record<string, Stowed> = {
  sword: { at: [0.27, 0.05, 0.02], along: [0.2, -0.75, -0.62], face: [1, 0, 0] },
  club: { at: [-0.27, 0.05, 0.02], along: [-0.2, -0.75, -0.62], face: [-1, 0, 0] },
  ...ACROSS_BACK,
};

/** At the oars (no backrest): back and out over the boat. */
const OARS: Record<string, Stowed> = {
  sword: { at: [0.26, 0.12, 0], along: [0.3, -0.3, -0.9], face: [1, 0, 0] },
  club: { at: [-0.26, 0.12, 0], along: [-0.3, -0.3, -0.9], face: [-1, 0, 0] },
  ...ACROSS_BACK,
};

/** On a seat with a backrest or a wheel to hold (cart, roadster, helm): across the lap. */
const LAP: Record<string, Stowed> = {
  sword: { at: [-0.28, 0.1, 0.16], along: [1, 0, 0.1], face: [0, 1, 0], parent: 'hips' },
  club: { at: [-0.26, 0.1, 0.16], along: [1, 0, 0.1], face: [0, 1, 0], parent: 'hips' },
  staff: { at: [-0.4, 0.1, 0.16], along: [1, 0, 0], face: [0, 1, 0], parent: 'hips' },
  bow: { at: [0, 0.1, 0.02], along: [0, 0, -1], face: [1, 0, 0], parent: 'hips' },
};

/** Where each weapon is put away for a way of travelling ('' is on foot). */
export function stowedFor(travel: string): Record<string, Stowed> {
  if (!travel) return ON_FOOT;
  if (travel === 'swim' || travel === 'glide') return FLAT;
  if (travel === 'ride') return SADDLE;
  if (travel === 'row') return OARS;
  return LAP;
}

/** The hand that draws and sheathes each weapon: the bow is the left hand's, the rest the right's. */
export const DRAWING_HAND: Record<string, Side> = { sword: 'R', club: 'R', staff: 'R', bow: 'L' };

/** The turn that puts a weapon, as held in the hand, the way a Stowed says. */
export function stowedTurn(s: Stowed, out: THREE.Quaternion): THREE.Quaternion {
  const y = new THREE.Vector3(...s.along).normalize().negate();
  const z = new THREE.Vector3(...s.face);
  z.addScaledVector(y, -z.dot(y)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
