import * as THREE from 'three';
import type { Side } from './body';

// Where the hero's weapon goes when it isn't in hand, on foot out of a fight. The close-up hero
// (src/render/character.ts) hangs the weapon's model there; the poses (humanoid.ts) reach a hand
// to it to draw and to sheathe, so the weapon in the hand is exactly where the one put away was at
// the moment it changes over. Travelling (swimming, gliding, riding, driving, rowing, sailing) and
// with a trade pack on the back, the weapon isn't drawn at all (character.ts).

type Vec3 = readonly [number, number, number];

/**
 * A weapon put away: where its grip goes, the way it points from there (the hand's -y, the way the
 * blade runs from the hilt) and the way its flat faces (the hand's z), in the torso's frame.
 */
export interface Stowed {
  at: Vec3;
  along: Vec3;
  face: Vec3;
}

/**
 * The sword and the club hang at the right hip, the hilt forward of the swinging arm and the blade
 * back and down past the leg, clear of the cape (a cape hides a back like nothing else, and the
 * hero's arms are too short to draw across the body from the left). Long things go across the
 * back: the staff over the right shoulder, the bow up by the left.
 */
export const STOWED: Record<string, Stowed> = {
  sword: { at: [-0.25, 0.0, 0.1], along: [-0.1, -0.5, -0.86], face: [-1, 0, 0] },
  club: { at: [-0.25, 0.02, 0.1], along: [-0.1, -0.7, -0.7], face: [-1, 0, 0] },
  staff: { at: [-0.33, 0.53, -0.24], along: [0.82, -0.57, 0], face: [0, 0, -1] },
  bow: { at: [0.1, 0.38, -0.25], along: [-0.6, -0.8, 0], face: [0.8, -0.6, 0] },
};

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
