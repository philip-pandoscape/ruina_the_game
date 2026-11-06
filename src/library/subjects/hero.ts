import * as THREE from 'three';
import { Hero, type WeaponAt } from '../../render/character';
import { pose, type PoseFeedback, type PoseInput } from '../../content/pose';
import { HERO_RIG, HERO_WEAPONS } from '../../content/creatures/hero';
import { GLIDERS, MOUNTS, VEHICLES } from '../../content/vehicles';
import { buildGlider, buildMount, buildVehicle } from '../../render/models';
import type { Holds } from '../../render/models/vehicles';
import { SCENARIOS, scenario, type Moment, type Scenario } from '../../render/detail/scenarios';
import { madeHero, madeHeroNow } from '../../render/detail/madeHero';
import { HERO_MOVES, HERO_MOVE_SETS } from '../../render/detail/moves';
import { NEW_LOOK } from '../../render/look';
import { ABILITIES, MOVEMENT_SKILLS, MOVE, WEAPONS } from '../../tuning';
import { NodeTrack, readBones, readJoint, sideOf, writeBones, writeJoint } from '../pose';
import type { AnimDef, Bone, FrameInfo, Options, Phase, Posable, Snapshot, Source, Subject, Take } from '../types';

// The hero in the library: each of the films in src/render/detail/scenarios.ts (what the rules
// report frame by frame) played through the game's own Hero (src/render/character.ts), exactly as
// /animations.html plays them, every frame kept. The new look's hero wears its made body
// (madeHero.ts); ?look=classic shows the box hero.

const STEP = 1 / 60;

/** Hero's private parts the library needs to show a kept frame again. */
interface HeroInside {
  trails: Map<string, { mesh: THREE.Object3D }>;
  place(at: WeaponAt): void;
  feedback(input: PoseInput, fb: PoseFeedback): void;
  weaponAt: WeaponAt;
  weaponShown: number;
}
const inside = (h: Hero): HeroInside => h as unknown as HeroInside;

// ---------- what the hero rides, flies or sits in (as /animations.html has them) ----------

interface Prop {
  root: THREE.Object3D;
  animate(dt: number, m: Moment, input: PoseInput): void;
  water?: number;
  holds?: Holds;
  driver?: string;
}

function makeProp(kind: Scenario['prop'], hero: Hero): Prop | null {
  if (!kind) return null;
  if (kind === 'glider') {
    const g = buildGlider(GLIDERS[0]);
    hero.root.add(g.root);
    return {
      root: g.root,
      animate: (dt, m, input) => g.animate(dt, { bank: input.bank * 0.6, pitch: Math.max(-0.35, Math.min(0.3, (input.rise * 9.2) / 12)), speed: m.speed }),
    };
  }
  if (kind === 'horse') {
    const def = MOUNTS.find((x) => x.id === 'horse')!;
    const h = buildMount(def);
    hero.root.add(h.root);
    return { root: h.root, animate: (dt, m) => h.animate(dt, { speed: m.speed, grounded: true }), holds: h.holds, driver: 'ride' };
  }
  const id = kind === 'cart' ? 'farmCart' : kind;
  const def = VEHICLES.find((x) => x.id === id)!;
  const v = buildVehicle(def);
  let t = 0;
  hero.root.add(v.root);
  const boat = def.class === 'boat';
  return {
    root: v.root,
    water: boat ? 0 : undefined,
    holds: v.holds,
    driver: def.seats[0].pose,
    animate: (dt, m, input) => {
      t += dt;
      v.animate(dt, { speed: m.speed, steer: m.controls?.steer ?? input.bank, throttle: m.controls?.throttle ?? input.effort, sail: 0.8, boom: 0.3, time: t });
    },
  };
}

/** Puts a ridden thing so the seat the hero uses is at the hero's origin; returns the seat's height. */
function seatProp(prop: Prop, kind: Scenario['prop'], input: PoseInput): number {
  if (!kind || kind === 'glider') return 0;
  const def = kind === 'horse' ? MOUNTS.find((x) => x.id === 'horse')! : VEHICLES.find((x) => x.id === (kind === 'cart' ? 'farmCart' : kind))!;
  const seat = def.seats.find((s) => s.pose === input.travel) ?? def.seats[0];
  prop.root.position.set(-seat.x, -seat.y, -seat.z);
  return seat.y;
}

// ---------- the hero's bones ----------

const LOCKED = new Set(['squash', 'eyes']);

/** The far ends of what the hands hold, in the weapon's own space: a blade's tip, the club's head, the orb, the bow's top. */
const POINTS: Array<{ name: string; bone: string; at: [number, number, number] }> = [
  { name: '@sword tip', bone: '@sword', at: [0, -1.1, 0] },
  { name: '@club head', bone: '@club', at: [0, -0.6, 0] },
  { name: '@staff orb', bone: '@staff', at: [0, -1.2, 0] },
  { name: '@bow top', bone: '@bow', at: [0, 0.275, 0.476] },
];
const MINOR = /^(palm|fingers|fingertips|eyes|squash)/;

function heroBones(hero: Hero): Bone[] {
  const rig = hero.detail;
  const bones: Bone[] = rig.def.joints.map((j) => ({
    name: j.name,
    object: rig.joint(j.name),
    parent: j.parent ?? null,
    side: sideOf(j.name),
    locked: LOCKED.has(j.name),
    minor: MINOR.test(j.name),
  }));
  // What it carries: shown where its hand (or the body, put away) has it, turned and moved by the grip.
  for (const name of [...HERO_WEAPONS, 'arrow']) {
    const a = HERO_RIG.attachments?.[name];
    if (!a) continue;
    bones.push({ name: `@${name}`, object: rig.attachment(name), parent: a.joint, side: 'C', minor: true });
  }
  return bones;
}

/** The body itself, posed from snapshots only: a ghost for onion skins and corrections. */
class HeroGhost implements Posable {
  readonly hero = new Hero();
  readonly root: THREE.Object3D;
  readonly space: THREE.Object3D;
  readonly bones: Bone[];
  readonly points = POINTS;

  constructor() {
    this.root = this.hero.root;
    this.space = this.hero.root;
    this.bones = heroBones(this.hero);
  }

  apply(s: Snapshot): void {
    const x = s.extra ?? {};
    const h = inside(this.hero);
    const weapon = typeof x.weapon === 'number' ? x.weapon : 0;
    if (h.weaponShown !== weapon) this.hero.setWeapon(weapon);
    const at = (x.at as WeaponAt | undefined) ?? 'hand';
    if (h.weaponAt !== at) h.place(at);
    writeBones(this.bones, s.joints);
    const root = s.joints['@root'];
    if (root) writeJoint(this.hero.root, root);
    const shown = (x.shown as Record<string, boolean> | undefined) ?? {};
    for (const b of this.bones) if (b.name.startsWith('@') && b.name in shown) b.object.visible = shown[b.name];
  }

  capture(): Snapshot {
    const h = inside(this.hero);
    return { joints: { ...readBones(this.bones), '@root': readJoint(this.hero.root) }, extra: { weapon: h.weaponShown, at: h.weaponAt } };
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}

// ---------- one film, every frame kept ----------

interface Kept {
  m: Moment;
  input: PoseInput;
  fb: PoseFeedback;
  at: WeaponAt;
  travelled: [number, number];
  buf: Float32Array;
}

class HeroTake implements Take {
  readonly root = new THREE.Group();
  readonly hero = new Hero();
  readonly space: THREE.Object3D;
  readonly bones: Bone[];
  readonly points = POINTS;
  readonly frames: number;
  readonly fps = 60;
  readonly loop = true;
  readonly phases: Phase[];
  readonly framing;
  private prop: Prop | null;
  private track: NodeTrack;
  private kept: Kept[] = [];
  private distance = 0;
  private travelled: [number, number] = [0, 0];
  private index = new Map<string, number>();
  private shownFrame = -1;
  private decor = true;

  constructor(
    readonly s: Scenario,
    readonly weapon: number,
  ) {
    this.root.name = `take:${s.id}`;
    this.root.add(this.hero.root);
    this.space = this.hero.root;
    this.prop = makeProp(s.prop, this.hero);
    this.bones = heroBones(this.hero);
    this.frames = s.frames;
    this.track = new NodeTrack(this.root);
    this.track.nodes.forEach((n, i) => this.index.set(n.uuid, i));
    this.phases = heroPhases(s, weapon);
    const far = s.prop === 'sloop' ? 9 : s.prop ? 6.5 : 4.6;
    this.framing = { target: [0, s.prop === 'glider' ? 1.5 : 0.95, 0] as [number, number, number], distance: far, height: 1.8 };
  }

  get baked(): number {
    return this.kept.length;
  }

  private stepOne(): void {
    const f = this.kept.length;
    const m = this.s.at(f);
    const input = pose({ time: (this.s.start ?? 0) + f * STEP, ...m.input, weapon: this.s.weapon ?? this.weapon });
    if (input.run > 0) this.distance += Math.abs(m.speed) * STEP;
    const facing = m.facing ?? 0;
    const h = facing + (m.input.heading ?? 0);
    this.travelled[0] += m.speed * Math.sin(h) * STEP;
    this.travelled[1] += m.speed * Math.cos(h) * STEP;
    // The hero really moves over the ground while it's worked out, so a planted foot stays put on it.
    const seat = this.prop ? seatProp(this.prop, this.s.prop, input) : 0;
    this.hero.root.position.set(this.travelled[0], (m.lift ?? 0) + seat, this.travelled[1]);
    this.hero.root.rotation.y = facing;
    this.prop?.animate(STEP, m, input);
    this.hero.seatHolds = this.prop?.holds && input.travel === this.prop.driver ? this.prop.holds : null;
    const fb = this.hero.drive(input, this.distance, STEP);
    this.kept.push({
      m,
      input,
      fb: { arrow: fb.arrow, draw: fb.draw, plant: [fb.plant[0], fb.plant[1]], trail: fb.trail ? { ...fb.trail } : null },
      at: inside(this.hero).weaponAt,
      travelled: [this.travelled[0], this.travelled[1]],
      buf: this.track.capture(),
    });
  }

  bake(budget: number): boolean {
    if (this.kept.length >= this.frames) return true;
    // Worked out where the world is still: the take's own offset (keeping the body in view) put aside.
    const saved = this.root.position.clone();
    this.root.position.set(0, 0, 0);
    this.root.updateMatrixWorld(true);
    for (let i = 0; i < budget && this.kept.length < this.frames; i++) this.stepOne();
    this.root.position.copy(saved);
    this.shownFrame = -1;
    return this.kept.length >= this.frames;
  }

  private ensure(frame: number): Kept {
    if (frame >= this.kept.length) this.bake(frame - this.kept.length + 1);
    return this.kept[frame];
  }

  show(frame: number): void {
    const f = Math.max(0, Math.min(this.frames - 1, Math.round(frame)));
    const k = this.ensure(f);
    const h = inside(this.hero);
    if (h.weaponAt !== k.at) h.place(k.at);
    this.track.apply(k.buf);
    h.feedback(k.input, k.fb);
    if (!this.decor) for (const arc of h.trails?.values() ?? []) arc.mesh.visible = false;
    // Kept in view: the take is moved back by however far the hero has travelled (the floor goes the other way).
    this.root.position.set(-k.travelled[0], 0, -k.travelled[1]);
    this.shownFrame = f;
  }

  snapshot(frame: number): Snapshot {
    const f = Math.max(0, Math.min(this.frames - 1, Math.round(frame)));
    const k = this.ensure(f);
    const joints: Record<string, number[]> = {};
    const S = NodeTrack.STRIDE;
    const shown: Record<string, boolean> = {};
    for (const b of this.bones) {
      const i = this.index.get(b.object.uuid);
      if (i === undefined) continue;
      joints[b.name] = Array.from(k.buf.subarray(i * S, i * S + 10));
      if (b.name.startsWith('@')) shown[b.name] = k.buf[i * S + 10] > 0.5;
    }
    const r = this.index.get(this.hero.root.uuid)!;
    const root = Array.from(k.buf.subarray(r * S, r * S + 10));
    root[0] = 0;
    root[2] = 0;
    joints['@root'] = root;
    return { joints, extra: { weapon: k.input.weapon, at: k.at, shown } };
  }

  capture(): Snapshot {
    const base = this.snapshot(Math.max(0, this.shownFrame));
    const live = readBones(this.bones);
    return { joints: { ...base.joints, ...live }, extra: base.extra };
  }

  apply(s: Snapshot): void {
    writeBones(
      this.bones.filter((b) => !b.locked),
      s.joints,
    );
  }

  info(frame: number): FrameInfo {
    const k = this.ensure(Math.max(0, Math.min(this.frames - 1, Math.round(frame))));
    const i = k.input;
    const parts = [
      i.attackIndex >= 0 && i.step ? swingWords(i) : '',
      i.actionId >= 0 ? `${MOVEMENT_SKILLS[i.actionId]?.name ?? 'action'} f${Math.round(i.actionFrame)}` : '',
      i.castAbility >= 0 ? `cast ${ABILITIES[i.castAbility]?.name ?? ''} f${Math.round(i.castFrame)}/${i.castFrames}` : '',
      !i.grounded ? `in the air, rising ${i.rise.toFixed(2)}${i.flipFrame >= 0 ? ', flipping' : ''}` : '',
      i.landFrame < 20 ? `landing f${i.landFrame}` : '',
      i.stunned ? `hit f${i.stunFrame}` : '',
      i.down ? `knocked down f${i.downFrame}` : '',
      i.run > 0 ? `${(i.run * MOVE.runSpeed).toFixed(1)} m/s` : '',
      i.travel ? i.travel : '',
      i.stow > 0 && i.stow < 1 ? `stow ${i.stow.toFixed(2)}` : i.stow >= 1 && !i.travel ? 'weapon away' : '',
      i.carry ? 'pack on' : '',
    ].filter(Boolean);
    return { line: parts.join(' · ') || 'standing', detail: inputDetail(k) };
  }

  ground(frame: number): { x: number; z: number; y: number; water: number | null; floor: boolean } {
    const k = this.ensure(Math.max(0, Math.min(this.frames - 1, Math.round(frame))));
    const swim = this.s.id.startsWith('swim') || this.s.id === 'tread';
    const boat = this.prop?.water !== undefined;
    return { x: k.travelled[0], z: k.travelled[1], y: swim ? -1.5 : 0, water: swim ? 1.2 : boat ? (this.prop?.water ?? 0) : null, floor: !boat };
  }

  ghost(): Posable {
    return new HeroGhost();
  }

  setDecor(on: boolean): void {
    this.decor = on;
    if (!on) for (const arc of inside(this.hero).trails?.values() ?? []) arc.mesh.visible = false;
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}

/** A swing in words: which, and how far through its wind-up, strike or recovery. */
function swingWords(i: PoseInput): string {
  const s = i.step!;
  const f = i.attackFrame;
  const n = i.attackIndex + 1;
  const what = `${i.airSwing ? 'jump attack' : `swing ${n}/${i.comboLength}`}${s.pose ? ` (${s.pose})` : ''}`;
  if (f < s.startup) return `${what} wind-up ${Math.floor(f) + 1}/${s.startup}`;
  if (f < s.startup + s.active) return `${what} strike ${Math.floor(f - s.startup) + 1}/${s.active}`;
  return `${what} recovery ${Math.floor(f - s.startup - s.active) + 1}/${s.recovery}`;
}

/** What the rules said on a frame, without the neutral fields: for the prompt. */
function inputDetail(k: Kept): Record<string, unknown> {
  const i = k.input;
  const out: Record<string, unknown> = {};
  const neutral = pose();
  for (const [key, v] of Object.entries(i)) {
    if (key === 'step' || key === 'grips' || key === 'footrest' || key === 'time' || key === 'phase' || key === 'stride' || key === 'effort' || key === 'lean') continue;
    if ((neutral as unknown as Record<string, unknown>)[key] === v) continue;
    out[key] = typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
  }
  if (i.step) out.step = { startup: i.step.startup, active: i.step.active, recovery: i.step.recovery, pose: i.step.pose ?? null };
  out.groundSpeed = Math.round(k.m.speed * 100) / 100;
  if (k.m.lift) out.lift = Math.round(k.m.lift * 1000) / 1000;
  if (k.m.facing) out.facingDeg = Math.round((k.m.facing * 180) / Math.PI);
  out.weaponAt = k.at;
  return out;
}

/** The timeline's bands: what the film is doing when, from the rules' own frame counts. */
function heroPhases(s: Scenario, weapon: number): Phase[] {
  const out: Phase[] = [];
  let cur: Phase | null = null;
  for (let f = 0; f < s.frames; f++) {
    const m = s.at(f);
    const i = pose({ ...m.input, weapon: s.weapon ?? weapon });
    const [label, kind] = classify(i, m);
    if (cur && cur.label === label && cur.to === f - 1) cur.to = f;
    else out.push((cur = { from: f, to: f, label, kind }));
  }
  return out;
}

function classify(i: PoseInput, m: Moment): [string, string] {
  if (i.attackIndex >= 0 && i.step) {
    const s = i.step;
    const what = i.airSwing || !i.grounded ? 'Jump attack' : `Swing ${i.attackIndex + 1}`;
    if (i.attackFrame < s.startup) return [`${what} · wind-up`, 'windup'];
    if (i.attackFrame < s.startup + s.active) return [`${what} · strike`, 'strike'];
    return [`${what} · recovery`, 'recover'];
  }
  if (i.actionId >= 0) {
    const def = MOVEMENT_SKILLS[i.actionId];
    const a = def?.action;
    const name = def?.name ?? 'Action';
    if (a && i.actionFrame < a.startup) return [`${name} · start`, 'windup'];
    if (a && i.actionFrame < a.startup + a.active) return [`${name}`, 'strike'];
    return [`${name} · recovery`, 'recover'];
  }
  if (i.castAbility >= 0) return [`Cast ${ABILITIES[i.castAbility]?.name ?? ''}`, 'cast'];
  if (i.down) return ['Knocked down', 'hurt'];
  if (i.stunned) return [i.grounded ? 'Hit' : 'Hit, in the air', 'hurt'];
  if (i.travel) return [i.travel[0].toUpperCase() + i.travel.slice(1), 'travel'];
  if (!i.grounded) return [i.flipFrame >= 0 ? 'Flip' : 'In the air', 'air'];
  if (i.landFrame < 12) return ['Landing', 'land'];
  if (i.stow > 0 && i.stow < 1) return ['Weapon away/out', 'other'];
  const v = Math.abs(m.speed);
  if (v < 0.05) return ['Standing', 'idle'];
  const name = v < 2.2 ? 'Walk' : v < 4.5 ? 'Jog' : v <= MOVE.runSpeed + 0.2 ? 'Run' : 'Sprint';
  return [name, 'move'];
}

// ---------- the subject ----------

const params = new URLSearchParams(location.search);
const setOf = (w: string): string => params.get(`${w}Moves`) ?? HERO_MOVE_SETS[w] ?? 'keyed';

export const heroSubject: Subject = {
  id: 'hero',
  name: 'Hero',
  group: 'Heroes',
  blurb: NEW_LOOK ? 'The player, in the made body (new look)' : 'The player, box body (classic look)',
  options: [
    {
      id: 'weapon',
      label: 'Weapon',
      value: '0',
      choices: WEAPONS.map((w, i) => ({ value: String(i), label: w.title })),
    },
  ],
  anims(): AnimDef[] {
    return SCENARIOS.map((s) => ({ id: s.id, label: s.label, group: s.group, frames: s.frames, fps: 60, loop: true, note: s.weapon !== undefined ? WEAPONS[s.weapon]?.title : undefined }));
  },
  async ready() {
    await (madeHeroNow() ? Promise.resolve() : madeHero()?.catch(() => null));
  },
  take(animId: string, opts: Options): Take {
    return new HeroTake(scenario(animId), Number(opts.weapon ?? 0));
  },
  // A film with a weapon of its own (the sword combo) plays it whatever the picker says.
  optionsFor: (animId: string, opts: Options): Options => (SCENARIOS.find((s) => s.id === animId)?.weapon !== undefined ? {} : { weapon: opts.weapon ?? '0' }),
  source(): Source {
    const made = !!madeHeroNow();
    const sets = (['sword', 'club'] as const).map((w) => `${w}: ${setOf(w)}`).join(', ');
    return {
      system: [
        'Procedural: every pose is worked out in code, a pure function of a PoseInput (what the rules say the body is doing on a frame: speed, heading, which swing and which frame of it, a jump\'s rise, a hit) — `poseHumanoid` in src/render/detail/humanoid.ts.',
        'On top of that the stateful Hero (src/render/character.ts) eases between states (Inertia), holds planted feet where they were put down (holdFeet), draws and sheathes the weapon, closes made hands round what they hold (gripHands), and draws trails and the bowstring.',
        'The library plays the films in src/render/detail/scenarios.ts (the rules\' frame counts, speeds and timings, frame by frame at 60 fps) through that same Hero, exactly as /animations.html does.',
        made
          ? `This is the new look's made body (madeHero.ts, src/render/assets/models/hero.glb, rig measured by fit.ts): its walk and run upper body come from Meshy's captured cycles (mocap.ts), and some combo swings are animation-library clips retargeted bone for bone (retarget.ts; which clip each weapon's combo plays: moves.ts — sets in use: ${sets}; 'keyed' means the code keyframes in swings.ts). A note on a swing that plays a clip may mean changing the clip choice, its cut (parts/from/to) or the retarget rather than swings.ts.`
          : 'This is the classic look\'s box hero (src/content/creatures/hero.ts): every move comes from the code keyframes.',
      ].join(' '),
      files: [
        { path: 'src/render/detail/humanoid.ts', what: 'poseHumanoid: every pose (gait, swings, actions, casts, hits, travel) from a PoseInput' },
        { path: 'src/render/detail/swings.ts', what: 'weapon swing keyframes per weapon and combo step, AIR_SWINGS (jump attacks)' },
        { path: 'src/render/detail/gait.ts', what: 'stride length, duty factor, planted feet at any speed and heading (BOX_STRIDE, MADE_STRIDE)' },
        { path: 'src/render/detail/body.ts', what: 'limb handles, two-bone IK, axis conventions' },
        { path: 'src/render/character.ts', what: 'Hero: transitions (Inertia), foot holds, weapon draw/sheathe, grips, trails, bowstring' },
        { path: 'src/render/detail/stow.ts', what: 'where weapons are put away on the body' },
        ...(made
          ? [
              { path: 'src/render/detail/mocap.ts', what: "the made body's captured walk/run cycles" },
              { path: 'src/render/detail/moves.ts', what: 'which library clip each weapon combo plays (or keyed)' },
              { path: 'src/render/detail/retarget.ts', what: 'how a library clip is baked onto the made body' },
              { path: 'src/render/detail/fit.ts', what: 'made body rig, palms and fingers, gripHands' },
            ]
          : []),
        { path: 'src/render/detail/scenarios.ts', what: 'the films: what the rules report per frame (do not change these to fix a pose)' },
        { path: 'src/content/creatures/hero.ts', what: 'the box rig: joints, parts, weapons' },
        { path: 'shared/*.json, src/tuning.ts', what: "the rules' frame counts (startup/active/recovery): changing them is a rules change in TS and Rust together" },
      ],
      conventions:
        "Model space: x to the body's left, y up, z ahead; the ground is y = 0. A bone hangs down its parent's -Y at rest. Arms: yaw about +Y, then pitch about +X (0 hangs down, -90° points forward, -180° straight up), then twist; elbows bend the forearm forward with negative X. Legs: pitch about +X (negative swings forward), spread about +Z, twist about +Y; knees bend the shin back with positive X; feet: positive pitch points the toes. Torso and hips: positive pitch leans forward, positive yaw turns left. Joints named @sword/@club/@staff/@bow/@arrow are what the hands hold (placed by gripHands and stow.ts).",
      checks: [
        { command: 'npx playwright test tests/integration/animation.spec.ts', what: 'planted feet, floor clearance, joint limits, trails on the blade, the bowstring, grips' },
        ...(made ? [{ command: 'npx playwright test tests/integration/retarget.spec.ts', what: 'library clips held to their source' }] : []),
      ],
    };
  },
  animSource(animId: string, opts: Options): string {
    const s = scenario(animId);
    const w = s.weapon ?? Number(opts.weapon ?? 0);
    const bits = [`film '${animId}' in src/render/detail/scenarios.ts (${s.frames} frames)`];
    const fights = s.group === 'Fighting';
    if (fights) {
      const name = HERO_WEAPONS[w];
      const set = setOf(name);
      const clipNote = madeHeroNow() && HERO_MOVES[name]?.[set] ? `; on the made body the ${name} combo plays clip set '${set}' (moves.ts)` : `; ${name} swings are keyframes in swings.ts`;
      bits.push(`weapon ${WEAPONS[w]?.name ?? name}${clipNote}`);
    }
    return bits.join(', ');
  },
};
