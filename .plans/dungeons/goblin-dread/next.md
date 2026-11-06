# Goblin's Dread: what's next

Parked on 2026-11-05 at the user's request ("we will pick this work up afterwards"). When picking it
up, start by agreeing the level plan with the user. Show it as a plan canvas, room by room, from
[level-plan.md](level-plan.md).

## In order

1. **Agree the level plan** room by room. Settle each room's size, its puzzle and fights, the
   checkpoints, and how the wings open the sun door.
2. **Goblins in the copy:** put the goblin session's Split-Eye war-band in.
   - Start with the grotto's lookout with the gong (the alarm) and a first band down the tunnel.
   - Spawn them per copy and keep the dead ones dead for the copy's life.
   - Monsters need to collide with walls first: they ignore colliders today.
3. **The Warren hub:** the town cavern, the tunnels to the wings, and the goblins at home.
4. **New mechanics, as each wing needs them:**
   - moving platforms that carry a player (Wheelworks)
   - water above sea level that you wade and swim in, with a level that can change (Cistern, and the
     plunge pool outside)
   - updrafts inside a dungeon (Updraft Shaft)
   - checkpoints for falls
   - shared puzzle state in a copy (valves, mirrors, the gong)

   Each of these is a rules change in TypeScript and Rust together, with conformance tests
   (AGENTS.md).
5. **The wings, the Sunbeam Hall and the chief's hall,** then the way out (the water slide).
6. **The lighthouse quest:** the lighthouse at Lanternwick's harbour goes dark, the trail leads here,
   and bringing the lens home lights it again.

## Known gaps in what's built

- **Looks:** a working first pass, plainer than the paintings.
  - The cave walls are faceted, and the slot's walls show stretched rock away from the ledge.
  - From behind the curtain you faintly see the sea.
  - Made models and textures for the grotto and cave would close the gap: concepts first, free
    assets before Meshy (AGENTS.md "Art and assets").
- **Camera:** under the rock hood it pulls in close to stay out of the cliff, so on the ledge you see
  little of your character.
- **Pools:** for looks only, with no wading or swimming (see item 4).
- **Controller:** it can answer invitations and use the Party window, but has no button to open it.
- **Parties:** they end when the server restarts (they live in memory).
- **Party features not built:** sharing a quest (the quest log's Share button), healing and loot for
  party members only, and choosing a channel to join a friend (copies already work across channels).
