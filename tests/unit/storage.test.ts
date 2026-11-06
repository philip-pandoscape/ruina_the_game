import { expect, test } from 'vitest';
import { migrateStorage } from '../../src/app/storage';

// The browser's keys from before the game was called Ruina move to their new names once
// (src/app/storage.ts), so nobody loses a saved build or the quests they've hidden.

/** A Storage held in a Map, as the browser's localStorage behaves. */
function memoryStorage(entries: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

const keys = (s: Storage) => Array.from({ length: s.length }, (_, i) => s.key(i)!).sort();

test('the old keys move to their new names, the per-character ones too', () => {
  const s = memoryStorage({
    'yggdrasil.build': '{"weapon":2}',
    'yggdrasil.skillxp': '{"sword":40}',
    'yggdrasil.untracked.Ada': '["landfall"]',
    'yggdrasil.untracked.Brin': '[]',
    'ruina.uiScale': '1.25',
  });
  migrateStorage(s);
  expect(keys(s)).toEqual(['ruina.build', 'ruina.skillxp', 'ruina.uiScale', 'ruina.untracked.Ada', 'ruina.untracked.Brin']);
  expect(s.getItem('ruina.build')).toBe('{"weapon":2}');
  expect(s.getItem('ruina.untracked.Ada')).toBe('["landfall"]');
});

test('a value already under the new name wins, and the old key still goes', () => {
  const s = memoryStorage({ 'yggdrasil.build': '{"weapon":0}', 'ruina.build': '{"weapon":3}' });
  migrateStorage(s);
  expect(keys(s)).toEqual(['ruina.build']);
  expect(s.getItem('ruina.build')).toBe('{"weapon":3}');
});

test('running it again changes nothing', () => {
  const s = memoryStorage({ 'yggdrasil.build': '{}', 'other.key': 'kept' });
  migrateStorage(s);
  const once = keys(s).map((k) => [k, s.getItem(k)]);
  migrateStorage(s);
  expect(keys(s).map((k) => [k, s.getItem(k)])).toEqual(once);
  expect(s.getItem('other.key')).toBe('kept');
});
