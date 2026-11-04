import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { BEHAVIOURS, behaviour, startBrain, stepBrain, type Sighting } from '../src/sim/ai/brain';
import { Actors, isAlive, type Actor } from '../src/sim/actor';
import { actorKind, actorKindAt, actorKindIndex } from '../src/content/actors';
import { stepActors } from '../src/sim/actors/step';
import { hurtActor } from '../src/sim/combat/deal';
import { len } from '../src/sim/math';

// Monster behaviour is data in shared/behaviours.json, read by src/sim/ai/brain.ts offline and
// server/src/ai.rs online. If the two ever drift, a monster would move differently in the
// training yard than it does on a server. This runs every behaviour through both and checks
// they agree frame by frame - each brain on its own, then whole packs of real kinds fighting,
// where calling, gathering, bursting and reforming all happen.

const AICHECK = `server/target/release/aicheck${process.platform === 'win32' ? '.exe' : ''}`;
const FRAMES = 900; // fifteen seconds, enough for many state changes and random draws

// The same path the Rust side works out for itself, so the scenario stays small.
const playerAt = (f: number): [number, number] => [Math.sin(f / 90) * 4, Math.cos(f / 70) * 4 - 1];

const rust = <T>(scenario: object): T =>
  JSON.parse(execFileSync(AICHECK, { input: JSON.stringify(scenario), maxBuffer: 256 * 1024 * 1024 }).toString()) as T;

// One brain on its own, built by hand so the kind doesn't have to exist.
function blank(x: number, z: number, seed: number, brain: string): Actor {
  const scratch = new Actors(actorKind);
  const a = scratch.spawn({ kind: 'slime', x, z, seed });
  return {
    ...a,
    id: 1, kind: 'test', faction: 1, ladder: -1, homeKind: 'test', mass: 0,
    radius: 0.4, hitHeight: 0.5, hitCeiling: 1.7, solid: false,
    hp: 1, maxHp: 1, brain, moveX: 0, moveZ: 1,
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
        const r = rust<{ frames: number[][] }>({ brain: b.id, seed, x: 2.5, z: 3.5, frames: FRAMES, player: present });
        const ts = runTs(b.id, seed, 2.5, 3.5, present);

        expect(r.frames).toHaveLength(ts.length);
        for (let f = 0; f < ts.length; f++) {
          for (let k = 0; k < LABELS.length; k++) {
            const diff = Math.abs(ts[f][k] - r.frames[f][k]);
            if (diff > 1e-9) {
              throw new Error(`${b.id} frame ${f}: ${LABELS[k]} is ${ts[f][k]} here and ${r.frames[f][k]} on the server`);
            }
          }
        }
        // It should actually have done something, or the check proves nothing.
        const moved = ts.some((row) => Math.hypot(row[0] - 2.5, row[2] - 3.5) > 0.5);
        expect(moved).toBe(true);
      });
    }
  }
});

// ---------- whole packs ----------

interface Spawn { kind: string; x: number; z: number; seed: number }
interface Hit { frame: number; x: number; z: number; damage: number }
interface Pack {
  pack: Spawn[];
  frames: number;
  hits: Hit[];
  /** What the fight has to have got up to, so a pass proves something: kinds seen, states entered, slams. */
  expect: { kinds: string[]; states: string[]; slams: boolean };
}
interface PackRun { frames: number[][][]; slams: number[][][] }

const ROW = ['id', 'kind', 'x', 'y', 'z', 'facing', 'state', 'stateFrame', 'wait', 'hp', 'mass', 'deadFrame',
  'angry', 'rallyTo', 'calling', 'fuse', 'group', 'gone', 'pulled', 'stride'];

const row = (a: Actor): number[] => [
  a.id, actorKindIndex(a.kind), a.x, a.y, a.z, a.facing, a.state, a.stateFrame, a.wait, a.hp, a.mass, a.deadFrame,
  a.angry, a.rallyTo, a.calling, a.fuse, a.group, a.gone ? 1 : 0, a.pulled, a.stride,
];

// The same fight, run by the browser's rules: hits land on whoever stands nearest a point, struck
// from where the player is, then every actor takes its frame.
function runPackTs(s: Pack): PackRun {
  const actors = new Actors(actorKind);
  for (const p of s.pack) {
    const a = actors.spawn({ kind: p.kind, x: p.x, z: p.z, seed: p.seed });
    startBrain(a, { x: p.x, z: p.z, present: false });
  }
  const out: PackRun = { frames: [], slams: [] };
  for (let f = 0; f < s.frames; f++) {
    const [px, pz] = playerAt(f);
    for (const h of s.hits.filter((v) => v.frame === f)) {
      let best: Actor | undefined;
      let bestDist = Infinity;
      for (const a of actors.all()) {
        if (!isAlive(a) || a.gone) continue;
        const d = len(a.x - h.x, a.z - h.z);
        if (d < bestDist) {
          best = a;
          bestDist = d;
        }
      }
      if (best) {
        const d = Math.max(1e-6, len(best.x - px, best.z - pz));
        hurtActor(actors, best, h.damage, (best.x - px) / d, (best.z - pz) / d, 0);
      }
    }
    const slams: number[][] = [];
    stepActors({
      actors,
      seen: { x: px, z: pz, present: true },
      frame: f,
      ground: () => 0,
      emit: () => {},
      slam: (x, z, radius, damage) => slams.push([x, z, radius, damage]),
    });
    out.frames.push(actors.all().map(row));
    out.slams.push(slams);
  }
  return out;
}

function comparePacks(name: string, ts: PackRun, r: PackRun): void {
  expect(r.frames).toHaveLength(ts.frames.length);
  for (let f = 0; f < ts.frames.length; f++) {
    if (ts.frames[f].length !== r.frames[f].length) {
      throw new Error(`${name} frame ${f}: ${ts.frames[f].length} actors here and ${r.frames[f].length} on the server`);
    }
    for (let i = 0; i < ts.frames[f].length; i++) {
      for (let k = 0; k < ROW.length; k++) {
        const diff = Math.abs(ts.frames[f][i][k] - r.frames[f][i][k]);
        if (diff > 1e-9) {
          throw new Error(`${name} frame ${f}, actor ${ts.frames[f][i][0]}: ${ROW[k]} is ${ts.frames[f][i][k]} here and ${r.frames[f][i][k]} on the server`);
        }
      }
    }
    const a = JSON.stringify(ts.slams[f]);
    const b = JSON.stringify(r.slams[f].map((s) => s.map((v) => v)));
    if (ts.slams[f].length !== r.slams[f].length || ts.slams[f].some((s, j) => s.some((v, k) => Math.abs(v - r.slams[f][j][k]) > 1e-9))) {
      throw new Error(`${name} frame ${f}: slams ${a} here and ${b} on the server`);
    }
  }
}

const ring = (kind: string, n: number, cx: number, cz: number, r: number, seed: number): Spawn[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + 0.4;
    return { kind, x: cx + Math.sin(a) * r, z: cz + Math.cos(a) * r, seed: (seed + Math.imul(i, 0x9e3779b1)) >>> 0 };
  });

// A steady stream of blows at whatever stands nearest a spot, then a long quiet stretch for the
// survivors to rally, gather and reform in.
const hitsAt = (x: number, z: number, from: number, to: number, every: number, damage: number): Hit[] =>
  Array.from({ length: Math.floor((to - from) / every) }, (_, i) => ({ frame: from + i * every, x, z, damage }));

const PACKS: Record<string, Pack> = {
  'a pack of slimes, hit and left alone': {
    pack: ring('slime', 6, 0, 3, 4, 0x51e0),
    frames: 2400,
    hits: hitsAt(0, 3, 30, 420, 18, 12),
    expect: { kinds: ['slime', 'slimelet'], states: ['chase', 'windup', 'leap', 'scatter', 'flee', 'regroup'], slams: true },
  },
  'mixed sizes, hit hard': {
    pack: [...ring('slime', 4, 0, 2, 5, 0x77aa), ...ring('great-slime', 1, 0, 2, 0.5, 0x1234), ...ring('slimelet', 3, 2, -1, 2, 0x99)],
    frames: 2400,
    hits: [...hitsAt(0, 2, 20, 300, 12, 26), ...hitsAt(3, 3, 900, 1100, 15, 14)],
    expect: { kinds: ['slime', 'great-slime', 'slimelet'], states: ['chase', 'windup', 'leap', 'scatter', 'regroup'], slams: true },
  },
};

test.describe('TypeScript and Rust run the same packs', () => {
  for (const [name, s] of Object.entries(PACKS)) {
    test(name, () => {
      test.skip(!existsSync(AICHECK), 'build it first: cargo build --release --manifest-path server/Cargo.toml --bin aicheck');
      const ts = runPackTs(s);
      const { expect: want, ...scenario } = s;
      comparePacks(name, ts, rust<PackRun>(scenario));
      const kinds = new Set<number>();
      const states = new Set<string>();
      for (const frame of ts.frames) {
        for (const r of frame) {
          kinds.add(r[1]);
          const k = actorKindAt(r[1]);
          const st = k?.brain ? behaviour(k.brain)?.states[r[6]]?.name : undefined;
          if (st) states.add(st);
        }
      }
      for (const k of want.kinds) expect(kinds, `${name} never had a ${k}`).toContain(actorKindIndex(k));
      for (const st of want.states) expect(states, `${name} never went into ${st}`).toContain(st);
      if (want.slams) expect(ts.slams.some((f) => f.length > 0), `${name} never slammed`).toBe(true);
    });
  }
});
