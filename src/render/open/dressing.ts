import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { World } from '../../sim/types';
import { structureDef, propDef } from '../../content/structures';
import { track } from '../assets';
import { grainMaterial } from '../models/detail';
import { madeProp } from '../models/glb';
import { toon } from '../toon';
import { tryBuild, type Models } from './models';

// The buildings, props and resource nodes a zone was laid out with. Real models when the library
// has them; otherwise a block the size of the footprint, so collisions still read correctly.

function standIn(w: number, h: number, d: number, wall: number, roof: number, deck?: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const paint = (g: THREE.BufferGeometry, hex: number) => {
    const c = new THREE.Color(hex);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  };
  if (deck !== undefined) {
    const slab = new THREE.BoxGeometry(w, 0.2, d);
    slab.translate(0, deck - 0.1, 0);
    parts.push(paint(slab, 0xa8743f));
    const legs = new THREE.BoxGeometry(w * 0.9, Math.max(0.1, deck + 3), d * 0.9);
    legs.translate(0, (deck - 3) / 2 - 0.2, 0);
    parts.push(paint(legs, 0x734828));
  } else {
    const bodyH = Math.min(h, Math.max(1, h * 0.6));
    const body = new THREE.BoxGeometry(w, bodyH, d);
    body.translate(0, bodyH / 2, 0);
    parts.push(paint(body, wall));
    if (h - bodyH > 0.2) {
      const top = new THREE.ConeGeometry(Math.hypot(w, d) / 2, h - bodyH, 4);
      top.rotateY(Math.PI / 4);
      top.scale((w / Math.hypot(w, d)) * Math.SQRT2, 1, (d / Math.hypot(w, d)) * Math.SQRT2);
      top.translate(0, bodyH + (h - bodyH) / 2, 0);
      parts.push(paint(top.index ? top.toNonIndexed() : top, roof));
    }
  }
  const merged = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
  merged.computeVertexNormals();
  return merged;
}

const STAND_IN_COLOURS: Record<string, [number, number]> = {
  lighthouse: [0xffffff, 0xc4553f],
  windmill: [0xbcb6aa, 0x734828],
  oreNode: [0x8c8a85, 0x8c8a85],
  stoneNode: [0xbcb6aa, 0xbcb6aa],
  timberNode: [0x8d5a3b, 0x8d5a3b],
  herbNode: [0x5aa33f, 0x5aa33f],
};

export class ZoneDressing {
  readonly group = new THREE.Group();
  private animated: Array<(t: number) => void> = [];

  constructor(world: World, models: Models) {
    const zone = world.zone;
    if (!zone) return;
    // Built things take the grain of what they're made of; crops keep plain colours.
    const plainMat = toon(0xffffff, { vertexColors: true });
    const mat = grainMaterial(plainMat);
    const standIns: THREE.BufferGeometry[] = [];
    const props = new Map<string, Array<{ x: number; y: number; z: number; rot: number }>>();
    const crops = new Map<string, Array<{ x: number; y: number; z: number; rot: number }>>();

    for (const p of zone.gen.placements) {
      if (p.kind === 'node') continue; // drawn by the life view, which hides them while depleted
      if (p.kind === 'prop') {
        let list = props.get(p.id);
        if (!list) props.set(p.id, (list = []));
        list.push(p);
        continue;
      }
      const def = structureDef(p.id);
      // Buildings you can walk into are the village's (src/render/village).
      if (def.collider === 'building') continue;
      const built = tryBuild(models.buildStructure ? () => models.buildStructure!(p.id, { tint: p.tint, seed: p.seed, stage: 4 }) : null);
      if (built) {
        built.root.position.set(p.x, p.y, p.z);
        built.root.rotation.y = p.rot;
        this.group.add(built.root);
        if (built.animate) this.animated.push(built.animate.bind(built));
      } else {
        const [wall, roof] = STAND_IN_COLOURS[p.id] ?? [0xdcbb8c, 0x8d5a3b];
        const g = standIn(def.w, def.h, def.d, wall, roof, def.deck);
        g.rotateY(p.rot);
        g.translate(p.x, p.y, p.z);
        standIns.push(g);
      }
      // Fields worked by the villagers: rows of ripe crops on the tilled plots.
      if (p.id === 'farmPlot' && p.decor) {
        const cell = 2;
        p.decor.forEach((crop, row) => {
          for (let col = 0; col < 4; col++) {
            const lx = (col - 1.5) * cell;
            const lz = (row - 1.5) * cell;
            const c = Math.cos(p.rot);
            const s = Math.sin(p.rot);
            const x = p.x + lx * c + lz * s;
            const z = p.z - lx * s + lz * c;
            let list = crops.get(crop);
            if (!list) crops.set(crop, (list = []));
            list.push({ x, y: world.terrain!.height(x, z), z, rot: (row * 7 + col * 3) * 0.7 });
          }
        });
      }
    }
    if (standIns.length) {
      const mesh = new THREE.Mesh(mergeGeometries(standIns), mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    // Small props and crops: one instanced mesh per kind.
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();
    const instanced = (
      geo: THREE.BufferGeometry,
      items: Array<{ x: number; y: number; z: number; rot: number }>,
      shadow: boolean,
      material: THREE.Material = mat,
    ): THREE.InstancedMesh => {
      const mesh = new THREE.InstancedMesh(geo, material, items.length);
      items.forEach((it, i) => {
        q.setFromAxisAngle(up, it.rot);
        m.compose(pos.set(it.x, it.y, it.z), q, one);
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      return mesh;
    };
    for (const [id, items] of props) {
      const def = propDef(id);
      const geo = tryBuild(models.propGeometry ? () => models.propGeometry!(id) : null) ?? standIn(def.w, def.h, def.d, 0x8d5a3b, 0x734828);
      const mesh = instanced(geo, items, true);
      // The made model, when there is one, takes over the same instances once loaded.
      const made = madeProp(id, def);
      if (made)
        track(
          made.then((m) => {
            if (!m) return;
            mesh.geometry = m.geometry;
            mesh.material = m.material;
            mesh.computeBoundingSphere();
          }),
        );
    }
    for (const [id, items] of crops) {
      const geo =
        tryBuild(models.cropGeometry ? () => models.cropGeometry!(id, 3) : null) ??
        standIn(0.7, 0.9, 0.7, id === 'barley' ? 0xe2c158 : id === 'flax' ? 0x8fb8ff : 0x4caf50, 0x3e9a45);
      instanced(geo, items, false, plainMat);
    }
  }

  update(t: number): void {
    for (const a of this.animated) a(t);
  }
}
