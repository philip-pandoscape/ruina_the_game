import { defineConfig } from 'vite';
import { bugReports } from './tools/bugReports.ts';

export default defineConfig({
  // Saves the bug reports the game records (press \ while playing) into bugs/.
  plugins: [bugReports()],
  server: {
    // The bug reporter wraps console.log and friends; keep DevTools pointing at the real callers.
    sourcemapIgnoreList: (source, map) => source.includes('node_modules') || /src[\\/]app[\\/]bugs[\\/]logs\.ts/.test(`${source} ${map}`),
  },
});
