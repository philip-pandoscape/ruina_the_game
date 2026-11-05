import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { part, toon } from '../toon';
import type { PartDef, RigDef, ShapeDef } from '../../content/rig';

// Turns a rig description into meshes. The description itself lives in src/content/rig.ts, so
// content never has to reach into the renderer.

export type { JointDef, MaterialDef, PartDef, RigDef, ShapeDef, Vec3 } from '../../content/rig';

function geometry(s: ShapeDef): THREE.BufferGeometry {
  switch (s.kind) {
    case 'box':
      return new RoundedBoxGeometry(s.w, s.h, s.d, 2, s.r ?? 0.05);
    case 'sphere':
      return new THREE.SphereGeometry(s.r, s.widthSeg ?? 12, s.heightSeg ?? 8);
    case 'cylinder':
      return new THREE.CylinderGeometry(s.top, s.bottom, s.h, s.sides ?? 8);
    case 'cone':
      return new THREE.ConeGeometry(s.r, s.h, s.sides ?? 4);
    case 'torus':
      return new THREE.TorusGeometry(s.r, s.tube, s.radialSeg ?? 6, s.tubularSeg ?? 14, s.arc);
    case 'ico':
      return new THREE.IcosahedronGeometry(s.r, s.detail ?? 0);
  }
}

export class DetailRig {
  readonly root = new THREE.Group();
  private joints = new Map<string, THREE.Group>();
  private materials = new Map<string, THREE.Material>();
  private attachments = new Map<string, THREE.Group>();
  /** Every mesh built, and which joint and palette slot it came from, for the crowd baker. */
  readonly built: Array<{ joint: string; mat: string; mesh: THREE.Mesh }> = [];

  constructor(readonly def: RigDef) {
    for (const [key, m] of Object.entries(def.materials)) {
      this.materials.set(
        key,
        m.basic
          ? new THREE.MeshBasicMaterial({ color: m.color, toneMapped: false })
          : toon(m.color, m.emissive !== undefined ? { emissive: m.emissive } : {}),
      );
    }
    for (const j of def.joints) {
      const g = new THREE.Group();
      if (j.pos) g.position.set(...j.pos);
      const parent = j.parent ? this.joints.get(j.parent) : undefined;
      if (j.parent && !parent) throw new Error(`rig ${def.id}: joint "${j.name}" wants parent "${j.parent}", which comes later or not at all`);
      (parent ?? this.root).add(g);
      this.joints.set(j.name, g);
    }
    for (const p of def.parts) this.build(p, this.joint(p.joint));
    for (const [name, a] of Object.entries(def.attachments ?? {})) {
      const g = new THREE.Group();
      this.joint(a.joint).add(g);
      for (const p of a.parts) this.build(p, g);
      this.attachments.set(name, g);
      g.visible = false;
    }
  }

  private build(p: PartDef, parent: THREE.Object3D): void {
    const g = geometry(p.shape);
    p.tweak?.(g);
    const mat = this.materials.get(p.mat);
    if (!mat) throw new Error(`rig ${this.def.id}: part on "${p.joint}" wants material "${p.mat}", which is not in the palette`);
    const [x, y, z] = p.pos ?? [0, 0, 0];
    const mesh = part(parent, g, mat, x, y, z, { outline: p.outline, castShadow: p.castShadow });
    if (p.hidden) mesh.visible = false;
    this.built.push({ joint: p.joint, mat: p.mat, mesh });
  }

  /** A joint to pose. Throws rather than silently doing nothing if the name is wrong. */
  joint(name: string): THREE.Group {
    const g = this.joints.get(name);
    if (!g) throw new Error(`rig ${this.def.id}: no joint "${name}"`);
    return g;
  }

  has(name: string): boolean {
    return this.joints.has(name);
  }

  attachment(name: string): THREE.Group {
    const g = this.attachments.get(name);
    if (!g) throw new Error(`rig ${this.def.id}: no attachment "${name}"`);
    return g;
  }

  /** Shows one weapon and hides the other weapons. Leaves non-exclusive attachments alone. */
  showAttachment(name: string | null): void {
    for (const [key, g] of this.attachments) {
      if (this.def.attachments?.[key]?.exclusive) g.visible = key === name;
    }
  }

  /** Recolours a palette entry; used for team colours. */
  recolour(key: string, color: number): void {
    const m = this.materials.get(key) as THREE.MeshToonMaterial | undefined;
    m?.color.set(color);
  }
}
