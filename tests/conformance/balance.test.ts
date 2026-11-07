import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, test } from 'vitest';

// End to end, through the real rules: the balance harness (crates/tools/src/bin/balance.rs) runs builds
// against each other under the server's own hit resolution, so this is the last link in the chain
// from the skill tree's data (tests/unit/skilltree.test.ts) to a fight: a modifier in the data
// actually changes who wins.

const BALANCE = `target/release/balance${process.platform === 'win32' ? '.exe' : ''}`;

test('a skill upgrade beats the build it upgrades, measured through the server rules', (ctx) => {
  ctx.skip(!existsSync(BALANCE), 'build it first: cargo build --release --bin balance');
  const scenario = {
    arena: 'battlefield',
    duels: 6,
    seed: 3,
    maxSeconds: 25,
    startDistance: 8,
    builds: [
      { name: 'mage', skills: ['staff', 'meteor'], weapon: 'staff', abilities: ['meteor'] },
      { name: 'quick', skills: ['staff', 'meteor', 'quickIncantation'], weapon: 'staff', abilities: ['meteor'] },
      { name: 'healer', skills: ['club', 'heal'], weapon: 'club', abilities: ['heal'] },
      { name: 'mender', skills: ['club', 'heal', 'swiftMending'], weapon: 'club', abilities: ['heal'] },
      { name: 'archer', skills: ['bow'], weapon: 'bow', abilities: [] },
      { name: 'rapid', skills: ['bow', 'rapidFire'], weapon: 'bow', abilities: [] },
    ],
  };
  const out = JSON.parse(execFileSync(BALANCE, { input: JSON.stringify(scenario), maxBuffer: 16 * 1024 * 1024 }).toString()) as {
    pairings: Array<{ a: string; b: string; aWinRate: number; draws: number }>;
  };
  const rate = (a: string, b: string) => out.pairings.find((p) => p.a === a && p.b === b)!.aWinRate;
  // Casting faster, drawing faster: each upgrade should win its own mirror.
  expect(rate('mage', 'quick')).toBeLessThan(0.5);
  expect(rate('healer', 'mender')).toBeLessThan(0.5);
  expect(rate('archer', 'rapid')).toBeLessThan(0.5);
});
