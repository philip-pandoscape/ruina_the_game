import * as THREE from 'three';
import { viewDirection, type Stage, type View } from './stage';
import type { Options, Subject, Take } from './types';

// A contact sheet: one animation at several frames side by side, a whole motion in one picture.
// Each frame is a take of its own (riding, flying or sitting in whatever the animation has it in),
// worked out to its frame and laid out across the view, left to right, first frame first.

export interface SheetOptions {
  /** The frames to show; without, `count` of them evenly spread over from..to (the whole animation). */
  frames?: number[];
  count?: number;
  from?: number;
  to?: number;
  /** Metres between them along the row. */
  spacing?: number;
}

export class Sheet {
  readonly group = new THREE.Group();
  private takes: Take[] = [];
  frames: number[] = [];

  constructor(private readonly stage: Stage) {
    stage.scene.add(this.group);
  }

  get active(): boolean {
    return this.takes.length > 0;
  }

  /** Lays the frames out and frames the camera on the row; returns which frames it shows. */
  show(
    subject: Subject,
    animId: string,
    options: Options,
    length: number,
    framing: Take['framing'],
    prop: boolean,
    view: View,
    o: SheetOptions = {},
  ): number[] {
    this.clear();
    if (!subject.take) return [];
    const count = o.count ?? 8;
    const from = o.from ?? 0;
    const to = o.to ?? length;
    const frames = (this.frames = o.frames ?? Array.from({ length: count }, (_, i) => Math.round(from + ((to - from) * i) / count)));
    const spacing = o.spacing ?? (prop ? 3.4 : 1.35);
    const dir = viewDirection(view);
    // Left to right on screen, first frame first.
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
    frames.forEach((f, i) => {
      const take = subject.take!(animId, options);
      const frame = Math.max(0, Math.min(take.frames - 1, f));
      take.bake(frame + 1);
      take.show(frame);
      take.setDecor?.(true);
      const holder = new THREE.Group();
      holder.position.copy(right).multiplyScalar((i - (frames.length - 1) / 2) * spacing);
      holder.add(take.root);
      this.group.add(holder);
      this.takes.push(take);
    });
    // Far enough back that the whole row, and each body's height, is in view.
    const half = Math.tan(THREE.MathUtils.degToRad(this.stage.camera.fov / 2));
    const wide = ((frames.length - 1) * spacing + 1.4) / 2 / (half * this.stage.camera.aspect);
    const tall = (framing.height * 0.75) / half;
    this.stage.frame({ ...framing, distance: Math.max(wide, tall, framing.distance) * 1.08 }, view);
    return frames;
  }

  clear(): void {
    for (const t of this.takes) t.dispose();
    this.takes = [];
    this.frames = [];
    this.group.clear();
  }
}
