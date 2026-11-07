import type { View } from './stage';

// What the library keeps in this browser across reloads: the toggles, the view and the speed
// (localStorage), and where the camera was on the animation last looked at (sessionStorage, so a
// reload after a code change comes back to the same picture).

const PREFS = 'ruina.animLibrary.prefs';
const CAMERA = 'ruina.animLibrary.camera';

/** The speeds the transport offers, slowest first. */
export const SPEEDS = [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2];

export interface Prefs {
  skeleton: boolean;
  /** Takes drawn on the studio's backdrop drawn outdoors instead, on grass under the sky. */
  outdoors: boolean;
  swoosh: boolean;
  onion: boolean;
  trails: boolean;
  ghosts: boolean;
  loop: boolean;
  view: View;
  speed: number;
  onionCount: number;
}

export function loadPrefs(): Prefs {
  const base: Prefs = {
    skeleton: true,
    outdoors: false,
    swoosh: true,
    onion: false,
    trails: false,
    ghosts: true,
    loop: true,
    view: 'three',
    speed: 1,
    onionCount: 2,
  };
  try {
    return { ...base, ...(JSON.parse(localStorage.getItem(PREFS) ?? '{}') as Partial<Prefs>) };
  } catch {
    return base;
  }
}

export function savePrefs(prefs: Prefs): void {
  localStorage.setItem(PREFS, JSON.stringify(prefs));
}

/** Where the camera is and what it looks at. */
export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
}

/** Keeps where the camera is on the animation `key` names (subject/animation). */
export function saveCamera(key: string, camera: CameraState): void {
  sessionStorage.setItem(CAMERA, JSON.stringify({ key, ...camera }));
}

/** Where the camera was on the animation `key` names, if it was the last one looked at. */
export function savedCamera(key: string): (CameraState & { key: string }) | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(CAMERA) ?? 'null') as (CameraState & { key: string }) | null;
    return s && s.key === key ? s : null;
  } catch {
    return null;
  }
}
