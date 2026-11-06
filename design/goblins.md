# Goblins: the Split-Eye war-band

The plan of record for goblins, agreed on 2026-11-05 (canvas `cnv_mv4fcuf5`). Concept art is in
`design/goblins/`.

## What was decided

| | Decision |
|---|---|
| Scope | Start with the basic goblin (the grunt) only; the archer, shaman, hobgoblin, lookout, trapper, wolf rider and Chief Gristlecrown come later |
| Code | Reusable engine parts any creature can use, with the goblin in its own folder built on them |
| Where | A camp in Thornwood only, no warren |
| Raids | Camp only: no night raids, no stolen trade packs |
| Difficulty | Easy one at a time, a coin flip at six, an alerted camp a fight for two or three, the chief a party fight |
| Tone | Menacing; villagers caged in the camp to rescue in a quest; no gore |
| Models | Box goblins while the brains are built; then the grunt made with Meshy (about 35 credits) beside the best free goblin (bagatir's, CC BY 4.0), and the user picks |
| Names | The Split-Eye tribe, Chief Gristlecrown |

## A creature is data and a body

A creature is two things, and neither needs engine code of its own:

- `shared/creatures/<name>.json`: its rules, which the browser and the server both read. Its
  kinds (health, size, poise), its brains (state machines in the format of
  `shared/behaviours.json`), its attacks (strikes and throws) and how its pack fights.
- `src/creatures/<name>/`: its body and look in the browser (a species the crowd renderer draws,
  the clips its states play).

The registries list each creature once: `src/content/creatures.ts` and `server/src/creatures.rs`
(same order, because a kind travels on the wire as its index).

## The engine parts

Each part is a rule in TypeScript and Rust alike, compared frame by frame by
`tests/ai-conformance.spec.ts`.

| Part | TypeScript | Rust | What it does |
|---|---|---|---|
| Senses | `src/sim/ai/senses.ts` | `server/src/ai.rs` (`Sighting`) | Every player as a creature sees them (a *foe*): where, how fast, facing, health, the reach of their weapon or a bow, and what they are doing (swinging, recovering, casting, guarding, dodging, stunned). A creature keeps the foe it is after until another is clearly closer |
| Brains | `src/sim/ai/brain.ts` | `server/src/ai.rs` | The state machine interpreter. New acts: `walk` (steered every frame toward the foe, a ring place, a rally point, home or away), `strike`, `throw`, `heal`. Guards take conditions with arguments (`near:2`, `hurt:0.4`, `ready:goblin-stone`), negation (`!afraid`) and lists (all must hold) |
| Pack | `src/sim/ai/pack.ts` | `server/src/pack.rs` | Before the brains, each frame: attack tokens per foe (only a few strike at once), openings (your back, your recovery, a cast, a stun), ring places around the foe just outside its weapon's reach, courage (health, friends near, foes near) and where to rally (the biggest group, else home) |
| Missiles | `src/sim/combat/missiles.ts` | `server/src/missiles.rs` | Thrown and shot things in flight: gravity, hitting a foe (a dodge's invulnerable frames let it pass), landing |
| Hits on foes | `src/sim/actors/step.ts` | `server/src/actors.rs` | A strike is a cone in front of the creature; a hit on a player goes through the usual hit rules (dodge and guard) |
| Flinch | `src/sim/combat/deal.ts` | `server/src/actors.rs` | A blow at or above a kind's poise knocks it out of what it was doing |

## The basic goblin

- 1.0 m, 30 HP (a full sword combo deals 52), poise 10, so most blows make it flinch.
- Stab: an 0.27 s wind-up, 6 damage, a short lunge. Stone throw: a lobbed stone for 4.
- Notices you at 16 m and shrieks; the band near it wakes too.
- Without a token it circles on a ring just outside your weapon's reach, so a sword keeps it at
  bay (and it throws stones) while a bow lets it come right up to you.
- Strikes only with a token or an opening, then backs off.
- Afraid when hurt and alone: it runs to the biggest group of its band (or home), and drinks its
  one stolen potion out of reach. A blow while it drinks spills it.

## Milestones

1. **The goblin in the yard** (built). Engine parts and the goblin, in both languages, with
   conformance tests and the yard tests (`tests/goblin.spec.ts`), box body. Try it with
   `npm run dev` and `/?yard&goblins=6`.
2. **Online at Thornwood.** The server's foes from every player, hits on players, missiles on the
   wire, a band at Thornwood's southern edge; pushed to beta for a playtest.
3. **Its look.** The grunt made with Meshy beside the free goblin; the user picks.
4. Then the rest of the war-band, the camp and its quests.
