// The UI is laid out on a virtual screen BASE_HEIGHT px tall and scaled to the window, so it keeps
// the same size relative to the screen at any resolution (70% at 720p, 105% at 1080p). A player
// setting multiplies that. Things drawn over the world (name plates, damage numbers) live outside
// the UI root and scale themselves with the --ui-s variable this sets.

export const BASE_HEIGHT = 1029;
export const UI_SCALE_MIN = 0.5;
export const UI_SCALE_MAX = 1.3;
const KEY = 'ruina.uiScale';

let current = 1;
let root: HTMLElement | null = null;
const listeners = new Set<(s: number) => void>();

/** The player's own factor, 1 by default. */
export function userScale(): number {
  const v = Number(localStorage.getItem(KEY));
  return Number.isFinite(v) && v >= UI_SCALE_MIN && v <= UI_SCALE_MAX ? v : 1;
}

export function setUserScale(v: number): void {
  localStorage.setItem(KEY, String(Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, v))));
  apply();
}

/** How much the UI is scaled right now (virtual px to CSS px). */
export function uiScale(): number {
  return current;
}

/** The UI's virtual screen size. */
export function uiSize(): { width: number; height: number } {
  return { width: innerWidth / current, height: innerHeight / current };
}

/** Converts a point on screen (CSS px, e.g. from getBoundingClientRect) to the UI's coordinates. */
export function toUi(x: number, y: number): { x: number; y: number } {
  return { x: x / current, y: y / current };
}

export function onUiScale(fn: (s: number) => void): void {
  listeners.add(fn);
}

function apply(): void {
  if (!root) return;
  current = Math.max(0.35, Math.min(3, (innerHeight / BASE_HEIGHT) * userScale()));
  root.style.width = `${innerWidth / current}px`;
  root.style.height = `${innerHeight / current}px`;
  root.style.transform = `scale(${current})`;
  document.documentElement.style.setProperty('--ui-s', String(current));
  for (const fn of listeners) fn(current);
}

/** A small tile of paper grain, drawn once: far cheaper to paint than a noise filter. */
function grainTile(): string {
  const n = 96;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  if (!g) return 'none';
  const img = g.createImageData(n, n);
  let seed = 7;
  for (let i = 0; i < n * n; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const v = (seed >>> 16) & 255;
    img.data.set([107, 69, 31, Math.round((v / 255) * 30)], i * 4);
  }
  g.putImageData(img, 0, 0);
  return `url(${c.toDataURL('image/png')})`;
}

// Every face the UI uses, loaded at start: a font first met when a window opens would make that
// frame wait for it.
const FONTS = ['400 16px "Ruina Serif"', '700 16px "Ruina Serif"', 'italic 400 16px "Ruina Serif"', '700 16px "Ruina Title"'];

export function initUiScale(el: HTMLElement): void {
  root = el;
  document.documentElement.style.setProperty('--grain', grainTile());
  for (const f of FONTS) document.fonts?.load(f).catch(() => {});
  addEventListener('resize', apply);
  apply();
}

/** Where UI elements go: the scaled root once it exists, the page before. */
export function uiRoot(): HTMLElement {
  return root ?? document.getElementById('ui') ?? document.body;
}
