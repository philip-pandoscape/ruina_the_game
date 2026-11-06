import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, test } from 'vitest';
import { makeRng } from '../../src/rng';
import { Sim } from '../../src/sim/sim';
import { NO_ACTIONS, type Actions } from '../../src/sim/types';
import { makeBattlefield } from '../../src/sim/world';
import {
  ABILITIES,
  abilityMpFor,
  castFramesFor,
  comboFor,
  effectAmount,
  effectDamage,
  effectRadius,
  HOTBAR_SLOTS,
  meleeTargets,
  movementCooldownFor,
  movementStaminaFor,
  MOVEMENT_SKILL_CAP,
  MOVEMENT_SKILLS,
  MOVEMENT_SLOTS,
  NO_ABILITY,
  NO_MOVEMENT,
  pierceTargets,
  type Build,
  WEAPONS,
} from '../../src/tuning';
import { BOOK, resolveSkills, skillsFrom, type Levels } from '../../src/skills';

// The browser predicts your moves with src/sim/sim.ts; the server decides with crates/engine/src/player.rs.
// If they ever disagree, your character would visibly jump back. This runs the same inputs through
// both, for several different builds, and checks they end up in the same place frame by frame.

const SIMCHECK = `target/release/simcheck${process.platform === 'win32' ? '.exe' : ''}`;
const MODES = { normal: 0, attack: 1, cast: 2, action: 3 } as const;

// One recorded frame, in the order both sides write it (see Out in crates/tools/src/bin/simcheck.rs).
// Named rather than numbered, because getting these out of step silently weakens the whole check.
const F = {
  x: 0,
  y: 1,
  z: 2,
  vx: 3,
  vy: 4,
  vz: 5,
  facing: 6,
  hp: 7,
  mode: 8,
  castFrame: 9,
  firedAbility: 10,
  castTargetX: 11,
  castTargetZ: 12,
  sprinting: 13,
  crouching: 14,
  crouchFrame: 15,
  actionId: 16,
  actionFrame: 17,
  stamina: 18,
  mp: 19,
  staminaDelay: 20,
  cooldowns: 21,
  movementCooldowns: 21 + HOTBAR_SLOTS,
} as const;
// Continuous values, compared with a tolerance.
const NEAR = [F.x, F.y, F.z, F.vx, F.vy, F.vz, F.facing, F.hp, F.castTargetX, F.castTargetZ, F.stamina, F.mp];
// Whole numbers and flags, which must match exactly.
const EXACT = [
  F.mode,
  F.castFrame,
  F.firedAbility,
  F.sprinting,
  F.crouching,
  F.crouchFrame,
  F.actionId,
  F.actionFrame,
  F.staminaDelay,
  ...Array.from({ length: HOTBAR_SLOTS }, (_, i) => F.cooldowns + i),
  ...Array.from({ length: MOVEMENT_SKILL_CAP }, (_, i) => F.movementCooldowns + i),
];

const skills = (...ids: string[]) => skillsFrom(...ids);
const HEAL = 0;
const METEOR = 1;
const DODGE = 0;
const BLOCK = 2;

// Abilities listed in slot order; the rest of the bar is empty.
const bar = (...a: number[]): number[] => {
  const out = new Array<number>(HOTBAR_SLOTS).fill(NO_ABILITY);
  a.forEach((v, i) => (out[i] = v));
  return out;
};
const moves = (...m: number[]): number[] => {
  const out = new Array<number>(MOVEMENT_SLOTS).fill(NO_MOVEMENT);
  m.forEach((v, i) => (out[i] = v));
  return out;
};

const BUILDS: Record<string, Build> = {
  'plain sword': { skills: skills('sword'), weapon: 0, abilities: bar(), movement: moves() },
  'sword master': { skills: skills('sword', 'cleave', 'whirlwind'), weapon: 0, abilities: bar(), movement: moves() },
  healer: { skills: skills('club', 'heal', 'swiftMending'), weapon: 1, abilities: bar(HEAL), movement: moves() },
  'meteor caster': { skills: skills('staff', 'meteor', 'quickIncantation'), weapon: 2, abilities: bar(METEOR), movement: moves() },
  archer: { skills: skills('bow', 'rapidFire', 'piercing'), weapon: 3, abilities: bar(), movement: moves() },
  // Meteor parked in slot 2, to exercise a slot other than the first.
  'archer with meteors': { skills: skills('bow', 'rapidFire', 'staff', 'meteor'), weapon: 3, abilities: bar(NO_ABILITY, METEOR), movement: moves() },
  // Movement skills bound, so the action state machine is compared too: a dodge that commits to
  // a direction and a guard that stays up while it's held.
  duelist: { skills: skills('sword', 'dodgeRoll', 'club', 'block'), weapon: 0, abilities: bar(), movement: moves(DODGE, BLOCK) },
  // The same builds again, with levels from use (below).
  'seasoned duelist': { skills: skills('sword', 'dodgeRoll', 'club', 'block'), weapon: 0, abilities: bar(), movement: moves(DODGE, BLOCK) },
  'practised healer': { skills: skills('club', 'heal', 'swiftMending'), weapon: 1, abilities: bar(HEAL), movement: moves() },
  'practised meteor caster': { skills: skills('staff', 'meteor', 'quickIncantation'), weapon: 2, abilities: bar(METEOR), movement: moves() },
  // Out of MP to begin with (below), so casts are turned down until enough has come back.
  'drained meteor caster': { skills: skills('staff', 'meteor', 'quickIncantation'), weapon: 2, abilities: bar(METEOR), movement: moves() },
};

// Where a build starts short of stamina or MP, so turning a dodge or a cast down for the want of
// it, and the refill that lets it through later, are compared too. The rest start full.
const STARTS: Record<string, { stamina?: number; mp?: number }> = {
  'drained meteor caster': { mp: 0 },
};

// The skills you use level up, and a level adds to what they do: damage, healing, cooldowns. The
// island keeps the experience; these give a few builds levels straight away (src/skills.ts BOOK),
// so what the levels add is compared too. The rest are at level 1.
const levels = (at: Record<string, number>): Levels => BOOK.map((b) => at[b.id] ?? 1);
const LEVELS: Record<string, Levels> = {
  'seasoned duelist': levels({ sword: 7, club: 4, dodgeRoll: 10, block: 6, slide: 5 }),
  'practised healer': levels({ club: 3, heal: 8, slide: 2 }),
  'practised meteor caster': levels({ staff: 5, meteor: 9, slide: 10 }),
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
  add(1, { abilitySlot: 1 }); // cast straight ahead
  add(90, {});
  add(1, { abilitySlot: 2, aimX: -6, aimZ: 7.5 }); // aimed cast from slot 2
  add(90, {});
  add(1, { abilitySlot: 1, aimX: 20, aimZ: 20 }); // aimed past max range
  add(10, {});
  add(1, { jumpPressed: true, jumpHeld: true }); // cancel the cast by jumping
  add(40, {});
  add(1, { abilitySlot: 1 }); // this cast gets interrupted by the hit at frame 520
  add(60, {});
  add(1, { jumpPressed: true, jumpHeld: true }); // short hop
  add(40, {});

  // Run straight at the nearest rock to exercise collisions.
  const rock = world.obstacles
    .filter((o) => o.kind === 'rock')
    .sort((a, b) => Math.hypot(a.x - spawn.x, a.z - spawn.z) - Math.hypot(b.x - spawn.x, b.z - spawn.z))[0];
  const d = Math.hypot(rock.x - spawn.x, rock.z - spawn.z);
  add(420, { moveX: (rock.x - spawn.x) / d, moveZ: (rock.z - spawn.z) / d });

  // Combat stance: facing one way while moving others. Strafe, back off, dodge sideways and
  // back, double jump sideways, sprint out of it, and swing and cast at what you face.
  const face = { faceX: Math.sin(0.6), faceZ: Math.cos(0.6) };
  add(30, { ...face, moveX: 1 });
  add(30, { ...face, moveX: -0.7, moveZ: -0.7 });
  add(1, { ...face, moveX: -1, movementSlot: 1 }); // dodge to the side without turning
  add(25, { ...face, moveX: -1 });
  add(1, { ...face, moveZ: -1, movementSlot: 1 }); // and backwards
  add(25, { ...face });
  add(1, { ...face, moveX: 0.4, jumpPressed: true, jumpHeld: true });
  add(14, { ...face, moveX: 0.4, jumpHeld: true });
  add(1, { ...face, moveX: -1, jumpPressed: true, jumpHeld: true }); // double jump sideways, still facing
  add(45, { ...face, moveX: -1, jumpHeld: true });
  add(30, { ...face, moveZ: -1, sprintHeld: true }); // sprinting turns and runs
  add(20, { ...face, moveX: 0.6, moveZ: 0.3, crouchHeld: true });
  add(1, { ...face, moveX: 1, attackPressed: true }); // swings ahead, not the way you push
  add(30, { ...face });
  add(1, { ...face, moveX: -1, abilitySlot: 1 }); // casts ahead too
  add(90, { ...face });

  // Random play: wandering with presses mixed in.
  const rng = makeRng(42);
  for (let i = 0; i < 600; i++) {
    const a = rng() * Math.PI * 2;
    const mag = rng() < 0.15 ? 0 : 0.3 + rng() * 0.7;
    // Holding a combat stance about half the time, facing some other way.
    const faceYaw = rng() * Math.PI * 2;
    const facing = rng() < 0.5;
    steps.push({
      moveX: Math.sin(a) * mag,
      moveZ: Math.cos(a) * mag,
      jumpPressed: rng() < 0.03,
      jumpHeld: rng() < 0.6,
      attackPressed: rng() < 0.04,
      slidePressed: rng() < 0.02,
      // A random hotbar slot now and then, plus sprinting and crouching, so both rules agree
      // on all of it.
      abilitySlot: rng() < 0.04 ? 1 + Math.floor(rng() * HOTBAR_SLOTS) : 0,
      // Movement skills too, with a slot held often enough to exercise a guard being released.
      movementSlot: rng() < 0.05 ? 1 + Math.floor(rng() * MOVEMENT_SLOTS) : 0,
      movementHeld: rng() < 0.2 ? 1 + Math.floor(rng() * MOVEMENT_SLOTS) : 0,
      sprintHeld: rng() < 0.35,
      crouchHeld: rng() < 0.12,
      aimX: rng() < 0.5 ? 0 : Math.round((rng() * 30 - 15) * 4) / 4,
      aimZ: rng() < 0.5 ? 0 : Math.round((rng() * 30 - 15) * 4) / 4,
      faceX: facing ? Math.sin(faceYaw) : 0,
      faceZ: facing ? Math.cos(faceYaw) : 0,
      stickX: 0, // vehicles only; on foot the rules read moveX / moveZ
      stickY: 0,
    });
  }
  // Dodging until out of stamina: five in a row (the last turned down, however cheap levels have
  // made them), and one more once enough has come back. (Only builds with a dodge on Q do anything.)
  add(60, {});
  for (let k = 0; k < 5; k++) {
    add(1, { moveX: k % 2 ? 1 : -1, movementSlot: 1 });
    add(25, {});
  }
  add(60, {});
  add(1, { moveZ: 1, movementSlot: 1 });
  add(40, {});
  const hits: Hit[] = [
    { frame: 240, damage: 30, dirX: 0.6, dirZ: 0.8, knock: 3.5 }, // knocked back mid-play
    { frame: 520, damage: 10, dirX: -0.8, dirZ: 0.6, knock: 3 }, // interrupts a cast
    { frame: 1400, damage: 100, dirX: -1, dirZ: 0, knock: 7 }, // knocked down, respawns 180 frames later
  ];
  return { world, spawn, team: 0, steps, hits };
}

for (const [name, build] of Object.entries(BUILDS)) {
  test(`TypeScript and Rust rules agree frame by frame: ${name}`, (ctx) => {
    ctx.skip(!existsSync(SIMCHECK), 'build it first: cargo build --release --bin simcheck');
    const s = buildScript();

    // TypeScript (what the browser predicts)
    const sim = new Sim(s.world, { training: false });
    sim.reset(s.spawn, s.team, build);
    const lv = LEVELS[name];
    if (lv) sim.levels = [...lv];
    const start = STARTS[name] ?? {};
    if (start.stamina !== undefined) sim.player.stamina = start.stamina;
    if (start.mp !== undefined) sim.player.mp = start.mp;
    const short = { stamina: 0, mp: 0 };
    const ts: number[][] = [];
    let casts = 0;
    s.steps.forEach((a, i) => {
      for (const h of s.hits) if (h.frame === i) sim.takeHit(h.damage, h.dirX, h.dirZ, h.knock);
      sim.step(a);
      const p = sim.player;
      if (p.firedAbility !== NO_ABILITY) casts++;
      for (const e of sim.drainEvents()) if (e.type === 'short') short[e.what]++;
      ts.push([
        p.pos.x,
        p.pos.y,
        p.pos.z,
        p.vel.x,
        p.vel.y,
        p.vel.z,
        p.facing,
        p.hp,
        MODES[p.mode as keyof typeof MODES],
        p.castFrame,
        p.firedAbility,
        p.castTargetX,
        p.castTargetZ,
        p.sprinting ? 1 : 0,
        p.crouching ? 1 : 0,
        p.crouchFrame,
        p.actionId,
        p.actionFrame,
        p.stamina,
        p.mp,
        p.staminaDelay,
        ...p.cooldowns,
        ...Array.from({ length: MOVEMENT_SKILL_CAP }, (_, i) => p.movementCooldowns[i] ?? 0),
      ]);
    });

    // Rust (what the server decides)
    // The script asks for what the build can't always afford: dodges in quick succession, casts out of MP.
    if (build.movement.includes(DODGE)) expect(short.stamina, 'a dodge turned down for want of stamina').toBeGreaterThan(0);
    if (start.mp === 0) {
      expect(short.mp, 'a cast turned down for want of MP').toBeGreaterThan(0);
      expect(casts, 'and cast once enough came back').toBeGreaterThan(0);
    }

    const input = JSON.stringify({ spawn: s.spawn, team: s.team, build, steps: s.steps, hits: s.hits, levels: lv ?? [], start });
    const rust = JSON.parse(execFileSync(SIMCHECK, { input, maxBuffer: 64 * 1024 * 1024 }).toString()) as {
      frames: number[][];
      obstacles: number[][];
      stats: {
        melee_targets: number[];
        pierce_targets: number[];
        cast_frames: number[];
        combo_startup: number[][];
        combo_damage: number[][];
        movement_cooldowns: number[];
        movement_stamina: number[];
        ability_mp: number[];
        effects: number[][][];
      };
    };

    // The skill tree resolved to the same numbers on both sides. Checked directly rather than
    // only through behaviour, so a modifier folded in a different order is a failed assertion
    // here instead of a drift that only shows up in a particular fight.
    const r = resolveSkills(build.skills, lv);
    const weapons = WEAPONS.map((_, w) => w);
    expect(weapons.map((w) => meleeTargets(w, r))).toEqual(rust.stats.melee_targets);
    expect(weapons.map((w) => pierceTargets(w, r))).toEqual(rust.stats.pierce_targets);
    expect(ABILITIES.map((_, a) => castFramesFor(a, r))).toEqual(rust.stats.cast_frames);
    expect(weapons.map((w) => comboFor(w, r).map((s) => s.startup))).toEqual(rust.stats.combo_startup);
    weapons.forEach((w) => {
      comboFor(w, r).forEach((step, i) => expect(step.damage).toBeCloseTo(rust.stats.combo_damage[w][i], 12));
    });
    expect(MOVEMENT_SKILLS.map((_, m) => movementCooldownFor(m, r))).toEqual(rust.stats.movement_cooldowns);
    MOVEMENT_SKILLS.forEach((_, m) => expect(movementStaminaFor(m, r)).toBeCloseTo(rust.stats.movement_stamina[m], 12));
    ABILITIES.forEach((_, a) => expect(abilityMpFor(a, r)).toBeCloseTo(rust.stats.ability_mp[a], 12));
    ABILITIES.forEach((a, i) => {
      a.effects.forEach((e, k) => {
        const [radius, damage, amount] = rust.stats.effects[i][k];
        expect(effectRadius(i, e, r)).toBeCloseTo(radius, 12);
        expect(effectDamage(i, e, r)).toBeCloseTo(damage, 12);
        expect(effectAmount(i, e, r)).toBeCloseTo(amount, 12);
      });
    });

    // Same battlefield layout.
    expect(rust.obstacles.length).toBe(s.world.obstacles.length);
    let worldDiff = 0;
    s.world.obstacles.forEach((o, i) => {
      worldDiff = Math.max(worldDiff, Math.abs(o.x - rust.obstacles[i][0]), Math.abs(o.z - rust.obstacles[i][1]), Math.abs(o.r - rust.obstacles[i][2]));
    });

    // Same movement, casting and cooldowns every frame.
    expect(rust.frames.length).toBe(ts.length);
    expect(rust.frames[0].length).toBe(ts[0].length); // the two sides record the same columns
    let posDiff = 0;
    let worstFrame = 0;
    let stateMismatch = 0;
    ts.forEach((f, i) => {
      const r = rust.frames[i];
      const d = Math.max(...NEAR.map((k) => Math.abs(f[k] - r[k])));
      if (d > posDiff) {
        posDiff = d;
        worstFrame = i;
      }
      if (EXACT.some((k) => f[k] !== r[k])) {
        if (stateMismatch === 0) {
          const names = Object.entries(F)
            .filter(([, k]) => EXACT.includes(k) && f[k] !== r[k])
            .map(([n]) => n);
          console.log(`${name}: first mismatch at frame ${i} in ${names.join(', ') || 'a cooldown'}: ts=${f.join()} rust=${r.join()}`);
        }
        stateMismatch++;
      }
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
