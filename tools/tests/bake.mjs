// Rebakes the server's copy of the island (crates/engine/data/emberholm.zone) from the TypeScript generator,
// after a change to the island (shared/zones/, src/sim/zone/, the building plans): `npm run bake`.
// The bake is a test that writes the file when BAKE is set (tests/conformance/terrain.test.ts), and
// this sets it the same way on Windows and Linux. Rebuild the server afterwards: it builds the bake in.

import { spawnSync } from 'node:child_process';

const run = spawnSync('npx', ['vitest', 'run', '--project', 'conformance', 'tests/conformance/terrain.test.ts'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, BAKE: '1' },
});
process.exit(run.status ?? 1);
