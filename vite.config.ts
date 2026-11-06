import { defineConfig } from 'vite';
import { bugReports } from './tools/bugReports.ts';
import { animReviews } from './tools/animReviews.ts';

// The game server (docker compose up, see README). Vite serves the game and forwards the account
// API and the WebSockets to it, so the browser sees one address, as it does in production where the
// server serves everything itself. RUINA_SERVER points somewhere else.
const gameServer = process.env.RUINA_SERVER ?? 'http://localhost:7777';

export default defineConfig({
  // Saves the bug reports the game records (press \ while playing) into bugs/, and the animation
  // library's notes, correction pictures and prompts (/library.html) into reviews/animations/.
  plugins: [bugReports(), animReviews()],
  server: {
    // The library writes its notes as you make them; they are not code to reload for. scratch/
    // holds unpacked asset kits (thousands of files): nothing there needs watching either.
    watch: { ignored: ['**/reviews/**', '**/scratch/**'] },
    proxy: {
      '/api': gameServer,
      '/ws': { target: gameServer, ws: true },
    },
    // The bug reporter wraps console.log and friends; keep DevTools pointing at the real callers.
    sourcemapIgnoreList: (source, map) => source.includes('node_modules') || /src[\\/]app[\\/]bugs[\\/]logs\.ts/.test(`${source} ${map}`),
  },
});
