// The content format every animated thing in the world shares: heroes, their races, mounts,
// monsters, NPCs. A species is a skeleton, a crowd-budget proxy built from boxes hung off that
// skeleton, and clips baked down to the matrices the GPU actually wants.
//
// Nothing here assumes a humanoid. A slime has four joints, this elf has twenty-two, a rig with
// fingers has fifty-odd, a quadruped has four leg chains. Joint count is data: it sets the width
// of the pose texture and nothing else.

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number]; // x, y, z, w

/** How the crowd renderer tints a box. Per-instance variation hangs off these. */
export const MAT = { fixed: 0, team: 1, hair: 2, skin: 3 } as const;
export const MAT_COUNT = 4;

/** Floats per joint per frame in a baked clip: a 3x4 matrix, row-major. */
export const MATRIX_STRIDE = 12;

export interface Joint {
  readonly name: string;
  /** Parent's index, or -1 for the root. Always lower than this joint's own index. */
  readonly parent: number;
  /** Bind pose relative to the parent, in metres. */
  readonly pos: Vec3;
  readonly rot: Quat;
}

/** One box of the crowd proxy, driven rigidly by a single joint. */
export interface ProxyBox {
  readonly joint: number;
  /** Centre, orientation and extent in the species' own bind space, in metres. */
  readonly pos: Vec3;
  readonly rot: Quat;
  readonly size: Vec3;
  readonly mat: number;
  readonly color: number;
}

export interface Clip {
  readonly name: string;
  readonly fps: number;
  readonly loop: boolean;
  readonly frames: number;
  /**
   * frames x joints x MATRIX_STRIDE, flat. Each 3x4 block already folds in the inverse bind, so
   * posing a vertex that sits in bind space is one matrix multiply and nothing else. Storing
   * matrices rather than TRS keys costs a little memory and buys indifference to what the rig
   * does - translation, scale, a slime squashing flat - all of it bakes the same way.
   */
  readonly matrices: Float32Array;
}

export interface SpeciesDef {
  readonly id: string;
  /** Metres from the ground to the top of the bind pose; drives camera framing and LOD choice. */
  readonly height: number;
  readonly joints: readonly Joint[];
  readonly proxy: readonly ProxyBox[];
  readonly clips: readonly Clip[];
}

export const jointCount = (s: SpeciesDef): number => s.joints.length;
export const clipByName = (s: SpeciesDef, name: string): Clip | undefined => s.clips.find((c) => c.name === name);

/** Total frames across every clip: the height of the species' pose texture. */
export const totalFrames = (s: SpeciesDef): number => s.clips.reduce((n, c) => n + c.frames, 0);

/** Which row of the pose texture each clip starts on, in clip order. */
export function clipRows(s: SpeciesDef): number[] {
  const rows: number[] = [];
  let row = 0;
  for (const c of s.clips) {
    rows.push(row);
    row += c.frames;
  }
  return rows;
}

/** Checks the invariants the renderer and the baker both rely on. Returns the problems found. */
export function validateSpecies(s: SpeciesDef): string[] {
  const bad: string[] = [];
  if (!s.joints.length) bad.push('no joints');
  s.joints.forEach((j, i) => {
    if (j.parent >= i) bad.push(`joint ${i} (${j.name}) has parent ${j.parent}, which is not earlier`);
    if (j.parent < -1) bad.push(`joint ${i} (${j.name}) has parent ${j.parent}`);
  });
  if (s.joints.length && s.joints[0].parent !== -1) bad.push('joint 0 must be the root');
  s.proxy.forEach((b, i) => {
    if (b.joint < 0 || b.joint >= s.joints.length) bad.push(`box ${i} drives joint ${b.joint}, which does not exist`);
    if (b.size.some((v) => !(v > 0))) bad.push(`box ${i} has size ${b.size.join('x')}`);
  });
  s.clips.forEach((c) => {
    const want = c.frames * s.joints.length * MATRIX_STRIDE;
    if (c.matrices.length !== want) bad.push(`clip ${c.name} has ${c.matrices.length} floats, expected ${want}`);
    if (c.frames < 1) bad.push(`clip ${c.name} has ${c.frames} frames`);
  });
  return bad;
}
