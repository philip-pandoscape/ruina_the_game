import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { bugReports } from './tools/bugReports.ts';
import { animReviews } from './tools/animReviews.ts';
import { contentBundles } from './tools/contentBundles.ts';
import { assetManifest } from './tools/assets/manifest.ts';

// The game server (docker compose up, see README). Vite serves the game and forwards the account
// API and the WebSockets to it, so the browser sees one address, as it does in production where the
// server serves everything itself. RUINA_SERVER points somewhere else.
const gameServer = process.env.RUINA_SERVER ?? 'http://localhost:7777';

/**
 * Every page the build makes: the game, the developer pages in dev/ and the design in design/
 * (served on beta and production to admins only, crates/server/src/http.rs), and the bible in bible/
 * (open to everyone). A new page in any of these folders is built without a word here.
 */
const pages = (folder: string): Array<[string, string]> =>
  readdirSync(resolve(import.meta.dirname, folder))
    .filter((f) => f.endsWith('.html'))
    .map((f) => [`${folder}/${f.slice(0, -'.html'.length)}`, resolve(import.meta.dirname, folder, f)]);

export default defineConfig({
  // Saves the bug reports the game records (press \ while playing) into bugs/, and the animation
  // library's notes, correction pictures and prompts (/dev/library.html) into reviews/animations/;
  // builds the content's bundles again when content/ changes; writes the asset manifest
  // (/asset-manifest.json, docs/assets.md) with every build.
  plugins: [bugReports(), animReviews(), contentBundles(), assetManifest()],
  build: {
    rollupOptions: {
      input: Object.fromEntries([['main', resolve(import.meta.dirname, 'index.html')], ...pages('dev'), ...pages('design'), ...pages('bible')]),
    },
  },
  server: {
    // The library writes its notes as you make them; they are not code to reload for. scratch/
    // holds unpacked asset kits (thousands of files): nothing there needs watching either.
    watch: { ignored: ['**/reviews/**', '**/scratch/**', '**/target/**'] },
    proxy: {
      '/api': gameServer,
      '/ws': { target: gameServer, ws: true },
    },
    // The bug reporter wraps console.log and friends; keep DevTools pointing at the real callers.
    sourcemapIgnoreList: (source, map) => source.includes('node_modules') || /src[\\/]app[\\/]bugs[\\/]logs\.ts/.test(`${source} ${map}`),
  },
});
