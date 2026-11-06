import * as THREE from 'three';
import { makeRng, range } from '../../rng';
import { valueNoise } from '../../sim/terrain';
import { PALETTE } from '../look';
import { toon } from '../toon';

// The horizon: other isles far out at sea, well past the edge of the world anyone can reach,
// wooded below and bare rock up high, softened by the haze (src/render/open/post.ts) into the blue
// of distance, as in the island's reference picture. Drawing only, and not at low quality.

interface Isle {
  /** Bearing from the island's middle (radians) and distance (m). */
  bearing: number;
  distance: number;
  /** Radius at the waterline and the highest peak (m). */
  radius: number;
  peak: number;
}

const ISLES: Isle[] = [
  { bearing: 0.35, distance: 2150, radius: 520, peak: 330 },
  { bearing: 1.25, distance: 2300, radius: 300, peak: 170 },
  { bearing: 2.2, distance: 2050, radius: 380, peak: 240 },
  { bearing: 3.05, distance: 2350, radius: 260, peak: 120 },
  { bearing: 3.9, distance: 2200, radius: 460, peak: 290 },
  { bearing: 4.9, distance: 2100, radius: 330, peak: 200 },
  { bearing: 5.7, distance: 2400, radius: 280, peak: 150 },
];

function isleGeometry(isle: Isle, seed: number): THREE.BufferGeometry {
  const RINGS = 18;
  const SPOKES = 64;
  const rng = makeRng(seed);
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const sand = new THREE.Color(PALETTE.ground[2][0]);
  const wood = new THREE.Color(PALETTE.leaves[3]).multiplyScalar(0.8);
  const grass = new THREE.Color(PALETTE.ground[0][1]);
  const rock = new THREE.Color(PALETTE.rock).multiplyScalar(0.95);
  const c = new THREE.Color();
  // A ridge running across the isle, so it reads as a range, not a cone.
  const ridge = range(rng, 0, Math.PI);
  pos.push(0, isle.peak, 0);
  col.push(rock.r, rock.g, rock.b);
  for (let r = 1; r <= RINGS; r++) {
    const u = r / RINGS;
    for (let k = 0; k < SPOKES; k++) {
      const a = (k / SPOKES) * Math.PI * 2;
      const wobble = 1 + 0.22 * (valueNoise(Math.cos(a) * 2 + seed, Math.sin(a) * 2, seed) - 0.5) * 2;
      const along = Math.abs(Math.cos(a - ridge));
      const rad = isle.radius * u * wobble * (0.75 + 0.35 * along);
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      const crag = valueNoise(x * 0.012 + seed, z * 0.012, seed + 3) * 0.5 + valueNoise(x * 0.04, z * 0.04 + seed, seed + 5) * 0.25;
      let h = isle.peak * Math.pow(1 - u, 1.6) * (0.7 + 0.6 * crag) * (0.8 + 0.3 * along);
      if (r === RINGS) h = -25;
      pos.push(x, h, z);
      const steep = Math.pow(1 - u, 0.8);
      if (h < 6) c.copy(sand);
      else if (h > isle.peak * 0.5 || steep > 0.75) c.copy(rock).lerp(grass, Math.max(0, 0.25 - crag * 0.3));
      else c.copy(wood).lerp(grass, crag * 0.6);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let k = 0; k < SPOKES; k++) idx.push(0, 1 + ((k + 1) % SPOKES), 1 + k);
  for (let r = 1; r < RINGS; r++)
    for (let k = 0; k < SPOKES; k++) {
      const a = 1 + (r - 1) * SPOKES + k;
      const b = 1 + (r - 1) * SPOKES + ((k + 1) % SPOKES);
      const d = 1 + r * SPOKES + k;
      const e = 1 + r * SPOKES + ((k + 1) % SPOKES);
      idx.push(a, b, d, b, e, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function horizonIsles(centreX: number, centreZ: number, water: number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'horizon';
  const mat = toon(0xffffff, { vertexColors: true });
  ISLES.forEach((isle, i) => {
    const mesh = new THREE.Mesh(isleGeometry(isle, 7 + i * 13), mat);
    mesh.position.set(centreX + Math.cos(isle.bearing) * isle.distance, water, centreZ + Math.sin(isle.bearing) * isle.distance);
    mesh.rotation.y = i * 1.7;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  });
  return group;
}
