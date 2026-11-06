import * as THREE from 'three';
import { actorKind, actorKindIds } from '../../../content/actors';
import { JellyCrowd } from '../../../render/creatures/jelly';
import { bindWorlds } from '../../../render/creatures/clips';
import { getSpecies, speciesIds } from '../../../render/creatures/registry';
import { MATRIX_STRIDE, type Clip, type SpeciesDef } from '../../../render/creatures/species';
import { readBones, sideOf, writeBones } from '../pose';
import type { AnimDef, Bone, FrameInfo, Options, Phase, Posable, Snapshot, Source, Subject, Take } from '../types';

// Species in the library: bodies the crowd draws from baked clips (src/species/): the slimes in
// every size (as jelly: src/render/creatures/jelly.ts), and the far-away bodies of the
// battlefield's crowds. A clip is a matrix per joint per frame; here each frame is turned back into
// joints you can see and move, with the species' boxes hung off them.

const ACTOR_KINDS = actorKindIds().map((id) => actorKind(id));

const _m = new THREE.Matrix4();
const _w = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

/** A species' skeleton as groups, its boxes hung off them, posed from a clip's matrices. */
class SpeciesBody implements Posable {
  readonly root = new THREE.Group();
  readonly space: THREE.Object3D;
  readonly bones: Bone[];
  private groups: THREE.Group[] = [];
  readonly boxes: THREE.Mesh[] = [];
  private bind: THREE.Matrix4[];

  constructor(
    readonly def: SpeciesDef,
    scale: number,
    colour: (box: SpeciesDef['proxy'][number]) => number,
  ) {
    this.root.scale.setScalar(scale);
    this.space = this.root;
    this.bind = bindWorlds(def.joints);
    def.joints.forEach((j) => {
      const g = new THREE.Group();
      g.name = j.name;
      g.position.set(...j.pos);
      g.quaternion.set(...j.rot);
      (j.parent >= 0 ? this.groups[j.parent] : this.root).add(g);
      this.groups.push(g);
    });
    const inv = this.bind.map((m) => m.clone().invert());
    for (const b of def.proxy) {
      const mat = new THREE.MeshLambertMaterial({ color: colour(b) });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...b.size), mat);
      // The box sits in the species' bind space; hung off its joint, it keeps that place.
      _m.compose(_p.set(...b.pos), _q.set(...b.rot), _s.set(1, 1, 1));
      _w.multiplyMatrices(inv[b.joint], _m).decompose(mesh.position, mesh.quaternion, mesh.scale);
      mesh.castShadow = true;
      this.groups[b.joint].add(mesh);
      this.boxes.push(mesh);
    }
    this.bones = def.joints.map((j, i) => ({
      name: j.name,
      object: this.groups[i],
      parent: j.parent >= 0 ? def.joints[j.parent].name : null,
      side: sideOf(j.name),
    }));
  }

  /** The joints' own transforms on a frame of a clip (bind space, from the baked matrices). */
  locals(clip: Clip, frame: number): Record<string, number[]> {
    const n = this.def.joints.length;
    const f = Math.max(0, Math.min(clip.frames - 1, frame));
    const world: THREE.Matrix4[] = [];
    const out: Record<string, number[]> = {};
    for (let j = 0; j < n; j++) {
      const at = (f * n + j) * MATRIX_STRIDE;
      const e = clip.matrices;
      // Baked: world times inverse bind. Times the bind again, it's the joint's world.
      _m.set(e[at], e[at + 1], e[at + 2], e[at + 3], e[at + 4], e[at + 5], e[at + 6], e[at + 7], e[at + 8], e[at + 9], e[at + 10], e[at + 11], 0, 0, 0, 1);
      world[j] = new THREE.Matrix4().multiplyMatrices(_m, this.bind[j]);
      const p = this.def.joints[j].parent;
      const local = p >= 0 ? new THREE.Matrix4().copy(world[p]).invert().multiply(world[j]) : world[j];
      local.decompose(_p, _q, _s);
      out[this.def.joints[j].name] = [_p.x, _p.y, _p.z, _q.x, _q.y, _q.z, _q.w, _s.x, _s.y, _s.z];
    }
    return out;
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

interface Look {
  kind: string | null;
  scale: number;
  jelly: boolean;
  palette?: { teamA: number; teamB: number };
}

class SpeciesTake implements Take {
  readonly root = new THREE.Group();
  readonly body: SpeciesBody;
  readonly space: THREE.Object3D;
  readonly bones: Bone[];
  readonly frames: number;
  readonly fps: number;
  readonly loop: boolean;
  readonly phases: Phase[];
  readonly framing;
  readonly baked: number;
  private poses: Array<Record<string, number[]>> = [];
  private jelly: JellyCrowd | null = null;
  private clipIndex: number;

  constructor(
    readonly def: SpeciesDef,
    readonly clip: Clip,
    readonly look: Look,
    private readonly colour: (box: SpeciesDef['proxy'][number]) => number,
  ) {
    this.body = new SpeciesBody(def, look.scale, colour);
    this.root.add(this.body.root);
    this.space = this.body.root;
    this.bones = this.body.bones;
    this.frames = clip.frames;
    this.fps = clip.fps;
    this.loop = clip.loop;
    this.clipIndex = def.clips.indexOf(clip);
    for (let f = 0; f < clip.frames; f++) this.poses.push(this.body.locals(clip, f));
    this.baked = clip.frames;
    this.phases = speciesPhases(this.poses, clip, def.joints[0].name);
    const h = def.height * look.scale;
    this.framing = { target: [0, Math.max(0.25, h * 0.5), 0] as [number, number, number], distance: Math.max(2.4, h * 4.4), height: h };
    if (look.jelly && look.kind) {
      // The jelly, drawn by the game's own crowd code from the same clip.
      const jelly = actorKind(look.kind).look;
      this.jelly = new JellyCrowd(def, 1, { inside: jelly?.inside, crown: jelly?.crown, palette: look.palette, scale: look.scale });
      this.jelly.place(0, 0, 0, 0, 0);
      this.root.add(this.jelly.group);
      for (const m of this.body.boxes) m.visible = false;
    }
  }

  bake(): boolean {
    return true;
  }

  show(frame: number): void {
    const f = Math.max(0, Math.min(this.frames - 1, Math.round(frame)));
    writeBones(this.bones, this.poses[f]);
    if (this.jelly) {
      this.jelly.animate(0, this.clipIndex, f / this.fps, 0);
      this.jelly.flush();
    }
  }

  /** Correcting a pose, the boxes stand in for the jelly (which only plays clips as they are). */
  setEditing(on: boolean): void {
    if (!this.jelly) return;
    this.jelly.group.visible = !on;
    for (const m of this.body.boxes) m.visible = on;
  }

  snapshot(frame: number): Snapshot {
    const f = Math.max(0, Math.min(this.frames - 1, Math.round(frame)));
    return { joints: Object.fromEntries(Object.entries(this.poses[f]).map(([k, v]) => [k, [...v]])) };
  }

  capture(): Snapshot {
    return this.body.capture();
  }

  apply(s: Snapshot): void {
    this.body.apply(s);
  }

  info(frame: number): FrameInfo {
    const f = Math.max(0, Math.min(this.frames - 1, Math.round(frame)));
    const root = this.poses[f][this.def.joints[0].name];
    return {
      line: `${this.clip.name} ${f + 1}/${this.frames}${root && root[1] > 0.01 ? ` · ${(root[1] * this.look.scale).toFixed(2)} m up` : ''}`,
      detail: { clip: this.clip.name, frame: f, fps: this.fps, loop: this.loop, t: Math.round((f / Math.max(1, this.frames - 1)) * 1000) / 1000 },
    };
  }

  ground(): { x: number; z: number; y: number; water: number | null; floor: boolean } {
    return { x: 0, z: 0, y: 0, water: null, floor: true };
  }

  ghost(): Posable {
    return new SpeciesBody(this.def, this.look.scale, this.colour);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.jelly?.dispose();
  }
}

/** Bands: off the ground (the root lifted), and the rest of the clip. */
function speciesPhases(poses: Array<Record<string, number[]>>, clip: Clip, root: string): Phase[] {
  const out: Phase[] = [];
  let cur: Phase | null = null;
  poses.forEach((p, f) => {
    const up = (p[root]?.[1] ?? 0) > 0.02;
    const label = up ? 'Off the ground' : clip.name[0].toUpperCase() + clip.name.slice(1);
    const kind = up ? 'air' : clip.loop ? 'idle' : 'other';
    if (cur && cur.label === label) cur.to = f;
    else out.push((cur = { from: f, to: f, label, kind }));
  });
  return out;
}

// ---------- the subjects ----------

const SLIME_SIZES = [
  { value: 'slimelet', label: 'Slimelet' },
  { value: 'slime', label: 'Slime' },
  { value: 'great-slime', label: 'Great' },
  { value: 'slime-monarch', label: 'Monarch' },
];

/** Which of an actor's moments play a clip ("hop: move, chase, call…"), from shared/actors.json. */
function usesOf(clip: string): string[] {
  const uses = new Set<string>();
  for (const k of ACTOR_KINDS) if (k.species === 'slime') for (const [moment, c] of Object.entries(k.clips ?? {})) if (c === clip) uses.add(moment);
  return [...uses];
}

const CLIP_LABELS: Record<string, string> = {
  idle: 'Idle',
  hop: 'Hop',
  die: 'Die',
  windup: 'Wind-up (before the slam)',
  leap: 'Leap and slam',
  gather: 'Gather the pack (cast)',
  dazed: 'Dazed',
  run: 'Run',
  attack: 'Attack',
  down: 'Knocked down',
  walk: 'Walk',
  sprint: 'Sprint',
  cast: 'Cast',
  air: 'In the air',
};
const label = (c: string) => CLIP_LABELS[c] ?? c.replace(/(\d+)$/, ' $1').replace(/^./, (x) => x.toUpperCase());

function speciesAnims(id: string): AnimDef[] {
  const def = getSpecies(id);
  // Loops first, then the ones that play once (each in the order the species lists them).
  const clips = [...def.clips.filter((c) => c.loop), ...def.clips.filter((c) => !c.loop)];
  return clips.map((c) => {
    const uses = id === 'slime' ? usesOf(c.name) : [];
    return {
      id: c.name,
      label: label(c.name),
      group: c.loop ? 'Loops' : 'Once',
      frames: c.frames,
      fps: c.fps,
      loop: c.loop,
      note: uses.length ? `Plays for: ${uses.join(', ')}` : undefined,
    };
  });
}

const slimeSubject: Subject = {
  id: 'slime',
  name: 'Slime',
  group: 'Mobs',
  blurb: 'Jelly slimes, every size',
  options: [
    { id: 'size', label: 'Size', value: 'slime', choices: SLIME_SIZES },
    {
      id: 'look',
      label: 'Look',
      value: 'jelly',
      choices: [
        { value: 'jelly', label: 'Jelly' },
        { value: 'box', label: 'Boxes' },
      ],
    },
  ],
  anims: () => speciesAnims('slime'),
  take(animId: string, opts: Options): Take {
    const def = getSpecies('slime');
    const kind = ACTOR_KINDS.find((k) => k.id === (opts.size ?? 'slime')) ?? ACTOR_KINDS.find((k) => k.id === 'slime')!;
    const clip = def.clips.find((c) => c.name === animId) ?? def.clips[0];
    const palette = kind.palette;
    const look: Look = { kind: kind.id, scale: kind.scale ?? 1, jelly: opts.look === 'jelly', palette };
    return new SpeciesTake(def, clip, look, (b) => (b.mat === 1 && palette ? palette.teamA : b.color));
  },
  source: (): Source => ({
    system:
      "Baked clips: each clip is authored in code as a function of (joint, frame) returning a joint's offset from its bind pose (position, rotation, scale), then baked to a matrix per joint per frame (`bakeAuthored` in src/render/creatures/clips.ts) and drawn by the crowd shader. A slime's motion is almost all squash and stretch: scale on `core` and `top`, the root lifted for hops and leaps, the buds sliding out. Every size shares the same clips, scaled (shared/actors.json). The game draws them as jelly over the same skeleton (src/render/creatures/jelly.ts, which lifts each frame so the jelly's base sits on the ground); the Boxes look shows the boxes the clips move.",
    files: [
      { path: 'src/render/creatures/builtin/slime.ts', what: 'the skeleton, its boxes, and every clip (idle, hop, die, windup, leap, gather, dazed)' },
      { path: 'src/render/creatures/jelly.ts', what: 'the jelly drawn over the same joints, faces by clip' },
      { path: 'src/render/creatures/clips.ts', what: 'bakeAuthored: how a clip function becomes matrices' },
      { path: 'shared/actors.json', what: "which clip plays for which of a slime's moments (move, chase, windup, leap, …), sizes" },
      { path: 'shared/behaviours.json', what: "the leap's gait (apex height, when it leaves and meets the ground): the rules; the leap clip matches it" },
    ],
    conventions:
      "Joints: root (on the ground), core (the body's middle, scaled for squash), top, budL, budR. In bakeAuthored a pose returns pos (metres, in the parent's space), rot (quaternion x, y, z, w) and scale. The library's numbers are in the slime's own space at size 1 (the sizes are scaled copies).",
    checks: [
      { command: 'npx playwright test tests/integration/slime.spec.ts', what: 'slime behaviour and clips' },
      { command: 'npx vitest run tests/unit/species.test.ts', what: 'species format and baking' },
    ],
  }),
  animSource: (animId) =>
    `clip '${animId}' in src/render/creatures/builtin/slime.ts (bakeAuthored)${usesOf(animId).length ? `, played for ${usesOf(animId).join(', ')} (shared/actors.json)` : ''}`,
};

function crowdSubject(id: string, name: string, blurb: string, file: string, made: string): Subject {
  return {
    id: `crowd-${id}`,
    name,
    group: 'Crowd',
    blurb,
    options: [],
    anims: () => speciesAnims(id),
    take(animId: string): Take {
      const def = getSpecies(id);
      const clip = def.clips.find((c) => c.name === animId) ?? def.clips[0];
      return new SpeciesTake(def, clip, { kind: null, scale: 1, jelly: false }, (b) => b.color);
    },
    source: (): Source => ({
      system: `Baked clips drawn by the crowd shader (src/render/creatures/crowd.ts) for bodies seen from afar, many at once. ${made}`,
      files: [
        { path: file, what: 'the skeleton, its boxes and its clips' },
        { path: 'src/render/creatures/clips.ts', what: 'baking clips to matrices' },
        { path: 'src/render/creatures/crowd.ts', what: 'drawing them' },
      ],
      checks: [{ command: 'npx vitest run tests/unit/species.test.ts', what: 'species format and baking' }],
    }),
    animSource: (animId) => `clip '${animId}' in ${file}`,
  };
}

/** What the library says of each built-in crowd body; a creature with a folder of its own is described from its folder. */
const BUILT_IN: Readonly<Record<string, readonly [name: string, blurb: string, made: string]>> = {
  hero: [
    'Hero, far away',
    'The crowd’s cut of the hero',
    "This one is the hero's own poses sampled: the clips (HERO_CLIPS in src/render/creatures/heroBody.ts) say what the hero is doing along each, and the close-up pose code (humanoid.ts) is run to bake them (src/render/creatures/fromRig.ts), so fixing the hero's close-up animation fixes these too.",
  ],
  fighter: ['Fighter', 'Battlefield crowd; townsfolk at a distance', 'Its four clips are authored directly as joint turns (bakeAuthored).'],
  quadruped: ['Four-legged beast', 'A test beast: four leg chains and a tail', 'Its clips are authored as joint turns per frame.'],
};

/** A crowd body's subject, built in or a creature's folder's (src/render/creatures/folders.ts). */
function crowdSubjectOf(id: string): Subject {
  const known = BUILT_IN[id];
  if (known) return crowdSubject(id, known[0], known[1], `src/render/creatures/builtin/${id}.ts`, known[2]);
  const name = id.charAt(0).toUpperCase() + id.slice(1);
  return crowdSubject(
    id,
    `${name}, far away`,
    `The ${id}'s crowd body`,
    `src/render/creatures/${id}/body.ts`,
    `A creature with a folder of its own: its body and clips are src/render/creatures/${id}/, its kinds, attacks and brains content/creatures/${id}/.`,
  );
}

/** The slime, and every other body the crowd draws (src/render/creatures/registry.ts), so a creature added with a body of its own has one here too. */
export const speciesSubjects: Subject[] = [
  slimeSubject,
  ...speciesIds()
    .filter((id) => id !== 'slime')
    .map(crowdSubjectOf),
];

/** Correcting a jelly slime: show its boxes while the pose is being moved. */
export function speciesEditing(take: Take, on: boolean): void {
  if (take instanceof SpeciesTake) take.setEditing(on);
}
