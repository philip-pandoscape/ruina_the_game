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
import { rainAt } from '../src/sim/life/weather';
import { toWorld } from '../src/sim/zone/generate';
import type { Vehicle } from '../src/sim/life/state';
import { applySave, islandData, type Island } from '../src/app/save';
import { LEVEL_XP } from '../src/skills';
import { QUESTS } from '../src/content/quests';

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
const PLAYER_KEYS = ['pos', 'vel', 'facing', 'mode', 'grounded', 'jumpsUsed', 'hp', 'stamina', 'staminaDelay', 'mp', 'stun', 'downFrame', 'pack', 'vehicle', 'seat', 'host', 'glider', 'airspeed', 'bank', 'modeFrame', 'gustFrames', 'sprinting', 'crouching'];

function compare(name: string, script: Script): void {
  const ts = runTs(script);
  const rs = runRust(script);
  if (process.env.LIFE_SUMMARY) {
    const last = ts[ts.length - 1].life as Record<string, any>;
    const modes = [...new Set(ts.map((c) => c.player.mode))];
    const toasts = ts.flatMap((c) => c.events.filter((e) => e.t === 'toast').map((e) => e.text));
    console.log(`== ${name}: modes ${modes.join(',')} | coins ${last.coins} | bag ${JSON.stringify(last.bag)} | packs ${JSON.stringify(last.packs.map((p: any) => p.def + '@' + p.at))} | vehicles ${last.vehicles.map((v: any) => v.def).join(',')} | scarecrows ${last.scarecrows.length} cells ${JSON.stringify(last.scarecrows.map((s: any) => s.cells.filter(Boolean).map((c: any) => c.crop + ':' + c.growth.toFixed(2))))} | houses ${JSON.stringify(last.houses.map((h: any) => h.plot + ' stage ' + h.stage + ' ' + JSON.stringify(h.delivered)))} | quests ${JSON.stringify(last.quests)}
   toasts: ${toasts.join(' | ')}`);
  }
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

/** The vehicle of a kind as it stands at the end of a script, in the browser's rules. */
function vehicleAfter(script: Script, def: string): Vehicle {
  const v = playTs(script).life.state.vehicles.find((x) => x.def === def);
  if (!v) throw new Error(`no ${def} after the script`);
  return JSON.parse(JSON.stringify(v)) as Vehicle;
}

/** A spot in a vehicle's own frame (x to its left, z ahead), facing the vehicle. */
function besideVehicle(v: Vehicle, lx: number, lz: number): { x: number; z: number; facing: number } {
  const [ox, oz] = toWorld(lx, lz, v.heading);
  const x = v.x + ox;
  const z = v.z + oz;
  return { x, z, facing: Math.atan2(v.x - x, v.z - z) };
}

test('the rain falls on the same clock in both rules, to the last bit (server/src/life/weather.rs pins the same showers)', () => {
  // (t, raining, start, end, next): online t is the server's clock, so these are what everyone gets.
  const showers: Array<[number, boolean, number, number, number]> = [
    [0, false, 240, 370.96530275652185, 240],
    [239, false, 240, 370.96530275652185, 240],
    [240, true, 240, 370.96530275652185, 983.9430155046284],
    [300, true, 240, 370.96530275652185, 983.9430155046284],
    [400, false, 240, 370.96530275652185, 983.9430155046284],
    [1000, true, 983.9430155046284, 1101.4316743402742, 1693.8431939273141],
    [5000, false, 4592.312170029618, 4691.087984668557, 5360.571019051131],
    [123456.5, false, 123296.18334829574, 123441.47021974204, 123953.02136573591],
    [1762300000, false, 1762299390.7330143, 1762299488.1632354, 1762300209.9376085],
    [1762310077.25, false, 1762310136.8058028, 1762310283.342108, 1762310136.8058028],
  ];
  for (const [t, raining, start, end, next] of showers) expect(rainAt(t), `at ${t}`).toEqual({ raining, start, end, next });
});

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
    const before: Segment[] = [
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
      // The cart, summoned beside you.
      idle(30, [{ t: 'summon', item: 'deed.farmCart' }]),
    ];
    const cart = vehicleAfter({ coins: 5000, every: 1000, segments: before }, 'farmCart');
    const script: Script = {
      coins: 5000,
      every: 30,
      segments: [
        ...before,
        // Up to its bed with the pack on your back: load it. Round to the driver's side: drive.
        { frames: 20, tp: besideVehicle(cart, 0, -2.6), cmds: [{ t: 'interact' }] },
        { frames: 20, tp: besideVehicle(cart, 1.7, 0.95), cmds: [{ t: 'interact' }] },
        { frames: 120, a: { stickY: 1 } },
        { frames: 60, a: { stickY: 1, stickX: 0.6 } },
        { frames: 30, a: { stickY: 1, stickX: -1, jumpHeld: true } },
        { frames: 60, a: { stickY: -1 } },
        idle(30, [{ t: 'exit' }]),
      ],
    };
    // Wherever the drive ended, the pack comes back off the bed and goes to Westwatch.
    const parked = vehicleAfter(script, 'farmCart');
    script.segments.push(
      { frames: 20, tp: besideVehicle(parked, 0, -2.6), cmds: [{ t: 'interact' }] },
      { frames: 20, tp: facingFrom(dunmore.x, dunmore.z, 1.6, Math.PI), cmds: [{ t: 'interact' }] },
      idle(30),
    );
    const modes = runTs(script).map((c) => c.player.mode);
    expect(modes, 'the cart was driven').toContain('ride');
    compare('pack run', script);
  });

  test('a rowboat summoned at the docks, rowed and left', () => {
    const docks = R.places.find((p) => p.id === 'docks')!;
    const before: Segment[] = [
      idle(5, [{ t: 'grant', item: 'deed.rowboat', n: 1 }]),
      { frames: 30, tp: { x: docks.x, z: docks.z, facing: Math.PI }, cmds: [{ t: 'summon', item: 'deed.rowboat' }] },
    ];
    const boat = vehicleAfter({ every: 1000, segments: before }, 'rowboat');
    const script: Script = {
      every: 30,
      segments: [
        ...before,
        { frames: 20, tp: besideVehicle(boat, 1.6, 0.05), cmds: [{ t: 'interact' }] },
        { frames: 180, a: { stickY: 1 } },
        { frames: 90, a: { stickY: 1, stickX: 1 } },
        { frames: 90, a: { stickY: -0.5, stickX: -0.5 } },
        idle(30, [{ t: 'exit' }]),
        { frames: 120, a: { moveZ: 1 } },
      ],
    };
    expect(runTs(script).map((c) => c.player.mode), 'the boat was rowed').toContain('ride');
    compare('rowboat', script);
  });

  test('timber, a chick raised and its eggs, and a contract taken at a trading post', () => {
    const node = R.nodes.find((n) => n.kind === 'timberNode')!;
    const farm = R.farmland;
    const dunmore = npc('dunmore');
    const before: Segment[] = [
      idle(5, [{ t: 'grant', item: 'scarecrow', n: 1 }, { t: 'grant', item: 'animal.chick', n: 1 }, { t: 'grant', item: 'barley', n: 10 }]),
      // A timber node, worked twice (the second time it's picked clean).
      { frames: 20, tp: facingFrom(node.x, node.z, 1.4, 0), cmds: [{ t: 'interact' }] },
      idle(20, [{ t: 'interact' }]),
      // A plot, a chick in it, fed and grown, eggs collected.
      { frames: 20, tp: { x: farm.x, z: farm.z - 7, facing: 0 }, cmds: [{ t: 'use', item: 'scarecrow' }] },
      idle(20, [{ t: 'interact' }]),
      { frames: 20, tp: { x: farm.x, z: farm.z - 3, facing: 0 }, cmds: [{ t: 'interact' }] },
      idle(20, [{ t: 'warp', seconds: 200 }]),
      idle(20, [{ t: 'interact' }]),
      idle(20, [{ t: 'warp', seconds: 200 }]),
      idle(20, [{ t: 'interact' }]),
      idle(20, [{ t: 'interact' }]),
      // The trading post's board.
      { frames: 20, tp: facingFrom(dunmore.x, dunmore.z, 1.6, Math.PI) },
    ];
    const first = playTs({ every: 1000, segments: before }).life.state;
    expect(first.bag.find((b) => b.item === 'egg')?.n ?? 0, 'eggs collected').toBeGreaterThan(0);
    const offered = first.contracts?.offered ?? [];
    const k = offered.find((c) => c.outpost === 'westwatch');
    expect(k, 'Westwatch posted a contract').toBeTruthy();
    const script: Script = { every: 30, segments: [...before, idle(30, [{ t: 'contract', id: k!.id }]), idle(30, [{ t: 'warp', seconds: 2000 }])] };
    compare('gathering, livestock and contracts', script);
  });

  test('a cog laid down on the slipway', () => {
    const slip = R.shipyards[0];
    const saw = bench('sawhorse');
    compare('shipyard', {
      labor: 1000,
      every: 30,
      segments: [
        idle(5, [{ t: 'grant', item: 'design.cog', n: 1 }, { t: 'grant', item: 'lumber', n: 40 }]),
        { frames: 20, tp: facingFrom(slip.x, slip.z, 4, 0), cmds: [{ t: 'interact' }] },
        { frames: 20, tp: facingFrom(saw.x, saw.z, 1.5, 0), cmds: [{ t: 'craft', recipe: 'pack.lumberBundle' }] },
        { frames: 20, tp: facingFrom(slip.x, slip.z, 4, 0), cmds: [{ t: 'interact' }] },
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

  test('an island saved with a stake still on a mini-game table gets it back, in both', () => {
    // The server stopped mid-game (src/ui/minigames): the stake was out of the purse, on the table.
    const island = islandAfter({ every: 1000, segments: [idle(5)] });
    const purse = island.state.coins;
    island.state.coins -= 50;
    island.state.staked = 50;
    const script = { island, every: 10, segments: [idle(10)] };
    compare('stake back', script);
    const first = runTs(script)[0].life as { coins: number; staked?: number };
    expect([first.coins, first.staked]).toEqual([purse, undefined]);
  });

  test('a house claimed and built from hauled stone', () => {
    const plot = R.housePlots[0];
    const cutter = bench('stonecutter');
    const site = { x: plot.x, z: plot.z + 5, facing: plot.rot + Math.PI };
    const haul = (): Segment[] => [
      { frames: 20, tp: facingFrom(cutter.x, cutter.z, 1.5, 0), cmds: [{ t: 'craft', recipe: 'pack.stoneBlock' }] },
      { frames: 20, tp: site, cmds: [{ t: 'interact' }] },
    ];
    const before: Segment[] = [
      idle(5, [{ t: 'grant', item: 'blueprint.cottage', n: 1 }, { t: 'grant', item: 'stone', n: 60 }, { t: 'grant', item: 'lumber', n: 60 }, { t: 'grant', item: 'ironOre', n: 20 }]),
      { frames: 20, tp: site, cmds: [{ t: 'interact' }] },
      ...haul(),
      ...haul(),
      idle(20, [{ t: 'interact' }]),
    ];
    const built = playTs({ coins: 20000, labor: 1000, every: 1000, segments: before }).life.state.houses;
    expect(built.map((h) => h.stage), 'the foundation is down').toEqual([1]);
    compare('housing', {
      coins: 20000,
      labor: 1000,
      every: 30,
      segments: [...before, idle(20, [{ t: 'payTax', house: built[0].id }]), { frames: 120, a: { moveZ: -1 } }],
    });
  });

  test('a skill levelled by use, and a milestone that finishes itself', () => {
    const hollis = npc('hollis');
    // Kept by the browser: Landfall handed in (which starts the milestones), then the slide one use
    // short of its next level and Practised Hand one level short of done.
    const island = islandAfter({
      every: 1000,
      segments: [
        { frames: 10, tp: facingFrom(hollis.x, hollis.z, 1.6, Math.PI) },
        idle(20, [{ t: 'interact' }]),
        idle(20, [{ t: 'complete', quest: 'landfall' }]),
      ],
    });
    const practised = island.state.quests.active.find((q) => q.id === 'practisedHand');
    expect(practised, 'Landfall started the milestones').toBeTruthy();
    practised!.counts = [4];
    island.state.skillXp = { slide: LEVEL_XP[1] - 1, sword: 3 };
    const script: Script = {
      island,
      every: 30,
      // Slide after slide, off to the side of Hollis.
      segments: [idle(10), { frames: 150, a: { moveX: 1, slidePressed: true } }, idle(30)],
    };
    const end = runTs(script).at(-1)!.life as unknown as { skillXp: Record<string, number>; quests: { done: string[] } };
    expect(end.skillXp.slide, 'slid more than once').toBeGreaterThan(LEVEL_XP[1]);
    expect(end.quests.done, 'the milestone finished itself').toContain('practisedHand');
    compare('levels and milestones', script);
  });

  test('a quest given up and taken again, and selling, buying back and walking off', () => {
    const hollis = npc('hollis');
    const mara = npc('mara');
    const script: Script = {
      coins: 100,
      every: 30,
      segments: [
        idle(5, [{ t: 'grant', item: 'sunroot', n: 10 }]),
        // Landfall handed in and Patch taken; Patch given up (a milestone and Landfall can't be),
        // then taken again.
        { frames: 10, tp: facingFrom(hollis.x, hollis.z, 1.6, Math.PI) },
        idle(20, [{ t: 'interact' }]),
        idle(20, [{ t: 'complete', quest: 'landfall' }, { t: 'accept', quest: 'patch' }]),
        idle(20, [{ t: 'abandon', quest: 'patch' }, { t: 'abandon', quest: 'wayfarer' }, { t: 'abandon', quest: 'landfall' }]),
        idle(20, [{ t: 'accept', quest: 'patch' }]),
        // At Mara's stall: sell, buy some back (and something never sold), sell again.
        { frames: 20, tp: facingFrom(mara.x, mara.z, 1.6, 0), cmds: [{ t: 'sell', npc: 'mara', item: 'sunroot', n: 6 }] },
        idle(20, [{ t: 'buyback', npc: 'mara', item: 'sunroot', n: 2 }, { t: 'buyback', npc: 'mara', item: 'barley', n: 1 }]),
        idle(20, [{ t: 'sell', npc: 'mara', item: 'sunroot', n: 1 }]),
        // Walk off, and she lets go of the rest; come back and there's nothing to buy back.
        { frames: 30, tp: facingFrom(mara.x, mara.z, 20, 0) },
        { frames: 20, tp: facingFrom(mara.x, mara.z, 1.6, 0), cmds: [{ t: 'buyback', npc: 'mara', item: 'sunroot', n: 5 }] },
      ],
    };
    type State = { buyback?: Array<{ npc: string; item: string; n: number }>; bag: Array<{ item: string; n: number }>; quests: { active: Array<{ id: string; step: number }>; done: string[] } };
    const ts = runTs(script);
    const at = (frame: number) => ts.find((c) => c.frame === frame)!.life as unknown as State;
    const sunroot = (s: State) => s.bag.filter((b) => b.item === 'sunroot').reduce((n, b) => n + b.n, 0);
    // Frame 150: 6 sold, 2 bought back, 1 more sold.
    expect(at(150).buyback, 'held at her stall').toEqual([{ npc: 'mara', item: 'sunroot', n: 5, price: 1 }]);
    expect(at(180).buyback, 'let go of once you walked off').toEqual([]);
    const end = ts.at(-1)!.life as unknown as State;
    expect(sunroot(end)).toBe(10 - 6 + 2 - 1);
    expect(end.quests.active.map((q) => q.id), 'Patch taken again; the milestone kept').toEqual(expect.arrayContaining(['patch', 'wayfarer']));
    expect(end.quests.active.find((q) => q.id === 'patch')!.step).toBe(0);
    const said = ts.flatMap((c) => c.events.filter((e) => e.t === 'toast').map((e) => e.text));
    expect(said).toContain('Quest abandoned: A Patch of Earth');
    compare('abandoning and buying back', script);
  });

  test('a place reached counts for each quest by its own reach and height', () => {
    const hollis = npc('hollis');
    const spire = R.places.find((p) => p.id === 'windspire')!;
    // Landfall handed in (which starts the Wayfarer milestone), and Wings taken: both want the
    // Windspire, Wayfarer from 40 m at any height, Wings its top (30 m, 115 m up).
    const island = islandAfter({
      every: 1000,
      segments: [
        { frames: 10, tp: facingFrom(hollis.x, hollis.z, 1.6, Math.PI) },
        idle(20, [{ t: 'interact' }]),
        idle(20, [{ t: 'complete', quest: 'landfall' }, { t: 'accept', quest: 'wings' }]),
      ],
    });
    const script: Script = {
      island,
      every: 30,
      // 35 m out from the spire, then up on top of it.
      segments: [{ frames: 30, tp: { x: spire.x + 35, z: spire.z } }, { frames: 30, tp: { x: spire.x, z: spire.z } }],
    };
    type Quests = { active: Array<{ id: string; step: number; counts: number[] }> };
    const [foot, top] = runTs(script).map((c) => (c.life as unknown as { quests: Quests }).quests.active);
    const k = QUESTS.find((q) => q.id === 'wayfarer')!.steps[0].objectives.findIndex((o) => o.place === 'windspire');
    expect(foot.find((q) => q.id === 'wayfarer')!.counts[k], 'Wayfarer has the spire').toBe(1);
    expect(foot.find((q) => q.id === 'wings')!.step, 'not yet the top for Wings').toBe(0);
    expect(top.find((q) => q.id === 'wings')!.step, 'the top for Wings').toBe(1);
    compare('places reached', script);
  });
});
