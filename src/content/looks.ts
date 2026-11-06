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

/** How a townsperson can wear their hair, and their beard. */
export const HAIRS = ['short', 'long', 'braid', 'ponytail', 'bun', 'bald', 'none'] as const;
export type Hair = (typeof HAIRS)[number];
export const BEARDS = ['bushy', 'long', 'stubble', 'moustache'] as const;

/** A colour, as #rrggbb. */
type Colour = string;

/**
 * A townsperson's look: the townsfolk's body (src/render/models/villagers.ts) built and dressed by
 * these, and an outfit over it (an apron and a basket, a coat and a spyglass), by name.
 */
export interface VillagerLook {
  outfit?: string;
  skin: Colour;
  /** Build: shoulder width, depth, torso height, arm thickness, leg length (1 is the hero's). */
  w?: number;
  d?: number;
  h?: number;
  arm?: number;
  leg?: number;
  /** A forward stoop of the upper body (radians). */
  hunch?: number;
  shirt: Colour;
  sleeve?: Colour;
  /** Sleeves rolled to the elbow. */
  rolled?: boolean;
  gloves?: Colour;
  pants: Colour;
  boots: Colour;
  tallBoots?: boolean;
  /** A robe or dress down to the ankles, in place of trousers, and a band round its hem. */
  skirt?: Colour;
  trim?: Colour;
  /** Long coat tails behind the legs. */
  tails?: Colour;
  /** Its colour (leather if none is given), or null for no belt. */
  belt?: Colour | null;
  hair: Colour;
  style: Hair;
  /** A beard, in the hair's colour. */
  beard?: (typeof BEARDS)[number];
  blush?: boolean;
  /** How the arms rest (radians about x, y and z), and which are free to gesture. */
  rest?: { l?: [number, number, number]; r?: [number, number, number] };
  free?: Array<'l' | 'r'>;
}

/** A townsperson's look as their file gives it (the zone holds it as it is), if it gives one. */
export const villagerLook = (raw: unknown): VillagerLook | undefined => (raw && typeof raw === 'object' ? (raw as VillagerLook) : undefined);
