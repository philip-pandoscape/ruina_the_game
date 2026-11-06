# Baseline: where the refactor starts (measured 2026-11-05 on beta d49c3b8)

Measured on the development machine (Windows 11, i9 laptop) unless it says otherwise. Phase 0
re-measures the suite with a timing reporter (R0.3) and adds the per-test numbers here.

## Code

| Area | Lines | Files |
|---|---|---|
| `src/` (TypeScript client) | ~55,000 | 411 (with assets) |
| ...of which `src/sim/` (the rules, TS copy) | ~10,100 | 40 |
| `server/src/` (Rust) | ~24,250 | 58 |
| `tests/` | ~12,000 | 41 specs + helper |
| `tools/` | ~2,100 | 25 |
| `shared/` (content JSON) | ~5,900 | 16 |

Largest files: `src/main.ts` 2,451; `src/ui/life/lifeUI.ts` 2,024; `src/library/app.ts` 1,912;
`server/src/life/vehicles.rs` 1,809; `src/render/detail/humanoid.ts` 1,532;
`src/render/models/structures.ts` 1,491; `tests/world.spec.ts` 1,408; `src/render/models/vehicles.ts`
1,372; `server/src/game.rs` 1,312; `server/src/world_game.rs` 1,296; `server/src/player.rs` 1,243.

Copy-paste inside each language is low: jscpd finds 15 exact clones, 262 lines (0.33%). The
duplication that matters is the rules written twice, in TypeScript and in Rust.

## Build and test times

| Step | Time |
|---|---|
| `npx tsc --noEmit` (TypeScript 7, native) | ~12 s |
| `vite build` | 2.8 s (12.8 s with start-up) |
| `cargo check` after touching one file | 9.6 s |
| `cargo test` (debug) after touching one rules file | 51 s (1.75 s of it running) |
| `cargo test --release` | 106 s (0.26 s of it running 184 tests) |
| `cargo build --release` after touching one rules file | 1 min 38 s |
| `cargo build --release`, dependencies cached | 3 min 26 s |
| `cargo build --release`, clean (worktree log) | 4 min 35 s |
| Playwright, whole suite, 6 workers | ~12 min (395 tests) |
| Playwright in CI (4 shards, software WebGL) | 10 to 60 min a shard |

The Rust crate is one crate of 24k lines with eight binaries: any change rebuilds and relinks all of
it. Its tests take a second or two to run and a minute or two to build.

## The built game

`vite build` makes 15 MB: models (GLB) 8.7 MB, textures (JPG) 2.7 MB, icons (WebP) 1.0 MB, JavaScript
1.8 MB (one 1.29 MB chunk, 403 KB gzipped), fonts 0.3 MB, CSS 71 KB. Only `index.html` is built: the
developer pages (`library.html`, `animations.html`, `retarget.html`, `buildings.html`, `models.html`,
`creatures.html`, `species.html`, `/design/`) exist only under `npm run dev`, so none of them work on
beta or production.

The server serves the built files with gzip (`server/src/http.rs:77`, `ServeDir`) and no
`Cache-Control`, so a returning player's browser asks again for every file. Everything is in the
first download; nothing streams by zone.

## The repository

- Public on GitHub (`philip-pandoscape/ruina_the_game`), 27.7 MB there. Anything committed is
  published: assets must have licences that allow it (CC0, CC-BY).
- Tracked at HEAD: 31.8 MB. WebP 8.8 MB (icons and their painted sheets), GLB 8.5 MB, JPG 5.7 MB
  (textures, concept art), the baked island `server/data/emberholm.zone` 3.5 MB (generated, and
  rebaked into history at every island change), TypeScript 3.1 MB, Rust 1.0 MB.
- Branches: everything is merged into `beta`. `origin/main` is a stale copy (3 Nov, 196 behind).
  `production` is 151 commits behind `beta`. Merged and idle: `feature/improve-animations`,
  `feature/improve-ui`, `look/emberholm`, `feature/goblins-dread`.
- Worktrees: `yggdrasil-dungeon` (parked, clean), `yggdrasil-improve-animations` (clean, merged),
  `yggdrasil-look` (clean, merged), `yggdrasil-trees` (detached; six untracked scratch pages),
  `.claude/worktrees/agent-aac66e55...` (locked; 23 uncommitted changes from 195365a, a fork that
  looks superseded by the merged dungeon work).

## Toolchain

Node 26.13, TypeScript 7.0.2, Vite 8.3, Playwright 1.64, Three 0.187; Rust 1.99.1 with only the
`x86_64-pc-windows-msvc` target (no `wasm32-unknown-unknown`, no `wasm-bindgen-cli` yet). Docker
Desktop with `postgres:18`.

## The game today

No sound at all (only the bug reporter records a voice). Design bible: `design/status.json` has 12
systems, 114 features (103 done, 9 planned, 2 ideas), 340 file references (none broken), 13 next
steps, 6 open questions and 22 session entries.
