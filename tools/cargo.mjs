// Runs cargo with the arguments given, for npm scripts: from the PATH when it's there (CI, most
// shells), else from where rustup puts it ($CARGO_HOME/bin, or ~/.cargo/bin), which some Windows
// shells don't have on their PATH.
//
//   node tools/cargo.mjs test --workspace
//
// `cargo fmt` finds a crate's files through their `mod` lines. The mini-games' rules modules are
// brought in by the engine's build script instead (crates/engine/build.rs finds them in their
// folder), so they're handed to it by name.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const GAMES = 'crates/engine/src/minigames/games';

const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const onPath = spawnSync(exe, ['--version'], { stdio: 'ignore' }).status === 0;
const home = process.env.CARGO_HOME ?? path.join(homedir(), '.cargo');
const cargo = onPath ? exe : path.join(home, 'bin', exe);
if (!onPath && !existsSync(cargo)) {
  console.error(`cargo is not on the PATH or in ${path.dirname(cargo)}: install Rust from https://rustup.rs`);
  process.exit(1);
}
const args = process.argv.slice(2);
if (args[0] === 'fmt' && existsSync(GAMES)) {
  const games = readdirSync(GAMES)
    .filter((f) => f.endsWith('.rs'))
    .map((f) => `${GAMES}/${f}`);
  if (!args.includes('--')) args.push('--');
  args.push(...games);
}
const run = spawnSync(cargo, args, { stdio: 'inherit' });
process.exit(run.status ?? 1);
