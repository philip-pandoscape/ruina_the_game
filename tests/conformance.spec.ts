import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { makeRng } from '../src/rng';
import { Sim } from '../src/sim/sim';
import { NO_ACTIONS, type Actions } from '../src/sim/types';
import { makeBattlefield } from '../src/sim/world';
import { NO_ABILITY, skillBit, type Build } from '../src/tuning';

// The browser predicts your moves with src/sim/sim.ts; the server decides with server/src/player.rs.
// If they ever disagree, your character would visibly jump back. This runs the same inputs through
// both, for several different builds, and checks they end up in the same place frame by frame.

const SIMCHECK = `server/target/release/simcheck${process.platform === 'win32' ? '.exe' : ''}`;
const MODES = { normal: 0, slide: 1, attack: 2, cast: 3 } as const;

const skills = (...ids: string[]) => ids.reduce((bits, id) => bits | (1 << skillBit(id)), 0);
const HEAL = 0;
const METEOR = 1;

const BUILDS: Record<string, Build> = {
  'plain sword': { perks: skills('sword'), weapon: 0, ability1: NO_ABILITY, ability2: NO_ABILITY },
  'sword master': { perks: skills('sword', 'cleave', 'whirlwind'), weapon: 0, ability1: NO_ABILITY, ability2: NO_ABILITY },
  healer: { perks: skills('club', 'heal', 'swiftMending'), weapon: 1, ability1: HEAL, ability2: NO_ABILITY },
  'meteor caster': { perks: skills('staff', 'meteor', 'quickIncantation'), weapon: 2, ability1: METEOR, ability2: NO_ABILITY },
  archer: { perks: skills('bow', 'rapidFire', 'piercing'), weapon: 3, ability1: NO_ABILITY, ability2: NO_ABILITY },
  'archer with meteors': { perks: skills('bow', 'rapidFire', 'staff', 'meteor'), weapon: 3, ability1: NO_ABILITY, ability2: METEOR },
};

interface Hit {
  frame: number;
  damage: number;
  dirX: number;
  dirZ: number;
  knock: number;
}

function buildScript() {
  const world = makeBattlefield();
  const spawn = world.teamSpawns[0];
  const steps: Actions[] = [];
  const add = (n: number, a: Partial<Actions>) => {
    for (let i = 0; i < n; i++) steps.push({ ...NO_ACTIONS, ...a });
  };
  add(30, { moveX: 1 }); // run
  add(1, { moveX: 1, jumpPressed: true, jumpHeld: true });
  add(15, { moveX: 1, jumpHeld: true });
  add(1, { moveZ: 1, jumpPressed: true, jumpHeld: true }); // double jump, turning mid-air
  add(40, { moveZ: 1, jumpHeld: true });
  add(20, { moveX: -0.7, moveZ: 0.7 });
  add(1, { moveX: -0.7, moveZ: 0.7, slidePressed: true }); // slide
  add(10, { moveX: -0.7, moveZ: 0.7 });
  add(1, { moveZ: 1, jumpPressed: true, jumpHeld: true }); // slide jump
  add(50, { moveZ: 1, jumpHeld: true });
  add(1, { attackPressed: true }); // full combo for whichever weapon
  add(7, {});
  add(1, { attackPressed: true });
  add(10, {});
  add(1, { attackPressed: true });
  add(40, {});
  add(1, { attackPressed: true, aimX: 3, aimZ: -4 }); // aimed attack
  add(30, {});
  add(1, { ability1Pressed: true }); // cast straight ahead
  add(90, {});
  add(1, { ability2Pressed: true, aimX: -6, aimZ: 7.5 }); // aimed cast from slot 2
  add(90, {});
  add(1, { ability1Pressed: true, aimX: 20, aimZ: 20 }); // aimed past max range
  add(10, {});
  add(1, { jumpPressed: true, jumpHeld: true }); // cancel the cast by jumping
  add(40, {});
  add(1, { ability1Pressed: true }); // this cast gets interrupted by the hit at frame 520
  add(60, {});
  add(1, { jumpPressed: true, jumpHeld: true }); // short hop
  add(40, {});

  // Run straight at the nearest rock to exercise collisions.
  const rock = world.obstacles
    .filter((o) => o.kind === 'rock')
    .sort((a, b) => Math.hypot(a.x - spawn.x, a.z - spawn.z) - Math.hypot(b.x - spawn.x, b.z - spawn.z))[0];
  const d = Math.hypot(rock.x - spawn.x, rock.z - spawn.z);
  add(420, { moveX: (rock.x - spawn.x) / d, moveZ: (rock.z - spawn.z) / d });

  // Random play: wandering with presses mixed in.
  const rng = makeRng(42);
  for (let i = 0; i < 600; i++) {
    const a = rng() * Math.PI * 2;
    const mag = rng() < 0.15 ? 0 : 0.3 + rng() * 0.7;
    steps.push({
      moveX: Math.sin(a) * mag,
      moveZ: Math.cos(a) * mag,
      jumpPressed: rng() < 0.03,
      jumpHeld: rng() < 0.6,
      attackPressed: rng() < 0.04,
      slidePressed: rng() < 0.02,
      ability1Pressed: rng() < 0.02,
      ability2Pressed: rng() < 0.02,
      aimX: rng() < 0.5 ? 0 : Math.round((rng() * 30 - 15) * 4) / 4,
      aimZ: rng() < 0.5 ? 0 : Math.round((rng() * 30 - 15) * 4) / 4,
    });
  }
  const hits: Hit[] = [
    { frame: 240, damage: 30, dirX: 0.6, dirZ: 0.8, knock: 3.5 }, // knocked back mid-play
    { frame: 520, damage: 10, dirX: -0.8, dirZ: 0.6, knock: 3 }, // interrupts a cast
    { frame: 1400, damage: 100, dirX: -1, dirZ: 0, knock: 7 }, // knocked down, respawns 180 frames later
  ];
  return { world, spawn, team: 0, steps, hits };
}

for (const [name, build] of Object.entries(BUILDS)) {
  test(`TypeScript and Rust rules agree frame by frame: ${name}`, () => {
    test.skip(!existsSync(SIMCHECK), 'build it first: cargo build --release --manifest-path server/Cargo.toml --bin simcheck');
    const s = buildScript();

    // TypeScript (what the browser predicts)
    const sim = new Sim(s.world, { training: false });
    sim.reset(s.spawn, s.team, build);
    const ts: number[][] = [];
    let casts = 0;
    s.steps.forEach((a, i) => {
      for (const h of s.hits) if (h.frame === i) sim.takeHit(h.damage, h.dirX, h.dirZ, h.knock);
      sim.step(a);
      const p = sim.player;
      if (p.firedCast) casts++;
      ts.push([
        p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z, p.facing, p.hp, MODES[p.mode],
        p.castFrame, p.cooldown1, p.cooldown2, p.firedCast, p.castTargetX, p.castTargetZ,
      ]);
    });

    // Rust (what the server decides)
    const input = JSON.stringify({ spawn: s.spawn, team: s.team, build, steps: s.steps, hits: s.hits });
    const rust = JSON.parse(execFileSync(SIMCHECK, { input, maxBuffer: 64 * 1024 * 1024 }).toString()) as {
      frames: number[][];
      obstacles: number[][];
    };

    // Same battlefield layout.
    expect(rust.obstacles.length).toBe(s.world.obstacles.length);
    let worldDiff = 0;
    s.world.obstacles.forEach((o, i) => {
      worldDiff = Math.max(worldDiff, Math.abs(o.x - rust.obstacles[i][0]), Math.abs(o.z - rust.obstacles[i][1]), Math.abs(o.r - rust.obstacles[i][2]));
    });

    // Same movement, casting and cooldowns every frame.
    expect(rust.frames.length).toBe(ts.length);
    let posDiff = 0;
    let worstFrame = 0;
    let stateMismatch = 0;
    ts.forEach((f, i) => {
      const r = rust.frames[i];
      const d = Math.max(...[0, 1, 2, 3, 4, 5, 6, 7, 13, 14].map((k) => Math.abs(f[k] - r[k])));
      if (d > posDiff) {
        posDiff = d;
        worstFrame = i;
      }
      if ([8, 9, 10, 11, 12].some((k) => f[k] !== r[k])) stateMismatch++;
    });
    console.log(
      `${name}: ${ts.length} frames | ${casts} casts finished | largest difference ${posDiff.toExponential(2)} (frame ${worstFrame}) | ` +
        `state mismatches ${stateMismatch} | world difference ${worldDiff.toExponential(2)}`,
    );
    expect(worldDiff).toBeLessThan(1e-9);
    expect(stateMismatch).toBe(0);
    expect(posDiff).toBeLessThan(1e-6);
  });
}
