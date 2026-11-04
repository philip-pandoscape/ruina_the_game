import type { AttackStep } from '../tuning';

// What a pose needs to know, with nothing from the rules in it. The live renderer fills this in
// from PlayerState every frame; the clip baker fills it in from a time along an animation. Same
// struct, same pose functions, so a creature's crowd LOD is its close-up motion sampled - not a
// second set of animations somebody has to keep in step.

export interface PoseInput {
  /**
   * Ground speed over run speed while on foot: 0 standing, ~0.43 at walking pace, 1 running, ~1.4
   * sprinting. Picks the gait and scales the stride. Zero in the air and during actions.
   */
  run: number;
  /** Stride phase, radians: one full turn is a left step and a right step. */
  phase: number;
  /** Horizontal speed over run speed whatever the body is doing (a running leap, a lunge). */
  speed: number;
  /**
   * Which way the body is travelling relative to where it faces, radians: 0 ahead, +pi/2 to the
   * left, -pi/2 to the right, pi backwards. Strafing, backing off, and which way a dodge, a leap or
   * a flip goes. During a movement skill it is the way the skill committed to.
   */
  heading: number;
  /** 0..1 how far down into a crouch. */
  crouch: number;
  /**
   * 0..1 how far from standing into the stride the legs are, or -1 to take it from the speed. The
   * close-up renderer eases it over a few frames, so stopping and starting don't snap the feet.
   */
  stride: number;
  /** Leaning into a turn while running, -1..1 (+ is a turn to the left). */
  lean: number;
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
  /** How far into the cast, and how long the cast is, in frames. */
  castFrame: number;
  castFrames: number;

  down: boolean;
  /** Frames since being knocked down. */
  downFrame: number;
  stunned: boolean;
  /** Frames since the hit that stunned you. */
  stunFrame: number;
  /**
   * Which way that hit shoved you, relative to where you face (radians, as `heading`: 0 forward,
   * + to the left): π is a blow from the front, 0 one from behind.
   */
  hit: number;

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
  speed: 0,
  heading: 0,
  crouch: 0,
  stride: -1,
  lean: 0,
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
  castFrame: 0,
  castFrames: 1,
  down: false,
  downFrame: 0,
  stunned: false,
  stunFrame: 0,
  hit: Math.PI,
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
  /** 0..1 how far the bowstring follows the drawing hand back (0 lets it snap straight). */
  draw: number;
  /** 0..1 how firmly each foot (left, right) is planted on the ground, for keeping it there. */
  plant: [number, number];
  /**
   * A weapon trail to draw, if the pose is mid-swing. `head` and `tail` run 0..1 through the
   * strike's active frames; the trail's shape is traced from the swing itself.
   */
  trail: { set: 'sword' | 'club' | 'staff' | 'spin'; index: number; head: number; tail: number; alpha: number } | null;
}
