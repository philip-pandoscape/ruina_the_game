import { SURFACE } from '../sim/terrain';

// Which look the world is drawn in. 'classic' is the bright toon look Ruina has had; 'new'
// (?look=new) is the look being tried: smooth light without outlines, ambient occlusion, haze that
// thins with height and warms toward the sun, a colour grade, and a muted, earthy palette. The
// screen effects are src/render/open/post.ts. Every colour the island is painted with lives here,
// once per look, so the two can be compared from the same build.

export type LookName = 'classic' | 'new';

const params = typeof location === 'undefined' ? null : new URLSearchParams(location.search);
export const LOOK: LookName = params?.get('look') === 'new' ? 'new' : 'classic';
export const NEW_LOOK = LOOK === 'new';
/** &lookdebug=ao shows the new look's ambient occlusion on its own. */
export const LOOK_DEBUG_AO = NEW_LOOK && params?.get('lookdebug') === 'ao';

export interface Palette {
  /** Ground colours per surface: a pair to dither between, so big areas never look flat. */
  ground: Record<number, [number, number]>;
  /** Sand at the waterline, the seabed out deep, and the tint of high ground. */
  wetSand: number;
  seabed: number;
  highland: number;
  /** Broadleaf canopies; pines are drawn from the same greens, cooler and darker. */
  leaves: number[];
  trunk: number;
  rock: number;
  grass: number[];
  flowers: number[];
  sea: { shallow: number; deep: number; foam: number; duskShallow: number; duskDeep: number };
  sky: { top: number; horizon: number; goldTop: number; goldHorizon: number; nightTop: number; nightHorizon: number };
  clouds: { color: number; emissive: number; emissiveIntensity: number };
  worldTree: { trunk: number; leaves: number };
  /** The sun, the moon and the sky's fill light (a hemisphere: sky above, bounce from the ground). */
  light: {
    sun: number;
    goldSun: number;
    moon: number;
    sunIntensity: number;
    sky: number;
    ground: number;
    nightSky: number;
    nightGround: number;
    fill: number;
  };
}

const CLASSIC: Palette = {
  ground: {
    [SURFACE.grass]: [0x8ccb5c, 0x62ab45],
    [SURFACE.road]: [0xd2ac72, 0xbd955c],
    [SURFACE.sand]: [0xeedb9f, 0xe0c787],
    [SURFACE.rock]: [0xa3a39b, 0x85857f],
    [SURFACE.soil]: [0x7e5636, 0x6a4529],
    [SURFACE.plaza]: [0xd9cdb2, 0xc6b897],
    [SURFACE.forest]: [0x5f9e43, 0x4b8a38],
  },
  wetSand: 0xb59a62,
  seabed: 0x3f7f86,
  highland: 0xb8b59a,
  leaves: [0x4caf50, 0x3e9a45, 0x5cb85c, 0x2e7d32, 0x6abf4b],
  trunk: 0x8d5a3b,
  rock: 0x9a9a94,
  grass: [0x6fb64a, 0x5aa33f, 0x82c95b, 0x4f9a38],
  flowers: [0xffffff, 0xffe066, 0xff8fab, 0xb8a1ff],
  sea: { shallow: 0x63d6cf, deep: 0x2c6fb4, foam: 0xf4fbff, duskShallow: 0xe9b98a, duskDeep: 0x8a6aa8 },
  sky: { top: 0x7fbde9, horizon: 0xcde9f3, goldTop: 0x6c86c8, goldHorizon: 0xf3c39b, nightTop: 0x0a1533, nightHorizon: 0x1f2f52 },
  clouds: { color: 0xffffff, emissive: 0x9fb8c8, emissiveIntensity: 0.35 },
  worldTree: { trunk: 0xbccdd3, leaves: 0xb9d4cb },
  light: { sun: 0xfff0d8, goldSun: 0xffa463, moon: 0x9fb4ff, sunIntensity: 2.6, sky: 0xe2f2ff, ground: 0x5d7f3a, nightSky: 0x5d74b8, nightGround: 0x1e2c33, fill: 1.25 },
};

// Muted and earthy: olive and moss instead of lime, dusty roads, grey stone, a slate sea, a hazy
// sky, and real darks. Saturation is saved for what should catch the eye (banners, spells, people).
const EARTHY: Palette = {
  ground: {
    [SURFACE.grass]: [0x86a35a, 0x67873f],
    [SURFACE.road]: [0xb09772, 0x977f5e],
    [SURFACE.sand]: [0xdccfa8, 0xcbbb92],
    [SURFACE.rock]: [0x928f88, 0x777571],
    [SURFACE.soil]: [0x654a35, 0x523b2a],
    [SURFACE.plaza]: [0xbdb29a, 0xa79c84],
    [SURFACE.forest]: [0x62804a, 0x506c3b],
  },
  wetSand: 0xa18c62,
  seabed: 0x2c5a60,
  highland: 0xaaa794,
  leaves: [0x5c8443, 0x4d763a, 0x6a8f4c, 0x426533, 0x76944f],
  trunk: 0x6e523c,
  rock: 0x908d85,
  grass: [0x7a9850, 0x688843, 0x87a359, 0x5d7c40],
  flowers: [0xe9e4d6, 0xdcc472, 0xc98e9b, 0xa194c8],
  sea: { shallow: 0x5ea7a1, deep: 0x234f6b, foam: 0xe8f0f2, duskShallow: 0xd9a77e, duskDeep: 0x6a5a8a },
  sky: { top: 0x4f8ccf, horizon: 0xcfdde3, goldTop: 0x5c74ad, goldHorizon: 0xf0b98a, nightTop: 0x060d1f, nightHorizon: 0x16233d },
  clouds: { color: 0xffffff, emissive: 0xd9e1ea, emissiveIntensity: 0.55 },
  worldTree: { trunk: 0x9eaeb8, leaves: 0x93aaab },
  light: { sun: 0xfff1dc, goldSun: 0xff9a55, moon: 0x8fa6e8, sunIntensity: 3.4, sky: 0xb9cfe8, ground: 0x7a7652, nightSky: 0x40528a, nightGround: 0x141c22, fill: 1.35 },
};

export const PALETTE: Palette = NEW_LOOK ? EARTHY : CLASSIC;
export const PALETTES: Record<LookName, Palette> = { classic: CLASSIC, new: EARTHY };

/** Dark outlines around characters, buildings and vehicles: the classic look only. */
export const OUTLINES = !NEW_LOOK;

/** The new look's screen effects (src/render/open/post.ts). */
export const POST = {
  /** Brightness before tone mapping. */
  exposure: 1.2,
  /**
   * Ambient occlusion: how far it reaches (metres), how strongly it is laid on (0..1), and an
   * exponent that deepens it (1 is three's GTAO as it comes).
   */
  ao: { radius: 2, strength: 0.9, darken: 1.8 },
  /**
   * Height fog: density at sea level per metre, how fast it thins with height (per metre), a thin
   * haze everywhere (per metre), and how much it glows toward the sun.
   */
  fog: { density: 0.0011, falloff: 0.012, haze: 0.00012, sunGlow: 0.7 },
  /** Bloom on what is brighter than white: the sun, lamps at night, spells. */
  bloom: { strength: 0.4, radius: 0.5, threshold: 1.25 },
  /** How bright the sun's disc is in the sky (the classic sky draws it at 0.9), so it blooms. */
  sunDisc: 3,
  /** The grade, after tone mapping: saturation, contrast, cool shadows and warm highlights, dark corners. */
  grade: { saturation: 0.96, contrast: 1.05, lift: [-0.008, 0.0, 0.012] as [number, number, number], gain: [1.02, 1.0, 0.97] as [number, number, number], vignette: 0.16 },
  /** Shadows: how far around you they reach (metres each way), their map size, and how soft their edges are. */
  shadow: { reach: 70, mapSize: 4096, softness: 3 },
};
