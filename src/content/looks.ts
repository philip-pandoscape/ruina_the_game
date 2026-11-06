// What a thing looks like, as its content file says (`look`): a body built into the game, by name,
// with its settings, or a made model fitted into the thing's size, or both, the body drawn at once
// and the model in its place once it has loaded. A thing whose look names neither is drawn with
// its kind's plain body. The bodies are src/render's code (a building's in
// src/render/models/structures.ts, a creature's species in src/render/creatures/), the made models
// files in src/render/assets/models. Drawing only: the rules never read a look.

/** A made model: files in src/render/assets/models, fitted into the thing's box, its foot on the ground. */
export interface MadeModel {
  /** Its files, without the extension: with more than one, a placement's seed picks (or its tint, with `tints`). */
  files: string[];
  /** The colour each file is painted (its awning, say), for a placement's tint to pick the one nearest in hue. */
  tints?: number[];
  /** The box it is fitted into, in metres, where it isn't the thing's own size. */
  w?: number;
  h?: number;
  d?: number;
  /** A turn about the vertical (radians) before it is fitted, for a model whose front isn't +Z. */
  yaw?: number;
  /** How far it sinks into the ground, so it sits on a slope without a gap under it. */
  sink?: number;
  /** Parts of the body that stay when the model comes (the windmill's turning sails). */
  keep?: string[];
}

/** A building's, prop's, crop's, pack's, animal's or ride's look. */
export interface Look {
  /** A body built into the game, by name. */
  body?: string;
  model?: MadeModel;
}
