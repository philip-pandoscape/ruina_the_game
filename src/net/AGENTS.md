# src/net

Talking to the game server. Online the browser plays on the world server
(`crates/server/src/play/`): it sends what you press and the commands you give, and draws what the
server says. Nothing it says about its own state is believed; it predicts only its own player.

| File | What |
|---|---|
| `account.ts` | The account API (`/api`): signing in and up, characters, who you are. |
| `worldLink.ts` | The world's WebSocket: inputs out (binary, each with the tick drawn), commands out (JSON), every tick in; going into dungeons and zones, parties, mini-games; the test lag (`?lag=ms`). `WORLD_PROTOCOL` must equal `crates/server/src/play/socket.rs`'s, and the content's hash (`shared/hash.json`) the server's: a browser with another of either reloads into the new build. |
| `worldFeed.ts` | What the ticks say, timed to be drawn: your state as the server has it, the monsters near you, arrows, meteors and effects; the tick everyone else is drawn at (`renderTick`, `INTERP_TICKS` behind the newest). |
| `netPlayer.ts` | Your own player: predicted at once from your inputs and corrected to the server (`Prediction`), the input bytes (`quantize`), a player's state from the server's words. |
| `worldPeers.ts` | Everyone else in your channel or copy, players and bots: brought to the moment drawn between updates (`DELAY` frames behind), with their side, health, vehicles, gliders, houses and farms; `src/render/open/peersView.ts` draws them. |
| `actorTimeline.ts` | The monsters over the last second, so they're drawn between updates. |
| `netMonsters.ts` | A blow on a monster felt at once: sparks and a flash on the guess, the server's number after. |
| `netSpells.ts` | Arrows, meteors and spell effects online: yours drawn at once, others' when they're drawn. |

## Rules

- **Boundaries.** net may use the rules (through the bridge, `src/engine/`) and content, never drawing (`src/render/`), the
  UI, the library, the developer pages or the bible (`tests/unit/boundaries.test.ts`). It keeps what
  the server says; the app hands it to what draws it (drawing doesn't import net either).
- **The protocol is both sides'.** A change to what the server sends or takes is made in
  `crates/server/src/play/` and here together, with `WORLD_PROTOCOL` raised on both.
- **Places in the content's lists** (a creature's kind, a weapon, an ability, a movement skill, a
  skill node, a mini-game, what caused a number) go on the wire as numbers, read on both sides from
  the same bundles, never from a list in code; the welcome's content hash keeps the two the same.
- **Lag compensation.** Each input carries the tick everyone else is drawn at (`renderTick` × 16);
  the server checks a swing against where its swinger saw the others (`rewound` in
  `crates/server/src/combat.rs`). Draw others at that tick and the two agree.
- **Sides** are a developer zone's: on the island everyone is on one (`docs/zones.md`).

## Tests

Online specs need a world server with a database (`docs/testing.md`): `online.spec.ts` (signing in,
playing, saving), `online-combat.spec.ts` (the island's slimes), `battlefield.spec.ts` (players
fighting: sides, lag compensation, spells, bots), `yard.spec.ts` (monsters streamed and fighting
back), `party.spec.ts`, `minigames.spec.ts`, `update.spec.ts` (the server going away and coming
back). The prediction alone: `tests/unit/prediction.test.ts`.
