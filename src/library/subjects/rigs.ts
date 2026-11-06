import * as THREE from 'three';
import { creatureIds, creatureRig } from '../../content/creatures/index';
import type { RigDef } from '../../content/rig';
import { DetailRig } from '../../render/detail/rig';
import { readBones, sideOf, writeBones } from '../pose';
import type { Bone, FrameInfo, Options, Phase, Posable, Snapshot, Source, Subject, Take } from '../types';

// Close-up bodies as their content builds them (src/content/creatures/), at rest, on the creature
// bench as it always looked (a dark room, no floor): a new race is looked at here before it is wired
// into the game, every joint posed by hand with the library's editor and any weapon in its hand.
// Library route: #/rig-<id>/rest?attach=sword|club|staff|bow|none. Measured without drawing:
// bench/rigs.ts, tests/unit/creatures.test.ts.

const name = (id: string) => `${id[0].toUpperCase()}${id.slice(1)} Rig`;

/** A rig built from its content, holding one of its weapons (or nothing). */
class RigBody implements Posable {
  readonly rig: DetailRig;
  readonly root: THREE.Object3D;
  readonly space: THREE.Object3D;
  readonly bones: Bone[];

  constructor(def: RigDef, attach: string | null) {
    this.rig = new DetailRig(def);
    this.rig.showAttachment(attach);
    this.root = this.rig.root;
    this.space = this.rig.root;
    this.bones = def.joints.map((j) => ({ name: j.name, object: this.rig.joint(j.name), parent: j.parent ?? null, side: sideOf(j.name) }));
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

/** The rig at rest: one frame, to look at from every side and pose by hand. */
class RigTake implements Take {
  readonly root = new THREE.Group();
  readonly body: RigBody;
  readonly space: THREE.Object3D;
  readonly bones: Bone[];
  readonly frames = 1;
  readonly fps = 60;
  readonly loop = false;
  readonly baked = 1;
  readonly phases: Phase[] = [{ from: 0, to: 0, label: 'At rest', kind: 'idle' }];
  readonly backdrop = 'bench' as const;
  readonly framing;
  private readonly rest: Snapshot;

  constructor(
    readonly def: RigDef,
    readonly attach: string | null,
  ) {
    this.body = new RigBody(def, attach);
    this.root.add(this.body.root);
    this.space = this.body.root;
    this.bones = this.body.bones;
    this.rest = this.body.capture();
    // As the bench framed a body 1.9 m tall: its middle, a little from above, the whole of it in view.
    const height = 1.9;
    this.framing = { target: [0, height * 0.45, 0] as [number, number, number], distance: height * 2.25, height };
  }

  bake(): boolean {
    return true;
  }

  show(): void {
    this.body.apply(this.rest);
  }

  snapshot(): Snapshot {
    return { joints: Object.fromEntries(Object.entries(this.rest.joints).map(([k, v]) => [k, [...v]])) };
  }

  capture(): Snapshot {
    return this.body.capture();
  }

  apply(s: Snapshot): void {
    this.body.apply(s);
  }

  info(): FrameInfo {
    const d = this.def;
    return {
      line: `${d.id} at rest: ${d.joints.length} joints, ${d.parts.length} parts${this.attach ? `, holding the ${this.attach}` : ''}`,
      detail: {
        joints: d.joints.length,
        parts: d.parts.length,
        materials: Object.keys(d.materials),
        attachments: Object.entries(d.attachments ?? {}).map(([n, a]) => `${n} (${a.joint}${a.exclusive ? ', one at a time' : ''})`),
      },
    };
  }

  ground(): { x: number; z: number; y: number; water: number | null; floor: boolean } {
    return { x: 0, z: 0, y: 0, water: null, floor: false };
  }

  ghost(): Posable {
    return new RigBody(this.def, this.attach);
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}

function rigSubject(id: string): Subject {
  const def = creatureRig(id);
  const carried = Object.entries(def.attachments ?? {}).filter(([, a]) => a.exclusive);
  return {
    id: `rig-${id}`,
    name: name(id),
    group: 'Rigs',
    blurb: 'Built from its content, posed joint by joint',
    options: [
      {
        id: 'attach',
        label: 'Holding',
        value: carried[0]?.[0] ?? 'none',
        choices: [...carried.map(([n]) => ({ value: n, label: n[0].toUpperCase() + n.slice(1) })), { value: 'none', label: 'Nothing' }],
      },
    ],
    anims: () => [{ id: 'rest', label: 'At Rest', group: 'Poses', frames: 1, fps: 60, loop: false, note: 'Every joint at its rest, to pose by hand' }],
    take: (_anim: string, o: Options): Take => new RigTake(def, o.attach && o.attach !== 'none' ? o.attach : null),
    source: (): Source => ({
      system: `A close-up body is content: a rig of joints (each a position on its parent), rounded boxes and balls hung off them in named materials, and what it carries (src/content/creatures/${id}.ts), built by DetailRig (src/render/detail/rig.ts). The poses that move it are code (src/render/detail/humanoid.ts) and turn its joints by name; a new race is a new rig with the same joints, looked at here before it is wired into the game.`,
      files: [
        { path: `src/content/creatures/${id}.ts`, what: 'the rig: joints, parts, materials, weapons' },
        { path: 'src/content/creatures/index.ts', what: 'every close-up body, by id' },
        { path: 'src/render/detail/rig.ts', what: 'building it' },
        { path: 'src/library/bench/rigs.ts', what: 'measuring it: rest positions, turning joints' },
      ],
      conventions:
        "Model space: x to the body's left, y up, z ahead; the ground is y = 0. A joint hangs down its parent's -Y at rest; knees fold the shin back with positive X, elbows the forearm forward with negative X.",
      checks: [
        {
          command: 'npx vitest run tests/unit/creatures.test.ts',
          what: 'every joint the poses turn, the weapons in the right hands, the skeleton hanging together',
        },
        { command: 'npx playwright test tests/integration/creatures.spec.ts', what: 'each rig drawn with each weapon' },
      ],
    }),
    animSource: () => `its rest pose, straight from src/content/creatures/${id}.ts`,
  };
}

export const rigSubjects: Subject[] = creatureIds().map(rigSubject);
