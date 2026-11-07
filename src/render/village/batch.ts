import * as THREE from 'three';
import type { Kit } from './kit';
import { PARTS } from './kit';

// Many placed pieces merged into one mesh per material: a whole town of kit buildings in a handful
// of draw calls. Each vertex keeps which building and part it came from (aPart), so the one you are
// in can be drawn cut open (src/render/village/kit.ts).

export interface BatchItem {
  /** Geometry parts by material name. */
  parts: Array<{ geometry: THREE.BufferGeometry; material: string }>;
  /** Into the world. */
  matrix: THREE.Matrix4;
  /** building index x PARTS + part */
  tag: number;
  /** A colour its materials' tinted parts take, where they carry none of their own (a house's roof, its plaster). */
  tint?: Record<string, [number, number, number]>;
}

/** A piece of the kit placed by `matrix`, tagged as part `part` of building `building`. */
export function kitItem(kit: Kit, piece: string, matrix: THREE.Matrix4, building: number, part: number): BatchItem | null {
  const parts = kit.pieces.get(piece);
  if (!parts) {
    console.warn(`village kit has no piece "${piece}"`);
    return null;
  }
  return { parts, matrix, tag: building * PARTS + part };
}

/**
 * The items merged by material into meshes. `materials` gives each material name its material;
 * parts whose material it lacks are left out.
 */
export function batch(items: BatchItem[], materials: (name: string) => THREE.Material | undefined, name: string): THREE.Mesh[] {
  const sizes = new Map<string, { verts: number; indices: number }>();
  for (const it of items)
    for (const p of it.parts) {
      const s = sizes.get(p.material) ?? { verts: 0, indices: 0 };
      s.verts += p.geometry.getAttribute('position').count;
      s.indices += p.geometry.index ? p.geometry.index.count : p.geometry.getAttribute('position').count;
      sizes.set(p.material, s);
    }
  const out: THREE.Mesh[] = [];
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  for (const [mat, size] of sizes) {
    const material = materials(mat);
    if (!material) continue;
    const pos = new Float32Array(size.verts * 3);
    const nor = new Float32Array(size.verts * 3);
    const uv = new Float32Array(size.verts * 2);
    const tag = new Float32Array(size.verts);
    const colored = (material as THREE.MeshToonMaterial).vertexColors === true;
    const col = colored ? new Float32Array(size.verts * 3).fill(1) : null;
    const index = size.verts > 65535 ? new Uint32Array(size.indices) : new Uint16Array(size.indices);
    let vo = 0;
    let io = 0;
    for (const it of items) {
      nm.getNormalMatrix(it.matrix);
      for (const p of it.parts) {
        if (p.material !== mat) continue;
        const g = p.geometry;
        const P = g.getAttribute('position');
        const N = g.getAttribute('normal');
        const U = g.getAttribute('uv');
        const C = col ? g.getAttribute('color') : null;
        if (C && col) for (let i = 0; i < P.count; i++) col.set([C.getX(i), C.getY(i), C.getZ(i)], (vo + i) * 3);
        const tint = col && !C ? it.tint?.[mat] : undefined;
        if (tint && col) for (let i = 0; i < P.count; i++) col.set(tint, (vo + i) * 3);
        for (let i = 0; i < P.count; i++) {
          v.fromBufferAttribute(P, i).applyMatrix4(it.matrix);
          pos[(vo + i) * 3] = v.x;
          pos[(vo + i) * 3 + 1] = v.y;
          pos[(vo + i) * 3 + 2] = v.z;
          if (N) {
            v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
            nor[(vo + i) * 3] = v.x;
            nor[(vo + i) * 3 + 1] = v.y;
            nor[(vo + i) * 3 + 2] = v.z;
          }
          if (U) {
            uv[(vo + i) * 2] = U.getX(i);
            uv[(vo + i) * 2 + 1] = U.getY(i);
          }
          tag[vo + i] = it.tag;
        }
        if (g.index) for (let k = 0; k < g.index.count; k++) index[io + k] = g.index.getX(k) + vo;
        else for (let k = 0; k < P.count; k++) index[io + k] = vo + k;
        io += g.index ? g.index.count : P.count;
        vo += P.count;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aPart', new THREE.BufferAttribute(tag, 1));
    if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `${name}:${mat}`;
    mesh.castShadow = !(material as THREE.Material).transparent;
    mesh.receiveShadow = true;
    out.push(mesh);
  }
  return out;
}
