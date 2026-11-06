import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { loadGltf } from '../../render/assets';
import { Body } from '../../render/detail/body';
import { wear } from '../../render/detail/fit';
import { madeHero, madeHeroNow, type MadeHero } from '../../render/detail/madeHero';
import { dressWeapons } from '../../render/detail/madeWeapons';
import { HERO_MOVES } from '../../render/detail/moves';
import { bake, JOINT, LIBRARIES, libraryOf, poseFromClip, RATE, type Baked, type Canon } from '../../render/detail/retarget';
import { DetailRig } from '../../render/detail/rig';
import { NodeTrack, readBones, sideOf, writeBones } from '../pose';
import type { AnimDef, Bone, FrameInfo, Options, Phase, Posable, Snapshot, Source, Subject, Take } from '../types';

// The retargeting check: a library clip on the made hero, baked and posed exactly as the game does it
// (src/render/detail/retarget.ts), beside the clip's own skeleton playing it as authored, every
// bone's direction on the hero measured against its source bone's and the feet against the ground,
// frame by frame, on the backdrop the check always had (a pale sky, a field with a metre grid).
// Library routes:
//   #/retarget/<file>:<Clip~Other>   a clip file in src/render/assets/models, clips end to end
//   ?url=/scratch/x.glb              any GLB instead of the file named
//   &mesh=/scratch/with-skin.glb     the source shown skinned (else its bones)
// The take on screen (window.__library.take()) measures any moment: measureAt(seconds) -> { mean,
// worst, bone, feet }, over `seconds`. tests/integration/retarget.spec.ts holds every move's clip
// (moves.ts) to it; the retarget-animation skill says how to use it.

const urls = import.meta.glob('../../render/assets/models/*.glb', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const fileUrl = (name: string): string | undefined => Object.entries(urls).find(([k]) => k.endsWith(`/${name}.glb`))?.[1];

type Gltf = { scene: THREE.Group; animations: THREE.AnimationClip[] };
/** Each file loaded once (its scene only read, by bake(); every take shows a copy of its own). */
const files = new Map<string, Promise<Gltf>>();
const loaded = new Map<string, Gltf>();
const load = (url: string): Promise<Gltf> => {
  let p = files.get(url);
  if (!p) {
    p = loadGltf(url).then((g) => {
      loaded.set(url, g);
      return g;
    });
    files.set(url, p);
  }
  return p;
};

/** Which file and clips an animation is: `<file>:<Clip~Other>`. */
const parse = (id: string): { file: string; clips: string[] } => {
  const at = id.lastIndexOf(':');
  return { file: id.slice(0, at), clips: id.slice(at + 1).split('~') };
};
const words = (clips: string[]) => clips.map((c) => c.replace(/_/g, ' ')).join(' + ');

/** Every clip the made hero's moves play (moves.ts), once each: what the check holds to its source. */
const MOVE_CLIPS: AnimDef[] = (() => {
  const out = new Map<string, AnimDef>();
  for (const [weapon, sets] of Object.entries(HERO_MOVES))
    for (const [set, moves] of Object.entries(sets))
      for (const m of moves) {
        if (!m) continue;
        const clips = [...new Set(m.parts.map((p) => p.clip))];
        const id = `${m.file}:${clips.join('~')}`;
        if (!out.has(id))
          out.set(id, {
            id,
            label: words(clips),
            group: `${weapon[0].toUpperCase()}${weapon.slice(1)} · ${set[0].toUpperCase()}${set.slice(1)}`,
            frames: 0,
            fps: RATE,
            loop: true,
            note: `${m.file}.glb`,
            tag: 'clip',
          });
      }
  return [...out.values()];
})();

const DIRECTED: Array<[Canon, Canon]> = [
  ['hips', 'spine1'],
  ['spine1', 'spine2'],
  ['spine2', 'spine3'],
  ['spine3', 'neck'],
  ['neck', 'head'],
  ['clavicleL', 'armL'],
  ['armL', 'forearmL'],
  ['forearmL', 'handL'],
  ['clavicleR', 'armR'],
  ['armR', 'forearmR'],
  ['forearmR', 'handR'],
  ['thighL', 'shinL'],
  ['shinL', 'footL'],
  ['footL', 'toeL'],
  ['thighR', 'shinR'],
  ['shinR', 'footR'],
  ['footR', 'toeR'],
];
const at = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
const _inv = new THREE.Matrix4();
const _p = new THREE.Vector3();

const LOCKED = new Set(['squash', 'eyes']);
const MINOR = /^(palm|fingers|fingertips|eyes|squash)/;

/** The made hero as the game builds it, the sword in its hand. */
class MadeBody implements Posable {
  readonly rig: DetailRig;
  readonly root = new THREE.Group();
  readonly space: THREE.Object3D;
  readonly bones: Bone[];

  constructor(made: MadeHero) {
    this.rig = new DetailRig(made.def);
    if (made.weapons) dressWeapons(this.rig, made.weapons);
    wear(this.rig, made.fitted);
    this.rig.showAttachment('sword');
    this.root.add(this.rig.root);
    this.space = this.rig.root;
    this.bones = made.def.joints.map((j) => ({
      name: j.name,
      object: this.rig.joint(j.name),
      parent: j.parent ?? null,
      side: sideOf(j.name),
      locked: LOCKED.has(j.name),
      minor: MINOR.test(j.name),
    }));
  }

  apply(s: Snapshot): void {
    writeBones(
      this.bones.filter((b) => !b.locked),
      s.joints,
    );
  }

  capture(): Snapshot {
    return { joints: readBones(this.bones) };
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}

interface Measured {
  mean: number;
  worst: number;
  bone: string;
  feet: number;
}

class RetargetTake implements Take {
  readonly root = new THREE.Group();
  readonly body: MadeBody;
  readonly space: THREE.Object3D;
  readonly bones: Bone[];
  readonly fps = RATE;
  readonly loop = true;
  readonly frames: number;
  readonly phases: Phase[] = [];
  readonly backdrop = 'retarget' as const;
  readonly framing = { target: [0, 0.95, 0] as [number, number, number], distance: 5.4, height: 1.8 };
  /** The clips' length end to end, seconds. */
  readonly seconds: number;
  /** The libraries whose skeletons it knows (retarget.ts LIBRARIES). */
  readonly libraries = Object.keys(LIBRARIES);
  /** The clips baked for the made hero, as the game bakes a move's. */
  readonly clip: Baked;
  private readonly hero: THREE.Group;
  private readonly pose: Body;
  private readonly src: THREE.Object3D;
  private readonly named = new Map<string, THREE.Object3D>();
  private readonly lib: ReturnType<typeof libraryOf>;
  private readonly srcRoot: THREE.Object3D | undefined;
  private readonly restRoot: THREE.Quaternion;
  private readonly rootStart: THREE.Vector3;
  private readonly mixer: THREE.AnimationMixer;
  private readonly clips: THREE.AnimationClip[];
  private readonly actions: THREE.AnimationAction[];
  private readonly track: NodeTrack;
  private readonly index = new Map<string, number>();
  /** The source's skeleton drawn as lines (when it isn't shown skinned): each node and its parent. */
  private readonly links: Array<[THREE.Object3D, THREE.Object3D]> = [];
  private lines: THREE.LineSegments | null = null;
  private kept: Array<{ buf: Float32Array; travel: [number, number]; m: Measured }> = [];
  private shownFrame = -1;

  constructor(
    private readonly made: MadeHero,
    source: Gltf,
    shown: Gltf | null,
    clipNames: string[],
  ) {
    this.clips = clipNames.map((n) => {
      const c = source.animations.find((a) => a.name === n);
      if (!c) throw new Error(`retarget: no clip ${n} (${source.animations.map((a) => a.name).join(', ')})`);
      return c;
    });
    // The clip baked for the made hero, as madeHero bakes a move's.
    this.clip = bake(
      source.scene,
      source.animations,
      clipNames.map((clip) => ({ clip })),
      { joints: made.fitted.joints, bind: made.fitted.bind },
    );
    // The hero, as the game builds it, a metre to the left.
    this.body = new MadeBody(made);
    this.pose = Body.of(this.body.rig);
    this.hero = this.body.root;
    this.hero.position.x = -1;
    this.root.add(this.hero);
    this.space = this.body.space;
    this.bones = this.body.bones;
    // The source a metre to the right: skinned if a model with the same skeleton was given, else its bones.
    this.src = cloneSkinned(shown ? shown.scene : source.scene);
    this.lib = libraryOf(this.src);
    this.src.position.x = 1;
    this.root.add(this.src);
    this.root.updateMatrixWorld(true);
    this.src.traverse((o) => this.named.set(o.name, o));
    // Its skeleton as lines from each node to its parent, from the hips out, in SkeletonHelper's
    // colours: a clip file's skeleton is plain nodes, not bones (no skin), so that helper draws none.
    if (!shown) {
      const hips = this.named.get(this.lib.bones.hips)!;
      hips.traverse((o) => o !== hips && o.parent && this.links.push([o.parent, o]));
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(this.links.length * 6), 3));
      geo.setAttribute(
        'color',
        new THREE.Float32BufferAttribute(
          this.links.flatMap(() => [0, 0, 1, 0, 1, 0]),
          3,
        ),
      );
      this.lines = new THREE.LineSegments(
        geo,
        new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, toneMapped: false, transparent: true }),
      );
      this.lines.renderOrder = 10;
      this.src.add(this.lines);
    }
    this.srcRoot = this.lib.root ? this.named.get(this.lib.root) : undefined;
    this.restRoot = this.srcRoot ? this.srcRoot.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
    this.rootStart = this.srcRoot ? this.srcRoot.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
    this.mixer = new THREE.AnimationMixer(this.src);
    this.actions = this.clips.map((c) => this.mixer.clipAction(c));
    this.seconds = this.clips.reduce((s, c) => s + c.duration, 0);
    this.frames = Math.floor(this.seconds * RATE) + 1;
    // The hero's frames are kept; the source is always posed by its own mixer, which only writes a
    // bone whose value has changed since it last wrote it, so nothing else may write its bones.
    this.track = new NodeTrack(this.hero);
    this.track.nodes.forEach((n, i) => this.index.set(n.uuid, i));
    // A band for each clip, end to end.
    let from = 0;
    this.clips.forEach((c, i) => {
      const to = i === this.clips.length - 1 ? this.frames - 1 : Math.min(this.frames - 1, Math.round((from / RATE + c.duration) * RATE) - 1);
      this.phases.push({ from, to, label: c.name.replace(/_/g, ' '), kind: i % 2 ? 'recover' : 'strike' });
      from = to + 1;
    });
  }

  private srcBone(c: Canon): THREE.Object3D {
    return this.named.get(this.lib.bones[c])!;
  }

  /** The source at a moment of its clips, laid end to end. */
  private poseSource(t: number): void {
    let s = Math.min(t, this.seconds - 1e-4);
    let i = 0;
    while (i < this.clips.length - 1 && s >= this.clips[i].duration) s -= this.clips[i++].duration;
    this.actions.forEach((a, j) => {
      a.enabled = j === i;
      if (j === i) a.play();
      else a.stop();
    });
    this.mixer.setTime(Math.min(s, this.clips[i].duration - 1e-4));
    this.src.updateMatrixWorld(true);
    if (this.lines) {
      const pos = this.lines.geometry.getAttribute('position') as THREE.BufferAttribute;
      const inv = _inv.copy(this.src.matrixWorld).invert();
      this.links.forEach(([a, b], k) => {
        _p.setFromMatrixPosition(a.matrixWorld).applyMatrix4(inv);
        pos.setXYZ(k * 2, _p.x, _p.y, _p.z);
        _p.setFromMatrixPosition(b.matrixWorld).applyMatrix4(inv);
        pos.setXYZ(k * 2 + 1, _p.x, _p.y, _p.z);
      });
      pos.needsUpdate = true;
      this.lines.geometry.computeBoundingSphere();
    }
  }

  /**
   * Poses both at a moment (seconds): how far the hero's bones point from the source's, in degrees
   * (the mean and the worst, and which), and its lower ankle against where it stands at rest (below
   * zero, a foot in the ground). As the check always measured: worked out with the take where the
   * world is still, then the frame on screen put back.
   */
  measureAt(t: number): Measured {
    const saved = this.root.position.clone();
    this.root.position.set(0, 0, 0);
    this.root.updateMatrixWorld(true);
    const m = this.poseAt(t);
    this.root.position.copy(saved);
    if (this.shownFrame >= 0) {
      const f = this.shownFrame;
      this.shownFrame = -1;
      this.show(f);
    }
    return m;
  }

  private poseAt(t: number): Measured {
    this.poseSource(t);
    this.pose.reset();
    poseFromClip(this.pose, this.clip, t);
    // Shown travelling as the source does (the game's rules carry the body; here, the clip's root).
    if (this.srcRoot) {
      const travel = at(this.srcRoot).sub(this.rootStart);
      this.hero.position.set(-1 + travel.x, 0, travel.z);
    }
    this.hero.updateMatrixWorld(true);
    const unturn = this.srcRoot ? this.restRoot.clone().multiply(this.srcRoot.getWorldQuaternion(new THREE.Quaternion()).invert()) : new THREE.Quaternion();
    const rig = this.body.rig;
    let sum = 0;
    let worst = 0;
    let bone = '';
    for (const [a, b] of DIRECTED) {
      const ds = at(this.srcBone(b))
        .sub(at(this.srcBone(a)))
        .applyQuaternion(unturn)
        .normalize();
      const dh = at(rig.joint(JOINT[b]))
        .sub(at(rig.joint(JOINT[a])))
        .normalize();
      const e = THREE.MathUtils.radToDeg(ds.angleTo(dh));
      sum += e;
      if (e > worst) {
        worst = e;
        bone = a;
      }
    }
    const ankle = Math.min(at(rig.joint('footL')).y, at(rig.joint('footR')).y) - this.made.fitted.feet.ankle;
    return { mean: sum / DIRECTED.length, worst, bone, feet: ankle };
  }

  get baked(): number {
    return this.kept.length;
  }

  bake(budget: number): boolean {
    if (this.kept.length >= this.frames) return true;
    const saved = this.root.position.clone();
    this.root.position.set(0, 0, 0);
    this.root.updateMatrixWorld(true);
    for (let i = 0; i < budget && this.kept.length < this.frames; i++) {
      const m = this.poseAt(this.kept.length / RATE);
      const travel: [number, number] = this.srcRoot ? [at(this.srcRoot).x - this.rootStart.x, at(this.srcRoot).z - this.rootStart.z] : [0, 0];
      this.kept.push({ buf: this.track.capture(), travel, m });
    }
    this.root.position.copy(saved);
    // The frame on screen put back.
    if (this.shownFrame >= 0) {
      const f = this.shownFrame;
      this.shownFrame = -1;
      this.show(f);
    }
    return this.kept.length >= this.frames;
  }

  private ensure(frame: number) {
    if (frame >= this.kept.length) this.bake(frame - this.kept.length + 1);
    return this.kept[frame];
  }

  show(frame: number): void {
    const f = Math.max(0, Math.min(this.frames - 1, Math.round(frame)));
    const k = this.ensure(f);
    this.poseSource(f / RATE);
    this.track.apply(k.buf);
    this.hero.position.set(-1 + k.travel[0], 0, k.travel[1]);
    // Kept in view: the take is moved back by however far the clip has carried them (the floor goes the other way).
    this.root.position.set(-k.travel[0], 0, -k.travel[1]);
    this.shownFrame = f;
  }

  snapshot(frame: number): Snapshot {
    const k = this.ensure(Math.max(0, Math.min(this.frames - 1, Math.round(frame))));
    const S = NodeTrack.STRIDE;
    const joints: Record<string, number[]> = {};
    for (const b of this.bones) {
      const i = this.index.get(b.object.uuid);
      if (i !== undefined) joints[b.name] = Array.from(k.buf.subarray(i * S, i * S + 10));
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
    const f = Math.max(0, Math.min(this.frames - 1, Math.round(frame)));
    const m = this.ensure(f).m;
    return {
      line: `${(f / RATE).toFixed(2)} s · bones ${m.mean.toFixed(2)}° off on average, ${m.worst.toFixed(2)}° at worst (${m.bone}) · lowest ankle ${(m.feet * 100).toFixed(1)} cm`,
      detail: { seconds: +(f / RATE).toFixed(3), mean: +m.mean.toFixed(3), worst: +m.worst.toFixed(3), bone: m.bone, feet: +m.feet.toFixed(4) },
    };
  }

  ground(frame: number): { x: number; z: number; y: number; water: number | null; floor: boolean } {
    const k = this.ensure(Math.max(0, Math.min(this.frames - 1, Math.round(frame))));
    return { x: k.travel[0], z: k.travel[1], y: 0, water: null, floor: true };
  }

  ghost(): Posable {
    return new MadeBody(this.made);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.root.removeFromParent();
  }
}

const urlOf = (animId: string, o: Options): string | undefined => o.url || fileUrl(parse(animId).file);

export const retargetSubject: Subject = {
  id: 'retarget',
  name: 'Library Clips',
  group: 'Heroes',
  blurb: 'Clips on the made hero, beside their source',
  options: [
    { id: 'url', label: 'Clip File', value: '', hint: '/scratch/clips.glb instead of the file named' },
    { id: 'mesh', label: 'Source Skinned As', value: '', hint: '/scratch/with-skin.glb' },
  ],
  anims: () => MOVE_CLIPS,
  find: (id) => {
    if (!id.includes(':')) return null;
    const { file, clips } = parse(id);
    return { id, label: words(clips), group: 'Other Clips', frames: 0, fps: RATE, loop: true, note: `${file}.glb`, tag: 'clip' };
  },
  async ready(o, animId) {
    const made = await madeHero();
    if (!made) throw new Error('retarget: the made hero did not load (hero.glb)');
    const url = urlOf(animId ?? MOVE_CLIPS[0].id, o);
    if (!url) throw new Error(`retarget: no clip file ${parse(animId ?? '').file} in src/render/assets/models (or give ?url=)`);
    await Promise.all([load(url), o.mesh ? load(o.mesh) : null]);
  },
  take(animId, o): Take {
    const made = madeHeroNow();
    const url = urlOf(animId, o);
    const source = url ? loaded.get(url) : undefined;
    if (!made || !source) throw new Error('retarget: open it through the library (its files load first)');
    return new RetargetTake(made, source, o.mesh ? (loaded.get(o.mesh) ?? null) : null, parse(animId).clips);
  },
  // Notes on a clip are the same with its source shown skinned or as bones.
  optionsFor: (_animId, o): Options => (o.url ? { url: o.url } : {}),
  source: (): Source => ({
    system:
      "A clip from an animation library (Meshy's, made on the hero's own skeleton, or Quaternius' Universal Animation Library, or any humanoid GLB) baked onto the made hero bone for bone (retarget.ts bake): each of our joints' rest lined up with its source bone's, every turn copied, the body following the source's hip joints sized by leg length, the clip's own travel taken off so the rules carry the body and the feet it plants are held; then played by poseFromClip as the game plays a move (moves.ts says which move plays which clip). Here the source plays beside it as authored, and every frame says how far each of the hero's bones points from its source bone and how high its lower ankle is against where it stands.",
    files: [
      { path: 'src/render/detail/retarget.ts', what: "bake, poseFromClip, the libraries' bone tables (LIBRARIES)" },
      { path: 'src/render/detail/moves.ts', what: 'which clip each weapon combo plays, and its cut (parts, from, to)' },
      { path: 'src/render/detail/madeHero.ts', what: "the made hero and its moves' bakes" },
      { path: 'src/render/detail/fit.ts', what: 'the made body on our rig: palms, fingers, gripHands' },
      { path: 'src/render/assets/models/hero_*.glb', what: 'the clip files (cut with tools/models/clips.mjs)' },
      { path: 'src/library/subjects/retarget.ts', what: 'this check: the source beside the hero, every frame measured' },
    ],
    conventions:
      "Model space: x to the body's left, y up, z ahead. The hero stands a metre to the left of the source; a bone's error is the angle between its direction on the hero and its source bone's, with the source's turn away from its rest taken off.",
    checks: [
      {
        command: 'npx playwright test tests/integration/retarget.spec.ts',
        what: 'every move clip, every frame: bones within 0.1° on average and 1° at worst, ankles out of the ground',
      },
    ],
  }),
  animSource: (animId, o) => {
    const { file, clips } = parse(animId);
    return `${clips.join(' then ')} from ${o.url || `src/render/assets/models/${file}.glb`}, baked onto the made hero by retarget.ts`;
  },
};
