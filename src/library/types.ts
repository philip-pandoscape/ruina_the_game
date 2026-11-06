import type * as THREE from 'three';

// The content library's own vocabulary (/dev/library.html, src/library/main.ts). Everything it shows
// is a Subject. One that moves (the hero, a slime, a cow, a villager, a library clip on the hero)
// lists its animations and makes a Take of one: the animation played through once, every frame kept,
// so any frame can be shown at once, scrubbed backwards, drawn as a ghost or corrected by hand. How a
// subject is animated (poses worked out in code, baked clips, a model's own animate()) stays its own
// business. A gallery (every model side by side, the buildings, a crowd) lists its entries instead
// and draws one in a scene of its own, as it always looked (Gallery).

export type Vec3 = [number, number, number];

/** A joint's local transform: position x y z, quaternion x y z w, scale x y z. */
export type JointPose = number[];

/** A body's pose on one frame, joint by joint (by name), and whatever else it needs to show it again. */
export interface Snapshot {
  joints: Record<string, JointPose>;
  extra?: Record<string, unknown>;
}

export interface Bone {
  name: string;
  object: THREE.Object3D;
  parent: string | null;
  /** L, R or centre: the skeleton is drawn in a colour per side. */
  side: 'L' | 'R' | 'C';
  /** Shown in the skeleton but not for editing (a rig's root, an eye socket). */
  locked?: boolean;
  /** Left out of the skeleton drawing (fingers, a cape's hidden joints): still edited from the list. */
  minor?: boolean;
}

/** A stretch of the timeline the animation spends doing one thing: a swing's wind-up, the air, a landing. */
export interface Phase {
  from: number;
  /** Inclusive. */
  to: number;
  label: string;
  /** Colours it: 'windup' | 'strike' | 'recover' | 'air' | 'land' | 'hurt' | 'move' | 'travel' | 'other'. */
  kind: string;
}

/** What drives a frame, in words (the HUD) and as data (the prompt). */
export interface FrameInfo {
  line: string;
  detail?: Record<string, unknown>;
}

/** A body that can be posed from a snapshot: the take's own, or a ghost of it. */
export interface Posable {
  root: THREE.Object3D;
  /** The body's own space (x to its left, y up, z ahead): where "model space" numbers are measured from. */
  space: THREE.Object3D;
  bones: Bone[];
  /** Points worth following besides the joints (a blade's tip), each in a bone's own space. */
  points?: Array<{ name: string; bone: string; at: Vec3 }>;
  apply(s: Snapshot): void;
  capture(): Snapshot;
  dispose(): void;
}

export interface Framing {
  /** Where the camera looks (the middle of the body), and from how far. */
  target: Vec3;
  distance: number;
  /** Rough height, for thumbnails and the skeleton's joint size. */
  height: number;
}

export interface Take extends Posable {
  frames: number;
  fps: number;
  loop: boolean;
  /** Frames worked out so far (they are baked in the background, start to end). */
  readonly baked: number;
  /** Works out up to this many more frames; returns whether all are done. */
  bake(budget: number): boolean;
  /** Shows a frame exactly as the game would draw it. */
  show(frame: number): void;
  /** The pose on a frame, joint by joint. */
  snapshot(frame: number): Snapshot;
  info(frame: number): FrameInfo;
  phases: Phase[];
  /** How far the body has travelled over the ground by a frame (x, z) and where the ground is (y, water). */
  ground(frame: number): { x: number; z: number; y: number; water: number | null; floor: boolean };
  /** Another body like this one, posed only from snapshots: for ghosts and onion skins. */
  ghost(): Posable;
  /** Shows or hides what's drawn besides the body (a weapon's swoosh). */
  setDecor?(on: boolean): void;
  framing: Framing;
  /** The backdrop it is drawn on (stage.ts BACKDROPS): the library's studio unless it says otherwise. */
  backdrop?: Backdrop;
}

/** The backdrops a take can be drawn on (stage.ts). */
export type Backdrop = 'studio' | 'outdoors' | 'bench' | 'retarget';

export interface AnimDef {
  id: string;
  label: string;
  group: string;
  /** Its length (0 until it has loaded, for a clip in a file: the take knows). */
  frames: number;
  fps: number;
  loop: boolean;
  /** A line about it for the library. */
  note?: string;
  /** Shown in the list instead of its length (a gallery's entries: how many models, a plan's size). */
  tag?: string;
}

export interface OptionDef {
  id: string;
  label: string;
  /** The values it takes, as buttons. Without, a value typed in (or given in the address), '' for none. */
  choices?: Array<{ value: string; label: string }>;
  value: string;
  /** What a typed value looks like, shown in its empty box. */
  hint?: string;
}

export type Options = Record<string, string>;

/** Where a subject's animation is made, for whoever fixes it (the prompt). */
export interface Source {
  /** How it moves, in a few sentences. */
  system: string;
  files: Array<{ path: string; what: string }>;
  /** Axis and angle conventions of its joints. */
  conventions?: string;
  /** Tests that hold it together, which a change must still pass. */
  checks?: Array<{ command: string; what: string }>;
}

/**
 * A gallery entry, drawn in a scene of its own (its own renderer, lights and ground, as the page it
 * came from drew it) in the library's viewport: every model side by side, the buildings, a crowd.
 */
export interface Gallery {
  /** The picture and whatever is drawn over it (labels), put in the viewport. */
  readonly el: HTMLElement;
  /** Everything it loads has loaded: ready to look at and to measure. */
  ready(): boolean;
  /** Steps whatever moves in it and draws it (dt in seconds). */
  frame(dt: number): void;
  /** Numbers about what is shown, for the side panel: a heading and rows of name and value. */
  numbers?(): Array<{ heading: string; rows: Array<[string, string]> }>;
  /** What tests and tools call, as window.__library.gallery(). */
  readonly api: Record<string, unknown>;
  dispose(): void;
}

export interface Subject {
  id: string;
  name: string;
  /** 'Heroes' | 'Mobs' | 'Creatures' | 'Townsfolk' | 'Mounts' | 'Crowd' | 'Rigs' | 'Galleries'. */
  group: string;
  blurb: string;
  options: OptionDef[];
  anims(opts: Options): AnimDef[];
  /** An animation its list doesn't hold (any clip in a file, named in the address), or null. */
  find?(animId: string, opts: Options): AnimDef | null;
  /** Loads whatever it needs first (a made body, a clip's file). */
  ready?(opts: Options, animId?: string): Promise<void>;
  /** Makes a take of one of its animations: a subject that moves has this... */
  take?(animId: string, opts: Options): Take;
  /** ...and a gallery this instead: it draws one of its entries in the viewport (host). */
  gallery?(host: HTMLElement, animId: string, opts: Options): Gallery;
  /** The options that make a difference to this animation (the rest are left out of its notes' key). */
  optionsFor?(animId: string, opts: Options): Options;
  source(opts: Options): Source;
  /** Where a single animation is defined, in a line. */
  animSource(animId: string, opts: Options): string;
}
