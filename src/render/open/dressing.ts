import * as THREE from 'three';
import type { World } from '../../engine/rules';
import { structureDef, propDef } from '../../content/structures';
import { track } from '../assets';
import { grainMaterial } from '../models/detail';
import { madeProp } from '../models/glb';
import { toon } from '../toon';
import type { ModelKit } from './models';

// The buildings, props and crops a zone was laid out with (the resource nodes are the life view's,
// which hides them while they are picked clean), drawn with the procedural models and the made
// ones that take their place as they load.

export class ZoneDressing {
  readonly group = new THREE.Group();
  private animated: Array<(t: number) => void> = [];

  constructor(world: World, models: ModelKit) {
    const zone = world.zone;
    if (!zone) return;
    // Built things take the grain of what they're made of; crops keep plain colours.
    const plainMat = toon(0xffffff, { vertexColors: true });
    const mat = grainMaterial(plainMat);
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
      const built = models.buildStructure(p.id, { tint: p.tint, seed: p.seed, stage: 4 });
      built.root.position.set(p.x, p.y, p.z);
      built.root.rotation.y = p.rot;
      this.group.add(built.root);
      if (built.animate) this.animated.push(built.animate.bind(built));
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
      const mesh = instanced(models.propGeometry(id), items, true);
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
    for (const [id, items] of crops) instanced(models.cropGeometry(id, 3), items, false, plainMat);
  }

  update(t: number): void {
    for (const a of this.animated) a(t);
  }
}
