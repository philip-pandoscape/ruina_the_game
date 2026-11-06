# Refactor Progress Report

What has landed on `refactor/first`, phase by phase, newest last. Each entry says what changed, the
numbers against the [baseline](inventory/baseline.md), decisions made on the way, problems, and
what's next. The work doesn't wait for this to be read; read it whenever suits you. The full task list
is in [tracker.md](tracker.md), the plan in [README.md](README.md).

## At a Glance

| Phase | State |
|---|---|
| 0 Prepare and Measure | in progress |
| 1 Test Tiers | to do |
| 2 Clear Out Dead Code | to do |
| 3 Admin Menu | to do |
| 4 The /find-assets Skill | to do |
| 5 The Rust Workspace | to do |
| 6 The Client in Areas | to do |
| 7 Content in Folders | to do |
| 8 One Copy of the Rules | to do |
| 9 Content as Data, Finished | to do |
| 10 Zones, Developer Zones and Bots | to do |
| 11 Bigger Than 64 MB | to do |
| 12 The Design Bible as a Knowledge Base | to do |
| 13 AGENTS.md, the Docs and the Merge | to do |

## 2026-11-05: The Survey and the Review

- **Surveyed the whole codebase** with five read-only explorers (one round was cancelled by an
  interrupt and rerun): the test suite, content and data, the rules in TypeScript and Rust, dead code
  and tech debt, and the architecture with accounts and developer pages. Six inventory files hold what
  they found; the plan and tracker cite them line by line.
- **Measured the starting point** ([baseline](inventory/baseline.md)): 395 Playwright tests (~12 min
  here), 182 Rust tests that run in 2 s but take 51 s (debug) to 106 s (release) to rebuild after
  touching one rules file, a 15 MB game sent all at once, a 31.8 MB public repository.
- **Findings worth knowing beyond the plan:**
  - Every player on beta can use the developer commands (grant, warp, teleport): beta runs with
    `DEV_TOOLS=1`. Phase 3 closes this; until the merge it stays as it is on beta.
  - The battlefield's socket (`/ws/battle`) checks neither sign-in nor origin (the battlefield is off
    on Railway, so nothing is exposed today).
  - The TypeScript and Rust rules agree only to about a millionth, not bit for bit, and one server loop
    (`rebuild_world`) walks a randomly ordered map, so colliders go in a different order each run.
  - CI renders in software, which switches the game to the old toon look and the box hero, so CI has
    been testing different code from what players see.
- **Your review** (canvas round 1): the plan approved with changes, recorded as decisions D0 to D14 in
  the plan. The big ones: run every phase to the end and merge into `beta` once; the yard and the
  battlefield become developer zones with bots as a core engine feature (a new Phase 10); the design
  bible becomes a knowledge base anyone can read (a new Phase 12); the toon look is retired; one
  Content Library page; `philip` is the admin; the server becomes `ruina-server`; big files go to Git
  LFS.
- **Optional for you, nothing waits on it:** play the five recent pushes on beta (Lanternwick's
  buildings, Goblin's Dread's way in and a party, `?yard&goblins=6`, the painted icons, the animation
  library locally), so a bug found later isn't blamed on the refactor.
- **Next:** the rest of Phase 0: the timing reporter, the baseline run, tidying branches and
  worktrees, Git LFS.
