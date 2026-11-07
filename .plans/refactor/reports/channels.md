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
