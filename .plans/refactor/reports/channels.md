# Channels (R10.22): Report

The channels workstream of [finish.md](../finish.md): a region runs as channels, another opens past
its soft cap and a quiet one merges, players are placed by affinity (party first, then friends,
guild and language) and may change channel under rules against hopping. Branch `refactor/channels`,
worktree `C:\GitHub\games\ruina-wt-channels`, slot 7.

The first half builds what doesn't wait on the server's tiers (R10.20): the policy, its tuning, the
browser's side and a harness that plays it with a crowd of bots. The second half puts it in the
directory once the tiers and land are in.

## 2026-11-06 20:46: Started, and the shape of it

Read the plan (finish.md, README Phase 10, D16-D21, R10.20-R10.22, issue #4), the research (3.7,
4.3, 5b.7, 5c), `docs/world.md`, the server's channels, spaces, parties and socket, the party UI and
the UI gallery, and the tiers worktree as it stands (`crates/world-api`: `SpaceId::Channel { region,
n: u32 }`, `Millis`, `CharacterId`, `PartyId`).

Decided so far, and why:

- **The policy is a crate of its own, `crates/channels` (`ruina-channels`)**: pure (serde only, no
  clocks, threads or I/O, as the engine and world-api are), so the directory, a test, or a later
  process role can all use it, and none of it sits in the files tiers is moving (`crates/server`'s
  `play/` is becoming `gate/`, `sim/`, `directory/`, `social/`, `store/`). It speaks the tiers'
  words: a channel is a region's number `n: u32`, times are `Millis` (ms since 1970), players are
  character ids (`i64`).
- **Its tuning is a bundle of its own, `content/channels.json` → `shared/channels.json`**, checked by
  contentc, read by the policy and by the bible. Not in `world.json` (bigworld's, being changed) nor
  in `tuning.json` (the engine's rules).
- **The browser's side is drawn and tested now without a server**, through the UI gallery's
  made-up states (`/dev/ui.html#/channels/...`), as the party windows are; the world connection gets
  its messages (`channels`, `channel`) whose server side is the second half.

Next: the policy and its tests, then the tuning, the harness, the browser, the docs and the bible.

## 2026-11-06 21:16: The policy, its tuning and the crowd harness

Landed in 11fef4e:

- **`crates/channels`**, the policy, pure and deterministic (its own `clippy.toml` forbids clocks
  and hash maps). A `Region` keeps its channels and who plays in each, and answers:
  - **placing** (`place`, `arrive`): back to the channel you left if within `rejoinWithin`; else
    your party's (its leader's channel, else where most of it is); else the channel with the most of
    your friends, then guild, then the biggest share speaking your language, then the fullest
    below the soft cap; else a new channel. Back and party may go past the soft cap, nothing past
    the hard cap;
  - **changing** (`may_change`, `change`, `joined_party`, `blocked`): refused with a pack, in combat
    (a blow within `calmAfter`, or down), riding, in the air, at a table, or within `changeEvery` of
    the last change; a choice only below the soft cap, joining your party up to the hard cap; an
    invitation refused by the rules waits and goes when they allow (`review`);
  - **opening and merging** (`review`, once a second): a channel quiet for `quietFor` merges into
    the fullest other that can take its players and stay at most `mergeFill`, newest first, one
    at a time: `Merging` (tell them), `Move` each when free (out of a fight, on the ground, off a
    table) from `mergeNotice` on, everyone at `mergeWait`'s end, then `Close`; an empty one closes
    at once; another opens ahead when the room below the soft cap falls under `openAhead`;
  - **what a player sees** (`view`): each channel's load (Quiet, Lively, Busy, Full), closing or not,
    party and friends in it, your merge's countdown, your cooldown, why you can't change.
- **`content/channels.json`** → `shared/channels.json`, checked by contentc (`channels()`) and by
  `Tuning::check`, with a unit test of each mistake (`tests/unit/content.test.ts`).
- **The crowd harness** (`crowd.rs`): a seeded crowd of bots (parties formed before and by
  invitation, friends, guilds, languages, packs, fights, tables, dropped connections, changes of
  channel) played against an `Arena` (`Here`: the policy in memory; the server's directory with
  bots in the second half), checked every second and counted in a `Tally`.

Numbers (the crowd, `cargo test --release -p ruina-channels crowds_measured -- --ignored --nocapture`):

| Crowd | Bots | Peak online | Peak channels | Fullest | Merges | Longest party split | Broken | Time (release) |
|---|---|---|---|---|---|---|---|---|
| small (`Tuning::small`: soft 20, hard 24) | 150 | 108 | 6 | 24 | 3 (+2 empty closed) | 235 s | 0 | 0.01 s |
| large (the game's numbers: soft 1,000, hard 1,200) | 6,000 | 5,177 | 6 | 1,019 | 5 | 306 s | 0 | 1.2 s |

A party is split only while a member waits on the rules (a pack, a fight, the cooldown) or came back
to the channel they'd left a moment ago; the longest stretches are pack carriers. 29 tests, 5.4 s
in debug (the large crowd most of it). Clippy and rustfmt clean.

Decisions, and why:

- **Soft cap 1,000, hard cap 1,200** (research 4.3 and 5b.7: about 1,000 a region; the 200 between
  is room for parties and players coming back, so neither is ever split by a full channel).
- **Quiet below 250 (a quarter) for 5 minutes, merging only to 750 (three quarters)**: the gap
  between where a merge stops (750) and where a channel opens ahead (1,000 less 50) is the
  hysteresis that keeps a merge from opening a channel again; contentc and `Tuning::check` hold
  `openAhead < softCap - mergeFill`. Five minutes rides out a lull; the fullest-first placement
  drains the emptier channels by itself, so few players are left to move.
- **One merge at a time, newest first, everyone into one channel**: predictable, parties stay
  together, numbers stay low.
- **A minute's notice, then a minute's grace for fights and tables**: nobody is pulled out of a fight
  or a game unless it outlasts both.
- **Change every 5 minutes, out of combat 10 s after the last blow; a party invitation obeys the
  same rules** (else a pack carrier hops by being invited); **someone back within 5 minutes goes
  back where they were**, so signing out and in doesn't hop either.
- **Language as a share, friends and guild as counts, in that order** (the plan's order; a share so
  a big channel doesn't win on size alone).

Next: the browser's side (the Channels window, the notice when a merge moves you), then the docs and
the bible's page.

## 2026-11-06 21:28: The browser's side

Landed in 9207f28:

- **The Channels window** (`src/ui/channels/channelsUI.ts`, a menu button beside Party's; it docks
  where the Party window does, and each closes the other): your region's channels with their load
  (Quiet, Lively, Busy, Full, Closing), You're Here, Your Party, friends; Change on each and Join
  Your Party, each shut with its reason when the rules say no (what stops you as you stand, the
  cooldown counted down, a full or closing channel), and the rules from the content otherwise.
- **The notice** (`#hud-channel`, top centre under the compass): counts down while your channel
  closes, and says where a move took you for eight seconds (a merge, your party, your choice).
- **The wire, the browser's half** (`src/net/worldLink.ts`): `channels {channels}` and
  `channelMoved {from, to, why}` in; `channels` (asked as the window opens and every 2 s while open)
  and `channel {to}` / `channel {party: true}` out. The server's half is the second half's.
- **Tests**: `tests/unit/channels.test.ts` (its words, the reasons, the countdowns); four UI gallery
  states (`/dev/ui.html#/channels/window|blocked|closing|moved`), drawn and held to Title Case by
  `tests/integration/uiGallery.spec.ts` (4 passed); typecheck, Biome and knip clean.
- The policy's view keeps what stops you as you stand (`Standing::hindrance`) apart from the wait,
  so the window counts the wait down itself.

Decided: no keyboard key yet (U and Y are the free letters, neither means anything here; the menu
button and the controller's menu presses reach it). The window shows load words, not counts, as
MMOs do: a number invites hopping to the emptiest.

Next: `docs/world.md`, the bible's Channels page, `src/ui/AGENTS.md`, then merge `refactor/first`
and `npm run check`.

## 2026-11-06 21:52: Docs, the bible, two fixes, and the first half done

Landed:

- **7b5d278, the guides and the bible.** `docs/world.md`'s Channels: the channels as they are
  (residents, until the second half) and as the policy has them (placing, opening, merging,
  changing, what a player sees, the hysteresis), its numbers field by field, the browser's window
  and messages, the crowd, what's next; the words table and the testing list. `docs/architecture.md`
  lists the crate, `AGENTS.md` and `src/ui/AGENTS.md` the crate and the window, and
  `crates/channels/AGENTS.md` is the crate's guide. The bible's Channels page
  (`src/bible/systems/channels.ts`, after Parties and Dungeons): where you're placed, how channels
  open and merge, changing channel, and a table of the numbers, every one from
  `shared/channels.json`; `tests/unit/bible.test.ts` reads `crates/channels/src` as rules (its table
  of contents and the crowd as plumbing, and tests kept in files beside the rules).
- **605a4fb, two fixes found reviewing.** A channel a merge had just filled could merge on in the
  same second, its quiet timer not yet cleared: `merge_due` now wants it quiet still (the new test
  fails without it). And a `space` message clears the channels heard (they were the old place's),
  so the notice says where a move took you rather than counting down a merge already done.
- **1b0b677**: merged `refactor/first` (the plan's files only, no conflicts).

Ran:

- `npm run check` after the merge: passed in 9 min 41 s: typecheck, Biome, knip, rustfmt, clippy,
  268 TypeScript unit tests in 44 files, and the Rust tests (channels 31 and 1 measurement ignored,
  engine 181, order 5, WebAssembly 4, server 81). The two fixes came after its first steps:
  typecheck, Biome, knip and the channels' unit tests again on them, clean.
- The slot's rig (Postgres `ruina-wt-channels-db` on 5487, the release server on 7878):
  `party.spec.ts`, `online.spec.ts` and `dungeon-way-in.spec.ts`, 25 passed (the world connection
  and the menu bar changed under them); `bible.spec.ts`'s pages and links, 2 passed;
  `uiGallery.spec.ts`'s channel states, 4 passed. No failures to compare with `refactor/first`.

## The First Half: What Landed

| Commit | What |
|---|---|
| 11fef4e | `crates/channels`: the policy, `content/channels.json`, the crowd harness |
| 9207f28 | The browser's side: the Channels window, the notice, the messages, the UI gallery's states |
| 7b5d278 | The guides and the bible's Channels page |
| 605a4fb | A merge's stale quiet; a move's notice over a stale countdown |

Not touched: `crates/server` (the first half needed nothing of it), the engine, the migrations.
Touched beside others' work, in small edits: `src/ui/party/partyUI.ts` (an `onOpen` hook, so the
Party and Channels windows close each other), `src/main.ts`, `src/app/` (wiring), `src/net/worldLink.ts`
(the messages), `tools/content/contentc.mjs` (the `channels()` check), `tests/unit/bible.test.ts`
(the crate's files as rules), the root `Cargo.toml` (the crate in the workspace).

## The Second Half: What It Needs (Waiting on Tiers and Land)

From **tiers** (R10.20; world-api at 86d6055 already has `SpaceId::Channel { region, n }`,
`Destination::Home`, `ToDirectory::Claim`, `Placed`, `PartyOf`):

1. **The directory holds a `ruina_channels::Region` per region** and asks it where a character
   goes: on `Claim` and on `Destination::Home` (out of a copy), `Region::arrive`; on `Release` and
   into a copy, `Region::leave`; on deletion, `Region::forget`. This replaces `home_channel` and
   `load_channel` (the gate's socket) and `CHANNEL_CAP`.
2. **A review once a second** (`Region::review`) on the directory's clock, carrying out its actions:
   `Open` starts a simulation for `channel:<region>:<n>`; `Merging` tells everyone in the channel (a
   `notice`, and a `channels` with its `closing`); `Move` takes the player out of one simulation with
   their life and into the other at the same spot (as `Spaces::move_to` does today: the gate
   re-routes their inputs, the browser hears `space` and `channelMoved`); `Close` stops the
   simulation once it has written its players' lives.
3. **Standing from the simulations**: each player's pack, last blow struck or taken, down, riding,
   airborne and seated, reported to the directory as it changes or once a second. The last blow
   needs the engine's combat to say who fought this tick: today `EVENT_YOU_HIT` and
   `EVENT_YOU_HURT` in `crates/engine/src/combat.rs` are private (made public, or a
   `Players::fought(slot)`), read from each player's `told` effects.
4. **The browser's messages, the server's half**: `channels` (answered with `Region::view`, and sent
   to a merging channel's players when it begins), `channel {to}` and `channel {party: true}`
   (`Region::change`, a refusal answered with `error {text: Refusal::sentence()}`), and `channelMoved
   {from, to, why}` with every move. WORLD_PROTOCOL goes to 12.
5. **The social tier's parties as `Ties`** (friends, guilds and languages answering nothing until it
   keeps them), and on an invitation accepted, `Region::joined_party` (refused for now: the player is
   told they'll go when they can); on leaving or a break-up, `Region::left_party`.

From **land** (R10.21):

6. **No residents.** Channels stop carrying estates and claims (`channels.rs`, the welcome's
   `estates` and `claims`); land's rows are the same in every channel. Migration 0020 (this
   workstream's range) drops `characters.home_channel` once nothing reads it.
7. **What a merge moves.** Players go with their lives, and whatever a life carries with them. If
   land keeps packs on the ground and parked vehicles by space and chunk alike in every channel,
   `Close` re-keys nothing; if it keys them by channel too (the research's "what moves belongs to one
   layer", so two channels can't both take one pack), `Close { n, into }` is where they're re-keyed
   into `into`. Land's call; the hook is there.

Then, in the second half itself:

8. **The crowd on the server**: an `Arena` over the directory in one process, bots arriving as
   players through it (their standing driven by the crowd), with `Tuning::small()` handed to the
   directory: a crowd fills a region, channels open, parties stay together, quiet channels merge, as
   Rust tests in `crates/server`.
9. **An integration spec** (`tests/integration/channels.spec.ts`) on the slot's rig: changing channel
   from the window (refused with a pack, then allowed; the cooldown), and an invitation taking a
   player into their party's channel. It needs a second channel without a thousand players: an
   admin command that opens one, or the server started with small numbers (the rig only).
