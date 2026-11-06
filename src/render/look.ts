import { SURFACE } from '../sim/terrain';

// How the world looks: Emberholm after its reference picture. Smooth light without outlines, haze
// that thins with height and warms toward the sun, ambient occlusion, bloom, a colour grade,
// textured ground, made models and full-size trees. Every colour the island is painted with lives
// here (PALETTE), and the screen effects' settings (POST; the effects are src/render/open/post.ts).
//
// How much of it is drawn is the quality, picked from the graphics chip (?quality=low|medium|high
// chooses instead). GRAPHICS below holds each setting:
//   high    a graphics card of its own: all of it.
//   medium  integrated graphics (a chip sharing the computer's memory, as laptops' and phones' do):
//           no ambient occlusion; shadows from a smaller map, 50 m round you instead of 70.
//   low     WebGL drawn in software (SwiftShader or llvmpipe, as CI's browsers draw it), or no
//           WebGL2: of the screen effects only the haze and the grade (no ambient occlusion, bloom
//           or multisampling); the frame drawn at three quarters of the window's size and
//           stretched to fit; the ground in plain colours, without its textures; shadows from a
//           small map, 30 m round you, that hills don't cast; every tree in its far shape, its crown
//           in half as many clumps; the view 1200 m deep instead of 2600; undergrowth 60 m round
//           you instead of 150, grass 40 m instead of 64; 32 plainer clouds instead of 58; no isles
//           on the horizon; a sea without swells or glints; built things without the grain of what
//           they're made of.

export type Quality = 'high' | 'medium' | 'low';

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
/** WebGL drawn on the CPU (SwiftShader, llvmpipe), or none at all: no graphics chip to draw with. */
const SOFTWARE = GPU === 'none' || /swiftshader|llvmpipe|software/i.test(GPU);
/** A graphics chip that shares the computer's memory (laptops' and phones'). */
const INTEGRATED = /intel|uhd|iris|mali|adreno|powervr|apple gpu/i.test(GPU);

const asked = params?.get('quality');
export const QUALITY: Quality = asked === 'high' || asked === 'medium' || asked === 'low' ? asked : SOFTWARE ? 'low' : INTEGRATED ? 'medium' : 'high';
/** &lookdebug=ao shows the ambient occlusion on its own (white where there is none: below high quality). */
export const LOOK_DEBUG_AO = params?.get('lookdebug') === 'ao';

const HIGH = QUALITY === 'high';
const LOW = QUALITY === 'low';

/** What the quality draws (see the top of this file). */
export const GRAPHICS = {
  /** Ambient occlusion (post.ts), the dearest of the screen effects. */
  occlusion: HIGH,
  /** Bloom on what is brighter than white (post.ts). */
  bloom: !LOW,
  /** The scene drawn multisampled (four samples a pixel) for smooth edges (post.ts). */
  multisample: !LOW,
  /** Screen pixels per CSS pixel, at most: a high-density screen has two or more; under one, the frame is drawn smaller and stretched. */
  pixelRatio: LOW ? 0.75 : 2,
  /** The ground's textures (src/render/open/ground.ts); without them, its plain colours. */
  groundTextures: !LOW,
  /** The sun's shadows: how far round you they reach (metres each way), their map's size, how soft their edges are, and whether hills cast them. */
  shadow: HIGH
    ? { reach: 70, mapSize: 4096, softness: 3, hills: true }
    : LOW
      ? { reach: 30, mapSize: 1024, softness: 1, hills: false }
      : { reach: 50, mapSize: 2048, softness: 2, hills: true },
  /** Within this many metres of the middle of a wood its trees take their near shape, a few hundred leaf clumps a crown; past it, fewer and bigger clumps (src/render/open/foliage.ts). */
  treeNear: LOW ? 0 : 320,
  /** The far crowns' clumps, as a share of the full count (each grows to keep the crown as full). */
  farClumps: LOW ? 0.5 : 1,
  /** How far the camera sees (metres); the haze fades everything into the sky before it. */
  viewDistance: LOW ? 1200 : 2600,
  /** How far round you the undergrowth and the grass are laid (metres). */
  bushReach: LOW ? 60 : 150,
  grassReach: LOW ? 40 : 64,
  /** How many clouds, and how finely their lumps are cut (an icosahedron's detail: 1 has a quarter of 2's triangles). */
  clouds: LOW ? { count: 32, detail: 1 } : { count: 58, detail: 2 },
  /** Other isles out on the horizon (src/render/open/horizon.ts). */
  isles: !LOW,
  /** The sea's swells, the sky in them and the sun's glints (src/render/open/water.ts). */
  seaGlints: !LOW,
  /** The grain of wood, stone and plaster on built things (src/render/models/detail.ts). */
  grain: !LOW,
};

interface Palette {
  /** Ground colours per surface: a pair to dither between, so big areas never look flat. */
  ground: Record<number, [number, number]>;
  /** Sand at the waterline, the seabed out deep, and the tint of high ground. */
  wetSand: number;
  seabed: number;
  highland: number;
  /** Broadleaf canopies; pines are drawn from the same greens, cooler and darker. */
  leaves: number[];
  rock: number;
  grass: number[];
  flowers: number[];
  sea: { shallow: number; deep: number; foam: number; duskShallow: number; duskDeep: number };
  sky: { top: number; horizon: number; goldTop: number; goldHorizon: number; nightTop: number; nightHorizon: number };
  worldTree: { leaves: number };
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

// After the island's reference picture: lush greens with darker woods, pale warm sand, grey-brown
// rock, light dusty paths, turquoise shallows over a deep blue sea, a clear sky. Rich, but with real
// darks; the made models bring the red roofs and blue banners.
export const PALETTE: Palette = {
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
  rock: 0x8f877d,
  grass: [0x749a4a, 0x62903e, 0x84a852, 0x58843a],
  flowers: [0xf2efe4, 0xf0d36a, 0xe08fa0, 0xa99be0],
  sea: { shallow: 0x3fbfbe, deep: 0x15487a, foam: 0xf2f7f8, duskShallow: 0xd9a77e, duskDeep: 0x5a4f86 },
  sky: { top: 0x3f7fc6, horizon: 0xd4e6ef, goldTop: 0x5c74ad, goldHorizon: 0xf3bf8c, nightTop: 0x060d1f, nightHorizon: 0x16233d },
  worldTree: { leaves: 0x93aaab },
  light: {
    sun: 0xfff3e0,
    goldSun: 0xff9a55,
    moon: 0x8fa6e8,
    sunIntensity: 3.6,
    sky: 0xc4dbf2,
    ground: 0x6f7a4a,
    nightSky: 0x40528a,
    nightGround: 0x141c22,
    fill: 1.3,
  },
};

/** The screen effects (src/render/open/post.ts). */
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
  /** How bright the sun's disc is in the sky, so it blooms. */
  sunDisc: 3,
  /** The grade, after tone mapping: saturation, contrast, cool shadows and warm highlights, dark corners. */
  grade: {
    saturation: 1.03,
    contrast: 1.07,
    lift: [-0.008, 0.0, 0.012] as [number, number, number],
    gain: [1.02, 1.0, 0.97] as [number, number, number],
    vignette: 0.12,
  },
};
