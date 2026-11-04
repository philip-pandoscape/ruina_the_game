import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';
import { makeRng } from '../src/rng';
import { makeZoneWorld } from '../src/sim/zone/world';

// The server stands players on the same ground as the browser: it reads Emberholm's height grid
// from server/data/emberholm.terrain (baked from the TypeScript generator) and samples it with the
// same triangles (server/src/terrain.rs). After changing the island, rebake:
//   BAKE=1 npx playwright test tests/terrain.spec.ts

const FILE = 'server/data/emberholm.terrain';
const CHECK = `server/target/release/terraincheck${process.platform === 'win32' ? '.exe' : ''}`;

function bake(): Buffer {
  const hf = makeZoneWorld().terrain!;
  const head = Buffer.alloc(36);
  head.write('RUHF', 0, 'latin1');
  head.writeUInt32LE(1, 4);
  head.writeUInt32LE(hf.cells, 8);
  head.writeDoubleLE(hf.cell, 12);
  head.writeDoubleLE(hf.water, 20);
  head.writeDoubleLE(hf.min, 28);
  return Buffer.concat([head, Buffer.from(hf.heights.buffer, hf.heights.byteOffset, hf.heights.byteLength)]);
}

test("the server's copy of the island's ground is current", () => {
  const want = bake();
  if (process.env.BAKE) {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, want);
  }
  const have = existsSync(FILE) ? readFileSync(FILE) : Buffer.alloc(0);
  expect(have.equals(want), `${FILE} is stale: run BAKE=1 npx playwright test tests/terrain.spec.ts`).toBe(true);
});

test('the server and the browser agree on the height of the ground', () => {
  test.skip(!existsSync(CHECK), 'build the server first: cargo build --release --manifest-path server/Cargo.toml');
  const hf = makeZoneWorld().terrain!;
  const rng = makeRng(20261104);
  const points: Array<[number, number]> = [];
  for (let i = 0; i < 2000; i++) points.push([hf.min - 20 + rng() * (hf.size + 40), hf.min - 20 + rng() * (hf.size + 40)]);
  const server = JSON.parse(execFileSync(CHECK, { input: JSON.stringify(points) }).toString()) as number[];
  const worst = Math.max(...points.map(([x, z], i) => Math.abs(server[i] - hf.height(x, z))));
  expect(worst).toBeLessThan(1e-9);
});
