import * as THREE from 'three';
import { Heightfield, SURFACE, valueNoise } from '../../sim/terrain';
import { NEW_LOOK, PALETTE } from '../look';
import { toon } from '../toon';

// The ground of an open world, drawn from the very grid the rules walk on, split into the same
// triangles (each quad along its a-d diagonal) so feet land on the drawn surface exactly.
// Chunked so the camera only draws what it can see.

const CHUNK = 64; // cells per chunk side

// Ground colours per surface (src/render/look.ts): a pair to dither between, so big areas never look flat.
const GROUND = PALETTE.ground;

export class TerrainView {
  readonly group = new THREE.Group();
  private material: THREE.MeshToonMaterial;
  private chunks: THREE.Mesh[] = [];

  constructor(private hf: Heightfield) {
    this.material = toon(0xffffff, { vertexColors: true });
    const per = Math.ceil(hf.cells / CHUNK);
    for (let cj = 0; cj < per; cj++)
      for (let ci = 0; ci < per; ci++) {
        const mesh = this.buildChunk(ci * CHUNK, cj * CHUNK, Math.min(CHUNK, hf.cells - ci * CHUNK), Math.min(CHUNK, hf.cells - cj * CHUNK));
        if (mesh) {
          this.group.add(mesh);
          this.chunks.push(mesh);
        }
      }
  }

  get chunkCount(): number {
    return this.chunks.length;
  }

  /** Colour of one vertex: the surfaces of the four cells around it, blended, then shaded by height. */
  private vertexColour(i: number, j: number, out: THREE.Color, tmp: THREE.Color, tmp2: THREE.Color): void {
    const hf = this.hf;
    const x = hf.vx(i);
    const z = hf.vx(j);
    const h = hf.at(i, j);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    const dither = valueNoise(x * 0.11, z * 0.11, 91) * 0.65 + valueNoise(x * 0.43, z * 0.43, 97) * 0.35;
    for (let dj = -1; dj <= 0; dj++)
      for (let di = -1; di <= 0; di++) {
        const ci = i + di;
        const cj = j + dj;
        if (ci < 0 || cj < 0 || ci >= hf.cells || cj >= hf.cells) continue;
        const s = hf.surface[cj * hf.cells + ci];
        const [ca, cb] = GROUND[s] ?? GROUND[SURFACE.grass];
        tmp.setHex(ca).lerp(tmp2.setHex(cb), dither);
        r += tmp.r;
        g += tmp.g;
        b += tmp.b;
        n++;
      }
    out.setRGB(r / n, g / n, b / n);
    // Wet sand at the waterline, then the seabed darkening and greening with depth.
    if (h < hf.water + 0.5) {
      const wet = Math.min(1, (hf.water + 0.5 - h) / 1.5);
      out.lerp(tmp.setHex(PALETTE.wetSand), wet * 0.6);
      if (h < hf.water - 1) out.lerp(tmp.setHex(PALETTE.seabed), Math.min(1, (hf.water - 1 - h) / 14));
    }
    // A little warmth up high, a little lushness down low.
    if (h > 40) out.lerp(tmp.setHex(PALETTE.highland), Math.min(0.35, (h - 40) / 200));
  }

  private buildChunk(i0: number, j0: number, wi: number, wj: number): THREE.Mesh | null {
    const hf = this.hf;
    let maxH = -Infinity;
    for (let j = j0; j <= j0 + wj; j++) for (let i = i0; i <= i0 + wi; i++) maxH = Math.max(maxH, hf.at(i, j));
    if (maxH < hf.water - 12) return null; // deep sea: the water is opaque enough to hide it

    const vx = wi + 1;
    const vz = wj + 1;
    const pos = new Float32Array(vx * vz * 3);
    const nor = new Float32Array(vx * vz * 3);
    const col = new Float32Array(vx * vz * 3);
    const c = new THREE.Color();
    const t1 = new THREE.Color();
    const t2 = new THREE.Color();
    const cell = hf.cell;
    for (let j = 0; j < vz; j++)
      for (let i = 0; i < vx; i++) {
        const gi = i0 + i;
        const gj = j0 + j;
        const k = (j * vx + i) * 3;
        pos[k] = hf.vx(gi);
        pos[k + 1] = hf.at(gi, gj);
        pos[k + 2] = hf.vx(gj);
        // Smooth normals from the grid itself, so neighbouring chunks agree along their seams.
        const hl = hf.at(Math.max(0, gi - 1), gj);
        const hr = hf.at(Math.min(hf.n - 1, gi + 1), gj);
        const hd = hf.at(gi, Math.max(0, gj - 1));
        const hu = hf.at(gi, Math.min(hf.n - 1, gj + 1));
        let nx = -(hr - hl) / (2 * cell);
        let nz = -(hu - hd) / (2 * cell);
        let ny = 1;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx /= l;
        ny /= l;
        nz /= l;
        nor[k] = nx;
        nor[k + 1] = ny;
        nor[k + 2] = nz;
        this.vertexColour(gi, gj, c, t1, t2);
        col[k] = c.r;
        col[k + 1] = c.g;
        col[k + 2] = c.b;
      }
    const idx = new Uint32Array(wi * wj * 6);
    let o = 0;
    for (let j = 0; j < wj; j++)
      for (let i = 0; i < wi; i++) {
        const a = j * vx + i;
        const b = a + 1;
        const cc = a + vx;
        const d = cc + 1;
        // The a-d split, matching Heightfield.height().
        idx[o++] = a;
        idx[o++] = d;
        idx[o++] = b;
        idx[o++] = a;
        idx[o++] = cc;
        idx[o++] = d;
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.receiveShadow = true;
    // In the new look hills shade the ground behind them too, which shows when the sun is low.
    mesh.castShadow = NEW_LOOK;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}
