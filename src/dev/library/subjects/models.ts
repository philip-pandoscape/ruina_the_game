import * as THREE from 'three';
import { buildAnimal, restartIdles as restartAnimals, type AnimalModel } from '../../../render/models/animals';
import { buildVillager, restartIdles as restartVillagers, villagerReady, type VillagerModel } from '../../../render/models/villagers';
import { buildMount, type MountModel } from '../../../render/models/mounts';
import { MOUNTS } from '../../../content/vehicles';
import { ANIMALS } from '../../../content/farming';
import { NodeTrack, readBones, sideOf, writeBones } from '../pose';
import type { AnimDef, Bone, FrameInfo, Options, Phase, Posable, Snapshot, Source, Subject, Take } from '../types';
import { EMBERHOLM } from '../../../engine/zone';

// Things built as models with an animate() of their own (src/render/models/): the farm animals,
// Emberholm's townsfolk and the mounts. Their moving parts are named pivots (body, head, armL,
// hipFL…), which become the bones here; each animation is a few seconds of animate() run at 60 fps
// from a fresh build, so a frame is the same frame after every reload.

const FPS = 60;

interface Model {
  root: THREE.Group;
  step(dt: number, t: number): void;
}

/** The named pivots under a model: its bones (a repeated name gets L and R by which side it's on). */
function pivots(root: THREE.Object3D): Bone[] {
  const found: Array<{ o: THREE.Object3D; name: string }> = [];
  root.traverse((o) => {
    if (o === root || (o as THREE.Mesh).isMesh || !o.name || o.name.startsWith('animal:') || o.name.startsWith('villager:')) return;
    found.push({ o, name: o.name });
  });
  const counts = new Map<string, number>();
  for (const f of found) counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
  const used = new Set<string>();
  const nameOf = new Map<THREE.Object3D, string>();
  for (const f of found) {
    let n = f.name;
    if ((counts.get(n) ?? 0) > 1) n = `${n}${f.o.position.x >= 0 ? 'L' : 'R'}`;
    while (used.has(n)) n = `${n}'`;
    used.add(n);
    nameOf.set(f.o, n);
  }
  return found.map(({ o }) => {
    let p = o.parent;
    while (p && p !== root && !nameOf.has(p)) p = p.parent;
    const name = nameOf.get(o)!;
    return { name, object: o, parent: p && nameOf.has(p) ? nameOf.get(p)! : null, side: sideOf(name) };
  });
}

class ModelBody implements Posable {
  readonly root: THREE.Object3D;
  readonly space: THREE.Object3D;
  readonly bones: Bone[];
  constructor(readonly model: Model) {
    this.root = model.root;
    this.space = model.root;
    this.bones = pivots(model.root);
  }
  apply(s: Snapshot): void {
    writeBones(this.bones, s.joints);
  }
  capture(): Snapshot {
    return { joints: readBones(this.bones) };
  }
  dispose(): void {
    this.root.removeFromParent();
  }
}

/** A few seconds of a model's animate(), every frame kept. */
class ModelTake implements Take {
  readonly root = new THREE.Group();
  readonly body: ModelBody;
  readonly space: THREE.Object3D;
  readonly bones: Bone[];
  readonly fps = FPS;
  readonly loop = true;
  readonly phases: Phase[];
  private track: NodeTrack;
  private kept: Float32Array[] = [];
  private index = new Map<string, number>();

  constructor(
    private readonly make: () => Model,
    readonly frames: number,
    readonly state: (f: number) => { line: string; detail: Record<string, unknown>; phase: [string, string] },
    readonly framing: Take['framing'],
  ) {
    this.body = new ModelBody(make());
    this.root.add(this.body.root);
    this.space = this.body.root;
    this.bones = this.body.bones;
    this.track = new NodeTrack(this.body.root);
    this.track.nodes.forEach((n, i) => this.index.set(n.uuid, i));
    this.phases = [];
    let cur: Phase | null = null;
    for (let f = 0; f < frames; f++) {
      const [label, kind] = state(f).phase;
      if (cur && cur.label === label) cur.to = f;
      else this.phases.push((cur = { from: f, to: f, label, kind }));
    }
  }

  get baked(): number {
    return this.kept.length;
  }

  bake(budget: number): boolean {
    for (let i = 0; i < budget && this.kept.length < this.frames; i++) {
      const f = this.kept.length;
      this.body.model.step(f === 0 ? 0 : 1 / FPS, f / FPS);
      this.kept.push(this.track.capture());
    }
    return this.kept.length >= this.frames;
  }

  show(frame: number): void {
    const f = Math.max(0, Math.min(this.frames - 1, Math.round(frame)));
    if (f >= this.kept.length) this.bake(f - this.kept.length + 1);
    this.track.apply(this.kept[f]);
  }

  snapshot(frame: number): Snapshot {
    const f = Math.max(0, Math.min(this.frames - 1, Math.round(frame)));
    if (f >= this.kept.length) {
      // Working ahead moves the body: put the shown frame back after.
      const live = readBones(this.bones);
      this.bake(f - this.kept.length + 1);
      writeBones(this.bones, live);
    }
    const buf = this.kept[f];
    const S = NodeTrack.STRIDE;
    const joints: Record<string, number[]> = {};
    for (const b of this.bones) {
      const i = this.index.get(b.object.uuid);
      if (i !== undefined) joints[b.name] = Array.from(buf.subarray(i * S, i * S + 10));
    }
    return { joints };
  }

  capture(): Snapshot {
    return this.body.capture();
  }

  apply(s: Snapshot): void {
    this.body.apply(s);
  }

  info(frame: number): FrameInfo {
    const s = this.state(frame);
    return { line: s.line, detail: s.detail };
  }

  ground(): { x: number; z: number; y: number; water: number | null; floor: boolean } {
    return { x: 0, z: 0, y: 0, water: null, floor: true };
  }

  ghost(): Posable {
    return new ModelBody(this.make());
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}

// ---------- farm animals ----------

/** An animal's name, grown and young (shared/farming.json). */
const animalNames = (id: string): [string, string] => {
  const a = ANIMALS.find((x) => x.id === id);
  return [a?.name ?? id, a?.young ?? id];
};

function animalModel(id: string, young: boolean, hungry: boolean, ready: boolean): Model {
  restartAnimals();
  const m: AnimalModel = buildAnimal(id, young ? 0 : 1);
  return { root: m.root, step: (dt, t) => m.animate(dt, { time: t, hungry, ready }) };
}

const ANIMAL_ANIMS: Array<{ id: string; label: string; hungry: boolean; ready: boolean; note: string }> = [
  { id: 'idle', label: 'Content', hungry: false, ready: false, note: 'Fed, nothing to collect: grazing, pecking, chewing' },
  { id: 'hungry', label: 'Hungry', hungry: true, ready: false, note: 'Wants feeding: head up' },
  { id: 'ready', label: 'Ready to collect', hungry: false, ready: true, note: 'An egg, a fleece or milk to collect (adults)' },
];

function animalSubject(id: string): Subject {
  const seconds = 14;
  return {
    id,
    name: animalNames(id)[0],
    group: 'Creatures',
    blurb: `Farm animal (young: ${animalNames(id)[1].toLowerCase()})`,
    options: [
      {
        id: 'age',
        label: 'Age',
        value: 'adult',
        choices: [
          { value: 'adult', label: 'Adult' },
          { value: 'young', label: animalNames(id)[1] },
        ],
      },
    ],
    anims: () => ANIMAL_ANIMS.map((a) => ({ id: a.id, label: a.label, group: 'Idles', frames: seconds * FPS, fps: FPS, loop: true, note: a.note })),
    take(animId: string, opts: Options): Take {
      const a = ANIMAL_ANIMS.find((x) => x.id === animId) ?? ANIMAL_ANIMS[0];
      const young = opts.age === 'young';
      const size = id === 'cow' ? 1.5 : id === 'sheep' ? 1 : 0.45;
      const h = size * (young ? 0.7 : 1);
      return new ModelTake(
        () => animalModel(id, young, a.hungry, a.ready),
        seconds * FPS,
        (f) => ({
          line: `${(f / FPS).toFixed(2)} s into its idle`,
          detail: { time: f / FPS, hungry: a.hungry, ready: a.ready, young },
          phase: [a.label, 'idle'],
        }),
        { target: [0, h * 0.45, 0], distance: Math.max(1.6, h * 3.4), height: h },
      );
    },
    source: (): Source => ({
      system: `Built from soft blocks on named pivots (body, head, tail, legs) and kept alive by animate(dt, {time, hungry, ready}) in src/render/models/animals.ts: a long idle cycle worked out from the time (pecking, grazing, chewing, tail swishing), the head lifted when hungry. Each animal's idle starts at its own point of the cycle in the game; the library starts them all at the start.`,
      files: [
        { path: 'src/render/models/animals.ts', what: `the ${id}'s build and its animate()` },
        { path: 'src/render/models/kit.ts', what: 'the building blocks and pivot()' },
      ],
      conventions: 'Faces +Z, origin on the ground under its middle. Pivots turn with rotation.x/y/z set in animate() from the time (seconds).',
      checks: [{ command: 'npx playwright test tests/integration/models.spec.ts', what: 'the models build and stay in budget' }],
    }),
    animSource: (animId) =>
      `animate() of the ${id} in src/render/models/animals.ts (${animId === 'hungry' ? 'hungry: true' : animId === 'ready' ? 'ready: true' : 'content'})`,
  };
}

// ---------- townsfolk ----------

const NPCS = EMBERHOLM.npcs;

function villagerModel(id: string, talking: boolean): Model {
  restartVillagers();
  const m: VillagerModel = buildVillager(id, NPCS.find((n) => n.id === id)?.look);
  return { root: m.root, step: (dt, t) => m.animate(dt, { time: t, talking }) };
}

function villagerSubject(id: string): Subject {
  const npc = NPCS.find((n) => n.id === id);
  const seconds = 12;
  return {
    id: `villager-${id}`,
    name: npc?.name ?? id,
    group: 'Townsfolk',
    blurb: npc?.title ?? 'Townsfolk',
    options: [],
    anims: () => [
      { id: 'idle', label: 'Idle', group: 'Standing', frames: seconds * FPS, fps: FPS, loop: true, note: 'Breathing, looking about, now and then a gesture' },
      { id: 'talk', label: 'Talking', group: 'Standing', frames: seconds * FPS, fps: FPS, loop: true, note: 'While you talk to them' },
    ],
    // One in a made body is filmed in it, not the built one standing in while it loads.
    ready: () => villagerReady(id, npc?.look),
    take(animId: string): Take {
      const talking = animId === 'talk';
      return new ModelTake(
        () => villagerModel(id, talking),
        seconds * FPS,
        (f) => ({
          line: `${(f / FPS).toFixed(2)} s${talking ? ', talking' : ''}`,
          detail: { time: f / FPS, talking },
          phase: [f < 0.5 * FPS && talking ? 'Turning to talk' : talking ? 'Talking' : 'Idle', talking ? 'other' : 'idle'],
        }),
        { target: [0, 1.05, 0], distance: 4.4, height: 1.8 },
      );
    },
    source: (): Source => ({
      system: npc?.look?.model
        ? `A made body (src/render/assets/models/${npc.look.model.files[0]}.glb) worn on the hero's rig, measured to it (src/render/detail/madeBody.ts, fit.ts): it stands as the hero stands at rest (poseHumanoid), and wearTownsperson's animate() in src/render/detail/madeTownsfolk.ts layers the townsfolk's own life on its joints - a sway, looking about, now and then a gesture, and talking with forearms raised (easing in over a moment). The built body (src/render/models/villagers.ts) stands in until it has loaded.`
        : 'Built like the box hero from rounded blocks: five merged meshes on pivots (legs, body, head, armL, armR) and animate(dt, {time, talking}) in src/render/models/villagers.ts breathes, looks about and gestures, more when talking (easing in over a moment). Each one may add its own touches (a prop that moves).',
      files: [
        ...(npc?.look?.model ? [{ path: 'src/render/detail/madeTownsfolk.ts', what: 'the made body posed and brought to life (wearTownsperson)' }] : []),
        { path: 'src/render/models/villagers.ts', what: `${npc?.name ?? id}'s build (const ${id}) and the shared animate() in villager()` },
        { path: 'shared/regions/emberholm.json', what: 'where they stand (npcs)' },
      ],
      conventions:
        'Faces +Z, origin at the feet. Arms hang from armL/armR pivots at the shoulders: rotation.x negative lifts the arm forward; rotation.z spreads it out (+ for the left).',
      checks: [{ command: 'npx playwright test tests/integration/models.spec.ts', what: 'the models build and stay in budget' }],
    }),
    animSource: (animId) => `animate() in villager() in src/render/models/villagers.ts (${animId === 'talk' ? 'talking: true' : 'talking: false'})`,
  };
}

// ---------- mounts ----------

function mountSubject(id: string): Subject {
  const def = MOUNTS.find((m) => m.id === id)!;
  const seconds = 6;
  const gaits: Array<{ id: string; label: string; speed: (t: number) => number; grounded?: (t: number) => boolean; note: string }> = [
    { id: 'stand', label: 'Standing', speed: () => 0, note: 'Standing still' },
    { id: 'walk', label: 'Walk', speed: () => def.walkSpeed, note: `${def.walkSpeed} m/s` },
    { id: 'run', label: 'Gallop', speed: () => def.runSpeed, note: `${def.runSpeed} m/s` },
    {
      id: 'speedUp',
      label: 'Walk to gallop and back',
      speed: (t) => (t < 1 ? 0 : t < 3 ? ((t - 1) / 2) * def.runSpeed : t < 4.5 ? def.runSpeed : Math.max(0, def.runSpeed * (1 - (t - 4.5) / 1.2))),
      note: 'Speeding up and slowing down',
    },
    { id: 'jump', label: 'Jump', speed: () => def.walkSpeed, grounded: (t) => !(t % 2 > 1 && t % 2 < 1.6), note: 'Leaving the ground: legs tucked' },
  ];
  return {
    id: `mount-${id}`,
    name: def.name,
    group: 'Mounts',
    blurb: `Mount: walk ${def.walkSpeed} m/s, gallop ${def.runSpeed} m/s`,
    options: [],
    anims: () => gaits.map((g) => ({ id: g.id, label: g.label, group: 'Gaits', frames: seconds * FPS, fps: FPS, loop: true, note: g.note }) satisfies AnimDef),
    take(animId: string): Take {
      const g = gaits.find((x) => x.id === animId) ?? gaits[0];
      const make = (): Model => {
        const m: MountModel = buildMount(def);
        return { root: m.root, step: (dt, t) => m.animate(dt, { speed: g.speed(t), grounded: g.grounded ? g.grounded(t) : true }) };
      };
      return new ModelTake(
        make,
        seconds * FPS,
        (f) => {
          const t = f / FPS;
          const v = g.speed(t);
          const up = g.grounded ? !g.grounded(t) : false;
          return {
            line: `${v.toFixed(1)} m/s${up ? ', in the air' : ''}`,
            detail: { speed: Math.round(v * 100) / 100, grounded: !up },
            phase: up ? ['In the air', 'air'] : v < 0.05 ? ['Standing', 'idle'] : v <= def.walkSpeed * 1.15 ? ['Walk', 'move'] : ['Gallop', 'move'],
          };
        },
        { target: [0, 1.0, 0], distance: 6, height: 2 },
      );
    },
    source: (): Source => ({
      system:
        'Built from soft blocks on pivots: four legs hang from hip pivots with a knee pivot halfway down (hipFL, kneeFL, …), a neck and head, a tail. animate(dt, {speed, grounded}) in src/render/models/mounts.ts runs a walk that blends into a gallop as speed rises, bobs the head, swishes the tail, and tucks the legs while airborne.',
      files: [
        { path: 'src/render/models/mounts.ts', what: 'the build and animate()' },
        { path: 'shared/vehicles.json', what: `the ${def.name.toLowerCase()}'s speeds and stride (mounts)` },
      ],
      conventions: 'Faces +Z, origin on the ground under the middle. Hips and knees swing about +X (rotation.x).',
      checks: [{ command: 'npx playwright test tests/integration/models.spec.ts', what: 'the models build and stay in budget' }],
    }),
    animSource: (animId) => `animate() in src/render/models/mounts.ts, driven at ${gaits.find((g) => g.id === animId)?.note ?? ''}`,
  };
}

export const modelSubjects: Subject[] = [
  ...ANIMALS.map((a) => animalSubject(a.id)),
  ...NPCS.map((n) => villagerSubject(n.id)),
  ...MOUNTS.map((m) => mountSubject(m.id)),
];
