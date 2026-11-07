# crates/channels

The channels' policy (R10.22, D17): each region is played as channels, copies of it for crowds, with
the same land in every one. This crate decides where an arriving player goes, when a region opens
another channel, when a quiet one merges and how its players are moved, and whether a player may
change channel. It decides only: whoever keeps who plays where (the server's directory) tells it
what happens and carries out what it answers. How it plays, for players and for whoever adds to it:
`docs/world.md`, Channels; the bible's Channels page (`src/bible/systems/channels.ts`).

| Module | What |
|---|---|
| `region.rs` | A `Region`: its channels and who plays in each. `arrive`, `leave`, `change`, `joined_party`, `left_party`, `forget` as things happen; `review` about once a second (merges, followers, opening ahead); `view`, the Channels window's `ChannelsView`. What it answers: `Action`s (`Open`, `Merging`, `Move`, `Close`), `Placed`, `Follow`, `Refusal` (each with the sentence a player reads). What a player is doing comes from their simulation as a `Standing`. Tests in `region/tests.rs` |
| `ties.rs` | Who belongs with whom (`Ties`): parties from the social tier; friends, guilds and languages as hooks that answer nothing until it keeps them. `Social` keeps them all in memory, for the tests and the crowd |
| `tuning.rs` | The numbers, `shared/channels.json` (built from `content/channels.json`), and `Tuning::check` (contentc holds the content to the same) |
| `crowd.rs` | A seeded crowd of bots played against an `Arena` (`Here`: the policy in memory; the server's directory with bots, once it plays the policy), checked every second and counted in a `Tally`. Tests in `crowd/tests.rs` |

## Rules

- **Pure.** serde only: no clocks (the time is an argument, `Millis` since 1970), no threads, no
  I/O, and B-trees, never hash maps (`clippy.toml`), so the same question gets the same answer and a
  crowd played twice from a seed plays the same.
- **The server tiers' words** (their messages' crate, world-api, R10.20): a channel is a region's number `n`
  (`SpaceId::Channel { region, n }`), a time `Millis`, a player a `CharacterId`.
- **Numbers are content.** A new number goes in `content/channels.json`, `Tuning`, contentc's
  `channels()` check and the bible's page, never in code.
- **Placing never passes the hard cap**, and passes the soft cap only for someone coming back or
  joining their party; a merge never fills a channel past `mergeFill`. The crowd checks both every
  second: keep it so.

## Tests

`cargo test -p ruina-channels`: every rule (`region/tests.rs`), the numbers (`tuning.rs`), and crowds
(`crowd/tests.rs`): 150 bots in small channels filling, opening, keeping parties together and merging
back to one, other seeds, the same crowd played twice, and 6,000 by the game's numbers. What a crowd
did, measured: `cargo test --release -p ruina-channels crowds_measured -- --ignored --nocapture`.
