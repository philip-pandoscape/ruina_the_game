import * as THREE from 'three';

// The scene's origin moves with you (a floating origin). The rules keep every position in the world's
// own coordinates, in 64-bit numbers; the graphics card works in 32-bit ones, which keep millimetres
// only within a few kilometres of their origin. So the scene stands shifted by the origin
// (OpenStage.rebase: everything in it, camera and lights too, as the page places it in the world),
// and what the card is handed is near its origin wherever you are. The origin moves in whole steps
// on a lattice, only once the camera is far from it, so near the world's origin (Emberholm) it never
// moves and nothing is drawn differently.
//
// Patterns laid in the world (the ground's textures, the sea's ripples and foam, the grain of built
// things) are drawn from positions relative to the origin plus what this module works out from the
// origin in 64-bit numbers, so they stay where they are in the world as the origin moves, and keep
// their precision far from it.

/** How far the camera may go from the scene's origin, on either axis, before the origin moves (m). */
export const ORIGIN_REACH = 3072;
/** The origin stands on a lattice this far apart (m). */
export const ORIGIN_STEP = 2048;

/** Where the scene's origin stands with the camera at (x, z), from where it stands now: still, while the camera is within reach of it; else on the lattice point nearest the camera. */
export function nextOrigin(ox: number, oz: number, x: number, z: number): [number, number] {
  if (Math.abs(x - ox) <= ORIGIN_REACH && Math.abs(z - oz) <= ORIGIN_REACH) return [ox, oz];
  // (+ 0: never a negative zero.)
  return [Math.round(x / ORIGIN_STEP) * ORIGIN_STEP + 0, Math.round(z / ORIGIN_STEP) * ORIGIN_STEP + 0];
}

/** The fraction of a number, in [0, 1) for negatives too (GLSL's fract). */
export const fract = (v: number): number => v - Math.floor(v);

/** An angle brought to within half a turn of 0, its sine and cosine the same. */
export function wrapTurn(a: number): number {
  const turn = Math.PI * 2;
  return a - turn * Math.round(a / turn);
}

/**
 * For a texture repeating every 1/`scale` metres, laid in the world: what to add to a position
 * relative to the origin (in repeats), so it's drawn as at the world's position. The whole repeats
 * between drop out.
 */
export function repeatShift(o: number, scale: number): number {
  return fract(o * scale);
}

/** The constants of the hashed value noise the sea draws (water.ts): fract(sin(dot(lattice, c)) × 43758.5453). */
export const NOISE_HASH: [number, number] = [127.1, 311.7];

/**
 * For value noise on a lattice `scale` per metre, laid in the world: what to add to a position
 * relative to the origin (the fraction of the origin's lattice coordinates), and what to add to the
 * hash's sine for the whole part (`dot(whole, c)` wrapped to a turn, worked out here in 64 bits), so
 * the noise is the world's at every point, and its hash takes small numbers wherever you are.
 */
export function noiseShift(ox: number, oz: number, scale: number, c: [number, number] = NOISE_HASH): { x: number; z: number; phase: number } {
  const ux = ox * scale;
  const uz = oz * scale;
  const ix = Math.floor(ux);
  const iz = Math.floor(uz);
  return { x: ux - ix, z: uz - iz, phase: wrapTurn(ix * c[0] + iz * c[1]) };
}

/** Whatever needs to know when the origin moves (the ground's, the sea's and the grain's patterns). */
type Follower = (ox: number, oz: number) => void;
const followers = new Set<Follower>();
let current: [number, number] = [0, 0];

/** The scene's origin now. */
export function sceneOrigin(): [number, number] {
  return current;
}

/** Calls `f` with the origin now and whenever it moves (until the returned function is called). */
export function followOrigin(f: Follower): () => void {
  followers.add(f);
  f(current[0], current[1]);
  return () => followers.delete(f);
}

/** Moves the scene's origin (OpenStage.rebase): every pattern laid in the world follows. */
export function setSceneOrigin(ox: number, oz: number): void {
  if (ox === current[0] && oz === current[1]) return;
  current = [ox, oz];
  for (const f of followers) f(ox, oz);
}

/** A point in the world as the scene has it (relative to the origin), for three.js's own maths: projecting to the screen, raycasting. */
export function toScene(v: THREE.Vector3): THREE.Vector3 {
  return v.set(v.x - current[0], v.y, v.z - current[1]);
}

/** A point in three.js's own coordinates (a hit, a world position) back in the world's. */
export function fromScene(v: THREE.Vector3): THREE.Vector3 {
  return v.set(v.x + current[0], v.y, v.z + current[1]);
}

const turn = new THREE.Matrix4();

/**
 * Turns a camera (or a light) standing at its place in the world to look at a point in the world: as
 * three.js's lookAt, but from the positions the page gives (the world's), so it's the same with the
 * camera in the scene, shifted by its origin, as out of it.
 */
export function lookAtWorld(o: THREE.Object3D, target: THREE.Vector3): void {
  turn.lookAt(o.position, target, o.up);
  o.quaternion.setFromRotationMatrix(turn);
}
