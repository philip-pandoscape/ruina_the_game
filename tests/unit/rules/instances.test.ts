import { expect } from 'vitest';
import { gameReady, test } from '../../support/headless';

// Offline the browser plays an instance in a copy of its own (?test=<instance>), as the server plays
// it online (docs/world.md, Instances): you come in where its file says, its pieces are solid round
// its own origin, and the creatures it brings stand on its floor (crates/engine/src/session.rs,
// enter_dungeon). The yard first: its training dummy and slimes (content/instances/yard.json).

test('offline in a copy of the yard: in where its file says, its dummy and slimes on its floor, and a combo lands on the dummy', async ({ page }) => {
  await page.goto('/?test=yard');
  await gameReady(page, 60_000);
  const start = await page.evaluate(() => {
    const g = window.__game;
    return { inside: g.dungeon().inside, at: g.state().player.pos, actors: g.actors().map((a) => ({ kind: a.kind, x: a.x, z: a.z })) };
  });
  expect(start.inside).toBe('yard');
  // Its arrival: (0, -18), on a floor whose top is its origin's height.
  expect(start.at.x).toBeCloseTo(0, 6);
  expect(start.at.z).toBeCloseTo(-18, 6);
  expect(start.at.y).toBeCloseTo(0, 2);
  // Its spawns, and nothing of Emberholm's.
  expect(start.actors.map((a) => a.kind)).toEqual(['dummy', 'slime', 'slime', 'slime']);
  expect(start.actors[0]).toMatchObject({ x: 0, z: 2 });

  // Started over in it, you're where it's entered again, not out at the world's spawn.
  await page.evaluate(() => window.__game.reset());
  const again = await page.evaluate(() => window.__game.state().player.pos);
  expect([again.x, again.z]).toEqual([0, -18]);

  // Three swings in front of the dummy land three blows, at the dummy's height over the floor.
  await page.evaluate(() => window.__game.reset({ x: 0, z: 0.4, facing: 0 }));
  const fight = await page.evaluate(() => {
    const g = window.__game;
    const before = g.state().dummy.hp;
    for (let f = 0; f < 100; f++) g.advance(1, { attackPressed: f === 0 || f === 8 || f === 20 });
    const hits = g.events().filter((e) => e.type === 'hit') as Array<{ index: number; y: number }>;
    return { before, after: g.state().dummy.hp, hits: hits.map((h) => ({ index: h.index, y: h.y })) };
  });
  expect(fight.hits.map((h) => h.index)).toEqual([0, 1, 2]);
  for (const h of fight.hits) {
    expect(h.y).toBeGreaterThan(0);
    expect(h.y).toBeLessThan(3);
  }
  expect(fight.after).toBeLessThan(fight.before);
});
