import { expect, test } from 'vitest';
import { EMBERHOLM, generateZone } from '../../src/engine/zone';

// The Windspire's waterfall (crates/engine/src/open/generate.rs, falls) is cut after the trees and rocks are
// scattered, so nothing else in the region moves. The way in, in the game: tests/integration/dungeon-way-in.spec.ts.

test('cutting the falls moves no tree or rock anywhere else in the region', () => {
  const cut = generateZone(EMBERHOLM);
  const uncut = generateZone({ ...EMBERHOLM, terrain: { ...EMBERHOLM.terrain, falls: [] } });
  const key = (o: { kind: string; x: number; z: number }) => `${o.kind}@${o.x},${o.z}`;
  const kept = new Set(cut.obstacles.map(key));
  const before = new Set(uncut.obstacles.map(key));
  // Only what stood in the slot or a pool is gone, and nothing new appears.
  expect(cut.obstacles.filter((o) => !before.has(key(o)))).toEqual([]);
  const gone = uncut.obstacles.filter((o) => !kept.has(key(o)));
  const f = cut.falls[0];
  for (const o of gone) {
    const s = (o.x - f.cx) * f.ux + (o.z - f.cz) * f.uz;
    const t = (o.x - f.cx) * f.vx + (o.z - f.cz) * f.vz;
    expect(s > f.lip - 3 && s < f.foot + 6 && Math.abs(t) < f.width).toBe(true);
  }
  expect(gone.length).toBeLessThan(10);
});
