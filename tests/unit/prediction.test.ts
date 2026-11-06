import { expect, test } from 'vitest';
import type { WorldFeed } from '../../src/net/worldFeed';
import { Prediction } from '../../src/net/netPlayer';
import { Sim } from '../../src/sim/sim';
import { NO_ACTIONS } from '../../src/sim/types';
import { makeBattlefield } from '../../src/sim/world';

// Predicting your own player online (src/net/netPlayer.ts): replaying the inputs the server hasn't
// answered yet must not run the clock everything is drawn by faster than time.

test('online, running the unanswered inputs again on each server update leaves the clock everything is drawn by at the speed of time', () => {
  const sim = new Sim(makeBattlefield(), { training: false });
  const net = { renderTick: () => 0, sendInput: () => {} } as unknown as WorldFeed;
  const prediction = new Prediction(sim, net);
  const state = () => JSON.parse(JSON.stringify(sim.player));
  prediction.reconcile(0, state()); // the first update places you
  const start = sim.frame;
  // Two seconds of play, the server answering every third frame, eight frames (a round trip) behind.
  for (let i = 1; i <= 120; i++) {
    prediction.step(NO_ACTIONS);
    if (i % 3 === 0 && i > 8) prediction.reconcile(i - 8, state());
  }
  // Counting the replayed frames again ran the clock (and every animation on it) three to four
  // times as fast as time, in jerks: the stroke of someone swimming past whirled.
  expect(sim.frame - start).toBe(120);
});
