// Runs cargo with the arguments given, for npm scripts: from the PATH when it's there (CI, most
// shells), else from where rustup puts it ($CARGO_HOME/bin, or ~/.cargo/bin), which some Windows
// shells don't have on their PATH.
//
//   node tools/cargo.mjs test --manifest-path server/Cargo.toml

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const onPath = spawnSync(exe, ['--version'], { stdio: 'ignore' }).status === 0;
const home = process.env.CARGO_HOME ?? path.join(homedir(), '.cargo');
const cargo = onPath ? exe : path.join(home, 'bin', exe);
if (!onPath && !existsSync(cargo)) {
  console.error(`cargo is not on the PATH or in ${path.dirname(cargo)}: install Rust from https://rustup.rs`);
  process.exit(1);
}
const run = spawnSync(cargo, process.argv.slice(2), { stdio: 'inherit' });
process.exit(run.status ?? 1);
