# Goblin's Dread: what's built

As of 2026-11-05. AGENTS.md and design/status.json have the same in brief.

## The way in (open world)

- **The falls** (recipe `terrain.falls` in `shared/zones/emberholm.json`, cut by `src/sim/zone/generate.ts`):
  - A spring pool beside the launch deck spills over the lip and falls free down a slot in the
    Windspire's south-west face into a plunge pool at the foot.
  - Numbers: bearing -1.2217 rad (about -70°, atan2(dz, dx) from the mountain's centre at 40, 250);
    lip 26 m out from the centre, foot 74; the slot is 10 m wide.
  - The falls are cut after the tree and rock scatter, so no other tree or rock on the island moves
    (`tests/integration/dungeon-way-in.spec.ts` checks this).
- **The ledge behind the curtain:** 85 m up, 26 to 34 m out from the centre, under a hood of rock
  (a deck with its top at 92 m).
  - Anyone dropping off the summit lands on the hood, so the only way onto the ledge is to glide in.
  - The goblins' landing stage is a deck at 85.5 m. Boxes wall the ledge in, so a glider that hits
    the back wall doesn't slide off.
- **The portal** (`dungeons` in the island's recipe):
  - At (49.714, 85, 223.313), reach 2.2 m. F there shows "Enter Goblin's Dread" (TS-only focus in
    `src/sim/life/interact.ts`).
  - You come out at (50.74, 220.494) facing the curtain (`outside`). That's just beyond the portal's
    reach, so you don't step straight back in.
- **The pools are visual only:** under 0.5 m deep in the rules, so there's no wading or swimming.
- **Drawing:**
  - `src/render/open/falls.ts`: the curtain, spray, foam, mist and the glow through the water.
  - `grotto.ts`: the ledge's dressing and the portal veil.
  - `goblinKit.ts`: goblin props (totem, lanterns, nets, cave drawings).
  - `src/render/camera.ts`: under a deck overhead, the camera stays under it and pulls in short of
    rock.
- **The server** gets the terrain only from the bake (`crates/engine/data/emberholm.zone`, rebaked with
  `npm run bake`), and reads the door from the recipe.

## A dungeon's copy

- **Where it is:** `shared/dungeons/goblinsDread.json` lays the inside out as boxes and decks around
  `origin` (0, 400, 640), a spot high above the sea north of the island that nothing else uses.
  - These colliders are solid only in a copy. The server adds them to a copy's OpenWorld
    (`crates/engine/src/open/dungeon.rs`, `make_dungeon`). The browser switches them on while you're inside
    and off when you leave (`src/sim/zone/dungeon.ts` `setDungeonSolid`, driven by
    `src/app/dungeonVisit.ts`).
  - So they're never invisible walls in the open world.
- **What's in it:** `arrive` (where you come in), `exit` (F within r leaves, "Leave Goblin's Dread"),
  `fall` (below origin.y + fall you're put back at `arrive`), and `maxPlayers` (5).
- **Drawing:** `src/render/open/dungeonView.ts` draws the cave (rock shell, the back of the falls
  glowing at the south end with the way out, the stage, the lookout with a pot gong, the totem,
  torches baked into vertex colours, and the tunnel to a barricade).
  - The island is hidden while you're inside (`stage.enterDungeon`): the sun becomes the cool light
    through the falls, there's no rain, the minimap is hidden, and the banner reads "Goblin's Dread ·
    Dungeon".
- **Knocked down inside,** you get up where it's entered: `OpenWorld.respawn` on the server,
  `World.respawnAt` in the browser.
- **To add a room:** add its boxes and decks to `goblinsDread.json` and its look to `dungeonView.ts`.
  Both sides read the same file, so there's nothing to bake.

## Parties (crates/server/src/play/parties.rs, src/ui/party/)

- **The rules:**
  - Up to 5 members.
  - Anyone not in a party invites someone who isn't either, and leads the party made when they
    accept. In a party only the leader invites, removes someone or hands on the lead.
  - Anyone can leave. A party of one is no party.
  - Offline members stay in it. Parties live in memory, so a restart ends them.
- **Messages:**
  - Browser to server: `partyInvite {to?, name?}` (by name, in any channel or dungeon),
    `partyAnswer {from, accept}`, `partyLeave`, `partyKick {id}`, `partyLead {id}`.
  - Server to browser: `party {party|null}` (members with online status and where they are, plus the
    party's copies), `partyInvite {invite|null}` (an invitation waits 60 s), and `notice {text}`.
- **The UI:**
  - The Party window opens with O or the menu's Party button: invite by name or from players within
    40 m.
  - The party frame under the portrait shows the others, with health while they're near and their
    place when they're not.
  - The invitation has its own window. Right-click a member for Promote to Leader or Remove from
    Party.
  - On a controller, the invitation takes A and B, and the window takes the D-pad.

## Dungeon copies (crates/server/src/play/spaces.rs)

- **Spaces** holds every game: channels (ids from 1 up) and copies (ids from -1 down), plus the
  parties, where each character is, their home channel, and which copy each owner has.
  - A copy is a `ChannelGame` whose `space` is a Copy (`crates/server/src/play/mod.rs`). The same world
    thread ticks it and it saves islands the same way. It has no slimes, no estates, and its own
    actors.
- **The rules:**
  - Through the portal you go into your owner's copy: your party's, or yours on your own. It's made
    on first entry and holds `maxPlayers` (members plus anyone who left in the last minute).
  - A copy is kept COPY_KEPT (30 min) after the last player leaves it; back within that, it's the
    same copy.
  - Whoever is inside but not in the copy's party is warned and put out after EXPEL_AFTER (60 s).
  - A party that forms takes over its leader's copy. One that breaks up leaves its copies to whoever
    was left in it.
- **Moving between games:** `ChannelGame::take` lifts a player out whole (member and connection,
  player, island) and `put` sets them down at a spot. The browser hears `space {space}`, resets what
  it saw (peers, monsters, prediction) and follows (`onlineSpace` in `src/main.ts`, `DungeonVisit`).
  WORLD_PROTOCOL is 7.
- **Saving:** an island in a copy is saved as standing outside its door, so a restart puts you back
  on the ledge. Reconnecting within the half hour puts you back inside (the welcome's `space`). Start
  Over inside a copy takes you out first.
- **Developer tools:** teleport inside a copy lands on its floor, and the developer panel has a
  "Goblin's Dread Door" teleport to the ledge (it isn't a map place: the way in is a secret).

## Tests

| Test | What it covers |
|---|---|
| `crates/server/src/play/parties.rs` | Unit tests: invitations, leading, kicking, the cap of 5, lapsing |
| `crates/server/src/play/spaces.rs` | Unit tests: one copy per party, a separate copy for a player on their own, the 30-minute rule, a minute's warning before being put out, adopting a copy, reconnecting inside, Start Over |
| `crates/engine/src/open/dungeon.rs` | Unit test: solid only in a copy |
| `tests/integration/party.spec.ts` (online) | Forming a party by name; a party into one copy and someone on their own into theirs; leaving and coming back to the same copy |
| `tests/integration/dungeon-way-in.spec.ts` | Gliding off the deck into the falls onto the stage; in and out through the portal offline; dropping off the summit lands on the hood; no tree or rock moved |
| `tests/integration/update.spec.ts` | A server restart while you're inside brings you back outside the door with the cave put away |
| `tests/conformance/terrain.test.ts` | 400 extra points over the falls, where the server and the browser must agree on the ground |
| `tests/stress/look.spec.ts` | Shots of the falls from Lanternwick, of the ledge, and of the inner grotto |
