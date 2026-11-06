import * as THREE from 'three';
import { creatureRig } from '../../content/creatures/index';
import { DetailRig } from '../../render/detail/rig';

// A close-up body built straight from its content (src/content/creatures/), measured: what it is
// made of, where every joint rests, and where they go when one is turned, so a test can check it
// didn't lose a limb or bend a knee the wrong way. Pure data, no drawing: the unit tier checks every
// rig with it (tests/unit/creatures.test.ts); the library shows each one on the creature bench
// (subjects/rigs.ts), posed joint by joint.

export interface RigInfo {
  id: string;
  joints: string[];
  parts: number;
  materials: string[];
  attachments: Array<{ name: string; joint: string; parts: number; exclusive: boolean }>;
  /** Every joint's resting position in the body's own space. */
  rest: Array<readonly [string, number, number, number]>;
}

const at = (o: THREE.Object3D): number[] => {
  const p = new THREE.Vector3();
  o.getWorldPosition(p);
  return [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)];
};

/** A rig built from its content, to turn joints on and measure. */
export class RigBench {
  readonly rig: DetailRig;

  constructor(readonly id: string) {
    this.rig = new DetailRig(creatureRig(id));
  }

  info(): RigInfo {
    const def = this.rig.def;
    this.rig.root.updateMatrixWorld(true);
    return {
      id: this.id,
      joints: def.joints.map((j) => j.name),
      parts: def.parts.length,
      materials: Object.keys(def.materials),
      attachments: Object.entries(def.attachments ?? {}).map(([name, a]) => ({ name, joint: a.joint, parts: a.parts.length, exclusive: !!a.exclusive })),
      rest: def.joints.map((j) => [j.name, ...at(this.rig.joint(j.name))] as unknown as readonly [string, number, number, number]),
    };
  }

  /** Turns one joint (radians, about its own x, y and z). */
  pose(joint: string, x = 0, y = 0, z = 0): void {
    this.rig.joint(joint).rotation.set(x, y, z);
  }

  reset(): void {
    for (const j of this.rig.def.joints) this.rig.joint(j.name).rotation.set(0, 0, 0);
  }

  show(attachment: string | null): void {
    this.rig.showAttachment(attachment);
  }

  /** Where a joint has ended up after posing. */
  worldOf(joint: string): number[] {
    this.rig.root.updateMatrixWorld(true);
    return at(this.rig.joint(joint));
  }
}
