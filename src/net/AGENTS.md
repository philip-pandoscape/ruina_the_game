# src/net

Talking to the game server. Online the browser plays on the world server
(`crates/server/src/gate/`, the simulations in `crates/server/src/sim/`): it sends what you press and the commands you give, and draws what the
server says. Nothing it says about its own state is believed; it predicts only its own player.

| File | What |
|---|---|
| `account.ts` | The account API (`/api`): signing in and up, characters, who you are. |
| `worldLink.ts` | The world's WebSocket: inputs out (binary, each with the tick drawn), commands out (JSON), every tick in, and the wire for crowds' updates (binary) heard and acknowledged; going into dungeons and zones, parties, mini-games; the test lag (`?lag=ms`). `WORLD_PROTOCOL` must equal `crates/server/src/gate/socket.rs`'s, and the content's hash (`shared/hash.json`) the server's: a browser with another of either reloads into the new build. |
| `feedTick.ts` | The adapter: all the feed takes from a tick (players and creatures with a fresh state, those in sight that weren't refreshed, arrows and meteors each as of its own tick, effects), whichever way the server sends it: `feedFromJson` from today's JSON tick, `wire/feed.ts` from the wire for crowds. Nothing above it knows which. |
| `wire/` | The wire for crowds, the browser's side of `crates/wire` (whose `AGENTS.md` has the protocol byte by byte): reading updates (`bytes.ts`, `schema.ts`, `decode.ts`), what's been heard and the acknowledgement (`heard.ts`), and the adapter into the feed (`feed.ts`, `WireFeed`: fields back into metres, radians and the content's ids; vehicles and packs under their owners; what's near and only ran on, run on). Held to the Rust by golden fixtures (`tests/fixtures/wire/`). |
| `worldFeed.ts` | What the ticks say, timed to be drawn: your state as the server has it (`applyYou`), the world around you (`applyWorld`, a FeedTick): the monsters near you, arrows, meteors and effects; the tick everyone else is drawn at (`renderTick`, `INTERP_TICKS` behind the newest). |
| `netPlayer.ts` | Your own player: predicted at once from your inputs and corrected to the server (`Prediction`), the input bytes (`quantize`), a player's state from the server's words. |
| `worldPeers.ts` | Everyone else in your channel or copy, players and bots: brought to the moment drawn between updates (`DELAY` frames behind, further for those refreshed less often), with their side, health, vehicles, gliders, houses and farms; `src/render/open/peersView.ts` draws them (far off, as crowd bodies). |
| `actorTimeline.ts` | The monsters over the last second, each on a timeline of its own (near you every tick, further off less often), so they're drawn between updates. |
| `netMonsters.ts` | A blow on a monster felt at once: sparks and a flash on the guess, the server's number after. |
| `netSpells.ts` | Arrows, meteors and spell effects online: yours drawn at once, others' when they're drawn. |

## Rules

- **Boundaries.** net may use the rules (through the bridge, `src/engine/`) and content, never drawing (`src/render/`), the
  UI, the library, the developer pages or the bible (`tests/unit/boundaries.test.ts`). It keeps what
  the server says; the app hands it to what draws it (drawing doesn't import net either).
- **The protocol is both sides'.** A change to what the server sends or takes is made in
  the server (`crates/server/src/gate/encode.rs`, `crates/world-api`, and `crates/wire` for the
  wire for crowds) and here together, with `WORLD_PROTOCOL` raised on both; the wire's golden
  fixtures are written again (`RUINA_GOLDEN=1 cargo test -p ruina-wire --test golden`) and
  `src/net/wire` must hear them.
- **One adapter.** What draws other players, monsters, arrows and effects reads the feed, and the
  feed reads FeedTicks (`feedTick.ts`) and nothing else of the server's messages. Today the JSON
  tick carries everyone in the game every tick; on the wire for crowds the server sends what's near,
  each thing at its own rate (near every tick, further off every fourth or twentieth), what hasn't
  changed not at all: the feed draws each from its own states, and a thing in sight but not refreshed
  is `kept`.
- **Places in the content's lists** (a creature's kind, a weapon, an ability, a movement skill, a
  skill node, a mini-game, what caused a number) go on the wire as numbers, read on both sides from
  the same bundles, never from a list in code; the welcome's content hash keeps the two the same.
- **Lag compensation.** Each input carries the tick everyone else is drawn at (`renderTick` × 16);
  the server checks a swing against where its swinger saw the others, players and monsters alike
  (the `Track` of where each stood, in `crates/engine/src/combat.rs`). Draw others at that tick (the
  monsters are, `actorTimeline.ts`) and the two agree.
- **Sides** are a developer zone's: in the world everyone is on one (`docs/world.md`).

## Tests

Online specs need a world server with a database (`docs/testing.md`): `online.spec.ts` (signing in,
playing, saving), `online-combat.spec.ts` (the region's slimes), `battlefield.spec.ts` (players
fighting: sides, lag compensation, spells, bots), `yard.spec.ts` (monsters streamed and fighting
back), `party.spec.ts`, `minigames.spec.ts`, `update.spec.ts` (the server going away and coming
back), `crowd-bodies.spec.ts` (players far off drawn as crowd bodies). The prediction alone:
`tests/unit/prediction.test.ts`; the feed: `tests/unit/actorTimeline.test.ts`; the wire for crowds:
`tests/unit/wire.test.ts` and `tests/unit/wireFeed.test.ts` (against the server's fixtures).
