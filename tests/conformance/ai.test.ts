import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { BEHAVIOURS, behaviour, sightingAt, startBrain, stepBrain, type Sighting } from '../../src/sim/ai/brain';
import type { Foe } from '../../src/sim/ai/senses';
import { Actors, isAlive, type Actor } from '../../src/sim/actor';
import { actorKind, actorKindAt, actorKindIndex } from '../../src/content/actors';
import { stepActors } from '../../src/sim/actors/step';
import { hurtActor } from '../../src/sim/combat/deal';
import { len } from '../../src/sim/math';

// Monster behaviour is data in shared/behaviours.json and shared/creatures.json, read by
// src/sim/ai/brain.ts offline and crates/engine/src/ai.rs online. If the two ever drift, a monster would
// move differently in the training yard than it does on a server. This runs every behaviour
// through both and checks they agree frame by frame - each brain on its own, then whole packs of
// real kinds fighting, where calling, gathering, bursting and reforming all happen, and war-bands
// of goblins fight scripted players: sharing out tokens, circling, stabbing, throwing stones,
// running and drinking.

const AICHECK = `target/release/aicheck${process.platform === 'win32' ? '.exe' : ''}`;
const FRAMES = 900; // fifteen seconds, enough for many state changes and random draws

// The same path the Rust side works out for itself, so the scenario stays small.
const playerAt = (f: number): [number, number] => [Math.sin(f / 90) * 4, Math.cos(f / 70) * 4 - 1];

const rust = <T>(scenario: object): T => JSON.parse(execFileSync(AICHECK, { input: JSON.stringify(scenario), maxBuffer: 256 * 1024 * 1024 }).toString()) as T;

// One brain on its own, built by hand so the kind doesn't have to exist.
function blank(x: number, z: number, seed: number, brain: string): Actor {
  const scratch = new Actors(actorKind);
  const a = scratch.spawn({ kind: 'slime', x, z, seed });
  return {
    ...a,
    id: 1,
    kind: 'test',
    faction: 1,
    ladder: -1,
    homeKind: 'test',
    mass: 0,
    radius: 0.4,
    hitHeight: 0.5,
    hitCeiling: 1.7,
    solid: false,
    hp: 1,
    maxHp: 1,
    brain,
    moveX: 0,
    moveZ: 1,
  };
}

function runTs(brain: string, seed: number, x: number, z: number, present: boolean): number[][] {
  const a = blank(x, z, seed, brain);
  const seen = (f: number): Sighting => {
    const [px, pz] = playerAt(f);
    return sightingAt(px, pz, present);
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

describe('TypeScript and Rust run the same behaviours', () => {
  for (const b of BEHAVIOURS) {
    for (const present of [true, false]) {
      test(`${b.id}${present ? '' : ' with nobody about'}`, (ctx) => {
        ctx.skip(!existsSync(AICHECK), 'build it first: cargo build --release --bin aicheck');
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

interface Spawn {
  kind: string;
  x: number;
  z: number;
  seed: number;
  band?: number;
}
interface Hit {
  frame: number;
  x: number;
  z: number;
  damage: number;
}
/**
 * A scripted player: walks back and forth between two points every `period` frames, facing a
 * point, swinging and dodging on a beat. Exact arithmetic only (and atan2, which both sides share
 * bit for bit), so crates/tools/src/bin/aicheck.rs works out the very same foe.
 */
interface FoeScript {
  id: number;
  from: [number, number];
  to: [number, number];
  period?: number;
  look: [number, number];
  reach?: number;
  ranged?: boolean;
  /** [every, swinging for, recovering for] frames; every 0 never swings. */
  swing?: [number, number, number];
  /** [every, from, to] frames of a dodge's untouchable window. */
  dodge?: [number, number, number];
  hp?: number;
}
interface Pack {
  pack: Spawn[];
  frames: number;
  hits: Hit[];
  foes?: FoeScript[];
  /** What the fight has to have got up to, so a pass proves something: kinds seen, states entered (and never entered), slams, blows on foes, missiles. */
  expect: { kinds: string[]; states: string[]; slams: boolean; hits?: boolean; missiles?: boolean; never?: string[] };
}
interface PackRun {
  frames: number[][][];
  slams: number[][][];
  hits: number[][][];
  missiles: number[][][];
}

const ROW = [
  'id',
  'kind',
  'x',
  'y',
  'z',
  'facing',
  'state',
  'stateFrame',
  'wait',
  'hp',
  'mass',
  'deadFrame',
  'angry',
  'rallyTo',
  'calling',
  'fuse',
  'group',
  'gone',
  'pulled',
  'stride',
  'target',
  'band',
  'token',
  'opening',
  'afraid',
  'slotX',
  'slotZ',
  'rallyX',
  'rallyZ',
  'destX',
  'destZ',
  'charges',
  'cd0',
  'cd1',
  'struck',
];

const row = (a: Actor): number[] => [
  a.id,
  actorKindIndex(a.kind),
  a.x,
  a.y,
  a.z,
  a.facing,
  a.state,
  a.stateFrame,
  a.wait,
  a.hp,
  a.mass,
  a.deadFrame,
  a.angry,
  a.rallyTo,
  a.calling,
  a.fuse,
  a.group,
  a.gone ? 1 : 0,
  a.pulled,
  a.stride,
  a.target,
  a.band,
  a.token ? 1 : 0,
  a.opening ? 1 : 0,
  a.afraid ? 1 : 0,
  a.slotX,
  a.slotZ,
  a.rallyX,
  a.rallyZ,
  a.destX,
  a.destZ,
  a.charges,
  a.cds[0],
  a.cds[1],
  a.struck ? 1 : 0,
];

function foeAt(s: FoeScript, f: number): Foe {
  const period = s.period ?? 1;
  const t = (f % period) / period;
  const k = t < 0.5 ? 2 * t : 2 - 2 * t;
  const dir = t < 0.5 ? 2 : -2;
  const x = s.from[0] + (s.to[0] - s.from[0]) * k;
  const z = s.from[1] + (s.to[1] - s.from[1]) * k;
  const vx = (((s.to[0] - s.from[0]) * dir) / period) * 60;
  const vz = (((s.to[1] - s.from[1]) * dir) / period) * 60;
  let act = 0;
  let invuln = false;
  const swing = s.swing ?? [0, 0, 0];
  const dodge = s.dodge ?? [0, 0, 0];
  if (swing[0] > 0) {
    const c = f % swing[0];
    if (c < swing[1]) act = 1;
    else if (c < swing[1] + swing[2]) act = 2;
  }
  if (act === 0 && dodge[0] > 0) {
    const c = f % dodge[0];
    if (c >= dodge[1] && c < dodge[2]) {
      act = 5;
      invuln = true;
    }
  }
  return {
    id: s.id,
    x,
    y: 0,
    z,
    vx,
    vz,
    facing: Math.atan2(s.look[0] - x, s.look[1] - z),
    hp: s.hp ?? 1,
    reach: s.reach ?? 0,
    ranged: s.ranged ?? false,
    act,
    invuln,
    air: 0,
  };
}

const plainFoe = (x: number, z: number): Foe => ({ id: 1, x, y: 0, z, vx: 0, vz: 0, facing: 0, hp: 1, reach: 0, ranged: false, act: 0, invuln: false, air: 0 });

// The same fight, run by the browser's rules: hits land on whoever stands nearest a point, struck
// from where the player is, then every actor takes its frame.
function runPackTs(s: Pack): PackRun {
  const actors = new Actors(actorKind);
  for (const p of s.pack) {
    const a = actors.spawn({ kind: p.kind, x: p.x, z: p.z, seed: p.seed });
    a.band = p.band ?? 0;
    startBrain(a, sightingAt(p.x, p.z, false));
  }
  const out: PackRun = { frames: [], slams: [], hits: [], missiles: [] };
  for (let f = 0; f < s.frames; f++) {
    const foes = s.foes ? s.foes.map((fs) => foeAt(fs, f)) : [plainFoe(...playerAt(f))];
    const [px, pz] = [foes[0].x, foes[0].z];
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
    const hits: number[][] = [];
    stepActors({
      actors,
      foes,
      frame: f,
      ground: () => 0,
      emit: () => {},
      slam: (x, z, radius, damage) => slams.push([x, z, radius, damage]),
      hitFoe: (id, damage, nx, nz, knock) => hits.push([id, damage, nx, nz, knock]),
    });
    out.frames.push(actors.all().map(row));
    out.slams.push(slams);
    out.hits.push(hits);
    out.missiles.push(actors.missiles.map((m) => [m.id, m.x, m.y, m.z, m.vy]));
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
    for (const [what, mine, theirs] of [
      ['blows on foes', ts.hits[f], r.hits[f]],
      ['missiles', ts.missiles[f], r.missiles[f]],
    ] as const) {
      if (mine.length !== theirs.length || mine.some((s, j) => s.some((v, k) => Math.abs(v - theirs[j][k]) > 1e-9))) {
        throw new Error(`${name} frame ${f}: ${what} ${JSON.stringify(mine)} here and ${JSON.stringify(theirs)} on the server`);
      }
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
    hits: hitsAt(0, 3, 30, 900, 12, 26),
    expect: {
      kinds: ['slime', 'slimelet', 'great-slime'],
      states: ['chase', 'windup', 'leap', 'call', 'rally', 'gather', 'scatter', 'flee', 'huddle', 'regroup'],
      slams: true,
    },
  },
  'mixed sizes, hit hard': {
    pack: [...ring('slime', 4, 0, 2, 5, 0x77aa), ...ring('great-slime', 1, 0, 2, 0.5, 0x1234), ...ring('slimelet', 3, 2, -1, 2, 0x99)],
    frames: 2400,
    hits: [...hitsAt(0, 2, 20, 300, 12, 26), ...hitsAt(3, 3, 900, 1100, 15, 14)],
    expect: { kinds: ['slime', 'great-slime', 'slimelet'], states: ['chase', 'windup', 'leap', 'scatter', 'flee'], slams: true },
  },
  // One blow, then nothing: the slime that was hit calls, the pack rallies to it, and it gathers.
  'one hit, and the pack gathers': {
    pack: ring('slime', 5, 0, 6, 5, 0x3c3c),
    frames: 1500,
    hits: [{ frame: 30, x: 2, z: 11, damage: 1 }],
    expect: { kinds: ['slime', 'great-slime'], states: ['call', 'rally', 'gather'], slams: false },
  },
  // The same, with small blows landing on the caller all through its cast until it breaks.
  'the gather broken': {
    pack: ring('slime', 5, 0, 6, 5, 0x3c3c),
    frames: 1500,
    hits: [{ frame: 30, x: 2, z: 11, damage: 1 }, ...hitsAt(2, 11, 150, 420, 9, 3)],
    expect: { kinds: ['slime'], states: ['call', 'rally', 'gather', 'dazed'], slams: false },
  },
  // A war-band against a swordsman pacing in front of it, swinging every second and a half and
  // dodging now and then, cutting down whoever comes nearest: they notice him, share out who
  // strikes, circle and throw stones, flinch when struck and run when hurt.
  'a goblin band against a swordsman': {
    pack: ring('goblin', 6, 0, 7, 2, 0x6b1d).map((p) => ({ ...p, band: 1 })),
    frames: 2400,
    foes: [{ id: 1, from: [-4, 1], to: [4, 1], period: 360, look: [0, 7], reach: 2.1, swing: [90, 9, 14], dodge: [210, 150, 163] }],
    hits: hitsAt(0, 2.5, 200, 1400, 30, 12),
    expect: {
      kinds: ['goblin'],
      states: ['spot', 'engage', 'circle', 'close', 'stab', 'backoff', 'throw', 'retreat', 'flinch'],
      slams: false,
      hits: true,
      missiles: true,
    },
  },
  // Two bands and two foes, one of them an archer: nobody throws stones at someone with no reach,
  // they go in close.
  'two bands, a swordsman and an archer': {
    pack: [...ring('goblin', 4, -6, 6, 1.6, 0x2a2a).map((p) => ({ ...p, band: 1 })), ...ring('goblin', 3, 6, 6, 1.4, 0x3b3b).map((p) => ({ ...p, band: 2 }))],
    frames: 1800,
    foes: [
      { id: 1, from: [-6, 0], to: [-2, 2], period: 300, look: [-6, 6], reach: 2.1, swing: [80, 9, 14] },
      { id: 2, from: [6, -1], to: [3, 1], period: 420, look: [6, 6], ranged: true },
    ],
    hits: [...hitsAt(-5, 2, 300, 900, 40, 12), ...hitsAt(5, 1, 400, 1000, 45, 12)],
    expect: { kinds: ['goblin'], states: ['spot', 'circle', 'close', 'stab', 'throw', 'flinch'], slams: false, hits: true, missiles: true },
  },
  // A lone goblin worn down by a swordsman who keeps coming and going: it runs home and, once
  // he is far enough off, drinks its potion.
  'a lone goblin drinks when it gets clear': {
    pack: [{ kind: 'goblin', x: 0, z: 9, seed: 0x5eed, band: 0 }],
    frames: 1800,
    foes: [{ id: 1, from: [0, -2], to: [0, 6], period: 500, look: [0, 9], reach: 2.1, swing: [100, 9, 14] }],
    hits: [
      { frame: 260, x: 0, z: 6, damage: 12 },
      { frame: 330, x: 0, z: 6, damage: 6 },
    ],
    expect: { kinds: ['goblin'], states: ['spot', 'close', 'stab', 'flinch', 'retreat', 'drink'], slams: false, hits: true },
  },
};

describe('TypeScript and Rust run the same packs', () => {
  for (const [name, s] of Object.entries(PACKS)) {
    test(name, (ctx) => {
      ctx.skip(!existsSync(AICHECK), 'build it first: cargo build --release --bin aicheck');
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
      for (const st of want.never ?? []) expect(states, `${name} went into ${st}`).not.toContain(st);
      if (want.slams)
        expect(
          ts.slams.some((f) => f.length > 0),
          `${name} never slammed`,
        ).toBe(true);
      if (want.hits)
        expect(
          ts.hits.some((f) => f.length > 0),
          `${name} never landed a blow on a foe`,
        ).toBe(true);
      if (want.missiles)
        expect(
          ts.missiles.some((f) => f.length > 0),
          `${name} never threw anything`,
        ).toBe(true);
    });
  }
});
