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

/** A colour as its red, green and blue parts (0 to 1), as the light is worked out in. */
type Rgb = [number, number, number];

/** A lamp a cave's colours are baked from: its colour, how bright, and how far it reaches. */
export interface CaveLamp {
  colour: Rgb;
  power: number;
  reach: number;
}

/**
 * How a cave is dressed (an instance drawn as one: src/render/open/dungeonView.ts), round its origin.
 * Its rock lines a hall, and the tunnel off the hall's north wall if it has one, along the faces of
 * the walls it names (boxes of its own, so the rock stands where the walls are solid); the back of a
 * waterfall closes the hall's south end if it has one, the way out through it. Drawing only: the
 * rules never read it.
 */
export interface CaveDressing {
  /** The boxes that are the hall's walls, each bounding it with its face toward it, and how high its ceiling is. */
  hall: { west: string; east: string; south: string; north: string; ceiling: number };
  /** A tunnel north out of the hall: the boxes that are its walls, the one that ends it, and its ceiling. */
  tunnel?: { west: string; east: string; end: string; ceiling: number };
  /** The back of a waterfall across the hall's south end, and how many lights the daylight through it makes. */
  falls?: { lights: number };
  /** How many stalactites hang from the hall's ceiling, and how many rocks lie at the foot of the walls. */
  stalactites?: number;
  rubble?: number;
  /** Torches on the walls: where each stands, and its turn about the vertical (radians). */
  torches?: Array<{ at: [number, number, number]; turn: number }>;
  /**
   * What stands on its pieces: a body by name (src/render/open/dungeonView.ts PROPS), on the box or
   * deck whose id `on` is, fitted to it and turned `turn` from it.
   */
  props?: Array<{ body: string; on: string; seed: number; turn?: number }>;
  /** Catch nets: where each hangs, its turn, its width and height. */
  nets?: Array<{ at: [number, number, number]; turn: number; size: [number, number] }>;
  /** Piles of stolen goods (dungeonView.ts PILES: barrels, boxes, bales), each from its corner at `at` (x, z). */
  loot?: Array<{ pile: string; at: [number, number]; count: number; seed?: number }>;
  /** Pictures daubed on the walls: where, their turn, their width and height. */
  drawings?: Array<{ at: [number, number, number]; turn: number; size: [number, number]; seed: number }>;
  /** The light its colours are baked from: a fill everywhere, the way out's lamp, each torch's and the falls'. */
  light: { fill: Rgb; exit: CaveLamp; torch?: CaveLamp; falls?: CaveLamp };
}

/**
 * A creature's look besides its species (an actor kind's `species`, `palette`, `scale`, `clips`
 * and `cycles` are the rest of it).
 */
export interface CreatureLook {
  /** jelly: drawn as the slimes' jelly over the species' skeleton, rather than as its boxes. */
  body?: 'jelly';
  /** What floats inside the jelly (src/render/creatures/jelly.ts INSIDES), and whether it wears a crown. */
  inside?: string[];
  crown?: boolean;
  /** How it falls apart when it goes down: straw, a burst of it from where it stands; otherwise a puff of dust. */
  dies?: 'straw';
}
