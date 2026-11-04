import type { AttackStep } from '../tuning';

// What a pose needs to know, with nothing from the rules in it. The live renderer fills this in
// from PlayerState every frame; the clip baker fills it in from a time along an animation. Same
// struct, same pose functions, so a creature's crowd LOD is its close-up motion sampled - not a
// second set of animations somebody has to keep in step.

export interface PoseInput {
  /** 0..1: how hard it is running. Scales the whole stride. */
  run: number;
  /** Stride phase, radians. */
  phase: number;
  /** Seconds, for idle breathing and the cast bob. */
  time: number;
  grounded: boolean;
  /** Vertical speed over jump speed, -1..1. */
  rise: number;
  weapon: number;

  /** Which combo step is swinging, or -1. */
  attackIndex: number;
  attackFrame: number;
  /** The shape of that swing; null unless attacking. */
  step: AttackStep | null;
  /** How many steps the combo has, so the last one can hit harder. */
  comboLength: number;

  /** Movement skill in progress, or -1. */
  actionId: number;
  actionFrame: number;

  /** Ability being cast, or -1. */
  castAbility: number;

  down: boolean;
  stunned: boolean;

  /** Landing squash and take-off stretch. */
  landFrame: number;
  landImpact: number;
  takeoffFrame: number;
  /** Double-jump flip, or -1. */
  flipFrame: number;

  /**
   * Open-world body states: '' on foot, otherwise 'swim', 'glide', or a seat pose
   * ('drive', 'sit', 'row', 'helm', 'ride').
   */
  travel: string;
  /** Lean into a turn, -1..1 (+ is left). */
  bank: number;
  /** A pack on the back: arms to the straps, a forward lean. */
  carry: boolean;
  /** How hard the stroke, stride or pull is going, 0..1 (swimming, rowing, a mount's gait). */
  effort: number;
}

export const NEUTRAL_POSE: PoseInput = {
  run: 0,
  phase: 0,
  time: 0,
  grounded: true,
  rise: 0,
  weapon: 0,
  attackIndex: -1,
  attackFrame: 0,
  step: null,
  comboLength: 1,
  actionId: -1,
  actionFrame: 0,
  castAbility: -1,
  down: false,
  stunned: false,
  landFrame: 99,
  landImpact: 0,
  takeoffFrame: 99,
  flipFrame: -1,
  travel: '',
  bank: 0,
  carry: false,
  effort: 0,
};

export const pose = (over: Partial<PoseInput> = {}): PoseInput => ({ ...NEUTRAL_POSE, ...over });

/** One baked animation: what the creature is doing at each point along it. */
export interface ClipDriver {
  name: string;
  frames: number;
  fps?: number;
  loop?: boolean;
  /** What it is doing at `t` (0..1 through the clip), on frame `frame`. */
  at(t: number, frame: number): Partial<PoseInput>;
}

/** What a pose wants drawn that is not a joint: only the close-up renderer acts on these. */
export interface PoseFeedback {
  /** Whether the nocked arrow is still on the string. */
  arrow: boolean;
  /** A weapon trail to draw, if the pose is mid-swing. */
  trail: { set: 'sword' | 'club' | 'staff' | 'spin'; index: number; head: number; tail: number; alpha: number } | null;
}
