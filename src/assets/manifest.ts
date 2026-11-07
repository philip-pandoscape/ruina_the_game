import { idOf, ruleFor, type AssetKind, type Zone } from './catalog';

// The game's own copy of the asset manifest (docs/assets.md): every file the loader can fetch, by
// id, with its address, size, kind and zones. The addresses come from Vite (files named after what's
// in them under /assets/ in a build, the source files under the dev server), the sizes from the
// build (tools/assets/manifest.ts), the kinds and zones from src/assets/catalog.ts.

export interface Asset {
  id: string;
  url: string;
  /** Bytes, as the build has it (0 where the build didn't say: tests in Node). */
  size: number;
  kind: AssetKind;
  zones: readonly Zone[];
}

// Under Node (tests that import the game's modules) there is no page to load files into: no table.
const urls = (
  typeof window !== 'undefined' ? import.meta.glob('../render/assets/**/*.{glb,jpg,png,webp,ktx2}', { query: '?url', import: 'default', eager: true }) : {}
) as Record<string, string>;
const sizes = (typeof window !== 'undefined' ? import.meta.env.RUINA_ASSET_SIZES : undefined) as Readonly<Record<string, number>> | undefined;

const table = new Map<string, Asset>();
for (const [path, url] of Object.entries(urls)) {
  const id = idOf(path.replace(/^(\.\.\/)+/, 'src/'));
  const rule = id === null ? undefined : ruleFor(id);
  if (id === null || !rule) continue;
  table.set(id, { id, url, size: sizes?.[id] ?? 0, kind: rule.kind, zones: rule.zones });
}

/** An asset by id (`models/hero`, `ground/grass`), or undefined if there is no such file. */
export function asset(id: string): Asset | undefined {
  return table.get(id);
}
