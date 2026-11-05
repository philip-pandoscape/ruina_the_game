// Going straight back into the world after a reload: when the game reloads itself (the server or
// the page was updated) or the player presses F5, this tab returns to the same character without
// the intro or the character select screen. Leaving on purpose (Characters, Sign Out) doesn't.
//
// Kept in sessionStorage, so it belongs to this tab alone, and written only as the page goes, so a
// duplicated tab doesn't take the character over from the one it was copied from.

const KEY = 'ruina.resume';
/** Older than this, it isn't a reload any more: the select screen it is. */
const FRESH_MS = 120_000;

let playing: number | null = null;
let leaving = false;

/** This tab is in the world as `character`: a reload brings it straight back. */
export function playingAs(character: number): void {
  if (playing === null) addEventListener('pagehide', () => (leaving || playing === null ? undefined : resumeAfterReload(playing)));
  playing = character;
}

/** Marks the next load as a return to the world with `character` (written now, before reloading). */
export function resumeAfterReload(character: number): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ id: character, at: Date.now() }));
  } catch {
    /* storage off: the select screen it is */
  }
}

/** The character this load returns to, if it is such a reload. Taken once. */
export function takeResume(): number | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (!raw) return null;
    const { id, at } = JSON.parse(raw) as { id?: unknown; at?: unknown };
    return typeof id === 'number' && typeof at === 'number' && Date.now() - at < FRESH_MS ? id : null;
  } catch {
    return null;
  }
}

/** Leaves the world on purpose (to the character select screen, or signed out): `url` loads without coming back in. */
export function leaveFor(url: string): void {
  leaving = true;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing kept */
  }
  location.replace(url);
}

/** This page's address without the options that sign in or start over (?as, &fresh). */
export function plainUrl(): string {
  const q = new URLSearchParams(location.search);
  q.delete('as');
  q.delete('fresh');
  const s = q.toString();
  return location.pathname + (s ? `?${s}` : '');
}
