import * as THREE from 'three';

// The island's shared material: three's toon material with a light ramp that makes it smooth,
// ordinary diffuse light (src/render/look.ts).

let gradient: THREE.DataTexture | null = null;

// The toon material looks the light up by (n·l + 1) / 2. This ramp turns that back into ordinary
// diffuse light, wrapped a little past the edge so the terminator is soft; faces turned away get
// no sunlight at all, only the sky's fill, which is what gives shapes their form.
function softGradient(): THREE.DataTexture {
  if (gradient) return gradient;
  const n = 256;
  const wrap = 0.2;
  const tones = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const ndl = (i / (n - 1)) * 2 - 1;
    tones[i] = Math.round(255 * Math.max(0, (ndl + wrap) / (1 + wrap)));
  }
  gradient = new THREE.DataTexture(tones, n, 1, THREE.RedFormat);
  gradient.minFilter = THREE.LinearFilter;
  gradient.magFilter = THREE.LinearFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

export function toon(color: THREE.ColorRepresentation, extra: THREE.MeshToonMaterialParameters = {}): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, gradientMap: softGradient(), ...extra });
}

// Adds a mesh to a parent at a position, casting a shadow unless told not to.
export function part(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0, opts: { castShadow?: boolean } = {}): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = opts.castShadow ?? true;
  parent.add(mesh);
  return mesh;
}
