import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Stage } from './stage';
import { readBones, writeBones } from './pose';
import type { Bone, JointPose, Posable } from './types';

// Correcting a frame by hand: pick a joint and turn it (a rotation gizmo in its own space), or take
// a hand or a foot and put it where it should be (two-bone IK bends the limb to reach, the hand
// keeping its turn). Every change can be undone; what was touched is remembered for the note.

export type Tool = 'rotate' | 'move' | 'scale';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _pq = new THREE.Quaternion();

/** Sets a node's world turn, keeping its parent's. */
function setWorldQuaternion(o: THREE.Object3D, world: THREE.Quaternion): void {
  o.parent!.getWorldQuaternion(_pq);
  o.quaternion.copy(_pq.invert().multiply(world));
}

export class Editor {
  readonly gizmo: TransformControls;
  /** What the move tool drags for a limb's end (the IK target). */
  private handle = new THREE.Object3D();
  body: Posable | null = null;
  active = false;
  tool: Tool = 'rotate';
  selected: Bone | null = null;
  /** Bones turned or moved by hand since editing began. */
  touched = new Set<string>();
  private undoStack: Array<Record<string, JointPose>> = [];
  private redoStack: Array<Record<string, JointPose>> = [];
  private base: Record<string, JointPose> | null = null;
  private dragging = false;
  private ikEndTurn = new THREE.Quaternion();
  onChange: () => void = () => {};

  constructor(stage: Stage) {
    this.gizmo = new TransformControls(stage.camera, stage.renderer.domElement);
    this.gizmo.setSpace('local');
    this.gizmo.setSize(0.85);
    const helper = this.gizmo.getHelper();
    helper.renderOrder = 1100;
    stage.scene.add(helper, this.handle);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      const on = Boolean((e as unknown as { value: boolean }).value);
      stage.controls.enabled = !on;
      if (on) this.beginDrag();
      else this.dragging = false;
    });
    this.gizmo.addEventListener('objectChange', () => this.dragged());
  }

  /** Whether a gizmo handle is being dragged right now. */
  get isDragging(): boolean {
    return this.dragging;
  }

  /** Whether the pointer is over one of the gizmo's handles (so a click is for it, not for picking). */
  get hot(): boolean {
    return this.gizmo.axis !== null || this.dragging;
  }

  begin(body: Posable): void {
    this.body = body;
    this.active = true;
    this.touched.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.base = readBones(body.bones);
    this.attach();
    this.onChange();
  }

  /** Stops editing; the caller puts the frame back as it was (or keeps the edit as a note first). */
  end(): void {
    this.active = false;
    this.selected = null;
    this.base = null;
    this.gizmo.detach();
    this.touched.clear();
    this.onChange();
  }

  get dirty(): boolean {
    return this.touched.size > 0;
  }

  select(bone: Bone | null): void {
    this.selected = bone && !bone.locked ? bone : null;
    this.attach();
    this.onChange();
  }

  setTool(t: Tool): void {
    this.tool = t;
    this.attach();
    this.onChange();
  }

  /** A hand or a foot: the end of a two-bone limb (a hinge and its upper bone, each with one child). */
  chainOf(b: Bone): [Bone, Bone, Bone] | null {
    if (!this.body) return null;
    const bones = this.body.bones;
    const byName = new Map(bones.map((x) => [x.name, x]));
    const mid = b.parent ? byName.get(b.parent) : undefined;
    const top = mid?.parent ? byName.get(mid.parent) : undefined;
    if (!mid || !top || mid.locked || top.locked) return null;
    const kids = (p: Bone) => bones.filter((x) => x.parent === p.name && !x.minor && !x.name.startsWith('@')).length;
    if (kids(mid) !== 1 || kids(top) !== 1) return null;
    // Both bones have length: a limb, not a stack of joints at one spot.
    top.object.getWorldPosition(_a);
    mid.object.getWorldPosition(_b);
    b.object.getWorldPosition(_c);
    if (_a.distanceTo(_b) < 0.02 || _b.distanceTo(_c) < 0.02) return null;
    return [top, mid, b];
  }

  private attach(): void {
    const b = this.selected;
    if (!this.active || !b) {
      this.gizmo.detach();
      return;
    }
    if (this.tool === 'scale') {
      // Squash and stretch: a slime's whole motion.
      this.gizmo.setMode('scale');
      this.gizmo.setSpace('local');
      this.gizmo.attach(b.object);
      return;
    }
    if (this.tool === 'rotate') {
      this.gizmo.setMode('rotate');
      this.gizmo.setSpace('local');
      this.gizmo.attach(b.object);
      return;
    }
    this.gizmo.setMode('translate');
    if (this.chainOf(b)) {
      b.object.getWorldPosition(this.handle.position);
      this.handle.quaternion.identity();
      this.handle.updateMatrixWorld(true);
      this.gizmo.setSpace('world');
      this.gizmo.attach(this.handle);
    } else {
      // Not a limb's end: the joint itself moves, in its parent's space.
      this.gizmo.setSpace('local');
      this.gizmo.attach(b.object);
    }
  }

  private beginDrag(): void {
    if (!this.body || !this.selected) return;
    this.dragging = true;
    this.pushUndo();
    this.selected.object.getWorldQuaternion(this.ikEndTurn);
  }

  private dragged(): void {
    const b = this.selected;
    if (!this.body || !b) return;
    if (this.tool === 'move') {
      const chain = this.chainOf(b);
      if (chain && this.gizmo.object === this.handle) {
        this.reach(chain, this.handle.getWorldPosition(_t));
        for (const x of chain) this.touched.add(x.name);
      } else this.touched.add(b.name);
    } else this.touched.add(b.name);
    this.onChange();
  }

  /**
   * Two-bone IK in the world: the hinge bends so the limb is as long as the reach, then the upper
   * bone swings to point the limb at the target; the end keeps the turn it had in the world.
   */
  private reach([top, mid, end]: [Bone, Bone, Bone], target: THREE.Vector3): void {
    const root = this.body!.root;
    root.updateMatrixWorld(true);
    const A = top.object.getWorldPosition(new THREE.Vector3());
    const B = mid.object.getWorldPosition(new THREE.Vector3());
    const C = end.object.getWorldPosition(new THREE.Vector3());
    const l1 = A.distanceTo(B);
    const l2 = B.distanceTo(C);
    const d = Math.max(Math.abs(l1 - l2) + 1e-4, Math.min(l1 + l2 - 1e-4, A.distanceTo(target)));
    // Bend: the angle at the hinge that makes A..C as long as d.
    const ba = _a.subVectors(A, B).normalize();
    const bc = _b.subVectors(C, B).normalize();
    const now = Math.acos(THREE.MathUtils.clamp(ba.dot(bc), -1, 1));
    const want = Math.acos(THREE.MathUtils.clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
    _n.crossVectors(bc, ba);
    if (_n.lengthSq() < 1e-10) {
      // Straight: bend toward the target's side of the limb.
      _n.crossVectors(_c.subVectors(target, A), ba);
      if (_n.lengthSq() < 1e-10) _n.set(1, 0, 0).applyQuaternion(mid.object.getWorldQuaternion(_q));
    }
    _n.normalize();
    // Opening the hinge by (want - now) about that axis, applied to the lower bone in the world.
    mid.object.getWorldQuaternion(_q);
    _q2.setFromAxisAngle(_n, -(want - now));
    setWorldQuaternion(mid.object, _q2.multiply(_q));
    root.updateMatrixWorld(true);
    // Swing: the upper bone turns so A..C points at the target.
    const C2 = end.object.getWorldPosition(new THREE.Vector3());
    const from = _a.subVectors(C2, A).normalize();
    const to = _b.subVectors(target, A).normalize();
    _q2.setFromUnitVectors(from, to);
    top.object.getWorldQuaternion(_q);
    setWorldQuaternion(top.object, _q2.multiply(_q));
    root.updateMatrixWorld(true);
    // The end keeps its turn in the world (a hand keeps holding the sword the same way).
    setWorldQuaternion(end.object, this.ikEndTurn);
  }

  private pushUndo(): void {
    if (!this.body) return;
    this.undoStack.push(readBones(this.body.bones));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): void {
    if (!this.body || !this.undoStack.length) return;
    this.redoStack.push(readBones(this.body.bones));
    writeBones(this.body.bones, this.undoStack.pop()!);
    this.recountTouched();
    this.attach();
    this.onChange();
  }

  redo(): void {
    if (!this.body || !this.redoStack.length) return;
    this.undoStack.push(readBones(this.body.bones));
    writeBones(this.body.bones, this.redoStack.pop()!);
    this.recountTouched();
    this.attach();
    this.onChange();
  }

  /** Touched means different from the frame as it was. */
  private recountTouched(): void {
    if (!this.body || !this.base) return;
    this.touched.clear();
    for (const b of this.body.bones) {
      const was = this.base[b.name];
      if (!was) continue;
      const o = b.object;
      const moved = Math.abs(o.position.x - was[0]) + Math.abs(o.position.y - was[1]) + Math.abs(o.position.z - was[2]) > 1e-6;
      const turned = 1 - Math.abs(o.quaternion.x * was[3] + o.quaternion.y * was[4] + o.quaternion.z * was[5] + o.quaternion.w * was[6]) > 1e-9;
      const scaled = Math.abs(o.scale.x - was[7]) + Math.abs(o.scale.y - was[8]) + Math.abs(o.scale.z - was[9]) > 1e-6;
      if (moved || turned || scaled) this.touched.add(b.name);
    }
  }

  /** Puts a bone (or all of them) back as the frame had it. */
  reset(bone?: Bone): void {
    if (!this.body || !this.base) return;
    this.pushUndo();
    if (bone) writeBones([bone], this.base);
    else writeBones(this.body.bones, this.base);
    this.recountTouched();
    this.attach();
    this.onChange();
  }

  /** Sets the selected bone's local turn from Euler angles (degrees, XYZ). */
  setEuler(deg: [number, number, number]): void {
    const b = this.selected;
    if (!b) return;
    this.pushUndo();
    b.object.rotation.set((deg[0] * Math.PI) / 180, (deg[1] * Math.PI) / 180, (deg[2] * Math.PI) / 180, 'XYZ');
    this.touched.add(b.name);
    this.attach();
    this.onChange();
  }

  /** Turns the selected bone a little about one of its own axes (keyboard nudges). */
  nudge(axis: 'x' | 'y' | 'z', deg: number): void {
    const b = this.selected;
    if (!b) return;
    this.pushUndo();
    const v = axis === 'x' ? new THREE.Vector3(1, 0, 0) : axis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    b.object.quaternion.multiply(_q.setFromAxisAngle(v, (deg * Math.PI) / 180));
    this.touched.add(b.name);
    this.attach();
    this.onChange();
  }

  /** The handle follows its joint when the pose changes underneath it (undo, a reset). */
  sync(): void {
    if (this.gizmo.object === this.handle && this.selected) {
      this.selected.object.getWorldPosition(this.handle.position);
      this.handle.updateMatrixWorld(true);
    }
  }
}
