// Parties and Dungeons: written from its rules (`rules` below); every number from the content and the rules.

import { DUNGEONS, EMBERHOLM } from '../../engine/zone';
import { count, duration, metres } from '../format';
import { join, system, table } from '../kit';
import { link, md, raw } from '../md';
import { rustConst, sourceNumber, tsConst } from '../source';
import partiesSource from '../../../crates/server/src/social/parties.rs?raw';
import spacesSource from '../../../crates/server/src/directory/mod.rs?raw';
import zoneSource from '../../../crates/engine/src/open/zone.rs?raw';
import dungeonSource from '../../../crates/engine/src/open/dungeon.rs?raw';
import interactSource from '../../../crates/engine/src/life/interact.rs?raw';
import partyUiSource from '../../ui/party/partyUI.ts?raw';

const N = String.raw`(\d+(?:\.\d+)?)`;

/** The numbers the party and dungeon rules keep in their source, read as the page is drawn. */
const rule = () => ({
  partyMax: rustConst(partiesSource, 'PARTY_MAX'),
  inviteFor: rustConst(partiesSource, 'INVITE_FOR'),
  copyKept: rustConst(spacesSource, 'COPY_KEPT'),
  expelAfter: rustConst(spacesSource, 'EXPEL_AFTER'),
  /** The server's slack round a door's portal, and how far above or below it you may stand. */
  doorSlack: sourceNumber(
    zoneSource,
    new RegExp(String.raw`\(\(x - self\.x\)\.powi\(2\) \+ \(z - self\.z\)\.powi\(2\)\)\.sqrt\(\) <= self\.r \+ ${N}`),
    'the slack round a dungeon door',
  ),
  doorHeight: sourceNumber(
    zoneSource,
    new RegExp(String.raw`self\.r \+ \d+(?:\.\d+)? && \(y - self\.y\)\.abs\(\) < ${N}`),
    'how far above a dungeon door you may stand',
  ),
  /** The same for the portal back out. */
  exitSlack: sourceNumber(dungeonSource, new RegExp(String.raw`<= self\.exit\.r \+ ${N}`), 'the slack round the way out'),
  exitHeight: sourceNumber(
    dungeonSource,
    new RegExp(String.raw`self\.exit\.r \+ \d+(?:\.\d+)? && y\.abs\(\) < ${N}`),
    'how far above the way out you may stand',
  ),
  /** The prompt at a door: how far above or below it you may stand. */
  promptHeight: sourceNumber(interactSource, new RegExp(String.raw`\(p\.pos\.y - door\.portal\.y\)\.abs\(\) > ${N}`), 'how far above a door its prompt shows'),
  /** Players this near are listed to invite. */
  near: tsConst(partyUiSource, 'NEAR'),
});

const placeName = (id: string): string => EMBERHOLM.places.find((p) => p.id === id)?.name ?? id;

/** The place nearest a point: where a dungeon's door is. */
function nearest(x: number, z: number): string {
  let best = EMBERHOLM.places[0]?.id ?? '';
  let d = Infinity;
  for (const p of EMBERHOLM.places) {
    const dd = Math.hypot(p.x - x, p.z - z);
    if (dd < d) {
      d = dd;
      best = p.id;
    }
  }
  return best;
}

export const parties = system({
  id: 'parties',
  title: 'Parties and Dungeons',
  summary: 'Forming a party, inviting and leading; going into a dungeon together, in a copy of its own.',
  icon: '🛡️',
  keywords: ['party', 'group', 'invite', 'leader', 'dungeon', 'instance', 'copy', 'portal', 'goblin'],
  rules: ['crates/engine/src/open/dungeon.rs', 'crates/server/src/social/parties.rs', 'crates/server/src/directory/mod.rs'],
  content: ['shared/instances.json#instances', 'shared/regions/*.json#doors'],
  body: () => {
    const R = rule();
    // The developer zones (the yard, the battlefield) are dungeons too, for admins only: players don't read about them.
    const list = Object.values(DUNGEONS).filter((d) => !d.developer);
    return join(
      md`
Online, a few players can form a party, as groups do in World of Warcraft, and go into a dungeon together. Each party plays its own copy of a dungeon, which nobody else sees. Parties are the game server's: offline there is nobody to party with. They live in its memory, so a server restart ends them.

## Forming a Party

Open the Party window (O) to invite someone: by name (anyone playing, in any channel or dungeon, whatever their capitals), or from the players within ${metres(
        R.near,
      )} of you. Anyone not in a party may invite someone who isn't in one either; when they say yes, a party forms and the one who asked leads it. In a party, only the leader invites.

An invitation is refused at once if it is to yourself, to someone already in a party, to someone you have already invited, or to someone answering another invitation, or if the party would be too big: at most ${count(
        R.partyMax,
        'player',
      )}, and the leader's invitations still waiting count toward that. An invitation waits ${duration(
        R.inviteFor,
      )} for its answer, then lapses, and both of you are told.

Saying yes checks again that you aren't in a party, that the one who asked still leads theirs and that it isn't full; then you are in, and everyone in it is told. Saying no tells the one who asked.

## Leading and Leaving

- The leader can remove a member, or hand the lead to another member.
- Anyone can leave. If the leader leaves, the member who joined first leads; invitations the leader sent lapse with them.
- A party of one is no party: when only one member is left, it breaks up.
- Members stay in the party while they are away. The party frame under your portrait shows everyone else in it: their health while they are near you, and where they are when they aren't.

## Going Into a Dungeon

A dungeon's door is a portal somewhere on the island. Stand at it (within its reach and ${metres(
        R.promptHeight,
      )} of its height) and F enters, if your hands are free: no pack on your back, on your own feet (not riding, not knocked down) and not sitting at a game. The server allows a step's slack, ${metres(R.doorSlack)} more than the portal's reach and ${metres(
        R.doorHeight,
      )} above or below it.

You go into your party's copy of the dungeon, or, on your own, your own copy. The first of you to go in makes it; the rest of the party joins the same copy, until it holds as many players as the dungeon allows. Inside:

- You arrive at its way in. A copy is a place of its own: its floors and walls are all there is, and nothing of the world outside is near you.
- Knocked down, you get up at the way in, not at the world's spawn.
- Fall out of the bottom of it and you are back at the way in.

To leave, F at the portal back out (the server allows ${metres(R.exitSlack)} more than its reach, and ${metres(
        R.exitHeight,
      )} above or below its floor): you come out in your home channel, standing outside the dungeon's door.

## How Long a Copy Lasts

- **Kept.** A copy nobody is in is kept for ${duration(
        R.copyKept,
      )} after the last player leaves it; anyone of its party who comes back through the door within that finds it as it was left. Then it closes. The Party window shows your party's copies: how many are inside, and how long until an empty one closes.
- **Coming back.** If your connection drops inside, you come back into the same copy while it lasts and is still yours; otherwise into your home channel.
- **No longer yours.** Leave the party, or be removed from it, while inside its copy, and you are warned, then taken out after ${duration(R.expelAfter)}.
- **Parties change.** A party that forms takes over the copies of the one who invited (for dungeons it has no copy of yet); a party that breaks up leaves its copies to whoever was left in it.
- **Saved outside.** While you are in a copy, your island is saved as standing outside the dungeon's door: a copy is gone after a server restart, and you come back to the open world there.
`,
      md`Each dungeon's door, how far its portals reach, and how far below its floor a fall takes you back to the way in:`,
      table(
        ['Dungeon', 'Holds', 'Its Door', 'Door Reach', 'Way Out Reach', 'Fall'],
        list.map((d) => {
          const door = EMBERHOLM.doors?.find((x) => x.id === d.id);
          const near = door ? nearest(door.portal.x, door.portal.z) : '';
          return [
            link(`dungeons/${d.id}`),
            count(d.maxPlayers, 'player'),
            door ? raw(`${metres(door.portal.y).html} up, near ${link(`places/${near}`, placeName(near)).html}`) : '',
            door ? metres(door.portal.r) : '',
            metres(d.exit.r),
            metres(-d.fall),
          ];
        }),
        [1, 3, 4, 5],
      ),
    );
  },
});
