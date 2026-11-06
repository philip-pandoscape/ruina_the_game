// What this browser keeps for the game (localStorage) is named `ruina.*`. A few keys were named
// `yggdrasil.*` before the game was called Ruina; they move to their new names once, the first
// time the game starts, so nobody loses a saved build or the quests they've hidden.

/** Old key, new key. */
const RENAMED: ReadonlyArray<[string, string]> = [
  ['yggdrasil.build', 'ruina.build'],
  ['yggdrasil.skillxp', 'ruina.skillxp'],
];
/** Old prefix, new prefix: keys with a name after them (the quest tracker's, per character). */
const RENAMED_PREFIXES: ReadonlyArray<[string, string]> = [['yggdrasil.untracked.', 'ruina.untracked.']];

/**
 * Moves the old keys to their new names. A value already under the new name wins (it's newer);
 * either way the old key goes. Safe to run every time: once moved, there's nothing left to move.
 */
export function migrateStorage(store: Storage): void {
  const move = (from: string, to: string) => {
    const old = store.getItem(from);
    if (old === null) return;
    if (store.getItem(to) === null) store.setItem(to, old);
    store.removeItem(from);
  };
  for (const [from, to] of RENAMED) move(from, to);
  // Backwards, as moving a key renumbers the ones after it.
  for (let i = store.length - 1; i >= 0; i--) {
    const key = store.key(i);
    if (key === null) continue;
    for (const [from, to] of RENAMED_PREFIXES) if (key.startsWith(from)) move(key, to + key.slice(from.length));
  }
}
