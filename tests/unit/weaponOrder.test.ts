import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type * as THREE from 'three';
import { build } from '../../tools/content/contentc.mjs';
import type { PoseInput } from '../../src/content/pose';
import type { ResolvedSkills, SkillSet } from '../../src/content/skills';
import type { Build } from '../../src/content/tuning';
import type { Actions } from '../../src/engine/rules';
import type { Scenario } from '../../src/render/detail/scenarios';

// Weapons, abilities and movement skills each go by their place in their list in the rules' state
// and on the wire: the order content/weapons/, content/abilities/ and content/movement-skills/ give
// in their _order.json, which the server and the page read from the same bundle. Whatever else names
// one names it by id (R9.5): the skill tree and the levels, whose places the engine and the page find
// as they read them; kept builds; and the page, which holds, swings, traces, puts away and grips each
// weapon by its id, casts and moves as each ability's and movement skill's data says, aims by whether
// a weapon shoots, and says in the skill book what each one does. Here each list is turned round by
// one (its first last, every other one place earlier), in a copy of content/ built by contentc as
// content/ is, and the page and the engine (a WebAssembly instance of its own, given that bundle in
// place of the one built into it) are loaded on it: each does exactly what it does in the order the
// content has, thing for thing, every place it shows read as the id it holds there.
// crates/engine/tests/order.rs does the same for the engine as the server runs it.

/** The lists whose order is changed, by their folders in content/. */
const LISTS = ['weapons', 'abilities', 'movement-skills'] as const;
const WASM = 'target/wasm32-unknown-unknown/release/ruina_engine_wasm.wasm';

/** The modules that know weapons, abilities and movement skills, loaded afresh on whatever bundle is in place. */
async function load() {
  return {
    tuning: await import('../../src/content/tuning'),
    pose: await import('../../src/content/pose'),
    skills: await import('../../src/content/skills'),
    rules: await import('../../src/engine/rules'),
    engine: await import('../../src/engine/engine'),
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

/** Numbers to a hundred-thousandth, typed arrays as arrays, an object's keys in order, then a hash. */
const hash = (x: unknown): string =>
  createHash('sha1')
    .update(
      JSON.stringify(x, (_k, v) => {
        if (typeof v === 'number') return Math.round(v * 1e5) / 1e5;
        if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v as unknown as ArrayLike<number>, (n) => Math.round(n * 1e5) / 1e5);
        if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
        return v;
      }),
    )
    .digest('hex');

/** Films any weapon is held through: standing, running, putting it away and drawing it, guarding, hit, a swing with a pack on. */
const ANY_WEAPON = ['idle', 'run', 'sheathe', 'block', 'hit', 'carrySwing'];
const STATS = ['attack.damage', 'attack.startup', 'melee.maxTargets', 'projectile.pierce'];
/** Levels in the skill book by id, so what each level adds has to reach the skill it's for. */
const LEVELS: Record<string, number> = { sword: 5, club: 2, staff: 7, bow: 6, heal: 3, meteor: 4, dodgeRoll: 10, backstep: 2, block: 3, slide: 2 };

/** The id each place holds in its list, in the content as loaded; a place that holds nothing (255, -1) stays as it is. */
function names(c: Client) {
  const { WEAPONS, ABILITIES, MOVEMENT_SKILLS } = c.tuning;
  const variants = WEAPONS.flatMap((w) => (w.variants ?? []).map((v) => v.id));
  return {
    weapon: (i: number): string | number => WEAPONS[i]?.name ?? i,
    ability: (i: number): string | number => ABILITIES[i]?.id ?? i,
    move: (i: number): string | number => MOVEMENT_SKILLS[i]?.id ?? i,
    /** A build's combo variants, from their bits. */
    variants: (bits: number): string[] => variants.filter((_, k) => bits & (1 << k)).sort(),
    /** The bits of every variant a weapon has. */
    variantBits: (w: number): number => (WEAPONS[w]?.variants ?? []).reduce((bits, v) => bits | (1 << variants.indexOf(v.id)), 0),
  };
}

/** What the rules or the content hand back, every place in a list in it put as the id it holds there. */
function byId(c: Client, value: unknown): unknown {
  const n = names(c);
  const walk = (v: unknown, key: string, owner: Record<string, unknown> | null): unknown => {
    if (typeof v === 'number') {
      if (key === 'weapon') return n.weapon(v);
      if (key === 'ability' || key === 'castAbility' || key === 'firedAbility') return n.ability(v);
      if (key === 'movement' || key === 'actionId' || key === 'actionBufferId' || (key === 'id' && owner?.type === 'action')) return n.move(v);
      if (key === 'comboVariants') return n.variants(v);
      return v;
    }
    if (Array.isArray(v)) {
      if (key === 'abilities') return v.map((a: number) => n.ability(a));
      if (key === 'movement') return v.map((m: number) => n.move(m));
      if (key === 'movementCooldowns') return Object.fromEntries(v.map((cd, m) => [n.move(m), cd]));
      return v.map((x) => walk(x, '', null));
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x, k, o)]));
    }
    return v;
  };
  return walk(value, '', null);
}

/** A build's numbers as the engine resolves them, each weapon's, ability's and movement skill's under its id. */
function statsById(c: Client, r: ResolvedSkills): unknown {
  const n = names(c);
  const under = <T>(list: T[], name: (i: number) => string | number) => Object.fromEntries(list.map((x, i) => [name(i), x]));
  return {
    weapon: under(r.weapon, n.weapon),
    ability: under(r.ability, n.ability),
    move: under(r.move, n.move),
    combos: [...r.combos].sort(),
    weapons: r.weapons.map(n.weapon),
    abilities: r.abilities.map(n.ability),
    movement: r.movement.map(n.move),
  };
}

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

/**
 * The engine in the yard (a copy of the instance), frame by frame, every place it shows read as its
 * id: for each node that grants something, the way to it learned and what it grants used (a weapon or
 * a combo swung at the dummy, an ability cast at it, a movement skill used running from it), and the
 * slide everyone has.
 */
function yard(c: Client): Record<string, string> {
  const { tuning: t, skills: k } = c;
  const levels = k.BOOK.map((b) => LEVELS[b.id] ?? 1);
  const run = (skills: SkillSet, slots: { ability?: number; movement?: number }, press: (f: number) => Partial<Actions>): string => {
    const build: Build = {
      skills,
      weapon: k.grantsOf(skills).weapons[0],
      abilities: Array.from({ length: t.HOTBAR_SLOTS }, (_, i) => (i === 0 ? (slots.ability ?? t.NO_ABILITY) : t.NO_ABILITY)),
      movement: Array.from({ length: t.MOVEMENT_SLOTS }, (_, i) => (i === 0 ? (slots.movement ?? t.NO_MOVEMENT) : t.NO_MOVEMENT)),
    };
    const e = new c.engine.Engine({ online: false, build });
    e.enterDungeon('yard');
    e.reset({ x: 0, z: 1.4, facing: 0 }, build);
    e.calm(true);
    e.setLevels(levels);
    // The build is the one in hand.
    expect([e.player.weapon, e.player.abilities[0], e.player.movement[0]]).toEqual([build.weapon, build.abilities[0], build.movement[0]]);
    const rows: unknown[] = [];
    for (let f = 0; f < 150; f++) {
      const events = e.step({ ...c.rules.NO_ACTIONS, ...press(f) });
      rows.push(byId(c, [e.player, events, e.range?.arrows ?? [], e.range?.meteors ?? []]), e.actors.list);
    }
    rows.push(statsById(c, e.stats), Object.fromEntries(k.BOOK.map((b, i) => [b.id, e.sim.levels[i]])));
    return hash(rows);
  };
  const out: Record<string, string> = {};
  k.NODES.forEach((node, i) => {
    const g = node.grants;
    if (!g) return;
    const skills = k.pathTo(k.emptySkills(), i).reduce((s, j) => k.withSkill(s, j, true), k.emptySkills());
    if (g.ability !== undefined) out[node.id] = run(skills, { ability: g.ability }, (f) => (f === 2 ? { abilitySlot: 1, aimX: 0, aimZ: 1.8 } : {}));
    else if (g.movement !== undefined)
      out[node.id] = run(skills, { movement: g.movement }, (f) => ({ moveZ: -1, movementSlot: f === 2 ? 1 : 0, movementHeld: f >= 2 && f < 40 ? 1 : 0 }));
    else out[node.id] = run(skills, {}, (f) => ({ attackPressed: f % 12 === 2 && f < 110 }));
  });
  out.slide = run(t.DEFAULT_BUILD.skills, {}, (f) => ({ moveZ: -1, sprintHeld: true, slidePressed: f === 30 }));
  return out;
}

/** Everything the page and the engine do with each weapon, ability and movement skill, by its id. */
function observe(c: Client): Record<string, unknown> {
  const { WEAPONS, ABILITIES, weaponId, weaponIndex, abilityIndex, shoots, comboShape, groundRange, DEFAULT_BUILD } = c.tuning;
  const { BOOK, NODES, LEVEL_MODS, emptySkills, withSkill } = c.skills;
  const n = names(c);
  const films = c.scenarios.SCENARIOS;
  const everything = NODES.reduce((s, _, i) => withSkill(s, i, true), emptySkills());
  const r = c.rules.resolveSkills(
    everything,
    BOOK.map((b) => LEVELS[b.id] ?? 1),
  );
  // The films of a movement skill or a cast, and which they show.
  const uses = (s: Scenario) => {
    const inputs = Array.from({ length: s.frames }, (_, f) => s.at(f).input);
    const moves = [...new Set(inputs.map((i) => i.actionId ?? -1).filter((m) => m >= 0))].map(n.move);
    const casts = [...new Set(inputs.map((i) => i.castAbility ?? -1).filter((a) => a >= 0))].map(n.ability);
    return { moves, casts };
  };
  const skillFilms = films.map((s) => ({ s, used: uses(s) })).filter(({ used }) => used.moves.length + used.casts.length > 0);
  const out: Record<string, unknown> = {
    films: Object.fromEntries(films.filter((s) => s.weapon !== undefined).map((s) => [s.id, weaponId(s.weapon ?? -1)])),
    skillFilms: Object.fromEntries(skillFilms.map(({ s, used }) => [s.id, { ...used, played: play(c, s, s.weapon ?? DEFAULT_BUILD.weapon) }])),
    starts: weaponId(DEFAULT_BUILD.weapon),
    held: weaponId(new c.character.Hero().weaponHeld),
    posed: weaponId(c.pose.pose().weapon),
    crowd: [...new Set(c.heroBody.HERO_CLIPS.map((clip) => weaponId(c.pose.pose(clip.at(0.5, 2)).weapon)))],
    crowdCasts: [...new Set(c.heroBody.HERO_CLIPS.map((clip) => c.pose.pose(clip.at(0.5, 2)).castAbility).filter((a) => a >= 0))].map(n.ability),
    crowdBaked: hash(c.crowd.heroSpecies()),
    nodes: byId(c, NODES),
    levelMods: byId(c, LEVEL_MODS),
    tree: Object.fromEntries(NODES.map((node) => [node.id, c.describe.nodeLines(node)])),
    book: Object.fromEntries(
      BOOK.map((b) => [
        b.id,
        {
          kind: b.kind,
          is: b.kind === 'weapon' ? n.weapon(b.index) : b.kind === 'ability' ? n.ability(b.index) : n.move(b.index),
          name: c.describe.bookName(b),
          icon: c.describe.bookIcon(b),
          tree: c.describe.bookTree(b),
          desc: c.describe.bookDesc(b),
          type: c.describe.bookType(b),
          stats: c.describe.bookStats(b, r),
        },
      ]),
    ),
    stats: statsById(c, r),
    yard: yard(c),
  };
  for (const w of WEAPONS) {
    const i = weaponIndex(w.name);
    const own = films.filter((s) => s.weapon === i);
    // Its swings' paths, with and without the variants a skill unlocks (the sword's Whirlwind).
    const traced = [0, n.variantBits(i)].map((variants) => {
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
  for (const a of ABILITIES) out[`ability ${a.id}`] = { ground: groundRange(abilityIndex(a.id)) };
  return out;
}

/** The tuning bundle with each list turned round by one: built from a copy of content/ with the lists' _order.json changed. */
function turned(): Record<string, unknown> {
  const root = mkdtempSync(join(tmpdir(), 'ruina-order-'));
  try {
    cpSync('content', root, { recursive: true });
    for (const list of LISTS) {
      const file = join(root, list, '_order.json');
      const [first, ...rest] = JSON.parse(readFileSync(file, 'utf8')) as string[];
      writeFileSync(file, JSON.stringify([...rest, first]));
    }
    return build(root).get('tuning.json') as Record<string, unknown>;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the page and the engine know each weapon, ability and movement skill by its id or its data, in whatever order the content lists them', async () => {
  const before = observe(await load());
  const tuning = turned();
  vi.resetModules();
  vi.doMock('../../shared/tuning.json', () => ({ default: tuning }));
  // An engine of its own, reading that bundle in place of the one built into it.
  const wasm = await import('../../src/engine/wasm');
  wasm.useEngine(new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM)), {}).exports);
  wasm.useContent({ 'tuning.json': tuning });
  const c = await load();
  // Everything somewhere else in its list...
  const now: Record<(typeof LISTS)[number], string[]> = {
    weapons: c.tuning.WEAPONS.map((w) => w.name),
    abilities: c.tuning.ABILITIES.map((a) => a.id),
    'movement-skills': c.tuning.MOVEMENT_SKILLS.map((m) => m.id),
  };
  for (const list of LISTS) {
    const order = JSON.parse(readFileSync(`content/${list}/_order.json`, 'utf8')) as string[];
    expect(now[list]).toEqual([...order.slice(1), order[0]]);
    expect(order.filter((id, i) => now[list][i] === id)).toEqual([]);
  }
  // ...the engine reading it so too...
  const r = c.rules.resolveSkills(c.skills.skillsFrom('sword', 'heal', 'club', 'dodgeRoll'));
  expect(r.weapons).toEqual(['sword', 'club'].map(c.tuning.weaponIndex));
  expect([r.abilities, r.movement]).toEqual([[c.tuning.abilityIndex('heal')], [c.tuning.movementIndex('dodgeRoll')]]);
  // ...and each held, swung, drawn, cast, used, aimed and described as before.
  expect(observe(c)).toEqual(before);
  vi.doUnmock('../../shared/tuning.json');
});
