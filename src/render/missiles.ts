import * as THREE from 'three';

// What creatures throw, drawn where the rules have it (src/sim/combat/missiles.ts): a tumbling
// stone, the only look so far. One instanced mesh, however many are in the air.

export interface ShownMissile {
  id: number;
  x: number;
  y: number;
  z: number;
  age: number;
  radius: number;
}

export class MissileView {
  readonly group = new THREE.Group();
  private stones: THREE.InstancedMesh;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();

  constructor(private capacity = 64) {
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x8d877d, roughness: 0.95, flatShading: true });
    this.stones = new THREE.InstancedMesh(geo, mat, capacity);
    this.stones.count = 0;
    this.stones.frustumCulled = false;
    this.stones.castShadow = true;
    this.group.add(this.stones);
  }

  update(list: readonly ShownMissile[]): void {
    let n = 0;
    for (const m of list) {
      if (n >= this.capacity) break;
      // Tumbling as it flies, a little lumpy.
      const spin = m.age * 0.3 + m.id;
      this.e.set(spin, spin * 0.7, spin * 0.4);
      this.q.setFromEuler(this.e);
      const r = m.radius * 1.1;
      this.s.set(r, r * 0.8, r * 0.9);
      this.p.set(m.x, m.y, m.z);
      this.m.compose(this.p, this.q, this.s);
      this.stones.setMatrixAt(n++, this.m);
    }
    this.stones.count = n;
    this.stones.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.stones.geometry.dispose();
    (this.stones.material as THREE.Material).dispose();
  }
}
