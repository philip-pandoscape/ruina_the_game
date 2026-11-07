# The End Pass

Done here, in the orchestrating session, once land is merged and the words sub-agent has renamed
"island" (the user, 2026-11-06, late: stop the extra rounds, fix every bug directly at the end). The
integration and end-to-end tests each workstream listed are in its report
(`.plans/refactor/reports/<id>.md`); this page lists the known gaps to fix and the order to work in.

## Order

1. Merge land; the beta copy's saves taken up again on the merged server (land's migration).
2. The words sub-agent (R10.14), merged.
3. Every tier: unit, conformance, the whole integration tier, then the integration and end-to-end
   tests the reports list, written and run; the stress tier and scale's measurements against its
   baseline; the look check against beta's screenshots; the game as several processes
   (`npm run cluster`, `npm run test:cluster`).
4. The gaps below, each with a test.
5. The docs (Phase 13).
6. Beta: `ADMIN_USERS=philip`, merge and push, CI and the deploy watched.

## Known Gaps

**Borders** (`reports/borders.md`, "Not done"):
- A split region's parts after the first get no lease or placement of their own, so parts run in one
  process only; the leases table knows the first part.
- Across processes, parts should trade a tick late (`Pace::Late`, built and unit-tested, not wired),
  in one process in lockstep.
- A part that stops costs its neighbours 250 ms at every barrier, and nothing takes its chunks over.
- Server bots lose their brains crossing a border (a bot past it stands still).
- `Hand` into a split channel goes to its first part, not the part where the player stands.
- Neighbours' arrows, meteors and effects aren't shown across a border.

**Multiserver** (`reports/multiserver.md`):
- Channels across a services restart: a restarted directory should merge or close nothing until
  every sim has said whom it holds; each region's open channels kept in Postgres (a migration 0032).
- The docs still describe the first half's stand-in and a removed `--spaces` flag.

**Scale** (`reports/scale.md`):
- A player runs 61 inputs a second for 60 sent, so a backlog after a stall drains at one input a
  second (two seconds of backlog take two minutes): catch up faster.

**Bigworld** (`reports/bigworld.md`):
- Combat heights (`Players.ground`) read Emberholm's grid; in other regions the camera's rooms and
  players' cottages use Emberholm's village, and road travel Emberholm's roads.
- The first region of a land pair grows its neighbour's edges with a whole generate.

**Tiers** (`reports/tiers.md`):
- `emberholm()` still called in production in the engine's `session.rs` and `crates/engine-wasm`.

**Channels** (`reports/channels.md`): no keyboard key for the Channels window; friends, guild and
language placement wait for the social tier to keep them.

**Land** (`reports/land.md`): what its final report says is left.

## Found by the First Whole Run (2026-11-07, on cddb69b, everything merged but the words)

The integration tier: 209 passed, 2 failed, 4 didn't run (behind the failures), 1 skipped.
- `online.spec.ts:174` (a second window takes the character over): `saveAndWait` waits for a save,
  but lives are now saved a second after they change and at least once a minute (land), and the
  second window had changed nothing. Make it change something first; `saveAndWait`'s comment still
  says every 5 s. Check the other online specs' waits for the same assumption.
- `update.spec.ts:73`: its own Vite didn't answer within 180 s while another workstream built on the
  machine; the spec alone passes whole (5 of 5).
