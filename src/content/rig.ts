import type * as THREE from 'three';

// The shape of a close-up character, as content describes it. No renderer here: the runtime
// that turns one of these into meshes lives in src/render/detail/rig.ts.
//
// A close-up character, described rather than built by hand. A rig is joints (a tree of empty
// groups you can rotate) and parts (shapes hung off them), so adding a race or an NPC is a data
// file instead of another hundred lines of `new THREE.Group()`.
//
// Poses stay as code, in the renderer that drives them: humanoid races share their motion and
// differ in their build, which is the same split real games make.

export type Vec3 = readonly [number, number, number];

export type ShapeDef =
  | { kind: 'box'; w: number; h: number; d: number; r?: number }
  | { kind: 'sphere'; r: number; widthSeg?: number; heightSeg?: number }
  | { kind: 'cylinder'; top: number; bottom: number; h: number; sides?: number }
  | { kind: 'cone'; r: number; h: number; sides?: number }
  | { kind: 'torus'; r: number; tube: number; radialSeg?: number; tubularSeg?: number; arc?: number }
  | { kind: 'ico'; r: number; detail?: number };

export interface MaterialDef {
  color: number;
  emissive?: number;
  /** Unlit, for things that should glow rather than take the scene's light. */
  basic?: boolean;
}

export interface JointDef {
  name: string;
  /** Parent joint, or undefined for one hanging off the rig root. */
  parent?: string;
  pos?: Vec3;
}

export interface PartDef {
  joint: string;
  shape: ShapeDef;
  mat: string;
  pos?: Vec3;
  outline?: number | false;
  castShadow?: boolean;
  /** Escape hatch for the handful of shapes that need a rotate or a squash first. */
  tweak?: (g: THREE.BufferGeometry) => void;
}

export interface RigDef {
  id: string;
  materials: Record<string, MaterialDef>;
  joints: JointDef[];
  parts: PartDef[];
  /**
   * Things carried rather than worn. `exclusive` ones are weapons: showing one hides the others.
   * Anything else (a nocked arrow, a lantern) is left for the renderer to toggle itself.
   */
  attachments?: Record<string, { joint: string; exclusive?: boolean; parts: PartDef[] }>;
}
