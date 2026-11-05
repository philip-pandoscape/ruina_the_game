import { SURFACE } from '../sim/terrain';

// Which look the world is drawn in. 'new' (the default) is Emberholm after its reference picture:
// smooth light without outlines, ambient occlusion, haze that thins with height and warms toward the
// sun, bloom, a colour grade, textured ground, made models and full-size trees. 'classic'
// (?look=classic) is the bright toon look Ruina had before, kept for comparison and for machines
// that draw WebGL in software (CI's browsers among them), which the new look's screen effects would
// slow to a crawl. The screen effects are src/render/open/post.ts. Every colour the island is
// painted with lives here, once per look, so the two can be compared from the same build.

export type LookName = 'classic' | 'new';

const params = typeof location === 'undefined' ? null : new URLSearchParams(location.search);
/** The graphics chip's name as WebGL reports it ('' outside a browser or when it won't say). */
function gpuName(): string {
  if (typeof document === 'undefined') return '';
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return 'none';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return '';
  }
}

const GPU = gpuName();
/** WebGL drawn on the CPU (SwiftShader, llvmpipe), or none at all: no graphics card to carry the new look. */
const SOFTWARE = GPU === 'none' || /swiftshader|llvmpipe|software/i.test(GPU);
/** A graphics chip that shares the computer's memory (laptops' and phones'): the new look, lighter. */
const INTEGRATED = /intel|uhd|iris|mali|adreno|powervr|apple gpu/i.test(GPU);

const asked = params?.get('look');
export const LOOK: LookName = asked === 'classic' ? 'classic' : asked === 'new' ? 'new' : SOFTWARE ? 'classic' : 'new';

/**
 * How much of the new look's screen work to do: 'high' everything; 'medium' (chosen for integrated
 * graphics) leaves out ambient occlusion and draws smaller, nearer shadows. ?quality= overrides.
 */
export const QUALITY: 'high' | 'medium' = params?.get('quality') === 'medium' ? 'medium' : params?.get('quality') === 'high' ? 'high' : INTEGRATED ? 'medium' : 'high';
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

// After the island's reference picture: lush greens with darker woods, pale warm sand, grey-brown
// rock, light dusty paths, turquoise shallows over a deep blue sea, a clear sky. Rich, but with real
// darks; the made models bring the red roofs and blue banners.
const EARTHY: Palette = {
  ground: {
    [SURFACE.grass]: [0x789a4a, 0x5a8238],
    [SURFACE.road]: [0xc0a074, 0xa98a60],
    [SURFACE.sand]: [0xe3d3a6, 0xd2c08f],
    [SURFACE.rock]: [0x8f877d, 0x746c63],
    [SURFACE.soil]: [0x6b4a32, 0x573c28],
    [SURFACE.plaza]: [0xc4bba8, 0xada491],
    [SURFACE.forest]: [0x4d7236, 0x3d602d],
  },
  wetSand: 0xb39a6a,
  seabed: 0x2b6f78,
  highland: 0xa9a58c,
  leaves: [0x56843a, 0x4a7a33, 0x5f8f40, 0x3f6a2e, 0x6a9646],
  trunk: 0x6b4a33,
  rock: 0x8f877d,
  grass: [0x749a4a, 0x62903e, 0x84a852, 0x58843a],
  flowers: [0xf2efe4, 0xf0d36a, 0xe08fa0, 0xa99be0],
  sea: { shallow: 0x3fbfbe, deep: 0x15487a, foam: 0xf2f7f8, duskShallow: 0xd9a77e, duskDeep: 0x5a4f86 },
  sky: { top: 0x3f7fc6, horizon: 0xd4e6ef, goldTop: 0x5c74ad, goldHorizon: 0xf3bf8c, nightTop: 0x060d1f, nightHorizon: 0x16233d },
  clouds: { color: 0xffffff, emissive: 0xe4ebf2, emissiveIntensity: 0.6 },
  worldTree: { trunk: 0x9eaeb8, leaves: 0x93aaab },
  light: { sun: 0xfff3e0, goldSun: 0xff9a55, moon: 0x8fa6e8, sunIntensity: 3.6, sky: 0xc4dbf2, ground: 0x6f7a4a, nightSky: 0x40528a, nightGround: 0x141c22, fill: 1.3 },
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
  ao: { radius: 3, strength: 0.9, darken: 3 },
  /**
   * Height fog: density at sea level per metre, how fast it thins with height (per metre), a thin
   * haze everywhere (per metre), and how much it glows toward the sun.
   */
  fog: { density: 0.0006, falloff: 0.012, haze: 0.00006, sunGlow: 0.7 },
  /** Bloom on what is brighter than white: the sun, lamps at night, spells. */
  bloom: { strength: 0.4, radius: 0.5, threshold: 1.6 },
  /** How bright the sun's disc is in the sky (the classic sky draws it at 0.9), so it blooms. */
  sunDisc: 3,
  /** The grade, after tone mapping: saturation, contrast, cool shadows and warm highlights, dark corners. */
  grade: { saturation: 1.03, contrast: 1.07, lift: [-0.008, 0.0, 0.012] as [number, number, number], gain: [1.02, 1.0, 0.97] as [number, number, number], vignette: 0.12 },
  /** Shadows: how far around you they reach (metres each way), their map size, and how soft their edges are. */
  shadow: QUALITY === 'high' ? { reach: 70, mapSize: 4096, softness: 3 } : { reach: 50, mapSize: 2048, softness: 2 },
};
