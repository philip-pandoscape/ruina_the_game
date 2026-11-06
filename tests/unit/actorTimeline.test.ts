import { expect, test } from 'vitest';
import { ActorTimeline } from '../../src/net/actorTimeline';

// Monsters online are drawn on a timeline between the server's updates (src/net/actorTimeline.ts).
// The whole path on a live server: tests/integration/net-actors.spec.ts.

test('drawn between two updates: blended, turning the short way round, and never sliding back from a respawn', () => {
  const t = new ActorTimeline();
  const base = { kind: 1, y: 0, state: 1, progress: 0.2, hp: 1, deadFrame: -1, targetX: 0, targetZ: 0 };
  t.push(
    10,
    [
      { ...base, id: 1, x: 0, z: 0, facing: 3.0 },
      { ...base, id: 2, x: 5, z: 5, facing: 0, deadFrame: 200 },
    ],
    0,
  );
  t.push(
    11,
    [
      { ...base, id: 1, x: 1, z: 0, facing: -3.0, progress: 0.3, hp: 0.8 },
      { ...base, id: 2, x: 30, z: 30, facing: 0 },
    ],
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
