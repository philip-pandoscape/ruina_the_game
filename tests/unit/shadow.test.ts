import { afterEach, expect, test } from 'vitest';
import { defaultBuild } from '../../src/content/build';
import { Engine } from '../../src/engine/engine';
import { NO_ACTIONS } from '../../src/engine/rules';
import { differences, shadowRules } from '../../src/engine/shadow';

// The shadow (src/engine/shadow.ts, .plans/refactor R8.5): the engine's own session beside the
// TypeScript rules, every step compared. The headless rules tests run with it on
// (tests/support/engineSetup.ts); these hold it to failing when the two differ.

afterEach(() => shadowRules(false));

test('the shadow fails the step after the rules part ways', () => {
  const seen: string[] = [];
  shadowRules(true, (d) => seen.push(d));
  const engine = new Engine({ openWorld: false, online: false, build: defaultBuild() });
  engine.step(NO_ACTIONS);
  expect(seen).toEqual([]);
  // A write that goes round the Engine's named calls reaches the TypeScript alone.
  engine.sim.player.hp -= 7;
  engine.step(NO_ACTIONS);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatch(/after step at frame 2:\n {2}player\.hp: \d+ vs \d+/);
  // Having parted ways it stops comparing: everything after would differ too.
  engine.step(NO_ACTIONS);
  expect(seen).toHaveLength(1);
});

test('differences: missing is undefined, a seed is read mod 2^32, and lists say how long they are', () => {
  expect(differences({ a: 1, b: undefined }, { a: 1, b: null })).toEqual([]);
  expect(differences({ seed: 2 ** 32 + 5 }, { seed: 5 }, 'actor')).toEqual([]);
  expect(differences([1, 2], [1, 3, 4], 'xs')).toEqual(['xs: 2 items vs 3', 'xs[1]: 2 vs 3']);
  expect(differences({ p: { x: 0.1 } }, { p: { x: 0.2 } })).toEqual(['p.x: 0.1 vs 0.2']);
});
