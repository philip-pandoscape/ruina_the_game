import * as THREE from 'three';
import type { Stage } from './stage';
import type { Bone, Posable, Take, Vec3 } from './types';

// What the library draws over a body: its skeleton (bones you can click), ghosts of other frames
// and of corrections, and the paths its hands and feet take through the whole animation.

export const SIDE_COLOURS = { L: 0x4da3ff, R: 0xff6b6b, C: 0xffc857 } as const;
const SELECTED = 0xffffff;
const LOCKED = 0x7d8796;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** The bones worth drawing, each joined to its nearest drawn ancestor. */
function drawn(bones: readonly Bone[]): Array<{ bone: Bone; up: Bone | null }> {
  const byName = new Map(bones.map((b) => [b.name, b]));
  const shown = bones.filter((b) => !b.minor && !b.name.startsWith('@'));
  const shownSet = new Set(shown.map((b) => b.name));
  return shown.map((bone) => {
    let p = bone.parent ? byName.get(bone.parent) : undefined;
    while (p && !shownSet.has(p.name)) p = p.parent ? byName.get(p.parent) : undefined;
    return { bone, up: p ?? null };
  });
}

/** The skeleton drawn over the body, on top of everything: a dot per joint and a stick per bone. */
export class Skeleton {
  readonly group = new THREE.Group();
  private dots: THREE.InstancedMesh | null = null;
  private sticks: THREE.InstancedMesh | null = null;
  private list: Array<{ bone: Bone; up: Bone | null }> = [];
  private size = 0.02;
  selected: string | null = null;
  hovered: string | null = null;
  visible = true;

  constructor() {
    this.group.renderOrder = 1000;
  }

  setBody(body: Posable | null, height = 1.8): void {
    for (const m of [this.dots, this.sticks]) {
      if (!m) continue;
      m.removeFromParent();
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.dots = this.sticks = null;
    this.list = body ? drawn(body.bones) : [];
    if (!body || !this.list.length) return;
    this.size = Math.max(0.008, Math.min(0.03, height * 0.012));
    const mat = () => new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true, opacity: 0.95, toneMapped: false });
    this.dots = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 14, 10), mat(), this.list.length);
    const stick = new THREE.CylinderGeometry(0.35, 1, 1, 6, 1).translate(0, 0.5, 0);
    this.sticks = new THREE.InstancedMesh(stick, mat(), this.list.length);
    (this.sticks.material as THREE.MeshBasicMaterial).opacity = 0.55;
    for (const m of [this.dots, this.sticks]) {
      m.renderOrder = 1000;
      m.frustumCulled = false;
      this.group.add(m);
    }
    this.update();
  }

  bones(): Bone[] {
    return this.list.map((x) => x.bone);
  }

  /** After the body moves: where each dot and stick goes, and its colour. */
  update(): void {
    const dots = this.dots;
    const sticks = this.sticks;
    if (!dots || !sticks) return;
    this.group.visible = this.visible;
    const colour = new THREE.Color();
    this.list.forEach(({ bone, up }, i) => {
      bone.object.getWorldPosition(_a);
      const sel = bone.name === this.selected;
      const hov = bone.name === this.hovered;
      const r = this.size * (sel ? 1.6 : hov ? 1.35 : 1);
      dots.setMatrixAt(i, _m.compose(_a, _q.identity(), _s.set(r, r, r)));
      colour.set(sel ? SELECTED : bone.locked ? LOCKED : SIDE_COLOURS[bone.side]);
      dots.setColorAt(i, colour);
      if (up) {
        up.object.getWorldPosition(_b);
        const d = _a.clone().sub(_b);
        const len = d.length();
        _q.setFromUnitVectors(UP, len > 1e-6 ? d.divideScalar(len) : UP);
        const w = this.size * 0.55;
        sticks.setMatrixAt(i, _m.compose(_b, _q, _s.set(w, len, w)));
      } else sticks.setMatrixAt(i, _m.makeScale(0, 0, 0));
      sticks.setColorAt(i, colour.lerp(new THREE.Color(0xffffff), sel ? 0 : 0.25));
    });
    for (const m of [dots, sticks]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  /** The joint nearest a point on the screen, within `radius` CSS pixels. */
  pick(stage: Stage, x: number, y: number, radius = 16): Bone | null {
    if (!this.visible) return null;
    let best: Bone | null = null;
    let bestD = radius;
    const p = new THREE.Vector3();
    for (const { bone } of this.list) {
      bone.object.getWorldPosition(_a);
      stage.toScreen(_a, p);
      if (p.z > 1) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) {
        bestD = d;
        best = bone;
      }
    }
    return best;
  }
}

const ghostMaterials = new Map<string, THREE.Material>();
function ghostMaterial(color: number, opacity: number): THREE.Material {
  const key = `${color}:${opacity}`;
  let m = ghostMaterials.get(key);
  if (!m) {
    // Pushed back a touch in depth: where a ghost lies on the body it hides, so only what differs shows.
    m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 8 });
    ghostMaterials.set(key, m);
  }
  return m;
}

/** Turns a body into a see-through ghost of one colour (outlines and hidden bulk left out). */
export function ghostify(p: Posable, color: number, opacity: number): void {
  p.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.material instanceof THREE.ShaderMaterial) {
      m.visible = false;
      return;
    }
    m.material = ghostMaterial(color, opacity);
    m.castShadow = false;
    m.receiveShadow = false;
    m.renderOrder = 20;
  });
}

/** A ghost's colour and opacity, by what it shows. */
export const GHOST = {
  before: { color: 0x58a6ff, opacity: 0.22 },
  after: { color: 0xffa94d, opacity: 0.22 },
  target: { color: 0x3ddc97, opacity: 0.42 },
  original: { color: 0x9aa4b2, opacity: 0.18 },
} as const;

export interface TrailMark {
  name: string;
  bone: string;
  /** A point in that bone's own space (the tip of a blade), else the joint itself. */
  at?: Vec3;
  color: number;
}

/** Ends of limbs by default: drawn bones with no drawn children. */
export function defaultMarks(bones: readonly Bone[]): TrailMark[] {
  const shown = bones.filter((b) => !b.minor && !b.name.startsWith('@') && !b.locked);
  const parents = new Set<string>();
  const byName = new Map(bones.map((b) => [b.name, b]));
  for (const b of shown) {
    let p = b.parent ? byName.get(b.parent) : undefined;
    while (p && (p.minor || p.name.startsWith('@'))) p = p.parent ? byName.get(p.parent) : undefined;
    if (p) parents.add(p.name);
  }
  return shown.filter((b) => !parents.has(b.name)).map((b) => ({ name: b.name, bone: b.name, color: SIDE_COLOURS[b.side] }));
}

/** The paths marked points take through the whole take, with a dot where each is now. */
export class Trails {
  readonly group = new THREE.Group();
  private paths: Array<{ mark: TrailMark; points: Float32Array; line: THREE.Line; dot: THREE.Mesh }> = [];
  private frames = 0;

  clear(): void {
    for (const p of this.paths) {
      p.line.geometry.dispose();
      (p.line.material as THREE.Material).dispose();
      p.dot.geometry.dispose();
      (p.dot.material as THREE.Material).dispose();
    }
    this.group.clear();
    this.paths = [];
    this.frames = 0;
  }

  /** Works the paths out by showing every frame of the take (it has to be baked). */
  build(take: Take, marks: TrailMark[]): void {
    this.clear();
    if (!marks.length) return;
    const byName = new Map(take.bones.map((b) => [b.name, b]));
    const n = take.frames;
    const pts = marks.map(() => new Float32Array(n * 3));
    for (let f = 0; f < n; f++) {
      take.show(f);
      take.root.updateMatrixWorld(true);
      marks.forEach((mk, i) => {
        const b = byName.get(mk.bone);
        if (!b) return;
        _a.set(...(mk.at ?? [0, 0, 0])).applyMatrix4(b.object.matrixWorld);
        pts[i].set([_a.x, _a.y, _a.z], f * 3);
      });
    }
    marks.forEach((mark, i) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pts[i], 3));
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: mark.color, transparent: true, opacity: 0.75, depthTest: false, toneMapped: false }));
      line.renderOrder = 990;
      line.frustumCulled = false;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.018, 10, 8), new THREE.MeshBasicMaterial({ color: mark.color, depthTest: false, toneMapped: false }));
      dot.renderOrder = 991;
      this.group.add(line, dot);
      this.paths.push({ mark, points: pts[i], line, dot });
    });
    this.frames = n;
  }

  setFrame(f: number): void {
    if (!this.frames) return;
    const k = Math.max(0, Math.min(this.frames - 1, f)) * 3;
    for (const p of this.paths) p.dot.position.set(p.points[k], p.points[k + 1], p.points[k + 2]);
  }

  get built(): boolean {
    return this.frames > 0;
  }
}
