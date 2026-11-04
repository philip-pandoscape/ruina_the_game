import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { Sim } from '../src/sim/sim';
import { NO_ACTIONS, type Actions, type World } from '../src/sim/types';
import { EMBERHOLM, type ZoneData } from '../src/sim/zone/world';
import { generateZone } from '../src/sim/zone/generate';
import { ColliderIndex, groundAt } from '../src/sim/zone/colliders';
import { Life, type Command } from '../src/sim/life/life';
import { dismount } from '../src/sim/life/vehicles';
import { applySave, islandData, type Island } from '../src/app/save';

// Online, the game server runs your island (server/src/life, server/src/open) and the browser shows
// what it decides, predicting only your own moves and vehicles in between. If the two sets of
// rules ever disagree, the island would jump about or a command would do something else than the
// prompt said. This plays the same scripted sessions (walking about, talking, farming, crafting,
// pack running, driving, riding, gliding, swimming, building) through the TypeScript and through
// server/src/bin/lifecheck.rs, and checks the player and the whole island at checkpoints.

const LIFECHECK = `server/target/release/lifecheck${process.platform === 'win32' ? '.exe' : ''}`;

interface Segment {
  frames: number;
  a?: Partial<Actions>;
  cmds?: Command[];
  tp?: { x: number; z: number; facing?: number };
}

interface Script {
  coins?: number;
  labor?: number;
  /** Start from an island the browser saved (as kept in Postgres). */
  island?: Island;
  every: number;
  segments: Segment[];
}

interface Checkpoint {
  frame: number;
  player: Record<string, unknown>;
  life: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
}

/** Emberholm as makeZoneWorld() builds it, but its own copy: the rules add to its colliders. */
function freshWorld(): World {
  const recipe = EMBERHOLM;
  const gen = generateZone(recipe);
  const hf = gen.terrain;
  const zone: ZoneData = { recipe, gen };
  return {
    seed: recipe.seed,
    spawns: [],
    radius: hf.size / 2 - 8,
    obstacles: gen.obstacles,
    dummy: { ...recipe.dummy },
    spawn: { ...recipe.spawn },
    teamSpawns: [{ ...recipe.spawn }, { ...recipe.spawn }],
    terrain: hf,
    index: new ColliderIndex(gen.obstacles, gen.boxes, gen.decks),
    zone,
  };
}

/** The script through the TypeScript rules, as the browser would run it offline. */
function runTs(script: Script): Checkpoint[] {
  return playTs(script).out;
}

/** The island the browser would save at the end of a script. */
function islandAfter(script: Script): Island {
  const { life, sim } = playTs(script);
  return JSON.parse(JSON.stringify(islandData(life, sim))) as Island;
}

function playTs(script: Script): { out: Checkpoint[]; life: Life; sim: Sim } {
  const world = freshWorld();
  const hf = world.terrain!;
  const sim = new Sim(world, { training: false });
  const life = new Life(world.zone!, { coins: script.coins, labor: script.labor });
  sim.life = life;
  const p = sim.player;
  p.pos.y = groundAt(hf, world.index, p.pos.x, p.pos.z, hf.height(p.pos.x, p.pos.z) + 1.2, 1.2);
  p.prevPos = { ...p.pos };
  life.afterReset(sim);
  if (script.island) applySave(life, sim, { ...JSON.parse(JSON.stringify(script.island)), savedAt: 0 }, 0);
  const total = script.segments.reduce((n, s) => n + s.frames, 0);
  const out: Checkpoint[] = [];
  let events: Array<Record<string, unknown>> = [];
  let frame = 0;
  for (const seg of script.segments) {
    if (seg.tp) {
      // The developer panel's teleport (src/main.ts teleport, offline).
      if (sim.player.mode === 'ride') dismount(life, sim);
      const q = sim.player;
      const y = groundAt(hf, world.index, seg.tp.x, seg.tp.z, hf.height(seg.tp.x, seg.tp.z) + 1.2, 1.2);
      q.pos = { x: seg.tp.x, y, z: seg.tp.z };
      q.prevPos = { ...q.pos };
      q.vel = { x: 0, y: 0, z: 0 };
      if (seg.tp.facing !== undefined) q.facing = q.prevFacing = seg.tp.facing;
      if (q.mode === 'glide' || q.mode === 'swim') q.mode = 'normal';
      q.grounded = true;
    }
    const a = { ...NO_ACTIONS, ...seg.a };
    for (let f = 0; f < seg.frames; f++) {
      if (f === 0) for (const c of seg.cmds ?? []) life.command(c);
      sim.step(a);
      sim.drainEvents();
      events.push(...(life.drainEvents() as unknown as Array<Record<string, unknown>>));
      frame++;
      if (frame % script.every === 0 || frame === total) {
        out.push(JSON.parse(JSON.stringify({ frame, player: sim.player, life: life.state, events })));
        events = [];
      }
    }
  }
  return { out, life, sim };
}

function runRust(script: Script): Checkpoint[] {
  return JSON.parse(execFileSync(LIFECHECK, { input: JSON.stringify(script), maxBuffer: 1 << 28 }).toString()) as Checkpoint[];
}

/** Where everything is said not to match, as readable lines. Numbers within `tol` count as equal. */
function differences(a: unknown, b: unknown, path: string, out: string[], tol: number): void {
  if (out.length > 30) return;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > tol * Math.max(1, Math.abs(a))) out.push(`${path}: ${a} vs ${b}`);
    return;
  }
  if (a === null || b === null || a === undefined || b === undefined || typeof a !== 'object' || typeof b !== 'object') {
    if (a !== b) out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) differences((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out, tol);
}

/** The player fields both sides keep (the TypeScript's prevPos and prevFacing are the renderer's). */
const PLAYER_KEYS = ['pos', 'vel', 'facing', 'mode', 'grounded', 'jumpsUsed', 'hp', 'stun', 'downFrame', 'pack', 'vehicle', 'seat', 'glider', 'airspeed', 'bank', 'modeFrame', 'gustFrames', 'sprinting', 'crouching'];

function compare(name: string, script: Script): void {
  const ts = runTs(script);
  const rs = runRust(script);
  expect(rs.length, `${name}: checkpoints`).toBe(ts.length);
  for (let i = 0; i < ts.length; i++) {
    const out: string[] = [];
    const pick = (p: Record<string, unknown>) => Object.fromEntries(PLAYER_KEYS.map((k) => [k, p[k]]));
    differences(pick(ts[i].player), pick(rs[i].player), 'player', out, 1e-6);
    differences(ts[i].life, rs[i].life, 'life', out, 1e-6);
    differences(ts[i].events, rs[i].events, 'events', out, 1e-9);
    expect(out, `${name}: frame ${ts[i].frame} differs:\n${out.join('\n')}`).toEqual([]);
  }
}

// ---------- Where things are on Emberholm ----------

const R = EMBERHOLM;
const npc = (id: string) => R.npcs.find((n) => n.id === id)!;
const bench = (id: string) => R.workbenches.find((b) => b.id === id)!;
/** Standing `d` metres from a point, on the side `angle` points to, facing it. */
function facingFrom(x: number, z: number, d: number, angle: number): { x: number; z: number; facing: number } {
  const px = x + Math.sin(angle) * d;
  const pz = z + Math.cos(angle) * d;
  return { x: px, z: pz, facing: Math.atan2(x - px, z - pz) };
}
const idle = (frames: number, cmds?: Command[]): Segment => ({ frames, cmds });

test.describe('the island on the server matches the browser', () => {
  test.skip(!existsSync(LIFECHECK), 'build the server first: cargo build --release --manifest-path server/Cargo.toml');

  test('the first quest, a farm plot, planting, harvesting and the grocer', () => {
    const hollis = npc('hollis');
    const mara = npc('mara');
    const farm = R.farmland;
    const plot = { x: farm.x, z: farm.z };
    compare('landfall', {
      every: 30,
      segments: [
        idle(20),
        { frames: 10, tp: facingFrom(hollis.x, hollis.z, 1.6, Math.PI) },
        idle(20, [{ t: 'interact' }]),
        idle(20, [{ t: 'complete', quest: 'landfall' }]),
        // The scarecrow it hands you, walked out to open ground and put down 7 m ahead.
        { frames: 20, tp: { x: plot.x, z: plot.z - 7, facing: 0 }, cmds: [{ t: 'use', item: 'scarecrow' }] },
        idle(20, [{ t: 'interact' }]),
        // Into the plot: plant the cell in front, then the next one over.
        { frames: 20, tp: { x: plot.x, z: plot.z - 3, facing: 0 }, cmds: [{ t: 'interact' }] },
        { frames: 20, tp: { x: plot.x + 2, z: plot.z - 3, facing: 0 }, cmds: [{ t: 'cycleSeed' }] },
        idle(20, [{ t: 'interact' }]),
        idle(20, [{ t: 'warp', seconds: 400 }]),
        { frames: 20, tp: { x: plot.x, z: plot.z - 3, facing: 0 }, cmds: [{ t: 'interact' }] },
        { frames: 20, tp: { x: plot.x + 2, z: plot.z - 3, facing: 0 }, cmds: [{ t: 'interact' }] },
        // Sell some of it and buy more seed.
        { frames: 20, tp: facingFrom(mara.x, mara.z, 1.6, 0), cmds: [{ t: 'interact' }] },
        idle(20, [{ t: 'sell', npc: 'mara', item: 'sunroot', n: 2 }, { t: 'buy', npc: 'mara', item: 'seed.flax', n: 3 }]),
        // And walk off, past the stalls.
        { frames: 90, a: { moveX: 0.6, moveZ: -0.8 } },
      ],
    });
  });

  test('a trade pack crafted, carried, dropped, picked up, carted and sold', () => {
    const b = bench('lanternwickBench');
    const dunmore = npc('dunmore');
    compare('pack run', {
      coins: 5000,
      every: 30,
      segments: [
        idle(5, [{ t: 'grant', item: 'sunroot', n: 12 }, { t: 'grant', item: 'barley', n: 8 }, { t: 'grant', item: 'deed.farmCart', n: 1 }]),
        { frames: 20, tp: facingFrom(b.x, b.z, 1.5, Math.PI / 2), cmds: [{ t: 'craft', recipe: 'pack.harvestCrate' }] },
        // Heavy: slow, and no second jump.
        { frames: 60, a: { moveX: 1 } },
        { frames: 1, a: { moveX: 1, jumpPressed: true, jumpHeld: true } },
        { frames: 30, a: { moveX: 1, jumpHeld: true } },
        { frames: 1, a: { moveX: 1, jumpPressed: true, jumpHeld: true } },
        { frames: 40, a: { moveX: 1 } },
        idle(20, [{ t: 'drop' }]),
        idle(20, [{ t: 'interact' }]),
        // The cart: summoned beside you, loaded, driven, unloaded.
        idle(30, [{ t: 'summon', item: 'deed.farmCart' }]),
        { frames: 50, a: { moveZ: 1 } },
        idle(20, [{ t: 'interact' }]),
        idle(20, [{ t: 'interact' }]),
        { frames: 120, a: { stickY: 1 } },
        { frames: 60, a: { stickY: 1, stickX: 0.6 } },
        { frames: 30, a: { stickY: 1, stickX: -1, jumpHeld: true } },
        { frames: 60, a: { stickY: -1 } },
        idle(30, [{ t: 'exit' }]),
        idle(20, [{ t: 'interact' }]),
        // Sold at Westwatch.
        { frames: 20, tp: facingFrom(dunmore.x, dunmore.z, 1.6, Math.PI), cmds: [{ t: 'interact' }] },
        idle(30),
      ],
    });
  });

  test('a horse, a glider and a swim', () => {
    const docks = R.places.find((p) => p.id === 'docks')!;
    compare('getting about', {
      every: 30,
      segments: [
        idle(5, [{ t: 'grant', item: 'whistle.horse', n: 1 }, { t: 'grant', item: 'glider.wayfarer', n: 1 }]),
        idle(20, [{ t: 'mount' }]),
        { frames: 90, a: { moveZ: 1, sprintHeld: true } },
        { frames: 1, a: { moveZ: 1, jumpPressed: true, jumpHeld: true } },
        { frames: 60, a: { moveX: 0.7, moveZ: 0.7 } },
        idle(30, [{ t: 'mount' }]),
        idle(10, [{ t: 'use', item: 'glider.wayfarer' }]),
        // Jump, jump again, and a third time to open the wing; then glide, dive and gust.
        { frames: 1, a: { moveZ: 1, jumpPressed: true, jumpHeld: true } },
        { frames: 24, a: { moveZ: 1, jumpHeld: true } },
        { frames: 1, a: { moveZ: 1, jumpPressed: true, jumpHeld: true } },
        { frames: 20, a: { moveZ: 1, jumpHeld: true } },
        { frames: 1, a: { moveZ: 1, jumpPressed: true, jumpHeld: true } },
        { frames: 60, a: { moveZ: 1 } },
        { frames: 30, a: { moveZ: 1, sprintHeld: true }, cmds: [{ t: 'gust' }] },
        { frames: 120, a: { moveX: 1 } },
        // Off the docks into the sea, and back out.
        { frames: 240, tp: { x: docks.x, z: docks.z, facing: Math.PI }, a: { moveZ: -1 } },
        { frames: 120, a: { moveZ: 1, sprintHeld: true } },
        { frames: 1, a: { moveZ: 1, jumpPressed: true, jumpHeld: true } },
        { frames: 60, a: { moveZ: 1 } },
      ],
    });
  });

  test('an island saved by the browser plays on the same on the server', () => {
    const farm = R.farmland;
    const b = bench('lanternwickBench');
    // Built in the browser's rules: a farm with crops in, a pack left on the ground, coins spent.
    const island = islandAfter({
      every: 1000,
      segments: [
        idle(5, [{ t: 'grant', item: 'scarecrow', n: 1 }, { t: 'grant', item: 'seed.sunroot', n: 6 }, { t: 'grant', item: 'sunroot', n: 6 }, { t: 'grant', item: 'barley', n: 4 }]),
        { frames: 20, tp: { x: farm.x, z: farm.z - 7, facing: 0 }, cmds: [{ t: 'use', item: 'scarecrow' }] },
        idle(20, [{ t: 'interact' }]),
        { frames: 20, tp: { x: farm.x, z: farm.z - 3, facing: 0 }, cmds: [{ t: 'interact' }] },
        { frames: 20, tp: facingFrom(b.x, b.z, 1.5, Math.PI / 2), cmds: [{ t: 'craft', recipe: 'pack.harvestCrate' }] },
        idle(20, [{ t: 'drop' }]),
        { frames: 60, a: { moveZ: -1 } },
      ],
    });
    expect(island.state.scarecrows.length).toBe(1);
    expect(island.state.packs.length).toBe(1);
    compare('saved island', {
      island,
      every: 30,
      segments: [
        idle(30, [{ t: 'warp', seconds: 300 }]),
        { frames: 20, tp: { x: farm.x, z: farm.z - 3, facing: 0 }, cmds: [{ t: 'interact' }] },
        { frames: 20, tp: { x: island.state.packs[0].x, z: island.state.packs[0].z - 1, facing: 0 }, cmds: [{ t: 'interact' }] },
        { frames: 60, a: { moveX: 1 } },
      ],
    });
  });

  test('a house claimed and built from hauled stone', () => {
    const plot = R.housePlots[0];
    const cutter = bench('stonecutter');
    const site = { x: plot.x, z: plot.z + 5, facing: plot.rot + Math.PI };
    const haul = (): Segment[] => [
      { frames: 20, tp: facingFrom(cutter.x, cutter.z, 1.5, 0), cmds: [{ t: 'craft', recipe: 'pack.stoneBlock' }] },
      { frames: 20, tp: site, cmds: [{ t: 'interact' }] },
    ];
    compare('housing', {
      coins: 20000,
      labor: 1000,
      every: 30,
      segments: [
        idle(5, [{ t: 'grant', item: 'blueprint.cottage', n: 1 }, { t: 'grant', item: 'stone', n: 60 }, { t: 'grant', item: 'lumber', n: 60 }, { t: 'grant', item: 'ironOre', n: 20 }]),
        { frames: 20, tp: site, cmds: [{ t: 'interact' }] },
        ...haul(),
        ...haul(),
        idle(20, [{ t: 'interact' }]),
        idle(20, [{ t: 'payTax', house: 0 }]),
        { frames: 120, a: { moveZ: -1 } },
      ],
    });
  });
});
