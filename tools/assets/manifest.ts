import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { idOf, ROOTS, ruleFor, type AssetKind, type Zone } from '../../src/assets/catalog.ts';

// The asset manifest (docs/assets.md), built with the client. Every model, texture, icon and font in
// the asset folders (src/assets/catalog.ts) is listed with its id, the file the build named after
// what's in it, its size, its kind and the zones that use it, in /asset-manifest.json beside the
// pages (asked about every time, as pages are: crates/server/src/http.rs), with the code the game's
// page starts with and the code it loads later. The game itself gets the sizes (its progress bar
// counts bytes); the files' addresses it takes from Vite (src/assets/manifest.ts).

/** A file in one of the asset folders. */
export interface AssetFile {
  id: string;
  /** Its path from the repository's root, with forward slashes. */
  path: string;
  size: number;
}

/** One asset as the manifest lists it. */
export interface ManifestAsset {
  id: string;
  /** The built file, from the site's root (`assets/hero-Lp91RHMo.glb`). */
  file: string;
  size: number;
  kind: AssetKind;
  zones: Zone[];
}

/** Code (a script or a style sheet) as the manifest lists it. */
export interface ManifestCode {
  file: string;
  size: number;
}

export interface Manifest {
  assets: ManifestAsset[];
  /** The game's page (index.html): the code it starts with, and the code it loads on the way into the world. */
  code: { first: ManifestCode[]; later: ManifestCode[] };
}

/** Every file in the asset folders, by id. */
export function assetFiles(root: string): AssetFile[] {
  const out: AssetFile[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else {
        const id = idOf(rel);
        if (id !== null) out.push({ id, path: rel, size: statSync(join(root, rel)).size });
      }
    }
  };
  for (const r of ROOTS) walk(r.dir);
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function assetManifest(): Plugin {
  let root = process.cwd();
  const isAsset = (file: string) => idOf(file.replace(/\\/g, '/')) !== null;
  return {
    name: 'ruina-asset-manifest',
    config(config) {
      root = config.root ?? root;
      const sizes = Object.fromEntries(assetFiles(root).map((f) => [f.id, f.size]));
      return {
        // The game's progress bar counts bytes: each file's size, by id.
        define: { 'import.meta.env.RUINA_ASSET_SIZES': JSON.stringify(sizes) },
        // Every asset a file of its own, however small, so the manifest can name it (Vite would
        // write one under 4 KB into the script that uses it).
        build: { assetsInlineLimit: (file: string) => (isAsset(file) ? false : undefined) },
      };
    },
    generateBundle(_options, bundle) {
      const files = new Map(assetFiles(root).map((f) => [f.path, f]));
      const assets: ManifestAsset[] = [];
      for (const out of Object.values(bundle)) {
        if (out.type !== 'asset') continue;
        for (const original of out.originalFileNames ?? []) {
          const f = files.get(original);
          const rule = f && ruleFor(f.id);
          if (!f || !rule || assets.some((a) => a.id === f.id)) continue;
          const size = typeof out.source === 'string' ? Buffer.byteLength(out.source) : out.source.byteLength;
          assets.push({ id: f.id, file: out.fileName, size, kind: rule.kind, zones: [...rule.zones] });
        }
      }
      assets.sort((a, b) => a.id.localeCompare(b.id));

      // The game's page: the scripts and styles it starts with (its entry and what that imports),
      // and those it imports later (the game itself, on the way into the world).
      const chunks = Object.values(bundle).filter((o) => o.type === 'chunk');
      const byName = new Map(chunks.map((c) => [c.fileName, c]));
      const same = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
      const page = resolve(root, 'index.html');
      const entry = chunks.find((c) => c.isEntry && c.facadeModuleId && same(c.facadeModuleId, page));
      const sizeOf = (file: string): number => {
        const o = bundle[file];
        if (!o) return 0;
        return o.type === 'chunk' ? Buffer.byteLength(o.code) : typeof o.source === 'string' ? Buffer.byteLength(o.source) : o.source.byteLength;
      };
      const reach = (from: string[], follow: (c: (typeof chunks)[number]) => string[]): Set<string> => {
        const seen = new Set<string>();
        const todo = [...from];
        while (todo.length) {
          const f = todo.pop() as string;
          if (seen.has(f)) continue;
          seen.add(f);
          const c = byName.get(f);
          if (!c) continue;
          for (const css of c.viteMetadata?.importedCss ?? []) seen.add(css);
          todo.push(...follow(c));
        }
        return seen;
      };
      const first = entry ? reach([entry.fileName], (c) => c.imports) : new Set<string>();
      const all = entry ? reach([entry.fileName], (c) => [...c.imports, ...c.dynamicImports]) : new Set<string>();
      const list = (s: Iterable<string>) => [...s].sort().map((file) => ({ file, size: sizeOf(file) }));
      const manifest: Manifest = { assets, code: { first: list(first), later: list([...all].filter((f) => !first.has(f))) } };
      this.emitFile({ type: 'asset', fileName: 'asset-manifest.json', source: `${JSON.stringify(manifest, null, 1)}\n` });
    },
  };
}
