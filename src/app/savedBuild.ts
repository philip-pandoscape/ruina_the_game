import { defaultBuild, readSavedBuild, savedBuild } from '../content/build';
import type { Build } from '../content/tuning';

// Online your build is kept on the game server with your character. Offline (the tests, ?offline)
// it's kept in this browser, by id as the server keeps a character's (src/content/build.ts
// savedBuild); one kept by index before that still loads.

const STORAGE_KEY = 'ruina.build';

/** The build kept in this browser, or the starting one. */
export function loadBuild(): Build {
  try {
    const b = readSavedBuild(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
    if (b) return b;
  } catch {
    /* nothing saved, or storage unavailable */
  }
  return defaultBuild();
}

/** Keeps `b` in this browser. */
export function saveBuild(b: Build): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedBuild(b)));
  } catch {
    /* storage unavailable */
  }
}
