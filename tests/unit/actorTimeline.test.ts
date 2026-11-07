import { expect, test } from 'vitest';
import { ActorTimeline } from '../../src/net/actorTimeline';

// Monsters online are drawn on a timeline between the server's updates (src/net/actorTimeline.ts),
// each on its own: near you one comes every tick, further off (the wire for crowds) every fourth or
// twentieth. The whole path on a live server: tests/integration/yard.spec.ts.

test('drawn between two updates: blended, turning the short way round, and never sliding back from a respawn', () => {
  const t = new ActorTimeline();
  const base = { kind: 1, y: 0, state: 1, progress: 0.2, hp: 1, deadFrame: -1, targetX: 0, targetZ: 0 };
  t.push(
    10,
    [
      { ...base, id: 1, x: 0, z: 0, facing: 3.0 },
      { ...base, id: 2, x: 5, z: 5, facing: 0, deadFrame: 200 },
    ],
    null,
    0,
  );
  t.push(
    11,
    [
      { ...base, id: 1, x: 1, z: 0, facing: -3.0, progress: 0.3, hp: 0.8 },
      { ...base, id: 2, x: 30, z: 30, facing: 0 },
    ],
    null,
    50,
  );
  const mid = t.at(10.5);
  const a = mid.find((x) => x.id === 1)!;
  expect(a.x).toBeCloseTo(0.5);
  expect(a.progress).toBeCloseTo(0.25);
  // From 3.0 to -3.0 is a short turn through pi, not most of the way round through 0.
  expect(Math.cos(a.facing)).toBeLessThan(-0.99);
  // Health is the newest word on it, whenever it's drawn.
  expect(a.hp).toBe(0.8);
  // The other came back to life across the field: it is in one place or the other, never between.
  expect([5, 30]).toContain(mid.find((x) => x.id === 2)!.x);
  // An update running late: carried on a little past the newest, rather than stopping dead.
  expect(t.at(11.5).find((x) => x.id === 1)!.x).toBeCloseTo(1.5);
  // And the blow that took the health off was noticed, on the tick it showed.
  expect(t.hurts.map((h) => [h.id, h.tick])).toEqual([[1, 11]]);
});

test('one further off, refreshed every fourth tick, is blended over the four and kept while in sight', () => {
  const t = new ActorTimeline();
  const base = { kind: 1, y: 0, state: 1, progress: 0, hp: 1, deadFrame: -1, targetX: 0, targetZ: 0, facing: 0, every: 4 };
  // A near one every tick; the far one at 20 and 24 only, kept in sight between.
  const near = (tick: number) => ({ ...base, id: 1, x: tick, z: 0, every: 1 });
  t.push(20, [near(20), { ...base, id: 2, x: 0, z: 0 }], null, 0);
  for (const tick of [21, 22, 23]) t.push(tick, [near(tick)], [2], 0);
  t.push(24, [near(24), { ...base, id: 2, x: 8, z: 0 }], null, 0);
  // Between its two states, a quarter of the way at 21: as smooth as the near one.
  expect(t.at(21).find((a) => a.id === 2)!.x).toBeCloseTo(2);
  expect(t.newest().map((a) => a.id)).toEqual([1, 2]);
  // Quiet for a long while (it stood still, so nothing was sent), then moving again: it stood where it
  // was until a refresh before the new one, rather than sliding all the way from long ago.
  for (let tick = 25; tick < 60; tick++) t.push(tick, [near(tick)], [2], 0);
  t.push(60, [near(60), { ...base, id: 2, x: 12, z: 0 }], null, 0);
  expect(t.at(50).find((a) => a.id === 2)!.x).toBe(8);
  expect(t.at(58).find((a) => a.id === 2)!.x).toBeCloseTo(10);
  // Out of sight on the wire is gone, from the moment it went.
  t.push(61, [near(61)], [], 0);
  expect(t.at(60.5).some((a) => a.id === 2)).toBe(true);
  expect(t.at(61).some((a) => a.id === 2)).toBe(false);
  expect(t.newest().map((a) => a.id)).toEqual([1]);
});
