// What each of the game's files is and where it is used: the source of the asset manifest
// (docs/assets.md). A file is named by its id, its path under one of the folders below without the
// extension (`models/hero`, `ground/grass`, `icons/coin`); the first rule whose pattern matches the
// id says what kind of file it is and which zones use it. A new file needs a rule here (or matches
// one already): tests/unit/assets.test.ts fails on a file no rule names, and on a rule that names
// no file.
//
// Read by the build (tools/assets/manifest.ts writes the manifest from it), by the game (the loader,
// src/assets/loader.ts, through src/assets/manifest.ts) and by the tests, so it is plain data with
// no imports.

/** What a file is. */
export type AssetKind = 'model' | 'animation' | 'texture' | 'icon' | 'font' | 'sound' | 'music';

/**
 * The places a file is used:
 *   front      the title screen, sign-in and character select: the first download
 *   *          every zone a player can be in (their own body and gear)
 *   emberholm  the island (and the arenas drawn over it); a dungeon or developer zone in content/instances by its id
 *   dev        only the developer pages, or an address option for developers
 */
export type Zone = string;

/** Where the files are, and what their ids begin with. */
export const ROOTS: ReadonlyArray<{ dir: string; prefix: string; files: RegExp }> = [
  { dir: 'src/render/assets', prefix: '', files: /\.(glb|jpg|png|webp|ktx2)$/ },
  { dir: 'src/ui/theme/icons', prefix: 'icons/', files: /\.webp$/ },
  { dir: 'src/ui/theme/fonts', prefix: 'fonts/', files: /\.woff2$/ },
];

export interface AssetRule {
  /** Ids this rule is for: `*` stands for any run of characters but `/`. */
  match: string;
  kind: AssetKind;
  zones: Zone[];
  /** Who loads it, and when. */
  why: string;
}

export const RULES: readonly AssetRule[] = [
  {
    match: 'models/hero',
    kind: 'model',
    zones: ['front', '*'],
    why: "The hero's made body (src/render/detail/madeHero.ts), worn from character select's preview on",
  },
  {
    match: 'models/hero_moves_*',
    kind: 'animation',
    zones: ['dev'],
    why: 'Clips only another move set plays (?swordMoves=meshy, moves.ts) and the content library shows',
  },
  {
    match: 'models/hero_*',
    kind: 'animation',
    zones: ['front', '*'],
    why: "The hero's walk, run and swings, baked onto the made body as it is fitted (madeHero.ts)",
  },
  {
    match: 'models/weapon_*',
    kind: 'model',
    zones: ['front', '*'],
    why: "The hero's made weapons (src/render/detail/madeWeapons.ts), fitted with the body",
  },
  {
    match: 'models/*',
    kind: 'model',
    zones: ['emberholm'],
    why: 'Made structures, props and packs swapped in for the procedural ones as they come near (src/render/models/glb.ts)',
  },
  {
    match: 'village/*',
    kind: 'model',
    zones: ['emberholm'],
    why: "The village kit's pieces and furniture (src/render/village/kit.ts): Lanternwick and the players' cottages",
  },
  {
    match: 'ground/*',
    kind: 'texture',
    zones: ['emberholm'],
    why: "The island's ground textures, colour and normal per surface (src/render/open/ground.ts)",
  },
  { match: 'bark_*', kind: 'texture', zones: ['emberholm'], why: "The trees' bark (src/render/open/leaves.ts)" },
  {
    match: 'detail',
    kind: 'texture',
    zones: ['emberholm'],
    why: "Three grains in one picture, a channel each, for the made models' close-up detail (src/render/models/detail.ts)",
  },
  {
    match: 'icons/*',
    kind: 'icon',
    zones: ['front', '*'],
    why: 'Painted icons, each fetched the first time the interface shows it (src/ui/theme/icons.ts)',
  },
  {
    match: 'fonts/*',
    kind: 'font',
    zones: ['front', '*'],
    why: "The interface's typefaces, loaded with the title screen (src/ui/theme/theme.css, scale.ts)",
  },
];

const patterns = new Map<string, RegExp>();
const pattern = (match: string): RegExp => {
  let re = patterns.get(match);
  if (!re) patterns.set(match, (re = new RegExp(`^${match.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`)));
  return re;
};

/** The rule that describes a file, by its id; undefined for a file no rule names. */
export function ruleFor(id: string): AssetRule | undefined {
  return RULES.find((r) => pattern(r.match).test(id));
}

/** A file's id from its path in the repository (`src/render/assets/models/hero.glb` is `models/hero`); null outside the asset folders. */
export function idOf(path: string): string | null {
  const p = path.replace(/\\/g, '/');
  for (const root of ROOTS) {
    const at = p.indexOf(`${root.dir}/`);
    if (at < 0 || !root.files.test(p)) continue;
    return root.prefix + p.slice(at + root.dir.length + 1).replace(/\.[^./]+$/, '');
  }
  return null;
}

/** Whether a file of these zones is wanted in `zone`. */
export const usedIn = (zones: readonly Zone[], zone: Zone): boolean => zones.includes(zone) || (zone !== 'front' && zone !== 'dev' && zones.includes('*'));
