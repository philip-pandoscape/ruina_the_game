import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { BEHAVIOURS, startBrain, stepBrain, type Sighting } from '../src/sim/ai/brain';
import type { Actor } from '../src/sim/actor';

// Monster behaviour is data in shared/behaviours.json, read by src/sim/ai/brain.ts offline and
// server/src/ai.rs online. If the two ever drift, a monster would move differently in the
// training yard than it does on a server. This runs every behaviour through both and checks
// they agree frame by frame.

const AICHECK = `server/target/release/aicheck${process.platform === 'win32' ? '.exe' : ''}`;
const FRAMES = 900; // fifteen seconds, enough for many state changes and random draws

// The same path the Rust side works out for itself, so the scenario stays small.
const playerAt = (f: number): [number, number] => [Math.sin(f / 90) * 4, Math.cos(f / 70) * 4 - 1];

function blank(x: number, z: number, seed: number, brain: string): Actor {
  return {
    id: 1, kind: 'test', faction: 1,
    x, y: 0, z, facing: 0,
    radius: 0.4, hitHeight: 0.5, hitCeiling: 1.7, solid: false,
    hp: 1, maxHp: 1, flashFrame: 999, deadFrame: -1,
    brain, state: 0, stateFrame: 0, wait: 0,
    moveX: 0, moveZ: 1, homeX: x, homeZ: z, seed,
    leanX: 0, leanZ: 0, leanVX: 0, leanVZ: 0,
  };
}

function runTs(brain: string, seed: number, x: number, z: number, present: boolean): number[][] {
  const a = blank(x, z, seed, brain);
  const seen = (f: number): Sighting => {
    const [px, pz] = playerAt(f);
    return { x: px, z: pz, present };
  };
  startBrain(a, seen(0));
  const out: number[][] = [];
  for (let f = 0; f < FRAMES; f++) {
    stepBrain(a, seen(f));
    out.push([a.x, a.y, a.z, a.facing, a.state, a.stateFrame, a.wait, a.moveX, a.moveZ]);
  }
  return out;
}

const LABELS = ['x', 'y', 'z', 'facing', 'state', 'stateFrame', 'wait', 'moveX', 'moveZ'];

test.describe('TypeScript and Rust run the same behaviours', () => {
  for (const b of BEHAVIOURS) {
    for (const present of [true, false]) {
      test(`${b.id}${present ? '' : ' with nobody about'}`, () => {
        test.skip(!existsSync(AICHECK), 'build it first: cargo build --release --manifest-path server/Cargo.toml --bin aicheck');
        const seed = 0x51e0 + b.id.length * 7919;
        const scenario = JSON.stringify({ brain: b.id, seed, x: 2.5, z: 3.5, frames: FRAMES, player: present });
        const rust = JSON.parse(execFileSync(AICHECK, { input: scenario, maxBuffer: 64 * 1024 * 1024 }).toString()) as { frames: number[][] };
        const ts = runTs(b.id, seed, 2.5, 3.5, present);

        expect(rust.frames).toHaveLength(ts.length);
        for (let f = 0; f < ts.length; f++) {
          for (let k = 0; k < LABELS.length; k++) {
            const diff = Math.abs(ts[f][k] - rust.frames[f][k]);
            if (diff > 1e-9) {
              throw new Error(`${b.id} frame ${f}: ${LABELS[k]} is ${ts[f][k]} here and ${rust.frames[f][k]} on the server`);
            }
          }
        }
        // It should actually have done something, or the check proves nothing.
        const moved = ts.some((r) => Math.hypot(r[0] - 2.5, r[2] - 3.5) > 0.5);
        expect(moved).toBe(true);
      });
    }
  }
});
