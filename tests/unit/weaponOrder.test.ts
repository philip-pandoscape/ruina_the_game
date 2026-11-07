import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type * as THREE from 'three';
import { build } from '../../tools/content/contentc.mjs';
import type { PoseInput } from '../../src/content/pose';
import type { Scenario } from '../../src/render/detail/scenarios';

// A weapon goes by its place in the list (content/weapons/_order.json) in the rules' state, on the
// wire and in the skill tree; the client knows each one by its id or by its data (R9.5): the hero
// holds, swings, traces, puts away and grips it, the films hold it, aiming asks whether it shoots and
// the skill book says what it does. Here the weapons are put in another order, in a copy of content/
// built by contentc as content/ is, with the skill tree's weapon numbers moved to match (the tree and
// the levels in content/tuning.json name weapons by place, so a new order needs them changed too).
// The client loaded on those bundles does exactly what it does in the order the content has, weapon
// for weapon.

/** The modules that know weapons, loaded afresh on whatever bundles are in place. */
async function load() {
  return {
    tuning: await import('../../src/content/tuning'),
    pose: await import('../../src/content/pose'),
    skills: await import('../../src/content/skills'),
    film: await import('../../src/dev/library/subjects/film'),
    scenarios: await import('../../src/render/detail/scenarios'),
    character: await import('../../src/render/character'),
    heroBody: await import('../../src/render/creatures/heroBody'),
    crowd: await import('../../src/render/creatures/builtin/hero'),
    describe: await import('../../src/ui/skills/describe'),
  };
}
type Client = Awaited<ReturnType<typeof load>>;

/** What the hero keeps to itself that shows what it holds. */
interface Inside {
  grips(input: PoseInput): Record<'L' | 'R', { amount: number; held?: THREE.Object3D[] }>;
  strings: THREE.Mesh[];
}

/** Numbers to a hundred-thousandth, typed arrays as arrays, then a hash. */
const hash = (x: unknown): string =>
  createHash('sha1')
    .update(
      JSON.stringify(x, (_k, v) => {
        if (typeof v === 'number') return Math.round(v * 1e5) / 1e5;
        if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v as unknown as ArrayLike<number>, (n) => Math.round(n * 1e5) / 1e5);
        return v;
      }),
    )
    .digest('hex');

/** Films any weapon is held through: standing, running, putting it away and drawing it, guarding, hit, a swing with a pack on. */
const ANY_WEAPON = ['idle', 'run', 'sheathe', 'block', 'hit', 'carrySwing'];
const STATS = ['attack.damage', 'attack.startup', 'melee.maxTargets', 'projectile.pierce'];

/** A film played through the hero holding a weapon: its joints, what it shows where, the pose's feedback, its grips and bowstring, frame by frame. */
function play(c: Client, s: Scenario, weapon: number): string {
  const t = new c.film.Film(s, weapon);
  const inside = t.hero as unknown as Inside;
  const rows: unknown[] = [];
  for (let f = 0; f < s.frames; f++) {
    t.step();
    t.hero.root.updateMatrixWorld(true);
    const rig = t.hero.detail;
    const names = Object.keys(rig.def.attachments ?? {});
    const nameOf = (o: THREE.Object3D) => names.find((n) => rig.attachment(n) === o) ?? 'nocked arrow';
    const grips = inside.grips(t.input);
    rows.push([
      rig.def.joints.map((j) => rig.joint(j.name).matrixWorld.elements),
      names.filter((n) => rig.attachment(n).visible).map((n) => [n, rig.attachment(n).parent?.name, rig.attachment(n).matrixWorld.elements]),
      t.fb,
      [grips.L, grips.R].map((g) => [g.amount, (g.held ?? []).map(nameOf)]),
      inside.strings.map((m) => m.geometry.attributes.position.array),
    ]);
  }
  t.dispose();
  return hash(rows);
}

/** Everything the client does with each weapon, by the weapon's id. */
function observe(c: Client): Record<string, unknown> {
  const { WEAPONS, weaponId, weaponIndex, shoots, comboShape, DEFAULT_BUILD } = c.tuning;
  const films = c.scenarios.SCENARIOS;
  const out: Record<string, unknown> = {
    films: Object.fromEntries(films.filter((s) => s.weapon !== undefined).map((s) => [s.id, weaponId(s.weapon ?? -1)])),
    starts: weaponId(DEFAULT_BUILD.weapon),
    posed: weaponId(c.pose.pose().weapon),
    crowd: [...new Set(c.heroBody.HERO_CLIPS.map((clip) => weaponId(c.pose.pose(clip.at(0.5, 2)).weapon)))],
    crowdBaked: hash(c.crowd.heroSpecies()),
    tree: Object.fromEntries(c.skills.NODES.map((n) => [n.id, c.describe.nodeLines(n)])),
  };
  for (const w of WEAPONS) {
    const i = weaponIndex(w.name);
    const own = films.filter((s) => s.weapon === i);
    // Its swings' paths, with and without the variants a skill unlocks (the sword's Whirlwind).
    const traced = [0, 1].map((variants) => {
      const combo = comboShape(i, variants);
      return combo.map((step, k) => c.character.traceSwing(c.pose.pose({ weapon: i, attackIndex: k, attackFrame: 0, step, comboLength: combo.length })));
    });
    out[w.name] = {
      shoots: shoots(i),
      words: STATS.map((stat) => c.describe.describeMod({ stat, op: 'inc', value: -0.1, weapon: i })),
      traced: hash(traced),
      played: Object.fromEntries([...ANY_WEAPON.map((id) => films.find((s) => s.id === id)!), ...own].map((s) => [s.id, play(c, s, i)])),
    };
  }
  return out;
}

/** The bundles with the weapons in the opposite order: built from a copy of content/, the skill tree's weapon numbers moved to match. */
function reversed(order: string[]): { tuning: Record<string, unknown>; tree: Record<string, unknown> } {
  const back = [...order].reverse();
  const root = mkdtempSync(join(tmpdir(), 'ruina-weapon-order-'));
  try {
    cpSync('content', root, { recursive: true });
    writeFileSync(join(root, 'weapons/_order.json'), JSON.stringify(back));
    const tuning = build(root).get('tuning.json') as Record<string, unknown> & { skills: unknown };
    const tree = JSON.parse(readFileSync('shared/skilltree.json', 'utf8')) as Record<string, unknown> & { nodes: unknown };
    // A weapon named by place (a node's grant, a modifier's weapon) goes where that weapon went.
    const move = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(move);
      if (!v || typeof v !== 'object') return;
      const o = v as Record<string, unknown>;
      if (typeof o.weapon === 'number') o.weapon = back.indexOf(order[o.weapon]);
      Object.values(o).forEach(move);
    };
    move(tuning.skills);
    move(tree.nodes);
    return { tuning, tree };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the client knows each weapon by its id or its data, in whatever order the content lists them', async () => {
  const before = observe(await load());
  const order = JSON.parse(readFileSync('content/weapons/_order.json', 'utf8')) as string[];
  const { tuning, tree } = reversed(order);
  vi.resetModules();
  vi.doMock('../../shared/tuning.json', () => ({ default: tuning }));
  vi.doMock('../../shared/skilltree.json', () => ({ default: tree }));
  const c = await load();
  // Every weapon somewhere else in the list...
  expect(c.tuning.WEAPONS.map((w) => w.name)).toEqual([...order].reverse());
  expect(order.filter((id, i) => c.tuning.weaponIndex(id) === i)).toEqual([]);
  // ...and each held, swung, drawn, aimed and described as before.
  expect(observe(c)).toEqual(before);
  vi.doUnmock('../../shared/tuning.json');
  vi.doUnmock('../../shared/skilltree.json');
});
