import { angleBetween, boneChanges, modelPositions, modelTurns } from './pose';
import type { Note } from './store';
import type { Posable, Take } from './types';

// How close the animation, as the code has it now, comes to a corrected pose: each bone the user
// changed, as turned in the body's own space (so a fix made higher up the chain counts), and each
// joint that moved, by distance. "was" is the same measured on the pose before the correction.

export interface Measure {
  bones: Array<{ name: string; now: number; was: number }>;
  joints: Array<{ name: string; now: number; was: number }>;
  /** The worst bone (degrees) and joint (metres), now and before the correction. */
  worstDeg: number;
  worstM: number;
  wasDeg: number;
  wasM: number;
  /** 0..1: how much of the way from the old pose to the corrected one the animation has come. */
  progress: number;
}

export function measure(take: Take, rig: Posable, note: Note): Measure | null {
  const fix = note.fix;
  if (!fix || note.frame === undefined || note.frame >= take.frames) return null;
  rig.apply(take.snapshot(note.frame));
  const nowT = modelTurns(rig);
  const nowP = modelPositions(rig);
  rig.apply(fix.after);
  const tgtT = modelTurns(rig);
  const tgtP = modelPositions(rig);
  rig.apply(fix.before);
  const wasT = modelTurns(rig);
  const wasP = modelPositions(rig);

  const names = new Set([...fix.touched, ...boneChanges(fix.before, fix.after).map((c) => c.bone)]);
  const bones = [...names]
    .filter((n) => nowT[n] && tgtT[n] && wasT[n])
    .map((name) => ({ name, now: angleBetween(nowT[name], tgtT[name]), was: angleBetween(wasT[name], tgtT[name]) }));
  const joints = Object.keys(tgtP)
    .filter((k) => wasP[k] && nowP[k] && dist(wasP[k], tgtP[k]) > 0.01 && !/^(palm|fingers|fingertips)/.test(k))
    .map((name) => ({ name, now: dist(nowP[name], tgtP[name]), was: dist(wasP[name], tgtP[name]) }));
  const worstDeg = Math.max(0, ...bones.map((b) => b.now));
  const wasDeg = Math.max(0, ...bones.map((b) => b.was));
  const worstM = Math.max(0, ...joints.map((j) => j.now));
  const wasM = Math.max(0, ...joints.map((j) => j.was));
  // Progress by the worse of the two, so a fix that gets the angles but not the hand isn't called done.
  const p = (now: number, was: number) => (was > 1e-6 ? Math.max(0, Math.min(1, 1 - now / was)) : 1);
  const progress = Math.min(p(worstDeg, wasDeg), p(worstM, wasM));
  return { bones, joints, worstDeg, worstM, wasDeg, wasM, progress };
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Within a few degrees and a couple of centimetres: the code now makes the corrected pose. */
export const matches = (m: Measure): boolean => m.worstDeg < 4 && m.worstM < 0.025;
