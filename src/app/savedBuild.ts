import { defaultBuild, parseBuild } from '../content/build';
import type { Build } from '../content/tuning';

// In the open world your build is kept on the game server with your character. The training yard
// and the battlefield, which are developer tools, keep theirs in this browser.

const STORAGE_KEY = 'ruina.build';

/** The build kept in this browser, or the starting one. */
export function loadBuild(): Build {
  try {
    const b = parseBuild(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
    if (b) return b;
  } catch {
    /* nothing saved, or storage unavailable */
  }
  return defaultBuild();
}

/** Keeps `b` in this browser. */
export function saveBuild(b: Build): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(b));
  } catch {
    /* storage unavailable */
  }
}
