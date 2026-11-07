import { expect, test } from 'vitest';
import { WorldFeed } from '../../src/net/worldFeed';
import { Prediction, quantize } from '../../src/net/netPlayer';
import { defaultBuild } from '../../src/content/build';
import { Engine } from '../../src/engine/engine';
import { NO_ACTIONS } from '../../src/engine/rules';

// Predicting your own player online (src/net/netPlayer.ts): replaying the inputs the server hasn't
// answered yet must not run the clock everything is drawn by faster than time.

test('online, running the unanswered inputs again on each server update leaves the clock everything is drawn by at the speed of time', () => {
  const engine = new Engine({ online: true, build: defaultBuild() });
  const net = { renderTick: () => 0, sendInput: () => {} } as unknown as WorldFeed;
  const prediction = new Prediction(engine, net);
  const state = () => JSON.parse(JSON.stringify(engine.player));
  prediction.reconcile(0, state()); // the first update places you
  const start = engine.frame;
  // Two seconds of play, the server answering every third frame, eight frames (a round trip) behind.
  for (let i = 1; i <= 120; i++) {
    prediction.step(NO_ACTIONS);
    if (i % 3 === 0 && i > 8) prediction.reconcile(i - 8, state());
  }
  // Counting the replayed frames again ran the clock (and every animation on it) three to four
  // times as fast as time, in jerks: the stroke of someone swimming past whirled.
  expect(engine.frame - start).toBe(120);
});

test('inputs are rounded as the server rebuilds them: a stick nudged just left of straight back is 0, not -0', () => {
  // -0 faces -π where the server's 0 faces π: turning to face straight back went the other way.
  const { actions } = quantize({ ...NO_ACTIONS, moveX: -0.001, moveZ: -1, aimX: -0.01, stickX: -0.001 });
  expect(Object.is(actions.moveX, 0)).toBe(true);
  expect(Object.is(actions.aimX, 0)).toBe(true);
  expect(Object.is(actions.stickX, 0)).toBe(true);
  expect(Math.atan2(actions.moveX, actions.moveZ)).toBe(Math.PI);
});

test("moved into another game, the last word heard from the one you left doesn't take you back there", () => {
  // The server moves you between games (into a dungeon's copy, back out) and says so; the page
  // stands you where it put you (src/app/onlineWiring.ts onSpace). A tick from the game you left,
  // heard just before that, was taken as the server's word on you at the next step, so you were put
  // back at that game's spot (its own frame, far off in the world) until the next tick came.
  const feed = new WorldFeed(() => {});
  const engine = new Engine({ online: true, build: defaultBuild() });
  const inCopy = { ...JSON.parse(JSON.stringify(engine.player)), pos: { x: 0, y: 0.5, z: -3.5 } };
  feed.applyYou(40, { id: 1, ack: 12, player: inCopy });
  expect(feed.you?.player.pos.z).toBe(-3.5);
  feed.resetWorld();
  // Nothing of yours is left to take in until the new game's first tick.
  expect(feed.you).toBeNull();
});
