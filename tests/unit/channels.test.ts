import { expect, test } from 'vitest';
import { CHANNELS } from '../../src/content/channels';
import { type ChannelsView, channelLines, closingLine, loadTag, movedLine, rulesLine, shortWait, stoppedBy } from '../../src/ui/channels/channelsUI';
import { isTitleCase } from '../../src/ui/theme/text';

// The Channels window's words (src/ui/channels): what it lists of the server's view of your region's
// channels (crates/channels/src/region.rs ChannelsView, whose JSON this is), why you can't go to
// each, and the notices while your channel closes and once a move has taken you. The window drawn,
// in Title Case, is the UI gallery's (tests/integration/uiGallery.spec.ts, #/ui/channels/...).

/** Your region's channels as the policy writes them: you in channel 1, your party in 2, channel 3 full. */
const VIEW: ChannelsView = {
  region: 'emberholm',
  here: 1,
  list: [
    { n: 1, load: 'busy', closing: false, party: 0, friends: 2 },
    { n: 2, load: 'quiet', closing: false, party: 1, friends: 0 },
    { n: 3, load: 'full', closing: false, party: 0, friends: 0 },
  ],
  closing: null,
  wait: null,
  blocked: null,
  party: 2,
  following: false,
};

test('each channel is listed with its tags in Title Case, and where you can go', () => {
  const lines = channelLines(VIEW, 0);
  expect(lines.map((l) => [l.name, l.tags, l.why])).toEqual([
    ['Channel 1', ["You're Here", 'Busy', '2 Friends'], null],
    ['Channel 2', ['Quiet', 'Your Party'], null],
    ['Channel 3', ['Full'], 'That channel is full.'],
  ]);
  for (const l of lines) for (const t of [l.name, ...l.tags]) expect(isTitleCase(t), t).toBe(true);
  expect(loadTag({ load: 'lively', closing: false })).toBe('Lively');
  expect(loadTag({ load: 'quiet', closing: true })).toBe('Closing');
});

test('what stops you: the server says so, or a change made lately', () => {
  const pack = { ...VIEW, blocked: "You can't change channel while carrying a pack." };
  expect(channelLines(pack, 0)[1].why).toBe("You can't change channel while carrying a pack.");
  expect(stoppedBy(VIEW, 200_000)).toBe('You can change channel again in 3m 20s.');
  expect(channelLines(VIEW, 45_000)[1].why).toBe('You can change channel again in 45s.');
  expect(stoppedBy(VIEW, 0)).toBeNull();
  // A closing channel takes nobody, whatever else.
  const closing = { ...VIEW, list: VIEW.list.map((c) => (c.n === 2 ? { ...c, closing: true } : c)) };
  expect(channelLines(closing, 0)[1].why).toBe('That channel is closing.');
});

test('waits read as the server writes them, and the rules as the content has them', () => {
  expect([shortWait(200_000), shortWait(240_000), shortWait(44_001), shortWait(-5)]).toEqual(['3m 20s', '4m', '45s', '0s']);
  const minutes = CHANNELS.changeEvery / 60;
  expect(rulesLine()).toBe(`You can change channel once every ${minutes} minute${minutes === 1 ? '' : 's'}, but not while carrying a pack or in combat.`);
});

test('the notices: your channel closing, and where a move took you', () => {
  expect(closingLine(1, 45_000)).toBe("This channel is closing: you'll be moved to Channel 1 in 45s.");
  expect(closingLine(1, -10)).toBe("This channel is closing: you'll be moved to Channel 1 in a moment.");
  expect(movedLine({ from: 3, to: 1, why: 'merge' })).toBe("Channel 3 has closed: you're in Channel 1 now.");
  expect(movedLine({ from: 1, to: 2, why: 'party' })).toBe("You've joined your party in Channel 2.");
  expect(movedLine({ from: 1, to: 2, why: 'choice' })).toBe("You're in Channel 2 now.");
});
