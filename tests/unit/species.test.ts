import { describe, expect, test } from 'vitest';
import { getSpecies } from '../../src/render/creatures/registry';
import { jointWorld, posedBounds, poseWorld, speciesInfo } from '../../src/library/bench/species';

// Per-species tests, on the baked clips' numbers (src/library/bench/species.ts): no drawing, so they
// need no page. Adding a monster means adding a row to SPECIES and, if it moves in a way worth
// guaranteeing, one motion test below - not a new harness. Drawn by the crowd (any number of them in
// two draw calls, and pictures of each): tests/integration/species.spec.ts, on the content library's
// crowd bench.

type Vec = number[];
const load = (id: string) => speciesInfo(id);
const jointsAt = (id: string, clip: string, frame: number): Vec[] => jointWorld(getSpecies(id), clip, frame);
const bounds = (id: string, clip: string, frame: number) => posedBounds(getSpecies(id), clip, frame);

// What every species must satisfy, whatever shape it is.
const SPECIES = [
  { id: 'fighter', joints: 7, boxes: 20, clips: ['idle', 'run', 'attack', 'down'], still: 'idle' },
  { id: 'slime', joints: 5, boxes: 6, clips: ['idle', 'hop', 'die', 'windup', 'leap', 'gather', 'dazed'], still: 'idle' },
  { id: 'quadruped', joints: 18, boxes: 19, clips: ['idle', 'walk', 'run'], still: 'idle' },
] as const;

// The crowd budget the box-art fighter set: 240 triangles of body, and a little room.
const CROWD_TRIANGLE_BUDGET = 300;

describe('species contract', () => {
  for (const spec of SPECIES) {
    test(`${spec.id} loads within the crowd budget`, () => {
      const info = load(spec.id);
      expect(info.joints).toBe(spec.joints);
      expect(info.boxes).toBe(spec.boxes);
      expect(info.triangles).toBe(spec.boxes * 12);
      expect(info.triangles).toBeLessThanOrEqual(CROWD_TRIANGLE_BUDGET);
      expect(info.clips.map((c) => c.name)).toEqual([...spec.clips]);
      expect(info.height).toBeGreaterThan(0.1);
    });

    test(`${spec.id} holds still when it should`, () => {
      const info = load(spec.id);
      const clip = info.clips.find((c) => c.name === spec.still)!;
      // An idle that drifts is a baking bug: the last frame must land back on the first.
      const first = jointsAt(spec.id, spec.still, 0);
      const last = jointsAt(spec.id, spec.still, clip.frames - 1);
      for (let j = 0; j < first.length; j++) {
        for (let k = 0; k < 3; k++) expect(Math.abs(first[j][k] - last[j][k])).toBeLessThan(0.05);
      }
    });
  }
});

describe('slime', () => {
  test('hop leaves the ground and lands flatter than it started', () => {
    const info = load('slime');
    const frames = info.clips.find((c) => c.name === 'hop')!.frames;
    const heights: number[] = [];
    const roots: number[] = [];
    for (let f = 0; f < frames; f++) {
      heights.push(bounds('slime', 'hop', f).max[1]);
      roots.push(jointsAt('slime', 'hop', f)[0][1]);
    }
    const apex = Math.max(...roots);
    expect(apex).toBeGreaterThan(0.35); // it actually jumps
    expect(Math.min(...roots)).toBeLessThan(0.02); // and comes back down
    // Squash on landing: at some frame it is meaningfully shorter than at rest.
    expect(Math.min(...heights)).toBeLessThan(heights[0] * 0.9);
  });

  test('die flattens and stays flat', () => {
    const info = load('slime');
    const die = info.clips.find((c) => c.name === 'die')!;
    expect(die.loop).toBe(false);
    const start = bounds('slime', 'die', 0).size[1];
    const end = bounds('slime', 'die', die.frames - 1).size[1];
    expect(end).toBeLessThan(start * 0.4);
  });

  test('has no limbs and still animates', () => {
    const info = load('slime');
    expect(info.jointNames).toEqual(['root', 'core', 'top', 'budL', 'budR']);
    const a = bounds('slime', 'hop', 0);
    const b = bounds('slime', 'hop', 10);
    expect(a.size).not.toEqual(b.size);
  });
});

describe('fighter', () => {
  test('is the same twenty boxes the hardcoded crowd drew', () => {
    const info = load('fighter');
    // The old renderer reported 240 triangles per fighter; the migration must not change it.
    expect(info.triangles).toBe(240);
    expect(info.jointNames).toEqual(['root', 'body', 'legL', 'legR', 'armL', 'armR', 'cape']);
  });

  test('run is one smooth sinusoidal cycle', () => {
    const info = load('fighter');
    const frames = info.clips.find((c) => c.name === 'run')!.frames;
    // A joint origin does not move when the joint rotates about itself, so the stride shows up
    // in how far the boxes hanging off it reach, not in jointWorld.
    const reach = (f: number) => bounds('fighter', 'run', f).size[2];
    const rest = reach(0);
    const half = reach(frames / 2);
    const fore = reach(frames / 4);
    const back = reach((frames * 3) / 4);

    // Both zero crossings of the stride are the same pose.
    expect(Math.abs(rest - half)).toBeLessThan(0.01);
    // The two extremes sit either side of it, and the cycle covers real ground.
    expect(fore).toBeLessThan(rest - 0.1);
    expect(back).toBeGreaterThan(rest + 0.1);
    expect(back - fore).toBeGreaterThan(0.4);
  });

  test('the chop reaches behind the head and comes back', () => {
    const info = load('fighter');
    const attack = info.clips.find((c) => c.name === 'attack')!;
    expect(attack.loop).toBe(false);
    // The sword hangs off armR; at the top of the wind-up it is behind and above the fighter.
    let highest = -Infinity;
    let back = -Infinity;
    for (let f = 0; f < attack.frames; f++) {
      const b = bounds('fighter', 'attack', f);
      highest = Math.max(highest, b.max[1]);
      back = Math.max(back, -b.min[2]);
    }
    const rest = bounds('fighter', 'attack', attack.frames - 1);
    expect(highest).toBeGreaterThan(rest.max[1] + 0.2); // the blade goes up
    expect(back).toBeGreaterThan(0.3); // and behind
  });

  test('down lays the fighter out flat', () => {
    const info = load('fighter');
    const at = (n: string) => info.jointNames.indexOf(n);
    const up = jointsAt('fighter', 'idle', 0);
    const flat = jointsAt('fighter', 'down', 0);
    // The body goes over: every joint above the waist ends up near the ground and well behind
    // where it stood. The bounding box is no use here - the sword swings upward as the fighter
    // falls, exactly as it did under the old shader, so the box stays tall.
    for (const joint of ['armL', 'armR', 'cape']) {
      const j = at(joint);
      expect(up[j][1]).toBeGreaterThan(1);
      expect(flat[j][1]).toBeLessThan(0.35);
      expect(flat[j][2]).toBeLessThan(up[j][2] - 0.7);
    }
    expect(bounds('fighter', 'down', 0).size[2]).toBeGreaterThan(bounds('fighter', 'idle', 0).size[2] * 1.2);
  });
});

describe('quadruped', () => {
  test('walks on four legs in a diagonal gait', () => {
    const info = load('quadruped');
    const at = (name: string) => info.jointNames.indexOf(name);
    const frames = info.clips.find((c) => c.name === 'walk')!.frames;

    // Diagonal pairs share a phase, so their feet swing together; neighbours do not.
    const swing = (joint: string) => {
      const zs: number[] = [];
      for (let f = 0; f < frames; f += 2) zs.push(jointsAt('quadruped', 'walk', f)[at(joint)][2]);
      return zs;
    };
    const fl = swing('footFL');
    const br = swing('footBR');
    const fr = swing('footFR');

    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    expect(spread(fl)).toBeGreaterThan(0.1); // the legs actually move

    // Same-phase pair rises and falls together; opposite-phase pair does not.
    const centred = (v: number[]) => {
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      return v.map((x) => x - m);
    };
    const corr = (a: number[], b: number[]) => {
      const [x, y] = [centred(a), centred(b)];
      const dot = x.reduce((s, v, i) => s + v * y[i], 0);
      return dot / Math.sqrt(x.reduce((s, v) => s + v * v, 0) * y.reduce((s, v) => s + v * v, 0));
    };
    expect(corr(fl, br)).toBeGreaterThan(0.9);
    expect(corr(fl, fr)).toBeLessThan(-0.5);
  });

  test('keeps its feet near the ground', () => {
    const info = load('quadruped');
    const frames = info.clips.find((c) => c.name === 'walk')!.frames;
    const feet = ['footFL', 'footFR', 'footBL', 'footBR'].map((n) => info.jointNames.indexOf(n));
    let lowest = Infinity;
    for (let f = 0; f < frames; f += 2) {
      const p = jointsAt('quadruped', 'walk', f);
      for (const i of feet) {
        expect(p[i][1]).toBeLessThan(0.45); // never lifts to mid-body
        lowest = Math.min(lowest, p[i][1]);
      }
    }
    expect(lowest).toBeLessThan(0.2); // and at least one is always planted low
  });
});

// ---------- baked from the close-up poses ----------

describe('hero', () => {
  test('its crowd body is the close-up body, boxed', () => {
    const hero = load('hero');
    // 23 worn parts plus the five pieces of the sword it is baked holding, on 23 joints.
    expect(hero.boxes).toBe(28);
    expect(hero.triangles).toBe(28 * 12);
    expect(hero.joints).toBe(23);
    expect(hero.height).toBeGreaterThan(1.5);
    expect(hero.height).toBeLessThan(1.9);
    expect(hero.clips.map((c) => c.name)).toContain('run');
    expect(hero.clips.map((c) => c.name)).toContain('sprint');
    expect(hero.clips.find((c) => c.name === 'down')!.loop).toBe(false);
  });

  // The whole point of baking: a hero in a battle is running the same animation as the hero
  // standing in front of you. If these ever disagree, the crowd has drifted from the game.
  for (const [clip, frame] of [
    ['run', 7],
    ['run', 19],
    ['sprint', 11],
    ['idle', 30],
    ['attack1', 9],
    ['attack3', 14],
    ['cast', 30],
    ['down', 0],
  ] as const) {
    test(`the baked ${clip} clip matches the live pose on frame ${frame}`, () => {
      const live = poseWorld('hero', clip, frame);
      const baked = jointsAt('hero', clip, frame);
      expect(baked).toHaveLength(live.length);
      live.forEach(([name, x, y, z], i) => {
        const b = baked[i];
        const off = Math.hypot(b[0] - x, b[1] - y, b[2] - z);
        if (off > 1e-3) throw new Error(`${clip} frame ${frame}: joint ${name} is at ${[x, y, z]} live and ${b} baked`);
      });
    });
  }
});
