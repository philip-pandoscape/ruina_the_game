// Channels: written from its rules (`rules` below); every number from the content.

import { CHANNELS } from '../../content/channels';
import { count, duration } from '../format';
import { join, system, table } from '../kit';
import { link, md } from '../md';

export const channels = system({
  id: 'channels',
  title: 'Channels',
  summary:
    'How the world is shared out among its crowds: the channels each region is played in, where you are placed, how channels open and merge, and changing channel.',
  icon: '🌀',
  keywords: ['channel', 'layer', 'shard', 'crowd', 'server', 'merge', 'full', 'busy', 'change channel', 'hop'],
  rules: ['crates/channels/src/region.rs', 'crates/channels/src/ties.rs', 'crates/channels/src/tuning.rs'],
  content: ['shared/channels.json'],
  body: () => {
    const C = CHANNELS;
    return join(
      md`
Online, each region of the world is played in channels: copies of it, each a game of its own, so that no crowd grows too big to play in. Everyone in a channel sees everyone else in it, and the creatures, vehicles and packs about it; nobody in another. The land is the same in every channel of a region: what is built and planted stands in all of them (${link('systems/housing', 'Houses and Plots')}). Offline there is only your own game.

## Where You Are Placed

When you come into the world (signing in, or out of a dungeon), you go to the first of these there is:

- **The channel you left**, if you left it less than ${duration(C.rejoinWithin)} ago: a dropped connection, or signing out and straight back in, puts you back where you were.
- **Your party's channel**: where its leader plays, or else where most of it does (${link('systems/parties', 'Parties and Dungeons')}).
- **The channel with the most of your friends** in it; then the one with the most of your guild; then the one where the most, for its size, speak your language; then the fullest. Only channels with fewer than ${count(C.softCap, 'player')} in them are counted.
- **A new channel**, if every channel has ${count(C.softCap, 'player')} or more.

Coming back and joining your party may take a channel past ${count(C.softCap, 'player')}, up to ${count(C.hardCap, 'player')}; nothing takes it past that. If your party's channel is that full, you are placed as if you had no party, and can join it once there is room.

## How Channels Open and Merge

- **Opening.** A new channel opens when every channel is full, and one opens ahead of a crowd: as soon as the room left in all of them together falls below ${count(C.openAhead, 'player')}.
- **Quiet.** A channel with fewer than ${count(C.quiet, 'player')} is quiet. One quiet for ${duration(C.quietFor)} merges into the fullest other channel that can take its players and still have no more than ${count(C.mergeFill, 'player')}: so a merge never fills a channel near to opening another. The newest quiet channel merges first, and one merge happens at a time.
- **Merging.** Everyone in a merging channel is told where they are going, and nobody new is placed in it. ${duration(C.mergeNotice)} later each is moved, as soon as they are out of combat, on the ground and away from a game's table, to the same spot in the other channel, with their pack and whatever they ride. Anyone still in a fight or a game ${duration(C.mergeWait)} after that is moved anyway. Then the channel closes.

## Changing Channel

The Channels window (its button is beside the Party's) lists your region's channels: how busy each is, which is yours, and where your party and friends are. You can go to any channel that isn't full (${count(C.softCap, 'player')}) or closing, or join your party's (up to ${count(C.hardCap, 'player')}), but:

- not while carrying a pack, so a pack can't be carried out of reach of whoever is chasing it;
- not in combat: until ${duration(C.calmAfter)} after the last blow you struck or took, nor while knocked down;
- not while riding, in the air or sitting at a game;
- and not within ${duration(C.changeEvery)} of your last change.

Accepting an invitation into a party whose members play in another channel takes you to theirs, under the same rules: if you can't go yet, you go as soon as you can. Leaving the party, or choosing a channel yourself meanwhile, cancels that.
`,
      md`The numbers channels go by:`,
      table(
        ['What', 'How Many or How Long'],
        [
          ['Placed by affinity up to', count(C.softCap, 'player')],
          ['Never past', count(C.hardCap, 'player')],
          ['A channel opens ahead when the room left falls below', count(C.openAhead, 'player')],
          ['Quiet below', count(C.quiet, 'player')],
          ['Quiet this long before merging', duration(C.quietFor)],
          ['A merge leaves at most', count(C.mergeFill, 'player')],
          ['Warning before a merge moves you', duration(C.mergeNotice)],
          ['Then it waits for fights and games', duration(C.mergeWait)],
          ['Between changes of channel', duration(C.changeEvery)],
          ['Out of combat after the last blow', duration(C.calmAfter)],
          ['Back where you were if you return within', duration(C.rejoinWithin)],
        ],
        [1],
      ),
    );
  },
});
